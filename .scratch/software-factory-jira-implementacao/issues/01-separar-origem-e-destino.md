# 01: Separar a origem do Ticket do destino do Trabalho

**What to build:** Um Trabalho GitHub continua da descoberta ao merge. A origem determina onde ler e conversar; o destino autorizado determina onde publicar código.

**Blocked by:** None (can start immediately)

Status: ready-for-agent

- [ ] No YAML v1, um Ticket GitHub percorre o fluxo atual com o mesmo grafo de bloqueios, operadores, etiquetas, associação de PR e checks. O transporte registra chamadas GitHub esperadas e nenhuma leitura de segredo ou chamada Jira.
- [ ] No YAML v2, fontes e destinos são independentes. Rejeitar uma rota para repositório desconhecido ou autorizado apenas para leitura de dependências; validar IDs e origem HTTPS configurada.
- [ ] Contratos comuns distinguem escopo, Ticket, observação, autor, entrada e cursor por provedor; GitHub não precisa simular remote links do Jira. A descoberta Jira em produção permanece desabilitada.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §1; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).
