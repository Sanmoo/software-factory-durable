# 41 — Desbloquear explicitamente uma recuperação bloqueada: incremento local

Autoridade: [ticket 41](../../.scratch/software-factory-mvp/issues/41-explicit-unblock-of-blocked-recovery.md), spec §5.5 (conteúdo perdido
bloqueia), §4.4 (recuperação operacional), §11.3 (comandos). Base: branch do ticket 27 (`9f94307`, sobre a integração `c645639`); 29 ainda
não integrado. Branch `implement/software-factory-mvp-41`. **Somente local**: sem GitHub, VM, modelo ou credenciais; nenhuma receita real.

## Desenho

- **Referência bloqueada** (`execution.blockedRequest`): quando a reconciliação do 27 encontra o pedido `ask_user` preservado em Records mas
  não íntegro (parcial, múltiplo, ilegível, divergente, conflito de id), grava no mesmo commit do assentamento
  `reference = request:<token>:<achado>` (token = invocationId; se ausente/estranho, a referência Records; senão a Execução; forma única em `contracts`), o código, o `questionId`/referência Records quando conhecidos e `override: null`. O
  impedimento `RECOVERY_BLOCKED` desse caso traz o comando exato. A semântica de bloqueio do 27 não muda.
- **Comando**: `factory resume <work> --override-blocked-recovery <reference> --request-id <id>` (identidade obrigatória). Mesmo `resume` do
  25 (mesma deduplicação `requests`); sem a flag, `resume` continua só levantando suspensão de autorização (`NOTHING_TO_RESUME` num bloqueio).
- **Revalidação no commit** (regra pura `overrideBlockedRecoveryDecision`): Work atual e aberto; `RECOVERY_BLOCKED` presente; bloqueio é de
  pedido perdido; referência **exatamente** igual; sem atividade viva neste processo e Execução `ended`; cessação confirmada; Slot livre;
  sem cancelamento; nenhuma resolução POSITIVA daquele pedido (`positiveResolution`: a Pergunta do `questionId` bloqueado — ou, sem id, da
  mesma invocação — ligada à Execução, ou reconciliação posterior `recorded:<id>`); fim ainda é a falha com o mesmo achado; nenhuma
  recuperação já pendente (`RECOVERY_ALREADY_PENDING`, nunca sucesso ambíguo). Recusas são recibos duráveis `not-applied` com motivo.
- **Aceite** (um commit): decisão auditável em `blockedRequest.override` (request id, operador `local-administrator`, horário, referência,
  resultado do pedido de recovery), histórico `blocked-recovery-overridden` (`<request id>:<referência>`), remove **só** `RECOVERY_BLOCKED`,
  e abre UMA recuperação operacional pelo caminho normal do 26 (`applyRecoveryRequest`: espera persistida 5/15/45 s, unidade de `recoveries`
  consumida no início confirmado, esgotamento → `RECOVERY_LIMIT_REACHED` e `grant` explícito). Nada é lançado pelo comando; nada do pedido
  perdido é reconstruído (a instrução de recuperação só cita `OPERATIONAL_RECOVERY:<achado>`).
- **Queda**: commit único; repetição com a mesma identidade devolve o recibo gravado; outra identidade para a mesma referência é
  `already-satisfied` (`BLOCKED_RECOVERY_ALREADY_OVERRIDDEN`); mesma identidade com outro conteúdo é `REQUEST_ID_CONFLICT`. Sem retry implícito.

## Mapa AC → evidência

Níveis: **R** regras puras; **S** Control real + Pi Durable/SQLite + Records reais, dublês de Sandbox/Builder/GitHub; **C** CLI + owner +
socket reais.

| AC | Testes | Nível |
| --- | --- | --- |
| 1 comando só para `RECOVERY_BLOCKED` com a referência exata; outros recusados com motivo | `override41-rules` (todas as recusas), `override41-flow` AC1-AC4 (referência errada, Work desconhecido, `resume` simples), `update-scope-cli` (forma, `--request-id` obrigatório, recibo via socket) | R, S, C |
| 2 revalida cessação, atividade/Slot, resolução posterior; não inventa | `override41-rules` (cessação, Slot, atividade, Pergunta ligada, reconciliação posterior, fim mudado); `override41-flow` (nenhuma Pergunta criada; prompt sem o conteúdo perdido) | R, S |
| 3 decisão durável/auditável, visível em `show`/histórico | `override41-flow` (`show` traz `blockedRequest` + comando; `override` com operador/horário/referência/request id; um evento de histórico) | S |
| 4 volta à fila pela recuperação do 26, uma unidade; esgotado → impedimento usual + grant | `override41-flow` AC1-AC4 (espera 5 s, `interruption` OPERATIONAL_RECOVERY, `charge: recovery`, consumo 1) e AC4 (`recoveryLimit: 0` → `RECOVERY_LIMIT_REACHED`, nada inicia; `grant` → recovery) | S |
| 5 sem retries implícitos; queda → estado recuperável sem dupla aceitação | `override41-flow` AC5 (owner parado após o commit, novo owner, replay = mesmo recibo, 1 evento, 1 pedido); `override41-rules` (`already`) | S, R |

TDD: os testes novos foram vistos vermelhos (símbolos ausentes; depois `INVALID_COMMAND` pela forma real `builder-<uuid>` do invocationId)
e verdes depois. Corte SIGKILL real não acrescentado: o aceite é um único commit Pi Durable (mecanismo já provado por `recovery-crash`).

## Correções da revisão independente (dd2e8ed)

| Achado | Correção | Teste |
| --- | --- | --- |
| MED reconciliação posterior não-bloqueada tornava o override impossível | resolução só positiva (`positiveResolution`) | `override41-flow` "review MED 1" (×2: absent aceita; recorded recusa), `override41-rules` |
| MED reassentar Execução já sobrescrita re-bloqueava (genérico) | `settleInterruption` idempotente: bloqueio sobrescrito → `operational-recovery`, recovery pendente mantida | `override41-flow` "review MED 2" (vermelho por mutação) |
| LOW resolução por qualquer Pergunta da Execução; cancelamento; `blockedRequest` gravado sem ser o fim; `already-open` ambíguo; regex duplicada; token ausente | ligada a `questionId`/invocação; `WORK_CANCELLING`; grava só quando o fim é o bloqueio; `RECOVERY_ALREADY_PENDING`; `blockedReferencePattern` em `contracts` (Control, socket, CLI); `blockedRequestToken` com fallback | `override41-rules`, `update-scope-cli` |

## Pendente no rebase sobre o 29

A visão de inspeção do 29 (`show`/`history` correlacionados) existe só no branch dele. Aqui a decisão aparece no `show` atual
(`execution.blockedRequest`, `limits.actions`, `history`). No rebase: expor `blockedRequest` (referência, achado, decisão) na visão de
Execução do 29 e o evento `blocked-recovery-overridden` no `history` correlacionado (request id → Execução seguinte), com teste de inspeção.
