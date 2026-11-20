# 59: Limite de sincronização de segredo abaixo do orçamento do Builder

**What to build:** cada requisição ao modelo chama `getAuth` (`src/workers/factory-oauth.ts`), que envia o token ao dono por
`acknowledgeSecrets`. O receptor do dono (`createOwnerSecretReceiver`, `src/platform/host/worker-secret-ipc.ts`) encerra o canal quando
`seen.size >= 128`, e a Execução termina `WORKER_EXECUTION_UNCERTAIN`. O orçamento do Builder é de 150 requisições (`builderBudgetV1`), com
máximo por repositório maior. No piloto 2, o Builder do #126 morreu na requisição 126 (05:15:10, sessão `w-Prr470`) e o do #124 na 127
(04:59:34), ambos com zero tokens, 6 ms após o início, mascarados como `WORKER_PROVIDER_UNAVAILABLE`. O dono não registra a contagem nem por
que o canal falhou.

**Blocked by:** —

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Um Builder dentro do seu orçamento máximo (requisições e renovações de token) nunca esgota a sincronização de segredos; o limite
  continua existindo (sem crescimento sem limite) e é derivado do orçamento, não um número solto.
- [ ] Reenviar um segredo já registrado não consome o limite (ou não é reenviado), mantendo a proteção contra replay de id.
- [ ] Quando o dono encerra o canal, o motivo (fechado, sem prefixo de valores) fica registrado e chega ao Control como causa própria, não como
  falha do provedor.
- [ ] Teste: sessão com mais requisições que o antigo limite de 128 continua; excesso real do novo limite é recusado com o motivo registrado.

## Comments

- Achado pelo ticket 57 (`## Answer`); evidência em `/home/sanmoo/software-factory-test/pl2-pilot-evidence/findings.md` item 10.

## Answer

Implementado no branch `fix-59`.

**Desenho.**

1. **O worker não reenvia valor já confirmado** (`createSecretPublisher`, `src/platform/host/worker-secret-ipc.ts`).
   - O publicador guarda, só em memória da sessão, os valores que o dono desta sessão já confirmou (ACK). Uma chamada cujos valores já
     foram todos confirmados retorna sem enviar nada, depois de checar que o canal continua ativo; um canal falho continua negando, mesmo
     para um valor conhecido.
   - Uma chamada com valores novos envia apenas esses. A entrada inteira continua validada como antes: formato, até 3 valores e tamanho
     serializado.
   - Com isso, quem gasta sincronização é a leitura de setup e a renovação de token (no máximo uma por requisição), não a requisição que
     reusa o mesmo token. No piloto 2, cada requisição reenviava o mesmo `apiKey`.
2. **O limite do dono vem do orçamento da sessão** (`secretSyncLimit`, `sessionRequestBudget` em `src/platform/host/worker-launch.ts`).
   - `limite = requisições máximas da sessão + secretSyncSetupMargin (16)`. As requisições são as da mesma política do Host que o worker
     transforma em limites (`budgetFor`): o ajuste do repositório para o Builder (até 300), `builder-v1` (150), `reviewer-v1` (48) ou a
     qualificação (2).
   - Os valores ficam em `src/contracts/index.ts`: `builderBudgetV1`, mais os novos `reviewerBudgetV1` e `qualificationRequestsV1`.
     `oauth-qualification.ts` e o registro da release (`productionProfile.limits.modelBudget.reviewerV1`) passam a ler desses valores, e o
     conteúdo publicado não muda.
   - Resultados: Builder 166, Builder no máximo do repositório 316, revisor 64, qualificação 18. O limite é calculado antes de qualquer
     efeito do launch.
   - A proteção contra replay continua: os tombstones por id ficam limitados pelo mesmo limite.
3. **O motivo do encerramento é registrado** (`secretChannelFailures`), num conjunto fechado: `schema`, `context`, `replay`, `limit`, `busy`,
   `not-started`, `register`, `timeout`, `send`, `disconnect`, `abort`, `closed`. Nenhum valor, prefixo ou texto de exceção entra nele.
   - O receptor passa o motivo para `revoke(reason)`.
   - `secretChannelEndCode` transforma o motivo no código de fim da Execução. Uma recusa vira `WORKER_SECRET_SYNC_<MOTIVO>`, por exemplo
     `WORKER_SECRET_SYNC_LIMIT`. Perda de canal ou de lifetime (`disconnect`, `abort`) e o fechamento normal do próprio dono (`closed`)
     continuam `WORKER_EXECUTION_UNCERTAIN`.
   - O código chega ao Control pelo `worker-completed` e aparece em `execution-ended`. Nunca é `WORKER_PROVIDER_UNAVAILABLE`.
   - Classificação no Control (`recovery.ts` e `review-recovery.ts`): `WORKER_SECRET_SYNC_TIMEOUT` e `_SEND` (ACK do dono não entregue) são
     transitórios, como a perda de canal. Os demais bloqueiam com `RECOVERY_BLOCKED` e trazem o código no detalhe, porque com a deduplicação
     um limite excedido, um replay ou um esquema inválido indicam anomalia, não falha transitória.

**Fora do escopo, observado.**
- O registro de segredos do `Records` do dono aceita no máximo 128 valores distintos por boot. Valores repetidos não contam. Com a
  deduplicação, cada renovação acrescenta de 2 a 3 valores, então só um boot com dezenas de renovações chega nesse teto. Se chegar, o
  motivo registrado é `register` (`WORKER_SECRET_SYNC_REGISTER`, que bloqueia).
- Uma falha só do lado do worker (o publicador expira sem o dono falhar) ainda não ganhou causa própria. Neste ticket, o dono era quem
  encerrava primeiro.

**Testes.**
- `test/workers/secret-sync-bound.test.ts` (novo):
  - limite derivado (Builder, máximo do repositório, revisor e qualificação, conferidos com `budgetFor`);
  - 300 requisições com o token inalterado usam uma única sincronização;
  - só os valores novos são enviados;
  - uma renovação por requisição cabe no limite, e a sincronização seguinte é recusada com `limit`;
  - um valor conhecido é negado depois que o canal falha;
  - mapeamento motivo→código.
- `test/workers/secret-ipc.test.ts`, alterações conscientes:
  - os receptores recebem o limite derivado do contexto `spec` (64) no lugar do 128 fixo;
  - o teste de overflow agora confirma `limit` sincronizações e recusa a seguinte (antes, 128 e a 129ª), com motivo `limit`;
  - os testes de modo agora conferem também o motivo de cada falha: `not-started`, `context`, `schema`, `replay`, `register`, `send`,
    `abort`, `timeout`, `busy`;
  - nenhuma outra asserção mudou.
- `test/workers/question-ipc.test.ts`: o novo parâmetro do limite.
- `test/control/recovery-rules.test.ts` e `test/control/review28-rules.test.ts`: classificação dos novos códigos.
