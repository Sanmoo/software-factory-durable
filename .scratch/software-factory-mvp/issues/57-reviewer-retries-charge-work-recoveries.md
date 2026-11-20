# 57: Novas tentativas de revisor consomem as recuperações do Trabalho

**What to build:** no #126 do piloto 2, as tentativas do revisor Spec terminaram `cancelled` (stop `aborted`, `WORKER_QUALIFICATION_CLOSED`)
às 04:59:42, 05:02:54 e 05:11:39 UTC. Cada nova tentativa foi cobrada das recuperações operacionais do **Trabalho** (r2a2, r2a3, r3a2 → 3/3).
As rodadas fecharam `incomplete`, e o Standards ficou limpo. Quando o Builder sofreu `WORKER_PROVIDER_UNAVAILABLE` (05:15:10), não havia mais
recuperação: `RECOVERY_LIMIT_REACHED`, sem culpa do Builder. É preciso entender por que o revisor fecha (qualificação encerrada no meio da
rodada? provedor? memória do host com swap pesado) e separar o orçamento de novas tentativas dos revisores do orçamento de recuperação do
Trabalho.

**Blocked by:** —

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Causa de `WORKER_QUALIFICATION_CLOSED` nas sessões do revisor identificada e registrada.
- [ ] Nova tentativa de revisor tem limite próprio por rodada; esgotar esse limite não consome as recuperações do Trabalho.
- [ ] `WORKER_PROVIDER_UNAVAILABLE` transitório tem tratamento explícito (registrado), sem retry implícito sem limite.

## Comments

- Evidência: `/home/sanmoo/software-factory-test/pl2-pilot-evidence/findings.md` item 10; `history-126.json`; sessões
  `pl2/r/LhaThlhFT_GZJ5ap3ww-gQ/w-bt0Txp`, `w-BElqGM`, `w-GXTe42`.

## Answer

Implementado no branch `fix-57` (commits `dd8f0f8` e `2c9ddb2`).

**Causa de `WORKER_QUALIFICATION_CLOSED` nos revisores Spec: o orçamento próprio `reviewer-v1` (48 requisições) esgotou.** Não foi
qualificação fechada pelo Host no meio da rodada, nem provedor, nem memória do host. Evidência (só leitura):

- Nas três sessões (`pl2/r/LhaThlhFT_GZJ5ap3ww-gQ/w-bt0Txp`, `w-BElqGM`, `w-GXTe42`), contando desde o último prompt da rodada, há
  exatamente 49 mensagens de assistente: 48 com `stopReason: toolUse` e a 49ª `aborted`/`WORKER_QUALIFICATION_CLOSED`, vazia. A sessão é
  continuada entre rodadas e conta 28 (r1) e 39 (r2a3) requisições antes, por isso a contagem é feita a partir do prompt da tentativa.
  O arquivo de sessão de cada uma está completo: termina nessa mensagem, e o mtime bate com o `reviewer-ended`.
- A 49ª requisição foi recusada 4 a 5 ms depois do último `toolResult` (04:59:42.560→.565, 05:02:54.086→.090, 05:11:39.595→.599),
  ou seja, recusa síncrona antes de qualquer rede. É `qualifyOAuth` (`src/workers/oauth-qualification.ts`):
  `count > limits.requests` → `close()`. As 48 requisições anteriores respondiam a cada ~3 s. Ferramentas: 48 chamadas `read` na rodada,
  bem abaixo de 160. Contexto: arquivo de sessão de 0,67 a 0,88 MB, abaixo dos 2 MiB.
- Memória: `journalctl -k` não registra OOM entre 01:55 e 02:16 local. O swap pesado (pico de 3,9 GiB por VM) não aparece nas sessões.
- `history-126.json`: `reviewer-ended r2:spec:cancelled` 04:59:42.980, `r2:spec:a2` 05:02:54.346, `r3:spec` 05:11:39.777. Cada um é
  seguido por `budget-reserved`/`budget-consumed recoveries:spec-…-r2a2|r2a3|r3a2` e por `reviewer-retried …:after:REVIEWER_INTERRUPTED`.
  As tentativas r2a3 (39 requisições) e r3a2 concluíram `incomplete` dentro do mesmo orçamento: o modelo não é determinístico, e a nova
  tentativa tem valor.
- O worker só registrava `REVIEWER_INTERRUPTED`, então a causa não chegava ao Control.

**Mudanças.**

