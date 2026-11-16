# 41: Desbloquear explicitamente uma recuperação bloqueada

**What to build:** Quando a recuperação de um Work fica em `RECOVERY_BLOCKED` porque um pedido do Builder preservado nos Records está parcial, múltiplo ou ilegível (ticket 27), hoje não existe comando que libere o Work: só cancelar e abrir um novo ciclo. O operador passa a poder decidir explicitamente seguir em frente, com a decisão registrada e revalidada, sem que a Factory invente o conteúdo do pedido perdido.

**Blocked by:** [27: Reconciliar efeitos externos nos cortes de crash](27-external-effect-crash-reconciliation.md), [29: Inspecionar toda a cadeia e o consumo pela CLI](29-correlated-cli-observability-and-usage.md)

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `factory resume <work> --override-blocked-recovery <reference> --request-id <id>` (ou forma equivalente no comando `resume` do ticket 25) aceita a decisão somente para um Work em `RECOVERY_BLOCKED` cuja referência ilegível é exatamente a informada; qualquer outra referência, estado ou Work é recusado com motivo.
- [ ] Antes de aceitar, revalida cessação confirmada, ausência de atividade e de Slot retido, e que nenhuma leitura completa posterior dos Records já resolveu o pedido; aceitar não inventa nem reconstrói o pedido perdido.
- [ ] A decisão é durável e auditável (operador, horário, referência sobrescrita, request id deduplicado) e aparece na inspecionabilidade do ticket 29 (`show`, `history`).
- [ ] Ao aceitar, o Work volta à fila pela recuperação operacional normal do ticket 26, consumindo uma unidade de `recoveries`; orçamento esgotado mostra o impedimento usual e exige concessão explícita.
- [ ] Sem novas tentativas implícitas; queda durante o comando resulta em estado recuperável sem dupla aceitação.

## Referências e validação

- Lacuna registrada nos tickets 27, 29 e 30 (decisão do operador em 2026-11-15).
- Spec: recuperação operacional, pedidos preservados, decisões explícitas do operador.

## Autorização e limites

Somente local; sem GitHub, VM ou modelo. Não altera a semântica de bloqueio do ticket 27, só acrescenta a saída explícita.
