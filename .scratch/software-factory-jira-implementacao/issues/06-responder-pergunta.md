# 06: Responder a uma pergunta e retomar o mesmo Trabalho

**What to build:** Uma pessoa responde no Card onde a fábrica publicou a pergunta. A resposta aceita retoma o Trabalho pela fila normal, mesmo se o controlador reiniciar.

**Blocked by:** [04 — Admitir uma única vez no destino revalidado](04-admitir-no-destino-revalidado.md); [05 — Explicar no Card por que o Trabalho não começou](05-explicar-impedimento.md)

Status: resolved

- [x] Publicar a pergunta de modo recuperável na origem persistida. Com POST incerto, reconciliar sem criar segunda pergunta; cabeçalho parecido não confirma publicação nem encerra a pergunta.
- [x] Validar ADF, audiência, Card e author.accountId observados no comentário comum da Platform. Mesmo em conta compartilhada, ignorar cabeçalho reservado, conversa sem prefixo inicial /factory e instrução já editada. Não projetar texto restrito para mais leitores.
- [x] Com uma pergunta aberta aceitar resposta livre prefixada; com zero orientar, com várias listar referências. Aceitar referência explícita só para pergunta aberta do mesmo Card. Comando conhecido incompleto não vira resposta.
- [x] Gravar recibo por site, issue e comentário e transição juntos; avançar cursor só sobre entradas processadas. Releitura após reinício não consome de novo nem desfaz resposta por edição posterior. A retomada não dispara Execução direta.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §4; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).
