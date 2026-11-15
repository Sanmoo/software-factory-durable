# 26: Recuperar Execuções sem adotar sobreviventes

**What to build:** Após crash ou parada, a Factory descobre o que realmente iniciou, cessa sobreviventes próprios e retoma somente com autoridade/capacidade comprovadas. Contexto e limites persistem sem adotar processo antigo nem repetir ferramenta cegamente.

**Blocked by:** [11: Continuar contexto e incorporar apenas mudanças de escopo autorizadas](11-context-continuation-and-authorized-scope.md); [19: Aplicar limites, timeout opcional e concessões explícitas](19-budgets-optional-timeout-and-grants.md)

**Status:** resolved

## Acceptance criteria

- [x] Boot exclusivo valida compatibilidade e abre Pi Durable com barreira fechada; inventaria reservas, recibos, recursos e processos próprios, inclusive cache em preparo e adapter anterior morto.
- [x] Sobreviventes são encerrados, não adotados; observação host comprova cessação de workers/VMM/subprocessos capazes de atuar antes de substituto, sem usar PID isolado, abort ou token como prova.
- [x] Recibo completo sincronizado confirma início e consumo único mesmo sem notificação; ausência só prova não início com storage íntegro/barreira e ausência ou cessação de atividade, senão mantém reserva.
- [x] Reconciliação atual incorpora evidências antigas explicitamente; mensagem de abertura/Execução/boot antigo não altera reserva vigente e replay de task não autoriza spawn.
- [x] Incerteza local bloqueia Trabalho/capacidade afetados sem impedir independentes seguros; incerteza global de autoridade/capacidade mantém despacho fechado, sem ignorar recursos desconhecidos.
- [x] Falhas operacionais recuperáveis voltam à fila sob contagem separada e espera persistida de 5/15/45 segundos ou maior indicada pelo serviço; eventos repetidos não antecipam prazo nem renovam orçamento.
- [x] Parada administrativa só é limpa após cessação e persistência comprovadas, permitindo continuação sem recovery só pela parada; crash/forçada/incerta preserva tratamento de falha e evidência temporal.
- [x] Provas reais com cortes em reserva/spawn/recibo/ferramenta/cache/processos demonstram ausência de escritor/consumo duplicado e preservação de contexto; perda de saída exige inspeção, não replay arbitrário.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.4, 4.4, 5.2, 5.3, 5.4, 5.7, 11.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-01, V-07, V-12, V-13 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-15: reconciliação de boot com a barreira fechada sobre um inventário do host (ambientes atribuídos, caches Git, recursos desconhecidos); sobreviventes parados pelo host (Sandbox.stop/observe, nunca PID/abort/token) antes de qualquer substituto; início estabelecido por recibo completo descoberto em Records (consumo único) ou não início comprovado só após cessação; incerteza local retém só o Trabalho afetado e a global mantém o despacho fechado; recovery operacional com contagem própria e esperas persistidas 5/15/45 s; parada administrativa limpa só após cessação/persistência, com continuação sem cobrança; preparo em voo nunca presumido cessado; caches interrompidos reconciliados sem reparo; Execução interrompida no meio de rodada de revisão sem adoção. Gate local 1073/0 (171 arquivos, 10 skip). Ensaio real: v1 com defeito de oráculo (8/9) e v2 aprovado 10/10 com cortes SIGKILL reais em ferramenta/reserva/spawn/recibo e parada limpa final; decisão do operador: manter a captura incremental como está. Evidência: `docs/evidence/26-execution-recovery-without-survivor-adoption.md`.
