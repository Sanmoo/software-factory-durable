# 22: Executar reparos automáticos por impedimentos efetivos

**What to build:** A Factory acompanha o mesmo PR e inicia correção prioritária somente quando existe impedimento efetivo e autorizado. Eventos repetidos consolidam contexto sem criar escritores paralelos, cobranças por evento ou reparos por simples avanço da base.

**Blocked by:** [11: Continuar contexto e incorporar apenas mudanças de escopo autorizadas](11-context-continuation-and-authorized-scope.md); [15: Explicar os checks obrigatórios do PR atual](15-required-checks-evaluation.md); [19: Aplicar limites, timeout opcional e concessões explícitas](19-budgets-optional-timeout-and-grants.md); [21: Preservar mudanças humanas durante atualização da branch](21-human-changes-and-explicit-lease.md)

**Status:** resolved

## Acceptance criteria

- [x] Gatilhos automáticos são conflito confirmado, check obrigatório atual pertinente falho e strict que efetivamente exige atualização; CI/review pendentes, mergeability desconhecida, opcional/antigo ou base apenas avançando não bastam.
- [x] Trabalho/correção/Execução existentes guardam motivos, contexto, posição e cobrança, sem fila adicional, máquina de estados por evento ou ACK de consumo por feedback.
- [x] Nova correção recebe sequência de reparo, continuações/eventos consolidados mantêm identidade/FIFO; seleção prioriza reparos sem preempção e preserva orçamento reservado/consumido.
- [x] Antes do início reconsulta requisitos, motivos, ownership, dependências e limites; se todos os motivos desapareceram, retira pendência sem cobrar, salvo reserva/início incerto que exige reconciliação.
- [x] Builder recebe motivos relevantes por continue ou recuperação, valida, obtém reviews aplicáveis e publica com lease seguro quando necessário; feedback novo aguarda ativação segura sem outro escritor.
- [x] Correção encerra após tratamentos, reviews/gates, publicação reconciliada e cessação, sem esperar CI; nova falha pertinente pode criar outra, mas evento antigo/problema declarado insolúvel bloqueia/pergunta em vez de gastar novamente.
- [x] Testes de regras/fluxos e integrações reais demonstram um reparo consolidado e cobrado uma vez, ausência de disparo por não gatilhos e manutenção do mesmo PR.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 4.3, 4.4, 9.2, 10; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-06, V-09, V-10 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-16. A Factory acompanha o MESMO PR próprio e só abre/estende a correção do Trabalho por impedimento efetivo do head
próprio atual (conflito confirmado, check obrigatório atual falho com evidência do resultado, strict que efetivamente exige atualizar sem CI
pendente); CI/review pendentes, mergeability desconhecida, resultados opcionais/antigos, base apenas avançando, causas operacionais, regras de
base que bloqueiam o merge (ticket 39), flags humanas e leituras incertas não disparam nem retiram nada. Correção cobrada uma vez no início
confirmado, categoria de reparo FIFO antes das normais sem preempção, releitura fresca antes da admissão (sumiu ⇒ retirada sem cobrança;
incerta ⇒ pulada nesse passe sem perder posição), pedido de reparo levado a toda ativação posterior da mesma correção (pergunta,
recuperação), motivos posteriores à cobrança pendentes até serem entregues, evento repetido no mesmo head bloqueia
(`REPAIR_EVENT_ALREADY_TREATED`). Nunca reescreve commits humanos: com commits de terceiros na branch faz merge da base (captura do Host e
checagem do Controle do ticket 21 provam a ancestralidade); só rebase quando todos os commits desde a base são próprios. Publicação pela
ativação do ticket 14 com lease explícito no head publicado, atualizando o mesmo PR; encerra sem esperar CI. Sob strict cada avanço da base
custa uma correção do orçamento (próximo passo diz isso). Ensaio real `q22-repair-v1` (issue #31, PR #32): avanço da base (PR #33) sem
disparo; conflito add/add (PR #34, base `85822b6`) ⇒ uma correção cobrada (1/1), continuação da sessão com a seção de reparo, rebase sobre
exatamente `85822b6`, revisões, push `--force-with-lease=…:afc13e9` do head `2644c67` no mesmo PR, correção encerrada `published`, sem novo
disparo; veredito 9/9. Evidência: `docs/evidence/22-effective-impediments-and-automatic-repairs.md` e `docs/evidence/22-real-repair-*.json`.

## Comments

- 2026-11-16 (supervisor-authorized real run `q22-repair-v1`, branch `run/q22-repair` = `172b027` + pin #31): all phases exit 0; verdict
  computed offline from the saved results (no rerun) — 9/9 met. Ruleset relaxed only during the run and restored by the supervisor.

