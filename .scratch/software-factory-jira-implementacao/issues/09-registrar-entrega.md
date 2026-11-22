# 09: Registrar Entregue mesmo com o Jira indisponível

**What to build:** O merge no GitHub entrega o Trabalho. O Card recebe o vínculo atualizado e o aviso quando possível; não muda de status para compensar uma falha de comunicação.

**Blocked by:** [05 — Explicar no Card por que o Trabalho não começou](05-explicar-impedimento.md); [08 — Vincular o Card ao PR próprio, inclusive após abertura incerta](08-vincular-pr-proprio.md)

Status: resolved

- [x] Confirmar merge do PR próprio na base autorizada: em um commit, registrar Entregue, retirada da fila, memória do ciclo e intenções independentes de atualizar o link e publicar o aviso com a URL do PR.
- [x] Em armazenamento temporário real, verificar percurso normal e interrupção com Jira indisponível. Após reinício, varrer também Trabalhos entregues; nem saída da fila nem limpeza apagam pendências.
- [x] Aplicar só o estado desejado mais recente ao mesmo globalId. Confirmar o link independentemente do comentário; simular POST aceito sem resposta e duas correspondências. Mostrar ambiguidade sem reenvio cego, reabertura ou segunda entrega.
- [x] Sem merge confirmado, não declarar entrega. Em nenhum percurso escrever status, responsável ou resolução do Ticket.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §5; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).

## Answer

O merge confirmado no GitHub entrega o Trabalho Jira sem depender do Jira. `recordMergeObservation` grava, no mesmo commit de Entregue
(saída da fila, memória do ciclo, início da limpeza), a intenção do link `delivered` (mesmo `globalId`, título `Trabalho T-n · Entregue`) e a
intenção do aviso `delivery:<work_id>` com o texto `[Software Factory · Entrega T-n] O PR foi integrado a <base>: <URL>`
(`src/control/durable/jira-deliveries.ts`). O link segue pela mesa de links do ticket 08 (estado desejado mais recente); o aviso pela mesa de
comentários recuperável do ticket 05, com um dono `delivery` composto aos donos do ticket 06 na passada da fonte Jira. Resposta perdida do POST
é reconciliada pela listagem (um POST); duas cópias deixam a pendência `JIRA_COMMENT_MULTIPLE` visível, sem reenvio, sem reabrir nem nova
entrega. Fechado sem merge só muda o título do link. Pendências de link/aviso protegem o Trabalho contra `forget`
(`EFFECT_UNSETTLED:jira-link|jira-notice`); limpeza de branch/ambiente e retenção de detalhes seguem independentes. Nenhum caminho escreve
status, responsável ou resolução (o double registra qualquer chamada não modelada).

Testes: `test/control/jira-delivery-flow.test.ts` (percurso normal; Jira indisponível no merge + reinício + resposta perdida; duas cópias;
fechado sem merge), `jira-notice-rules.test.ts`, `forget-rules.test.ts`. `npm run test:ci` verde.

Commits: c1283fcb (feature), merge de `integration/software-factory-jira` (ticket 06) na branch.
