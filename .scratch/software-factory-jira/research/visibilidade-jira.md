# Jira Cloud: o que uma leitura permite afirmar sobre Tickets e bloqueadores?

**Resposta:** um link visível e interpretado segundo a configuração do site é evidência positiva de uma relação. Uma busca que chegou à última página e uma leitura do Ticket que não mostrou bloqueadores **não distinguem, de forma documentada, “não existe bloqueador” de “existe um bloqueador que o leitor não pode ver”**. A paginação termina a enumeração da consulta; não atesta acesso às duas pontas de todos os links. [Busca JQL][busca] · [Get issue][issue] · [Get issue link][link] · [Modelo de links][modelo].

**Base:** documentação pública da Atlassian consultada via HTTP em **2026-11-21 (UTC)**. Jira Cloud Platform REST API **v3**; [OpenAPI da consulta][oas], `info.version = 1001.0.0-SNAPSHOT-eac1257d8e1582ed7dd2a97a93dbea3c277d24be`. Escopo: Tickets e links nativos no mesmo site. Os exemplos abaixo são sintéticos e abreviados, não respostas de um tenant. Não houve autenticação, ensaio nem decisão de admissão.

## Identidade: seguir o Ticket, não a chave

**Documentado.** `GET /rest/api/3/issue/{issueIdOrKey}` aceita ID ou chave e devolve `id` e `key` separados. Se não há correspondência direta, o Jira procura sem distinguir maiúsculas/minúsculas e verifica Tickets movidos. Se encontrar, devolve os detalhes com a **chave atual**, sem `302`. O ID é um número atribuído pelo Jira, representado como string em `IssueBean.id`; não é o sufixo da chave. Esta combina chave do projeto (*space*) e número sequencial. Ao alterar a chave do projeto, o Jira mantém aliases de chaves anteriores, mas um administrador pode removê-los. [Get issue][issue] · [OpenAPI: `IssueBean`][oas] · [JQL fields: Work item key][jql] · [Edit a space’s details: Change a space’s key][chave].

**Inferência conservadora.** Para correlacionar duas leituras no mesmo site, a referência mais forte é `(site, issue.id)`, conservando `key` e `fields.project` como valores observados. A [introdução à API][intro] identifica o site por `cloudId` na rota OAuth. Exemplo: ontem, `id="70101", key="LAB-7"`; hoje, após mudança de projeto, uma consulta por `70101` retorna `id="70101", key="OPS-42"`. Isso sustenta “o mesmo Ticket agora tem outra chave”; se a busca pela chave antiga falha, isso não sustenta “o Ticket deixou de existir”. Um movimento também pode mudar seu nível de segurança. [Get issue][issue] · [Work item security schemes][seg].

**Limite.** A regra de busca de Tickets movidos é condicional a encontrar uma correspondência. A documentação consultada não dá uma garantia irrestrita de imutabilidade ou não reutilização do `id` em migração entre sites, importação, restauração ou exclusão/recriação; tampouco promete que toda chave antiga permanecerá resolvível. Um `404` ao ler por ID ou chave pode significar inexistência **ou** falta de permissão. [Get issue, Responses][issue] · [Alteração e exclusão de chaves anteriores][chave].

## Descoberta: o fim das páginas não é o fim do grafo

**Documentado.** `POST /rest/api/3/search/jql` (busca aprimorada) aceita JQL delimitada, `fields`, `maxResults` e `nextPageToken`. Sem seleção de campos, o padrão da busca é devolver apenas IDs. O resultado só inclui Tickets para os quais o leitor tem *Browse projects* e, quando aplicável, permissão de segurança no Ticket. Projetos arquivados são excluídos por padrão. Na API OAuth, os escopos de leitura e as regras de acesso do aplicativo também importam: a busca e a leitura de Ticket não estão isentas dessas regras. [Busca JQL, Permissions/Scopes/Request][busca] · [OpenAPI: `SearchAndReconcileRequestBean`][oas].