1. **Limite próprio por rodada** (`dd8f0f8`). Uma nova tentativa de revisor não reserva nem consome `recoveries` do Trabalho.
   - O limite é `reviewerRetriesPerRound = 2` por papel por rodada, com a tentativa 3 como última (decisão do operador de 2026-11-15).
     Fica em `src/contracts/index.ts`, é aplicado como `maxReviewerRetries` (`src/control/rules/review-recovery.ts`, `retryDecision` e
     `recordReviewerRetry`) e está registrado na release em `productionProfile.limits.reviewerRetriesPerRound`.
   - A espera segue as tentativas do papel na rodada: 5 s e depois 15 s.
   - O histórico registra `reviewer-retried r<N>:<role>:a<k>:after:<code>:wait:<s>s:retry:<n>/2`, sem `budget-*`. Tentativas novas
     gravam `charge: null`.
   - Sem reserva compartilhada, os dois papéis não são mais serializados.
   - Reservas gravadas por versões anteriores continuam sendo assentadas (consumidas ou liberadas) pelo código existente.
   - Esgotar o limite usa o desfecho existente `REVIEWER_RETRY_LIMIT` do ticket 51: `reviewer-not-retried …:REVIEWER_RETRY_LIMIT`, boot
     próprio parado, Execução assentada, `RECOVERY_BLOCKED` com as duas decisões do operador (nova rodada ou cancelar). Escolhi esse
     desfecho, e não concluir a rodada `incomplete`, porque a decisão de 2026-11-15/ticket 51 proíbe entregar ou aceitar uma rodada não
     verificada depois de duas novas tentativas. A única unidade de `recoveries` gasta nesse caminho é a da decisão explícita do operador,
     "nova rodada".
   - `REVIEWER_BUDGET_EXHAUSTED` entrou no conjunto de falhas retentáveis do revisor.
2. **Causa registrada** (`2c9ddb2`).
   - A qualificação marca `providerFailed()` quando uma requisição termina em erro sem abort do Host.
   - O parecer interrompido do revisor passa a dizer `cancelled`/`REVIEWER_BUDGET_EXHAUSTED` (contagem própria) ou
     `failure`/`WORKER_PROVIDER_UNAVAILABLE`. Antes era sempre `REVIEWER_INTERRUPTED`.
   - O Builder interrompido envia `providerUnavailable`, que o owner (`worker-launch.ts`) converte em `WORKER_PROVIDER_UNAVAILABLE`.
3. **`WORKER_PROVIDER_UNAVAILABLE` transitório: tratamento explícito e limitado.**
   - Não há retry dentro da sessão: `maxRetries: 0` na chamada nativa, retry do SDK desligado, `providerRetries: 0`/`sdkRetries: 0` na
     release.
   - Builder: `classifyInterruption` (`src/control/rules/recovery.ts`) trata como recuperação operacional limitada pelas `recoveries` do
     Trabalho (3 + concessões, espera 5/15/45 s), com `recovery-requested interrupted:<code>` e `budget-exhausted` →
     `RECOVERY_LIMIT_REACHED` no limite.
   - Revisor: nova tentativa dentro do limite por rodada acima.

**Achado à parte (não corrigido aqui, precisa de decisão).** O `WORKER_PROVIDER_UNAVAILABLE` do Builder do #126 às 05:15:10 não parece
ser falha de provedor. A sessão `w-Prr470` falhou na 126ª requisição, 6 ms depois de começar e com zero tokens. O `execution-ended
WORKER_EXECUTION_UNCERTAIN` (05:15:10.500) foi gravado antes da mensagem de erro (.502), e esse texto é só como a qualificação mascara
qualquer erro de stream.

O mesmo padrão aparece às 04:59:34. Esse caso é do #124, não do #125 como diz o item 10 dos findings: boot `e14dcc21`, Execução
`f9b74a0a`, `WORKER_EXECUTION_UNCERTAIN` às 04:59:34.942, falha na 127ª requisição com zero tokens.

A explicação mais provável é o limite de 128 tombstones do recebedor de segredos do owner (`createOwnerSecretReceiver`,
`src/platform/host/worker-secret-ipc.ts`: `seen.size >= 128` → `fail()` → revoke → `WORKER_EXECUTION_UNCERTAIN` em `worker-launch.ts`).
Cada requisição ao modelo lê a credencial e publica uma sincronização de segredo. O teste `secret-ipc` comprova que a 129ª sincronização
é recusada. Assim, um Builder morre perto da requisição 126–127, abaixo do orçamento `builder-v1` de 150.

Falta para confirmar: o owner não registra a contagem de sincronizações nem o motivo do `fail()`, e o número exato de sincronizações de
setup e de refresh por sessão não é observável nos artefatos. As duas falhas ficaram a uma sincronização uma da outra. Sugestão: ticket
próprio para alinhar esse limite ao orçamento do Builder, por exemplo com janela deslizante ou limite derivado de `builder-v1`, e para
registrar o motivo da recusa.

**Testes.**
- `test/control/review28-rules.test.ts`: regra sem contador, limite e esperas, `REVIEWER_BUDGET_EXHAUSTED` e `WORKER_PROVIDER_UNAVAILABLE`.
- `test/control/review28-flow.test.ts`: reprodução do piloto, com r1 a1/a2 e r2 a1 fechados pelo orçamento, `recoveries` 0/3 e
  histórico `retry:n/2`. Os casos existentes foram atualizados: nenhuma cobrança, `REVIEWER_RETRY_LIMIT` com 0 consumidas, nova rodada
  com espera de 5 s e 1 consumida.
- `test/control/review28-crash.test.ts`: corte na espera da nova tentativa sem reserva.
- `test/workers/session-closure-cause.test.ts`: causa na qualificação e no parecer.
- `test/entrypoints/reviewer-budget-release.test.ts`: registro na release.
- Oráculo `review28-qualification`: atualizado para `charge` nulo e 0 recuperações.
