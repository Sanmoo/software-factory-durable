# 07: Cancelar somente o Trabalho daquele Card

**What to build:** Uma pessoa com permissão Jira de comentar consegue cancelar o Trabalho do próprio Card sem precisar ser operadora GitHub.

**Blocked by:** [06 — Responder a uma pergunta e retomar o mesmo Trabalho](06-responder-pergunta.md)

Status: resolved

- [x] Aceitar a sintaxe exata /factory cancel na entrada validada do Card de origem. Reentregar após reinício resulta em um cancelamento e um recibo, não duas transições.
- [x] Texto livre, cabeçalho automático, instrução editada e alegação de autoria no texto não autorizam cancelamento. Comando conhecido incompleto orienta sem cancelar nem responder a pergunta aberta.
- [x] Uma referência a outro Card não amplia o alcance; não aceitar comandos administrativos, globais ou destrutivos da instalação.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §4; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).

## Answer

`/factory cancel` (exact; the word in any case, surrounding whitespace ignored) on the origin Card cancels the Work of THAT Card with the same
transition as the local `cancel` (`cancelIn`, extracted from `acceptCancel` in `src/control/durable/cycles.ts`), in one commit with the request
identity `jira-comment-<site>-<issue>-<comment>`, the cancel receipt (`operation: 'cancel'`, plus `reply`) and the intent of a reply
`[Software Factory · Cancelamento R-…]` on the Card. History `cancel-requested` has origin `jira-comment`; the impediment names the comment and
the Jira account. After the commit the controller withdraws credentials and requests the stop exactly as for the local command. A re-read
(restart, lost cursor) replays the stored receipt: one transition, one request document, one reply.

Nothing else cancels: `/factory cancel PAG-43`, `/factory cancel please`, `/factory cancelar` (spelling is never corrected) get the
`JIRA_CANCEL_INVALID` guidance and are never an answer; free text (`/factory acho melhor cancelar`) follows the answer rules; prose, the
reserved header, edited and restricted comments and claims of authorship grant nothing (rules of 06). Pause, unpause, forget, cleanup, grant,
new, reopen, resume, repair stay `JIRA_COMMAND_UNSUPPORTED`. The Jira comment permission is the whole authorization (no GitHub operator list).

The input desk now also reads the Cards of open Jira Works that never ran (so the command works before the first Execution), at most 8 per
pass, least recently read first.

Tests: `test/control/jira-conversation-rules.test.ts` (parser/decision/reply text), `test/control/jira-cancel-flow.test.ts` (flow: only that
Card's Work, before any Execution, guidance cases, restart re-delivery, replay of the same comment; bounded rotation). Gate `npm run test:ci`.

Commits: see branch `implement/software-factory-jira-07` (feat commit "cancel the Work of the origin Card with an exact /factory cancel comment").