**Exemplo de percurso.** Iniciar com `{"jql":"project = LAB ORDER BY key","fields":["project","status","issuelinks"],"maxResults":50}`. Se vierem 12 Tickets, `isLast:false` e token `T`, repetir a consulta usando `nextPageToken:"T"`. Uma página curta não é a última por definição. `isLast:true` indica fim; na última página não há próximo token utilizável. Um erro antes do fim é um percurso incompleto. Mesmo no fim, `project = LAB` não enumera um bloqueador em `OPS`; o estado desse vizinho, se identificado e legível, pode ser consultado por ID fora da busca de candidatos. [Busca JQL][busca] · [OpenAPI: `SearchAndReconcileResults`][oas] · [Get issue][issue].

**Limites de consistência e cobertura.** Alterações recentes podem não aparecer de imediato. `reconcileIssues` melhora a consistência apenas para os IDs fornecidos (até 50, mantendo a lista nas páginas); não descobre IDs ocultos. O schema também descreve avisos **experimentais** de truncamento por limite de ingestão: ausência de aviso não é certificado de completude. Esgotar tokens não demonstra um snapshot atômico nem amplia o JQL ou os privilégios do leitor. [Search After Write][reconciliar] · [OpenAPI: `SearchAndReconcileResults.warnings`][oas] · [Busca JQL][busca].

## Estado e sentido de um link observado

**Estado documentado.** Pedir `fields=status` no Ticket de interesse. `status.id` e `status.name` identificam a etapa; `status.statusCategory` tem, entre outros, `id`, `key` e `name`. As categorias são *To do*, *In progress* e *Done*; a etapa pode ser personalizada e renomeada. A busca de status por nome pode encontrar homônimos; a Atlassian prefere o ID nesse caso. *Resolution* é outra informação: em projetos *company-managed*, descreve por que o trabalho foi para *Done*, e pode até faltar. [OpenAPI: `StatusDetails`, `StatusCategory`][oas] · [Get status][status] · [Workflow status][etapa] · [Resolution][res].

**Tipo e ponta documentados.** Com *issue linking* habilitado, `GET /rest/api/3/issueLinkType` lista o catálogo do site (`id`, `name`, `inward`, `outward`); exige *Browse projects* em algum projeto, não acesso a todo Ticket relacionado. O administrador pode editar os rótulos e criar ou remover tipos. No `fields.issuelinks` do Ticket consultado, `inwardIssue` identifica o vizinho que deve ser lido com `type.inward`; `outwardIssue`, com `type.outward`. Os links são bidirecionais: a ponta é estrutural, mas o significado de negócio vem da configuração. `link.id` identifica a relação, não o tipo nem o vizinho. [Get issue link types][tipos] · [Modelo de links, Issue link directionality][modelo] · [Configurar links][config] · [Get issue, exemplo 200][issue].

**Exemplo positivo.** Para `LAB-7`, suponha esta entrada em `fields.issuelinks`:

```json
{"id":"811","type":{"id":"31","name":"Blocks","inward":"is blocked by","outward":"blocks"},"inwardIssue":{"id":"70202","key":"OPS-9"}}
```

Com **esse** tipo, `OPS-9` bloqueia `LAB-7`; se a ponta na leitura de `LAB-7` fosse `outwardIssue`, seria `LAB-7` que bloquearia `OPS-9`. Não basta procurar a palavra `blocks`: inclusive em JQL, `workItemLinkType` pesquisa nome e ambas as descrições, que podem coincidir. O exemplo de `Get issue` mostra que o status embutido do vizinho pode trazer apenas nome e ícone. Se uma leitura de `70202` devolve `status={"id":"19","name":"Em validação","statusCategory":{"key":"indeterminate","name":"In Progress"}}`, há evidência de **relação** e de **estado observado**; se não for legível, seu estado é desconhecido. Nenhuma das duas informações, isolada, define se a Factory deve admitir trabalho. [Modelo de links][modelo] · [Link types and JQL search][config] · [Get issue][issue].

