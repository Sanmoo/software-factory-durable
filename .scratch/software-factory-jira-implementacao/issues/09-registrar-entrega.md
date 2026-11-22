# 09: Registrar Entregue mesmo com o Jira indisponível

**What to build:** O merge no GitHub entrega o Trabalho. O Card recebe o vínculo atualizado e o aviso quando possível; não muda de status para compensar uma falha de comunicação.

**Blocked by:** [05 — Explicar no Card por que o Trabalho não começou](05-explicar-impedimento.md); [08 — Vincular o Card ao PR próprio, inclusive após abertura incerta](08-vincular-pr-proprio.md)

Status: ready-for-agent

- [ ] Confirmar merge do PR próprio na base autorizada: em um commit, registrar Entregue, retirada da fila, memória do ciclo e intenções independentes de atualizar o link e publicar o aviso com a URL do PR.
- [ ] Em armazenamento temporário real, verificar percurso normal e interrupção com Jira indisponível. Após reinício, varrer também Trabalhos entregues; nem saída da fila nem limpeza apagam pendências.
- [ ] Aplicar só o estado desejado mais recente ao mesmo globalId. Confirmar o link independentemente do comentário; simular POST aceito sem resposta e duas correspondências. Mostrar ambiguidade sem reenvio cego, reabertura ou segunda entrega.
- [ ] Sem merge confirmado, não declarar entrega. Em nenhum percurso escrever status, responsável ou resolução do Ticket.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §5; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).
