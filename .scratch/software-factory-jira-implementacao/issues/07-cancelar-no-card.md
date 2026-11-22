# 07: Cancelar somente o Trabalho daquele Card

**What to build:** Uma pessoa com permissão Jira de comentar consegue cancelar o Trabalho do próprio Card sem precisar ser operadora GitHub.

**Blocked by:** [06 — Responder a uma pergunta e retomar o mesmo Trabalho](06-responder-pergunta.md)

Status: ready-for-agent

- [ ] Aceitar a sintaxe exata /factory cancel na entrada validada do Card de origem. Reentregar após reinício resulta em um cancelamento e um recibo, não duas transições.
- [ ] Texto livre, cabeçalho automático, instrução editada e alegação de autoria no texto não autorizam cancelamento. Comando conhecido incompleto orienta sem cancelar nem responder a pergunta aberta.
- [ ] Uma referência a outro Card não amplia o alcance; não aceitar comandos administrativos, globais ou destrutivos da instalação.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §4; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).
