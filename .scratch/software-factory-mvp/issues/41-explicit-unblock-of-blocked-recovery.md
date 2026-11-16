# 41: Desbloquear explicitamente uma recuperação bloqueada

**What to build:** Quando a recuperação de um Work fica em `RECOVERY_BLOCKED` porque um pedido do Builder preservado nos Records está parcial, múltiplo ou ilegível (ticket 27), hoje não existe comando que libere o Work: só cancelar e abrir um novo ciclo. O operador passa a poder decidir explicitamente seguir em frente, com a decisão registrada e revalidada, sem que a Factory invente o conteúdo do pedido perdido.

**Blocked by:** [27: Reconciliar efeitos externos nos cortes de crash](27-external-effect-crash-reconciliation.md), [29: Inspecionar toda a cadeia e o consumo pela CLI](29-correlated-cli-observability-and-usage.md)

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] `factory resume <work> --override-blocked-recovery <reference> --request-id <id>` (ou forma equivalente no comando `resume` do ticket 25) aceita a decisão somente para um Work em `RECOVERY_BLOCKED` cuja referência ilegível é exatamente a informada; qualquer outra referência, estado ou Work é recusado com motivo.
  Evidência: regras `test/control/override41-rules.test.ts` (todas as recusas com motivo); fluxo S `test/control/override41-flow.test.ts` "AC1-AC4" (referência errada, Work desconhecido, `resume` simples recusados); composição CLI+owner+socket reais `test/entrypoints/update-scope-cli.test.ts` (forma, `--request-id` obrigatório, recibo e replay). Referência `request:<invocação>:<achado>`, forma única em `src/contracts/index.ts`.
- [x] Antes de aceitar, revalida cessação confirmada, ausência de atividade e de Slot retido, e que nenhuma leitura completa posterior dos Records já resolveu o pedido; aceitar não inventa nem reconstrói o pedido perdido.
  Evidência: `override41-rules` (cessação, atividade, Slot, cancelamento, resolução positiva via `positiveResolution`, recovery já pendente); `override41-flow` "review MED 1" ×2 (reconciliação posterior `absent` aceita; `recorded:<id>` recusa) e AC1-AC4 (nenhuma Pergunta criada; instrução de recuperação sem o conteúdo perdido). Nível R + S.
- [x] A decisão é durável e auditável (operador, horário, referência sobrescrita, request id deduplicado) e aparece na inspecionabilidade do ticket 29 (`show`, `history`).
  Evidência: `override41-flow` AC1-AC4 (`blockedRequest.override` com request id, operador `local-administrator`, horário, referência; um evento `blocked-recovery-overridden`) e "AC3 (ticket 29 inspection)" (`show` → `chain.executions[].blockedRequest`; `history --execution` com `links.executionId`). Nível S.
- [x] Ao aceitar, o Work volta à fila pela recuperação operacional normal do ticket 26, consumindo uma unidade de `recoveries`; orçamento esgotado mostra o impedimento usual e exige concessão explícita.
  Evidência: `override41-flow` AC1-AC4 (espera persistida 5 s, `interruption` OPERATIONAL_RECOVERY, `charge: recovery`, 1 unidade consumida) e AC4 (`recoveryLimit: 0` → `RECOVERY_LIMIT_REACHED`, nada inicia; `grant` → recovery). Nível S.
- [x] Sem novas tentativas implícitas; queda durante o comando resulta em estado recuperável sem dupla aceitação.
  Evidência: `override41-flow` AC5 (owner parado após o commit, novo owner, replay = mesmo recibo, 1 evento, 1 pedido) e "review MED 2" (reassentar uma Execução sobrescrita não re-bloqueia; vista vermelha por mutação); `override41-rules` (`already`). Nível S + R; sem SIGKILL real (o aceite é um único commit Pi Durable, mecanismo já provado por `recovery-crash`).

## Referências e validação

- Lacuna registrada nos tickets 27, 29 e 30 (decisão do operador em 2026-11-15).
- Spec: recuperação operacional, pedidos preservados, decisões explícitas do operador.

## Autorização e limites

Somente local; sem GitHub, VM ou modelo. Não altera a semântica de bloqueio do ticket 27, só acrescenta a saída explícita.

## Answer

Resolvido em 2026-11-16 ([evidência](../../../docs/evidence/41-explicit-unblock-of-blocked-recovery.md); integrado em `20b6541`). Um Work em
`RECOVERY_BLOCKED` por pedido do Builder perdido (ticket 27) tem saída explícita:
`factory resume <work> --override-blocked-recovery <referência> --request-id <id>`. A referência (`request:<invocação>:<achado>`) é gravada
no assentamento e aparece em `show`. O aceite é um commit deduplicado: revalida tudo, registra a decisão auditável (inspeção do 29:
cadeia do `show` e `history --execution`), remove só aquele bloqueio e abre UMA recuperação operacional pelo caminho do 26. O conteúdo
perdido nunca é reconstruído. Correções da revisão: resolução só positiva; reassentamento idempotente; recusa de cancelamento e de recovery
já pendente.

Limites honestos: provas em regras, fluxos S (Control + Pi Durable/SQLite + Records reais, Sandbox/Builder/GitHub dublês) e CLI/socket
reais; **nenhum ensaio real executado nem necessário** pelo ticket ("Somente local; sem GitHub, VM ou modelo"): o comando não toca fronteira
externa, e a recuperação que ele abre segue o caminho do 26, já qualificado em real. Não provado: um bloqueio produzido por um registro
realmente corrompido numa VM real seguido do override (o bloqueio em si é do 27, provado localmente em `effects27-flow` MED 2). A releitura
de Records na hora do comando não é feita: "já resolvido" vem só do estado durável.
