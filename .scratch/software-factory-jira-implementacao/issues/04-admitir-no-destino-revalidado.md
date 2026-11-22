# 04: Admitir uma única vez no destino revalidado

**What to build:** Um Ticket elegível entra uma vez na fila para o único repositório autorizado na hora da admissão.

**Blocked by:** [02 — Atualizar o armazenamento sem interromper um Trabalho GitHub](02-atualizar-armazenamento.md); [03 — Explicar se um candidato Jira pode iniciar](03-avaliar-candidato.md)

Status: ready-for-agent

- [ ] Entre descoberta e criação, variar etiqueta, componentes, rotas e bloqueadores. Reler por ID e decidir com a configuração vigente imediatamente antes de criar. Só o destino único revalidado pode receber o Trabalho; recusa não cria nem despacha.
- [ ] Em um commit, persistir evidência, origem por (jira, siteId, issueId), destino, índice de ciclos e posição FIFO. Preservar pausa e proteção contra duplicata mesmo após releitura e reinício.
- [ ] Mudar a chave visível do Card atualiza apresentação em views, CLI, histórico e contexto do agente, sem mudar Trabalho ou recalcular destino. Não procurar substituto pela chave antiga nem fundir com Ticket GitHub de mesmo número ou título.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §3; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).
