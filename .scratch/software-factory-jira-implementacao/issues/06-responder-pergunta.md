# 06: Responder a uma pergunta e retomar o mesmo Trabalho

**What to build:** Uma pessoa responde no Card onde a fábrica publicou a pergunta. A resposta aceita retoma o Trabalho pela fila normal, mesmo se o controlador reiniciar.

**Blocked by:** [04 — Admitir uma única vez no destino revalidado](04-admitir-no-destino-revalidado.md); [05 — Explicar no Card por que o Trabalho não começou](05-explicar-impedimento.md)

Status: resolved

- [x] Publicar a pergunta de modo recuperável na origem persistida. Com POST incerto, reconciliar sem criar segunda pergunta; cabeçalho parecido não confirma publicação nem encerra a pergunta.
- [x] Validar ADF, audiência, Card e author.accountId observados no comentário comum da Platform. Mesmo em conta compartilhada, ignorar cabeçalho reservado, conversa sem prefixo inicial /factory e instrução já editada. Não projetar texto restrito para mais leitores.
- [x] Com uma pergunta aberta aceitar resposta livre prefixada; com zero orientar, com várias listar referências. Aceitar referência explícita só para pergunta aberta do mesmo Card. Comando conhecido incompleto não vira resposta.
- [x] Gravar recibo por site, issue e comentário e transição juntos; avançar cursor só sobre entradas processadas. Releitura após reinício não consome de novo nem desfaz resposta por edição posterior. A retomada não dispara Execução direta.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §4; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).

## Answer

Uma pergunta de um Trabalho Jira ganha uma referência curta da instalação (`Q-n`, nunca reutilizada) e um efeito de comentário Jira recuperável (o mecanismo do ticket 05) no Card de origem persistido. A referência, o destino e o conteúdo são gravados antes do POST (`prepareJiraQuestions`, `src/control/durable/jira-questions.ts`), e o texto da pendência passa a usar a sintaxe do Card. Se o POST for incerto, os comentários são reconciliados por conta, cabeçalho e conteúdo: uma cópia confirma, uma leitura completa sem cópia reenvia com a mesma referência e um cabeçalho parecido de outra conta não confirma nem encerra a pergunta. O desk de comentários compõe um dono por tipo de propósito (`composeJiraCommentOwners`: impedimento, pergunta, orientação), e o 09 acrescenta a entrega ali. O estado da publicação é espelhado na pergunta.
A leitura de entradas (`src/control/durable/jira-inputs.ts`) lê todas as páginas de comentários do Card ou não lê nenhuma, ordenadas por (created, id) e depois do cursor. Cada comentário é ingerido em um commit: recibo por `jira-comment-<site>-<issue>-<comment>` e transição juntos. A releitura devolve o recibo gravado, e uma edição posterior não desfaz nada. O cursor avança só depois do processamento. As regras puras (`src/control/rules/jira-conversation.ts`) são estas:
- O cabeçalho reservado é ignorado mesmo com `/factory`, e texto sem o prefixo inicial é conversa.
- `/factory <texto>` responde só quando há uma única pergunta aberta; com zero há orientação, com várias a orientação lista as referências.
- `q17:` e `answer Q-17` exigem uma pergunta aberta deste Card.
- Um comando conhecido incompleto ou não suportado (incluindo `cancel`, que fica para o 07) gera orientação.
- Um comentário já editado na primeira observação pede um novo comentário.
- Um comentário restrito nunca é aplicado nem citado.
Não há lista de operadores, e a conta da fábrica, que pode ser compartilhada, não é recusada. A resposta aceita remove só a pendência da pergunta, e o Trabalho é retomado pela fila. O comportamento GitHub não mudou.

Commits: `5d969688` (feature), `8cab9367` (merge da integração). Gate: `npm run test:ci` PASS (2254 testes, 0 falhas).
