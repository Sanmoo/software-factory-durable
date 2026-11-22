# 04: Admitir uma única vez no destino revalidado

**What to build:** Um Ticket elegível entra uma vez na fila para o único repositório autorizado na hora da admissão.

**Blocked by:** [02 — Atualizar o armazenamento sem interromper um Trabalho GitHub](02-atualizar-armazenamento.md); [03 — Explicar se um candidato Jira pode iniciar](03-avaliar-candidato.md)

Status: resolved

- [x] Entre descoberta e criação, variar etiqueta, componentes, rotas e bloqueadores. Reler por ID e decidir com a configuração vigente imediatamente antes de criar. Só o destino único revalidado pode receber o Trabalho; recusa não cria nem despacha.
- [x] Em um commit, persistir evidência, origem por (jira, siteId, issueId), destino, índice de ciclos e posição FIFO. Preservar pausa e proteção contra duplicata mesmo após releitura e reinício.
- [x] Mudar a chave visível do Card atualiza apresentação em views, CLI, histórico e contexto do agente, sem mudar Trabalho ou recalcular destino. Não procurar substituto pela chave antiga nem fundir com Ticket GitHub de mesmo número ou título.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §3; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).

## Answer

Implementado no branch `implement/software-factory-jira-04` (descoberta Jira segue desligada em produção: `jiraDiscoveryReleased`, ticket 10).

- **Admissão revalidada.** Cada fonte Jira tem sua rodada no poller, depois dos repositórios GitHub: listagem JQL (só com `discover: true`) e, por
  Card, índice → pausa → releitura por ID com a configuração vigente (`evaluateJiraTicket`, ticket 03) → `admitTicket`. Só `eligible` cria
  Trabalho, no destino único revalidado; recusa não cria, não despacha e não escreve no Jira (os avisos de impedimento são os do ticket 05,
  chamados uma vez por rodada depois das admissões).
- **Um commit.** Evidência `jira-rest` (site, projeto, etiqueta, rota com componentes, bloqueadores visíveis), `ticket` `(jira, siteId, issueId)`
  com chave/URL de apresentação, destino com `repositoryId` observado pelo GitHub, índice, memória de ciclos, sequência FIFO e a avaliação
  de bloqueadores da mesma releitura (sem `DEPENDENCIES_NOT_EVALUATED`). Pausa e duplicata seguem verificadas dentro do commit; repoll e
  reinício não duplicam.
- **Chave visível.** `PAG-42 → FIN-18` atualiza `ticket.key/url` com evento `ticket-presentation-changed` (views, `show`, histórico, prompt
  seguinte); Trabalho, destino e chave de índice não mudam; leituras só por ID; Ticket GitHub de mesmo número fica em outro Trabalho.
- **Encaminhamento por origem.** Rodada da fonte reavalia os bloqueadores dos Trabalhos Jira pendentes (`attemptKey`: GitHub = repositório de
  destino, Jira = fonte de origem); despacho revalida etiqueta e bloqueadores no Card; o cycle desk registra retirada da etiqueta.
- **Despacho.** Branch `factory/jira-<issueId>-<work8>`; o controlador lê resumo e descrição (ADF → texto, limitado) e entrega no primeiro
  prompt (o agente não recebe cliente nem token Jira); pack `factory-skills-v12` preserva essa seção em vez de `gh issue view` e usa a
  referência ao Card em vez de `Closes #N`; prompt de publicação sem closing keyword; leitura de refs por correlação só de branch. A
  correlação do PR próprio de um Trabalho Jira é a costura explícita do ticket 08 (`PUBLICATION_CORRELATION_NOT_AVAILABLE`: nada lido,
  vinculado ou reaberto).

Commits: `cd7afa9d` (admissão, encaminhamento, despacho, pack v12), `99eca685` (`lastPolled` pela fonte de origem), `3c6dde65` (integração
dos avisos do ticket 05), merge `68d63945` de `integration/software-factory-jira`. Gate: `npm run test:ci` PASS após o merge (2231 testes, 0 falhas).