## Comparação decisiva: Ticket sem bloqueador × bloqueador invisível

Mesmos JQL, leitor e campos pedidos; `LAB-7` é visível nos dois mundos. A tabela compara **evidências permitidas pelo contrato**, não prevê payloads idênticos em todo site.

| Leitura | A — `LAB-7` não tem bloqueador | B — `OPS-9` bloqueia `LAB-7`, mas o leitor não pode ver `OPS-9` |
|---|---|---|
| Última página da busca de candidatos | `LAB-7` retornado; paginação encerrada. | Mesmo resultado possível. Nem mesmo uma busca que inclua `OPS` tem obrigação de devolver `OPS-9` sem a permissão sobre ele. [Busca JQL][busca] |
| `GET issue/LAB-7?fields=issuelinks` | Por exemplo, `fields.issuelinks: []`, se não houver outros links. | Não há no contrato consultado marcador obrigatório “1 link oculto”, contagem global ou garantia da representação serializada dessa aresta. Se não veio bloqueador, a observação é **nenhum bloqueador retornado**, não uma prova de A. [Get issue][issue] · [Modelo de links][modelo] · [OpenAPI: `IssueBean`, `IssueLink`][oas] |
| Leitura direta de um `linkId` hipotético ou conhecido por outra via | Um ID sem link pode produzir `404`. | `GET /rest/api/3/issueLink/{linkId}` exige acesso aos projetos e aos **dois** Tickets; falta de permissão também pode produzir `404`, assim como linking desabilitado. Nem conhecer o ID desfaz essa ambiguidade. [Get issue link, Permissions e 404][link] |

**Lacuna e pré-condições.** Não há discriminador **garantido nas leituras examinadas**. Isso não afirma que o Jira sempre serialize B como `[]`, nem que nenhuma evidência externa possa distingui-los. Campo ausente sequer equivale a array vazio: pode não ter sido solicitado e, com `failFast=false`, a API admite resposta válida sem o valor de um campo cuja leitura falhou. A documentação de JQL oferece filtros por links, mas não os define como mecanismo de auditoria de links ocultos. Para sustentar uma negativa sobre o grafo, seria necessária evidência independente da cobertura de projetos e níveis de segurança nas duas pontas, dos tipos que contam como bloqueio, da habilitação dos links e da atualidade/integridade da leitura. Nada disso decorre de `200`, `404`, `[]` ou `isLast:true`. Esta pesquisa não verificou essas condições em nenhum site. [Get issue, `fields` e `failFast`][issue] · [JQL fields: Work item link type][jql] · [Segurança por Ticket][seg] · [Get issue link][link] · [Search After Write][reconciliar].

[intro]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
[oas]: https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json
[issue]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get
[busca]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post
[link]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/#api-rest-api-3-issuelink-linkid-get
[tipos]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-link-types/#api-rest-api-3-issuelinktype-get
[status]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflow-statuses/#api-rest-api-3-status-idorname-get
[modelo]: https://developer.atlassian.com/cloud/jira/platform/issue-linking-model/
[reconciliar]: https://developer.atlassian.com/cloud/jira/platform/search-and-reconcile/
[chave]: https://support.atlassian.com/jira-cloud-administration/docs/edit-a-projects-details/
[seg]: https://support.atlassian.com/jira-cloud-administration/docs/what-are-work-item-security-schemes/
[etapa]: https://support.atlassian.com/jira-cloud-administration/docs/what-is-a-workflow-status/
[res]: https://support.atlassian.com/jira-cloud-administration/docs/what-is-a-resolution-in-jira/
[config]: https://support.atlassian.com/jira-cloud-administration/docs/configure-issue-linking/
[jql]: https://support.atlassian.com/jira-software-cloud/docs/jql-fields/
