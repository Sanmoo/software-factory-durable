# 51: Revisão incompleta falsa por leitura além do fim, e orçamento do revisor para mudanças médias

**What to build:** no piloto 35 nenhuma revisão real terminou verificada:

- **#124 (rodadas 1 e 4):** o revisor Spec leu o índice, o patch completo e os 17 arquivos alterados inteiros e concluiu `clean`, mas o Host
  rebaixou a rodada para incompleta (`SOURCE_UNREADABLE`) porque o revisor pediu leituras além do fim de arquivos já lidos até o fim ("Offset
  401 is beyond end of file (259 lines total)"). `src/workers/review.ts:111` conta toda leitura falha em `hostChecks.failedReads`. O Builder
  perguntou ao operador duas vezes como seguir.
- **#124 (rodada 4):** o Standards foi interrompido (`REVIEWER_INTERRUPTED`) com o limite de recovery do revisor.
- **#126 (3º ciclo):** o Standards concluiu `clean` em 12 requisições; o Spec esgotou o orçamento `reviewer-v1` de 24 requisições três vezes
  (`WORKER_QUALIFICATION_CLOSED`) e a Execução ficou retida com `REVIEWER_RETRY_LIMIT`, sem comando para continuar. O Ticket foi retirado do
  piloto. O ticket 43 já tinha mantido o orçamento em 24 depois de corrigir a releitura em reconciliações.

**Blocked by:** —

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Leitura além do fim de um arquivo que o revisor já leu até a última linha não é fonte ilegível; o motivo do Host diz o caminho e o
  offset quando a leitura falha de verdade (teste de regra com os casos do piloto).
- [x] Orçamento do revisor passa a 48 requisições, 160 ferramentas e 30 minutos por rodada, fixo e registrado na release.
- [x] `REVIEWER_RETRY_LIMIT` tem decisão explícita do operador, registrada: nova rodada ou cancelar. Não existe opção de aceitar uma rodada
  não verificada. A Execução não fica retida indefinidamente.
- [x] Testes offline cobrem a regra de leitura além do fim, o novo orçamento e as duas decisões do operador.

## Comments

- Evidência: `pl1-pilot-evidence/findings.md` itens 11 e 12; `artifacts/review/r1/index.json` do ambiente do #124; sessões dos revisores em
  `pl1/r/BJksTe-QQZ2bYkcgbfjdkg/`.
- A prova real (Ticket médio com as duas revisões verificadas) foi para o [54](54-pilot-2.md).
- Relacionados: [43](43-reconciliation-review-own-patch.md), [52](52-cancel-of-held-execution.md).
- 2026-11-19 triagem (operador, decisões registradas): 48 requisições / 160 ferramentas / 30 min fixos; sem opção de aceitar rodada não verificada; independente, primeiro da fila junto com o 50; prova real no 54.

## Answer

Implementado no branch `fix/51-review-eof-budget` (commits `06a0180`, `c501f26`, `0287d6b`, `bb03781`).

**Leitura além do fim.** `createReadObserver` (`src/workers/review.ts`) reconhece a recusa nativa do SDK
("Offset N is beyond end of file (M lines total)") e a decide no `summary`: se o caminho foi lido até a última linha (em qualquer ordem),
não é leitura falha; senão fica em `failedReads` como `READ_BEYOND_END`. Toda leitura falha registra `{ path, code, offset? }` (contrato
`ReviewOpinion.hostChecks.failedReads` e `opinionSchema` com `offset` opcional, registros antigos continuam válidos), e o resultado entregue
ao Builder (`deliveryPrompt`) traz `hostFailedReads` com caminho e offset quando há rebaixamento. Testes: `test/workers/read-observer.test.ts`
(casos do piloto, ordem invertida, janela truncada, arquivo nunca lido, falhas reais; `composeOpinion` conclui `clean` no caso do piloto e
`incomplete`/`SOURCE_UNREADABLE` com leitura falha real) e `test/control/review-rules.test.ts`.

**Orçamento.** `reviewerBudget` (`src/workers/oauth-qualification.ts`): 48 requisições, 160 ferramentas, `deadlineMs` 30 min; congelado,
sem configuração. A release registra `limits.modelBudget.reviewerV1 = { requests: 48, toolCalls: 160, requestTimeoutMinutes: 30 }`
(`src/entrypoints/release.ts`). Os 30 minutos são o campo de tempo que o orçamento já tinha: limitam cada requisição ao modelo (timeout de
requisição do SDK) dentro da tentativa do revisor. Não viraram um corte de relógio da rodada inteira, porque spec §4.4 e o ticket 19
(`test/workers/worker-clock-bound.test.ts`, `release-artifact`: a composição de produção não define deadline de worker) proíbem isso. Um
relógio de rodada de verdade exigiria mudar essa decisão. Testes: `test/workers/reviewer-budget.test.ts` (a 48ª requisição e a 160ª ferramenta
passam, a seguinte fecha com `WORKER_QUALIFICATION_CLOSED`) e `test/entrypoints/reviewer-budget-release.test.ts`.

**Decisão do operador em `REVIEWER_RETRY_LIMIT`.**
- A Execução não fica mais retida: logo depois do hold, o dispatcher para o boot próprio (Builder suspenso) e assenta a Execução como
  interrupção (`reconcileExecution`, gatilho novo `review-retry-limit`). O resultado é: fim `failure`/`REVIEWER_RETRY_LIMIT`, cessação
  confirmada, Vaga liberada, nada retentado automaticamente e `RECOVERY_BLOCKED` com `reviewerRetryLimitImpediment`, que nomeia as duas
  decisões. A reconciliação no boot de uma Execução retida por uma versão anterior chega ao mesmo estado. Se a parada não for confirmada,
  continua `held`/`RECOVERY_CESSATION_UNCONFIRMED` até o próximo boot, como antes.
- Nova rodada: `factory resume <work> --new-review-round --request-id <id>` (identidade obrigatória; nunca combinada com
  `--override-blocked-recovery`). Regra pura `newReviewRoundDecision` (`src/control/rules/recovery.ts`), com recusas `WORK_NOT_FOUND`,
  `WORK_NOT_CURRENT`, `WORK_CANCELLED`/`WORK_DELIVERED`, `WORK_CANCELLING`, `REVIEWER_RETRY_LIMIT_NOT_PENDING`, `EXECUTION_ACTIVE`,
  `CESSATION_NOT_CONFIRMED`, `SLOT_HELD`, `RECOVERY_NOT_BLOCKED` e `RECOVERY_ALREADY_PENDING`, e `already` com
  `NEW_REVIEW_ROUND_ALREADY_DECIDED`. Um commit durável (`acceptNewReviewRound` em `src/control/durable/cycles.ts`), deduplicado por
  request id, registra `execution.reviewRetryLimit = { decision: 'new-review-round', request_id, operator, at }`, grava a entrada de histórico
  `review-retry-limit-decided` (`<id>:new-review-round`), retira só esse `RECOVERY_BLOCKED` e abre UMA recuperação operacional (ticket 26:
  espera persistida, uma unidade de `recoveries`). O Builder da recuperação entrega de novo e a rodada nova segue as regras do ticket 28
  (o parecer válido pode ser carregado se o conteúdo não mudou).
- Cancelar: o `factory cancel <work>` existente registra a mesma decisão (`decision: 'cancel'` mais o histórico `<id>:cancel`). Como a
  Execução já cessou e a Vaga foi liberada, o cancelamento termina na hora, sem reinício do controlador. O caso residual (parada não
  confirmada) continua dependendo do [52](52-cancel-of-held-execution.md).
- Nenhuma entrada aceita a rodada não verificada. O schema da CLI e do Control aceita só `new_review_round: true`, e flags desconhecidas são
  `INVALID_ARGUMENTS`.
- Testes: `test/control/review-round51-rules.test.ts` (regra, impedimento, classificação), `test/control/review28-flow.test.ts` (Execução
  assentada sem ficar retida; nova rodada auditada e deduplicada → recuperação → Spec revisa na rodada 2 → `clean` → concluída; cancelamento
  registrado e cessado na hora, nova rodada recusada depois), `test/entrypoints/update-scope-cli.test.ts` (forma da CLI, replay e conflito).

A prova real está no [54](54-pilot-2.md).

