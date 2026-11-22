# 01: Separar a origem do Ticket do destino do Trabalho

**What to build:** Um Trabalho GitHub continua da descoberta ao merge. A origem determina onde ler e conversar; o destino autorizado determina onde publicar código.

**Blocked by:** None (can start immediately)

Status: resolved

- [x] No YAML v1, um Ticket GitHub percorre o fluxo atual com o mesmo grafo de bloqueios, operadores, etiquetas, associação de PR e checks. O transporte registra chamadas GitHub esperadas e nenhuma leitura de segredo ou chamada Jira.
- [x] No YAML v2, fontes e destinos são independentes. Rejeitar uma rota para repositório desconhecido ou autorizado apenas para leitura de dependências; validar IDs e origem HTTPS configurada.
- [x] Contratos comuns distinguem escopo, Ticket, observação, autor, entrada e cursor por provedor; GitHub não precisa simular remote links do Jira. A descoberta Jira em produção permanece desabilitada.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §1; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).

## Answer

Contratos discriminados por provedor, YAML v1/v2 e composição por origem, com regressão GitHub intacta e descoberta Jira desligada.

- `TicketRef` = GitHub (forma persistida inalterada) | Jira `(siteId, issueId)` com `key`/`url` só de apresentação; `ticketKey` GitHub inalterada e Jira
  `jira:site:<id>:issue:<id>` codificada; `ticketLabel` mostra `owner/repo#n` ou `PAG-42`. `IssueTracker<P>` tipa escopo, Ticket, observações,
  bloqueadores, autor, entrada e cursor por provedor (`TrackerContracts`); *remote link* fica em `JiraRemoteLinks`, que o GitHub não implementa.
- `config.yaml` v1 mantém o significado (cada repositório é fonte GitHub); v2 separa `ticketSources` dos destinos e recusa rota/fonte para
  repositório desconhecido ou só de dependências, IDs não numéricos, origem não HTTPS ou com caminho, componente duplicado, conta divergente
  por site e valores com formato de token.
- `composeProductionAccess` cria o adapter Jira só com fontes Jira em v2; o token é lido no host apenas numa requisição Jira. Em v1 nenhum
  cliente Jira é criado nem credencial aberta (teste com transporte que registra chamadas e controle positivo em v2). `jiraDiscoveryReleased = false`.
- Caminhos só GitHub (poller, despacho, perguntas, ciclos, refs) estreitam pela origem e falham fechados para outra origem; fonte GitHub com
  `discover: false` não admite novos Tickets (`SOURCE_DISCOVERY_DISABLED`), mas continua acompanhando os Trabalhos existentes.

Commits: d9b886bc (contratos e configuração), e726927f (composição e descoberta por fonte), eb3058b8 (receitas de qualificação). `npm run test:ci`: PASS (2150 pass, 0 fail).

