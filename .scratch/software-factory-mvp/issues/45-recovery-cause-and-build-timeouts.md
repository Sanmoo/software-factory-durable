# 45: A recovery recebe a causa da interrupção, e as skills orientam timeouts longos para builds

**What to build:** no piloto (ticket 35, 2026-11-18) a primeira execução real do Gradle derrubou a Execução do #125
(`Sanmoo/java-springboot-event-sourcing`, Work `c48dc69e`, Execution `27a60d10`):

- O Builder instalou `openjdk25` com `apk` e rodou `./gradlew test --tests …` com `timeout: 120`, valor que ele mesmo escolheu. A primeira
  execução do Gradle baixa a distribuição e as dependências e passou de 120 s. O resultado da ferramenta foi "Command aborted (effects
  unknown)" e a Execução terminou `WORKER_INTERRUPTED` (sessão: `pl1/r/Q8aaFvXPRS6T-cudQ25Ang/…/2026-11-19T01-13-21-269Z_…jsonl`).
- Isso é o desenho atual (`src/workers/bash.ts`): comando com efeitos desconhecidos é crítico, a invocação fecha e o controlador abre uma
  recovery, que consome 1 das 3 do Trabalho (`recoveryLimit`).
- A recovery recebeu só "The previous Execution was interrupted (WORKER_INTERRUPTED)". Não soube que a causa foi o timeout do próprio comando,
  nem que o JDK já estava instalado; refez a leitura do Ticket e repetiu a Pergunta de seams (`02e739c6`). O operador precisou avisar na
  resposta ("JDK já instalado; use timeout de 1800 s no Gradle").

Dois pontos:

1. **Causa da interrupção na recovery.** Quando a interrupção tem causa conhecida pelo Host (timeout de um comando com o comando, o timeout
   pedido e a duração; abort; canal fechado; provider indisponível), o prompt da recovery inclui essa causa de forma estruturada e limitada,
   e o último estado útil já registrado (ex.: últimos comandos com sucesso e seus códigos de saída). Sem inventar causa quando o Host não sabe.
2. **Timeouts de build nas skills.** `implement` e `alpine-diagnostics` orientam: comandos de build/teste (Gradle, Maven, npm, Docker pull)
   recebem timeout generoso (ex.: 1800 s), sobretudo na primeira execução que baixa dependências; timeout curto só para comandos rápidos;
   e explicam que um timeout encerra a Execução e consome uma recovery.

**Blocked by:** —

**Type:** task

**Status:** needs-triage

## Acceptance criteria

- [ ] Uma Execução encerrada por timeout de comando gera recovery cujo prompt nomeia o comando, o timeout pedido, a duração e o fato de os
  efeitos serem desconhecidos (teste de regra pura sobre a composição do prompt).
- [ ] Causa desconhecida continua "WORKER_INTERRUPTED" sem detalhe inventado.
- [ ] O conteúdo vindo do guest que entra no prompt é limitado e tratado como dado (sem segredos, tamanho fixo).
- [ ] Skills `implement` e `alpine-diagnostics` (nova versão do pacote) trazem a orientação de timeout; regressão no teste do pacote.
- [ ] Prova real: um build Gradle de primeira execução no repositório Java não derruba a Execução.

## Comments

- Origem: piloto 35, #125 (Executions `27a60d10` e a recovery seguinte). Relacionado: [44](44-per-project-guest-environment.md) (com o
  ambiente preparado antes, o primeiro build fica mais curto, mas o ponto 1 vale para qualquer interrupção).
- No #126 a retomada após a resposta também terminou `WORKER_INTERRUPTED` após 43 s (Execution `5ad14a97`), com causa ainda não esclarecida
  (sessão sem registro): investigar junto.
