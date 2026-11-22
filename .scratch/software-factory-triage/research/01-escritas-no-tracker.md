# Escritas no tracker: o que GitHub e Jira Cloud permitem ao trocar labels, comentar e fechar

- **Consulta:** 2026-11-22 (UTC). Pesquisa documental, sem experimento autenticado.
- **Objeto:** ticket de pesquisa [#2](https://github.com/Sanmoo/software-factory-durable/issues/2), sob o mapa [#1](https://github.com/Sanmoo/software-factory-durable/issues/1) (Triagem de Tickets com um Triador autônomo).
- **Escopo:** GitHub.com (REST `2026-03-10` e GraphQL) e Jira Cloud (REST v3). Trocar labels de triagem, comentar e fechar (fechar só no GitHub; no Jira o mapa exclui transição de status).
- **Método:** somente fontes primárias: documentação oficial, a descrição OpenAPI oficial do GitHub (`github/rest-api-description`, commit `bbd57e64`, de 2026-11-17, arquivo `api.github.com.2026-03-10.json`), o OpenAPI oficial do Jira Cloud v3 (`swagger-v3.v3.json`, versão `1001.0.0-SNAPSHOT-eac1257d…`) e a especificação GraphQL. Nenhuma credencial, nenhum tenant, nenhuma escrita em serviço real.
- **Como ler:** **fato documental** é o que a fonte diz; **implicação** é análise para a spec; **não concluído** é o que a documentação não permite afirmar; **prova pendente** exigiria autorização separada e os guardrails de `docs/agents/experiment-proofs.md`. Marcadores `[Gxx]` (GitHub), `[Jxx]` (Jira) e `[Xxx]` (outros) apontam para a seção [Fontes](#fontes).

## 1. Resposta curta

A fábrica consegue fazer tudo o que o mapa pede com as APIs documentadas, mas **nenhuma das duas plataformas documenta atomicidade, escrita condicional ou chave de idempotência para essas escritas**. O que a documentação sustenta:

1. **GitHub, permissão:** a permissão de repositório `Issues: write` do GitHub App cobre adicionar, remover e substituir labels, fechar a issue (`PATCH` com `state`/`state_reason`) e comentar; `Issues: read` cobre eventos e timeline. O propósito `tracker` de `src/platform/github/index.ts` já pede `issues: write`. [G01][G02][G03][G04]
2. **GitHub, atomicidade:** "adicionar uma label" e "remover uma label" são dois endpoints e duas requisições. Uma única chamada só troca labels **substituindo o conjunto inteiro** (`PUT …/labels` ou `PATCH` da issue com `labels`), o que a expõe a sobrescrever uma mudança humana concorrente. A documentação não usa a palavra atômico para nenhum dos caminhos. [G02][G03]
3. **GitHub, autoria:** eventos `labeled`/`unlabeled`/`closed` trazem `actor` e, no schema, `performed_via_github_app`. Isso permite distinguir a escrita da fábrica da de um humano **se** a fábrica escrever com token de instalação do seu App, mas a documentação não descreve quando `performed_via_github_app` é preenchido nem a forma do `actor` de um App. [G05][G06][G07]
4. **GitHub, novidade que afeta o Triador:** desde julho de 2026 há, em public preview, "agent suggestions": mudanças de label, tipo, campos, responsável e fechamento podem ser **retidas como sugestão pendente** em vez de aplicadas, conforme o nível de automação do repositório. A documentação não diz com clareza como uma escrita de GitHub App sem `suggest`/`confidence` é roteada. É a maior incerteza desta pesquisa. [G08][G09][G02][G03]
5. **GitHub, limite de comentário:** não documentado na referência REST nem no OpenAPI; só o `422` genérico. [G04]
6. **Jira, permissão:** editar etiquetas exige a permissão de projeto *Edit issues* (`EDIT_ISSUES`) além de *Browse projects*; é uma permissão **nova** em relação às três que `src/issue-tracker/jira.ts` verifica hoje. Escopos OAuth: `write:jira-work` (clássico) ou `write:issue:jira` (granular, Beta); só importam com OAuth ou API token com escopos. [J01][J02][J03]
7. **Jira, atomicidade:** uma única chamada `PUT /rest/api/3/issue/{id}` aceita `update.labels: [{add}, {remove}]`; o exemplo oficial mostra exatamente isso. A documentação não promete atomicidade, mas declara `409` para "conflicting update". As operações são relativas, então não sobrescrevem outras etiquetas. [J01]
8. **Jira, autoria:** cada entrada do changelog tem `author` ("The user who made the change") e, opcionalmente, `historyMetadata`, que quem edita pode enviar no próprio `PUT`. Com Basic auth, o autor é a conta dona do token: só distingue a fábrica se a conta for dedicada. [J01][J04]
9. **Em ambos, concorrência e resposta ambígua:** não há `If-Match` nem chave de idempotência documentados para essas escritas. Depois de um timeout, a documentação não permite concluir se a escrita foi aplicada; a única saída documentada é **ler o estado e o histórico (timeline/changelog) e reconciliar antes de qualquer novo envio**. O Jira diz explicitamente para só repetir chamadas idempotentes. [G10][G11][J05]

## 2. GitHub

### 2.1 Permissões do GitHub App

**Fato documental.** A página "Permissions required for GitHub Apps" lista, sob a permissão de repositório "Issues", com o texto "For each permission granted to a GitHub App, these are the REST API endpoints that the app can use" [G01]:

| Endpoint | Nível |
| --- | --- |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/labels` (adicionar) | write |
| `PUT /repos/{owner}/{repo}/issues/{issue_number}/labels` (substituir conjunto) | write |
| `DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}` (remover uma) | write |
| `DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels` (remover todas) | write |
| `PATCH /repos/{owner}/{repo}/issues/{issue_number}` (fechar, editar) | write |
| `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` | write |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/labels` | read |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/events` | read |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/timeline` | read |
| `POST /repos/{owner}/{repo}/labels` (criar label no repositório) | write |

Os mesmos endpoints de label também aparecem sob "Pull requests". [G01] O OpenAPI marca os endpoints de label como `enabledForGitHubApps: true`. [G02]

**Fato documental.** `PATCH` da issue: "Issue owners and users with push access or Triage role can edit an issue." O parâmetro `labels` diz: "Only users with push access can set labels for issues. Without push access to the repository, label changes are silently dropped." [G03]

**Implicação.** `Issues: write` basta para as quatro transições, o comentário e o fechamento; o propósito `tracker` (`metadata: read`, `issues: write`) e o `question-publish` já têm esse teto. Não é preciso `Contents` nem `Pull requests`. Vale definir um propósito próprio e estreito para a Triagem, como o código já faz para cada efeito.

**Não concluído.** A frase "silently dropped" fala de *usuários* sem push access; a documentação não diz como ela se aplica a um token de instalação com `Issues: write` e sem `Contents: write`. Os endpoints dedicados de label (`POST`/`PUT`/`DELETE …/labels`) estão na tabela de `Issues: write` sem essa ressalva. **Implicação:** preferir os endpoints dedicados para labels e, se usar `PATCH`, conferir as labels na resposta, porque o descarte é silencioso (HTTP 200). **Prova pendente:** confirmar em repositório de teste.

**Não concluído.** A documentação consultada não diz o que acontece ao adicionar uma label que não existe no repositório (criar ou recusar). **Implicação:** tratar a existência das quatro labels de triagem como pré-condição verificada (`GET /repos/{owner}/{repo}/labels/{name}`), não como efeito colateral.

### 2.2 Trocar duas labels: atomicidade

**Fato documental.** [G02][G03]

- `POST …/labels`: "Adds labels to an issue." O corpo é "The labels to add to the issue's existing labels". Respostas: 200, 301, 404, 410, 422.
- `DELETE …/labels/{name}`: "Removes the specified label from the issue, and returns the remaining labels on the issue. This endpoint returns a `404 Not Found` status if the label does not exist." Respostas: 200, 301, 404, 410.
- `PUT …/labels`: "Removes any previous labels and sets the new labels for an issue." "The labels you set replace any existing labels."
- `PATCH` da issue, `labels`: "Pass one or more labels to _replace_ the set of labels on this issue." O mesmo `PATCH` aceita `state` (`open`/`closed`) e `state_reason` (`completed`, `not_planned`, `duplicate`, `reopened`; "Ignored unless `state` is changed").
- A única garantia transacional escrita na operação é sobre o campo `status` (preview): "The status and other applied field changes are saved together. If the status cannot be saved, those field changes are rolled back."
- GraphQL: `addLabelsToLabelable`, `removeLabelsFromLabelable`, `updateIssue` (`labelIds`: "An array of Node IDs of labels for this issue"; `state`), `closeIssue` (`stateReason`). [G12] A especificação GraphQL manda executar os campos de topo de uma mutation em série ("This selection set should be executed serially") e não fala em rollback. [X01]

**Implicação.** Há dois desenhos, cada um com um custo:

| Caminho | Chamadas | Risco |
| --- | --- | --- |
| `POST` adicionar a nova, depois `DELETE` remover `needs-triage` | 2 | Estado intermediário visível (duas labels de triagem ao mesmo tempo, ou nenhuma, conforme a ordem); falha entre as duas deixa a troca pela metade. Não toca nas outras labels. |
| `PUT …/labels` ou `PATCH` com o conjunto completo | 1 | Exige ler o conjunto antes (read-modify-write). Sem escrita condicional documentada, uma label que um humano adicione entre a leitura e a escrita é apagada. |

Para `wontfix`, um único `PATCH` pode levar `labels`, `state: closed` e `state_reason: not_planned` na mesma requisição; a documentação não afirma que os três campos são aplicados juntos ou nenhum.

**Não concluído.** Atomicidade de qualquer um dos caminhos; se `PUT`/`PATCH` gera um evento `unlabeled` e um `labeled` por label alterada; se repetir `POST` de uma label já presente gera novo evento. Duas mutations GraphQL no mesmo documento **não** são uma transação segundo a especificação.

**Implicação de desenho.** A ordem "adicionar a label de desfecho primeiro, remover `needs-triage` depois" faz com que a falha no meio deixe um estado detectável (as duas presentes), nunca um Ticket sem label de triagem. A spec deve nomear esse estado intermediário e a regra de reconciliação, em vez de presumir troca atômica.

### 2.3 Quem aplicou ou removeu uma label

**Fato documental.**

- Eventos `labeled` e `unlabeled` existem nas APIs de issue events e de timeline; propriedades comuns incluem `actor` ("The person who generated the event"), `event`, `created_at`, mais `label.name` e `label.color`. [G05]
- No OpenAPI, `labeled-issue-event` e `unlabeled-issue-event` têm como obrigatórios `id`, `node_id`, `url`, `actor` (schema `simple-user`, com `login`, `id` e `type`), `event`, `commit_id`, `commit_url`, `created_at`, `performed_via_github_app` (schema `nullable-integration`: GitHub App com `id`, `slug`, `owner`…) e `label`. O evento `closed` na timeline (`state-change-issue-event`) tem os mesmos campos mais `state_reason`. [G06]
- `GET …/timeline` aceita `per_page` (máx. 100), `page` e `exclude`. `GET …/events`: "Lists all events for an issue." [G06][G13]
- O comentário criado (`issue-comment`) e a issue também têm `user`/`closed_by` e `performed_via_github_app`. [G04][G03]
- GraphQL: `LabeledEvent`/`UnlabeledEvent` têm `actor` ("Identifies the actor who performed the event"), `createdAt`, `label`; `Actor` é "Typically a User or Bot". `ClosedEvent` tem `actor` e `stateReason`. [G12][G14]
- Webhook `issues.labeled`: payload com `sender` (`simple-user`), `label` e `installation`. [G06]
- Autenticação: "Your app should authenticate as an app installation when you want to attribute app activity to the app." [G07]

**Implicação.** Escrevendo com token de instalação do App da fábrica, a timeline permite separar "label aplicada pela fábrica" de "label aplicada por humano" comparando `actor.id` com o usuário bot do App (o módulo já lê esse id, ticket 14) e/ou `performed_via_github_app.id` com o id do App. Isso serve para os dois usos que o mapa precisa: reconhecer que `needs-triage` foi aplicado por um humano (o ato que autoriza) e reconhecer o próprio efeito depois de uma resposta ambígua.

**Não concluído.**

- O schema de `performed_via_github_app` não tem descrição: a documentação não diz em que condições ele vem preenchido para eventos de label (token de instalação, token user-to-server, ambos). Não usar esse campo como única prova sem ensaio.
- A documentação não descreve o formato do `actor` de um App (`type: "Bot"`, login `<slug>[bot]`); o exemplo do schema é `User`.
- Ordenação, atraso e completude de `events`/`timeline` não são especificados. Não se pode afirmar que um evento aparece imediatamente após a resposta da escrita.
- Um humano pode agir *por meio de* outro App ou de Actions; "não é o nosso App" não significa "é um humano". A regra segura é positiva: "é o nosso App" versus "qualquer outro ator".

### 2.4 Sugestões de agente (public preview, 2026-07)

**Fato documental.**

- Changelog de 2026-07-23: "Agent automation controls in GitHub Issues" em public preview, com Approvals, Confidence e Rationale para mudanças de labels, campos, tipo, fechamento e responsáveis; disponível também por REST e GraphQL. [G08]
- Documentação: o repositório tem um "Automation level" em Settings › Planning › "Agent suggestions for issues": Full control (toda mudança é retida), Cautious (padrão; só alta confiança aplica), Balanced e Full automation. "Changes rated below the threshold are held as suggestions; changes at or above it apply automatically." Para integrações próprias pela API, a mudança "is routed the same way as a change from an automation […]: subject to your repository's automation level, or held for review if you marked it as a suggestion." A configuração "is rolling out gradually and might not be available in your repository yet". [G09]
- OpenAPI: itens de `labels` em `POST …/labels` e no `PATCH` aceitam objeto com `name`, `rationale`, `suggest` ("If `true`, the label is stored as a pending suggestion for human review rather than applied directly") e `confidence` (`low`/`medium`/`high`). A resposta do `PATCH` pode trazer `suggestions`, com as sugestões pendentes dos campos tocados. Há `GET …/issues/{n}/suggestions` e `POST …/suggestions/{id}/approve|dismiss`, que "Requires triage access". Eventos ganham `intent` (`rationale`, `confidence`), presente "while the issue suggestions feature is enabled for the repository". [G02][G03][G06]

**Implicação.** Isso toca diretamente a decisão do mapa de que "a fábrica passa a aplicar `ready-for-agent` sozinha": em um repositório com o recurso ligado, uma escrita marcada com confiança baixa/média, ou com `suggest: true`, **não muda a label**; fica pendente até um humano aprovar. O recurso também oferece um lugar nativo para a justificativa do Triador (`rationale`), o que a spec pode aproveitar ou ignorar de propósito.

**Não concluído.** A documentação não diz como é roteada uma escrita de GitHub App que manda labels como strings simples, sem `suggest` nem `confidence`: se aplica direto (comportamento de sempre) ou se o nível "Full control" a retém. O changelog diz que "an agent with permission to change issues can directly apply changes rather than suggest them", o que sugere que o fluxo não é uma barreira de permissão, mas isso não responde ao caso. **Prova pendente** (a mais importante desta pesquisa): em repositório de teste com o recurso ligado, escrever a label sem campos de intenção e observar label, `suggestions` na resposta e timeline. Independentemente do resultado, a fábrica deve **verificar por leitura** que a label ficou aplicada, não confiar no 200.

### 2.5 Comentários: tamanho e ritmo

**Fato documental.** `POST …/comments` exige `body` ("The contents of the comment"), sem `maxLength` no schema; respostas 201, 403, 404, 410 e 422 ("Validation failed, or the endpoint has been spammed"). "This endpoint triggers notifications. Creating content too quickly using this endpoint may result in secondary rate limiting." [G04] Limites secundários: no máximo 80 requisições geradoras de conteúdo por minuto e 500 por hora; no máximo 100 requisições concorrentes; recomenda-se fazer requisições em série e esperar ao menos um segundo entre escritas. [G15][G10]

**Não concluído.** O tamanho máximo do corpo de um comentário **não está na documentação primária consultada**. O número que circula (65.536 caracteres, de uma mensagem de erro) vem de relatos da comunidade, com medições divergentes entre caracteres e bytes; não é fonte primária e não foi usado aqui como fato. **Implicação:** a spec deve fixar um teto próprio conservador para o brief e as notas do Triador, dividir ou truncar de forma determinística, e tratar `422` como recusa conhecida (nada foi criado). **Prova pendente:** medir o limite real, em caracteres e em bytes UTF-8.

### 2.6 Fechar a issue (`wontfix`)

**Fato documental.** `PATCH` com `state: closed` e `state_reason: not_planned`; a issue lida devolve `state_reason`, `closed_by` e `closed_at`. GraphQL: `closeIssue` com `stateReason`. [G03][G12] O fechamento também é um campo "suggestible" (`state`) no recurso da seção 2.4. [G03]

**Implicação.** `not_planned` é o motivo que corresponde a `wontfix`; a pesquisa anterior do MVP já registrou que só `closed + completed` satisfaz dependências, então um `wontfix` não libera Tickets bloqueados por ele (ver `.scratch/software-factory/research/github-capabilities.md`).

## 3. Jira Cloud

### 3.1 Permissão de projeto e escopos para editar etiquetas

**Fato documental.** `PUT /rest/api/3/issue/{issueIdOrKey}` ("Edit issue") exige "*Browse projects* and *Edit issues* project permission for the project that the issue is in" e, se houver, a permissão de issue-level security. Escopos OAuth 2.0: `write:jira-work` (Current) ou `write:issue:jira` (granular, Beta); escopo Connect `WRITE`. [J01] "Get edit issue metadata" lista as condições para um campo ser editável: campo presente em tela, visível na configuração de campos, etapa do workflow editável (`jira.issue.editable`), usuário com *Edit issues* e permissões de workflow (`jira.permission.*`). Já o `PUT` avisa: "This endpoint doesn't check screen configurations to determine if a field is editable." [J01]

**Fato documental.** `GET /rest/api/3/mypermissions` avisa que, em contexto de projeto, um usuário pode aparecer com `EDIT_ISSUES` sem tê-la em toda issue (exemplo: permissão concedida a Reporters). [J03]

**Fato documental.** Autenticação atual da fábrica: Basic com e-mail e API token (`src/issue-tracker/jira-http.ts`). A Atlassian diz que Basic "is not as secure as other methods" e o recomenda para scripts simples; tokens podem ser criados "with or without scopes", expiram em até 365 dias, e tokens com escopo precisam chamar `https://api.atlassian.com/ex/jira/{cloudId}`. [J06][J07]

**Implicação.**

- A conta da fábrica precisa de **`EDIT_ISSUES`**, que hoje não está em `jiraPermissions` (`BROWSE_PROJECTS`, `ADD_COMMENTS`, `LINK_ISSUES`). É um aumento real de autoridade: *Edit issues* permite editar qualquer campo editável do Card (título, descrição…), não só etiquetas. O Jira não documenta permissão mais estreita para etiquetas; o estreitamento teria de vir de escopos (token com escopo/OAuth), de configuração do projeto, ou ficar só no código da fábrica.
- O diagnóstico `checkAccess` deveria consultar `EDIT_ISSUES`, e a ressalva do `mypermissions` recomenda checar no contexto da issue (`issueId`), não só do projeto.
- Mesmo com a permissão, a edição pode ser recusada por etapa de workflow não editável ou campo fora de contexto: `400` ("the user does not have the necessary permission to edit one or more fields"), `422` ("a configuration problem prevents the issue being updated"). São recusas conhecidas, que viram Impediment, não tentativa repetida.
- Se a fábrica migrar para token com escopo, muda a URL base, o que o transporte atual (origem do site, só `/rest/api/3/...`) não cobre.

**Não concluído.** A página de permissões de projetos consultada [J08] não descreve *Edit issues* nem diz qual permissão cobre etiquetas; a afirmação vem só da referência REST. Projetos team-managed e Jira Service Management não foram examinados.

### 3.2 Adicionar e remover etiquetas em uma chamada

**Fato documental.** O corpo do `PUT` tem `fields` ("a straightforward option when setting a sub-field") e `update` ("A Map containing the field field name and a list of operations to perform"); um campo não pode estar nos dois. O exemplo oficial da operação inclui: [J01]

```json
"update": { "labels": [ { "add": "triaged" }, { "remove": "blocker" } ] }
```

Respostas: `204` (ou `200` com a issue, se `returnIssue=true`), `400`, `401`, `403`, `404`, **`409` "Returned if the issue could not be updated due to a conflicting update"**, `422`. `notifyUsers` (padrão `true`) envia e-mail aos watchers; desligar exige permissão de administração e, sem ela, "the request is ignored". [J01]

**Implicação.** A troca `needs-triage` → desfecho cabe em **uma requisição** com operações relativas, que não tocam nas outras etiquetas do Card (ao contrário de `fields.labels`, que define o conjunto). `returnIssue=true` devolve o estado resultante na mesma resposta. Cada troca notifica watchers por padrão, e a fábrica não deve tentar desligar isso sem permissão de administração.

**Não concluído.** A documentação não diz que as operações de um `PUT` são aplicadas todas ou nenhuma, nem que geram uma única entrada de changelog; não diz o que acontece ao adicionar etiqueta já presente ou remover etiqueta ausente (sucesso silencioso ou erro); não documenta parâmetro de versão ou `If-Match` que o cliente possa enviar, embora o `409` mostre que o servidor detecta conflito. Regras de formato de etiqueta (sem espaços, tamanho máximo) não estão na referência consultada. **Prova pendente:** um `PUT` com `add` + `remove` em Card de teste, observando changelog e os casos de etiqueta já presente/ausente.

### 3.3 Autor da mudança no changelog

**Fato documental.** `GET /rest/api/3/issue/{issueIdOrKey}/changelog` devolve lista paginada "sorted by date, starting from the oldest" (`startAt`, `maxResults` padrão 100); exige *Browse projects*; escopos `read:jira-work` ou granulares (Beta). Cada entrada tem `id`, `created`, `author` ("The user who made the change", `UserDetails` com `accountId` e `accountType`: `atlassian`, `app` ou `customer`), `items` (`field`, `fieldId`, `fieldtype`, `from`, `fromString`, `to`, `toString`) e `historyMetadata` (somente leitura no changelog). O `PUT` de edição aceita `historyMetadata` ("Additional issue history details"), com `type`, `description`, `actor`, `generator`, `cause`, `extraData`. O exemplo de resposta mostra uma mudança de etiquetas com `fromString: "label-1"` e `toString: "label-1 label-2"`. `GET` da issue aceita `expand=changelog` ("a list of recent updates"). [J04][J01]

**Implicação.**

- A autoria é por conta: com Basic auth, `author.accountId` é a conta dona do token. Só distingue fábrica de humano se a fábrica usar **conta dedicada**; se o token for de uma pessoa, as duas escritas ficam indistinguíveis por `author`.
- `historyMetadata` permite carimbar a própria edição (por exemplo, `generator` e um identificador do efeito em `extraData`) e reencontrá-la no changelog. É o correlacionador mais direto para reconciliar uma resposta ambígua.
- O exemplo indica que o item de etiquetas traz o **conjunto inteiro** antes e depois, separado por espaço: descobrir qual etiqueta entrou ou saiu exige comparar os dois conjuntos.
- Usar o endpoint paginado, não `expand=changelog`, que só promete atualizações "recentes".

**Não concluído.** O formato do item de etiquetas vem de um exemplo (que usa o nome de campo fictício `fields`), não de texto normativo; a documentação não garante que `historyMetadata` enviado por Basic auth seja persistido e devolvido, nem que não possa ser forjado por outro cliente (qualquer conta com *Edit issues* pode mandar o mesmo metadado: ele identifica o efeito, não autentica o autor). **Prova pendente:** conferir formato real do item `labels` e o retorno de `historyMetadata`.

### 3.4 Comentários em ADF e anexos

**Fato documental.**

- `POST /rest/api/3/issue/{issueIdOrKey}/comment`: *Browse projects* + *Add comments*; `body` em Atlassian Document Format; `visibility` opcional (grupo ou papel); respostas `201`, `400`, `401`, `404` e **`413` "Returned if the per-issue limit has been breached for one of the following fields: comments, attachments"**. [J02]
- Limites: "Jira Cloud doesn't support more than 32,767 characters for both description and comments". [J09] Por work item: 5.000 comentários, 2.000 anexos, 2.000 remote links; teto de 1 MB por entrada rich-text (descrição, comentários); 500 MB de tamanho total a partir de novembro de 2026. [J10]
- `POST /rest/api/3/issue/{issueIdOrKey}/attachments`: `multipart/form-data`, parâmetro `file`, cabeçalho `X-Atlassian-Token: no-check` obrigatório ("if not it is blocked"); exige *Browse Projects* + *Create attachments*; `413` se exceder o tamanho máximo, se forem mais de 60 arquivos ou se o limite por issue for atingido. `GET /rest/api/3/attachment/meta` informa se anexos estão habilitados e o tamanho máximo. [J11]
- O nó ADF `media` "represents a single file or link stored in media services"; `attrs.id` "is the Media Services ID". [J12]

**Implicação.**

- Hoje a fábrica já comenta com `ADD_COMMENTS` e ADF de parágrafos (`adfOf`). Um brief ou notas de `needs-info` longos precisam de teto próprio abaixo de 32.767 caracteres, com divisão determinística em mais de um comentário.
- Anexar evidências exigiria uma **quarta permissão** (`CREATE_ATTACHMENTS`), um transporte multipart e o cabeçalho especial, que o transporte atual não tem. O mapa fala em "evidências e perguntas anexadas"; se "anexadas" significar arquivo, é escopo novo de autoridade; se significar texto no comentário, não.
- O Card com 5.000 comentários recusa novos com `413`: é recusa conhecida.

**Não concluído.** Como os 32.767 caracteres são contados em ADF (texto visível, JSON serializado, por nó) não está documentado; qual código devolve um comentário longo demais (o `400` genérico é o candidato) também não. A referência do nó `media` não diz como obter o Media Services ID de um anexo enviado pela REST v3, então **embutir um anexo no corpo do comentário não é sustentado pela documentação**; o que ela sustenta é anexar ao Card e citar o nome do arquivo no texto.

## 4. Em ambos: escrita concorrente com um humano

**Fato documental.**

- GitHub: nenhuma das operações consultadas documenta `If-Match`, versão ou outro pré-requisito de escrita; a busca por "idempotency" e por `If-Match` no OpenAPI `2026-03-10` não retorna nada. Requisições condicionais são documentadas para leitura/polling (`304`). [G02][G10]
- Jira: o `PUT` declara `409` por "conflicting update", sem parâmetro documentado para o cliente informar a versão lida. A busca por `If-Match` no OpenAPI v3 não retorna nada. [J01]
- Limites de escrita por issue no Jira: 20 escritas a cada 2 segundos e 100 a cada 30 segundos, com `429` e `RateLimit-Reason: jira-per-issue-on-write`. [J05]

**Implicação.**

- Nenhuma plataforma oferece compare-and-swap ao cliente. A proteção possível é de desenho: (a) usar **operações relativas** (GitHub `POST`/`DELETE` por label; Jira `update.labels` com `add`/`remove`), que não sobrescrevem mudanças alheias em outras labels; (b) **reler** label e histórico imediatamente antes de escrever o desfecho; (c) **reler depois** e decidir pelo estado observado.
- O caso que a spec precisa decidir: um humano remove `needs-triage` (ou aplica outra label de triagem) enquanto o Triador trabalha. A API não impede a fábrica de escrever o desfecho por cima; a regra "o humano venceu, a Triagem é descartada" precisa existir na fábrica, com checagem antes da escrita e uma janela residual de corrida que a documentação não permite fechar.
- No GitHub, `DELETE` de uma label já removida devolve `404`: isso é um sinal documentado de que alguém a removeu antes (ou de que o próprio envio anterior já teve efeito; ver seção 5).
- No Jira, `409` deve ser tratado como recusa conhecida seguida de releitura, não como falha a repetir às cegas.

**Não concluído.** A semântica de duas escritas simultâneas (quem vence, se há mescla) não é documentada em nenhuma das duas; no GitHub, se um `PUT`/`PATCH` concorrente com uma mudança humana resulta em "último vence" é inferência, não fato documental.

## 5. Em ambos: resposta ambígua (timeout depois do envio)

**Fato documental.**

- GitHub: "If GitHub takes more than 10 seconds to process an API request, GitHub will terminate the request and you will receive a timeout response". A página não diz se a escrita foi aplicada. As boas práticas só tratam de repetição para limites de taxa (`retry-after`, backoff). [G11][G10]
- Jira: "Only retry if the API is idempotent and the response includes a `Retry-After` header."; `503` transitório pode trazer `Retry-After`. [J05]
- Nenhuma das operações de label, comentário ou fechamento aceita chave de idempotência documentada. No OpenAPI do Jira, a palavra só aparece em erros de uma API não relacionada. [G02][J01]

**Implicação.** Uma resposta ausente, um timeout ou um `5xx` depois do envio **não permitem concluir nem "aplicada" nem "não aplicada"**. É o mesmo princípio que o código já adota (`commentNotCreated`: só `4xx` ou "nada foi enviado" provam que o comentário não existe; todo o resto é reconciliado antes de novo `POST`). Por tipo de escrita:

| Escrita | Repetir às cegas é seguro? | Como reconciliar |
| --- | --- | --- |
| GitHub: adicionar label | Não documentado (efeito de repetir não descrito) | Ler labels da issue; timeline `labeled` com `actor`/App da fábrica e `created_at` posterior ao envio. |
| GitHub: remover label | Repetição devolve `404` se já saiu, sem dizer quem removeu | Timeline `unlabeled` com o ator da fábrica. |
| GitHub: fechar | `state` é definido, não incrementado; efeito de repetir não descrito | Ler `state`, `state_reason`, `closed_by`; evento `closed` na timeline. |
| GitHub: comentar | **Não**: cada `POST` cria um comentário | Listar comentários e casar por marcador do efeito e autor (prática atual da fábrica). |
| Jira: `PUT` com `add`/`remove` | Não documentado | Ler `labels` do Card; changelog com `author` da conta da fábrica e, se enviado, `historyMetadata` do efeito. |
| Jira: comentar | **Não**: cada `POST` cria um comentário | Listar comentários e casar por marcador (prática atual, `listComments`). |

Como o desfecho de uma Triagem são **duas ou três escritas** (comentário, troca de label, e fechamento no GitHub), a spec precisa de uma ordem e de um registro durável por efeito. Uma ordem defensável pela documentação: comentário primeiro (reconciliável por marcador), label de desfecho depois, remoção de `needs-triage` em seguida, fechamento por último; assim, toda parada no meio deixa `needs-triage` ainda presente ou um estado que a leitura identifica sem ambiguidade. A escolha da ordem é decisão de spec, não fato documental.

**Não concluído.** Quanto tempo depois de um timeout o efeito pode ainda aparecer (a documentação não dá prazo de consistência para labels, timeline ou changelog); portanto "li e não vi" logo após o timeout não prova que a escrita não ocorreu. A reconciliação precisa de uma regra de espera ou de repetição de leitura, a calibrar em prova.

## 6. Provas pendentes (não executadas; exigem autorização separada)

1. **GitHub, sugestões de agente:** com o recurso ligado em cada nível de automação, uma escrita de label e um fechamento por token de instalação, sem `suggest`/`confidence`, são aplicados ou retidos?
2. **GitHub, autoria:** forma real de `actor` e de `performed_via_github_app` em `labeled`/`unlabeled`/`closed` para escrita com token de instalação; atraso até o evento aparecer na timeline.
3. **GitHub, `PATCH` com `labels`** por App com `Issues: write` e sem `Contents: write`: aplica ou descarta em silêncio?
4. **GitHub, limite de comentário:** tamanho máximo real e resposta ao excedê-lo; eventos gerados por `PUT`/`PATCH` e por `POST` de label já presente.
5. **Jira, `PUT` com `add` + `remove`:** quantas entradas de changelog, formato do item `labels`, retorno de `historyMetadata`, comportamento com etiqueta já presente/ausente, e resposta em etapa de workflow não editável.
6. **Jira, comentário longo:** como os 32.767 caracteres são contados em ADF e qual erro volta.

## Fontes

Consultadas em 2026-11-22.

- **[G01]** GitHub Docs, Permissions required for GitHub Apps, "Repository permissions for Issues": https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2026-03-10#repository-permissions-for-issues
- **[G02]** GitHub Docs, REST API endpoints for labels: https://docs.github.com/en/rest/issues/labels?apiVersion=2026-03-10 (texto e schemas conferidos no OpenAPI oficial: https://github.com/github/rest-api-description/blob/bbd57e64767616df3b37792a1186166334043761/descriptions/api.github.com/api.github.com.2026-03-10.json)
- **[G03]** GitHub Docs, REST API endpoints for issues, "Update an issue" e "Get an issue": https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10#update-an-issue
- **[G04]** GitHub Docs, REST API endpoints for issue comments, "Create an issue comment": https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10#create-an-issue-comment
- **[G05]** GitHub Docs, Issue event types (`labeled`, `unlabeled`, `closed`, `reopened`, `commented`): https://docs.github.com/en/rest/using-the-rest-api/issue-event-types?apiVersion=2026-03-10
- **[G06]** GitHub Docs, REST API endpoints for timeline events: https://docs.github.com/en/rest/issues/timeline?apiVersion=2026-03-10 ; schemas `labeled-issue-event`, `unlabeled-issue-event`, `state-change-issue-event`, `nullable-integration`, `simple-user`, `nullable-issue-event-intent`, `webhook-issues-labeled` e endpoints `…/suggestions` no OpenAPI de [G02]
- **[G07]** GitHub Docs, About authentication with a GitHub App: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app
- **[G08]** GitHub Changelog, 2026-07-23, Agent automation controls in GitHub Issues in public preview: https://github.blog/changelog/2026-07-23-agent-automation-controls-in-github-issues-in-public-preview/
- **[G09]** GitHub Docs, Managing rationale, confidence, and approvals for issues: https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/use-copilot-agents/cloud-agent/manage-rationale-confidence-approvals
- **[G10]** GitHub Docs, Best practices for using the REST API: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2026-03-10
- **[G11]** GitHub Docs, Troubleshooting the REST API (timeouts, `Resource not accessible by integration`, `X-Accepted-GitHub-Permissions`): https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api?apiVersion=2026-03-10
- **[G12]** GitHub Docs, GraphQL reference, Issues (`addLabelsToLabelable`, `removeLabelsFromLabelable`, `updateIssue`, `closeIssue`, `addComment`, `LabeledEvent`, `UnlabeledEvent`, `ClosedEvent`): https://docs.github.com/en/graphql/reference/issues
- **[G13]** GitHub Docs, REST API endpoints for issue events: https://docs.github.com/en/rest/issues/events?apiVersion=2026-03-10
- **[G14]** GitHub Docs, GraphQL reference, Users (interface `Actor`): https://docs.github.com/en/graphql/reference/users
- **[G15]** GitHub Docs, Rate limits for the REST API: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2026-03-10
- **[J01]** Atlassian, Jira Cloud REST API v3, Issues ("Edit issue", "Get edit issue metadata", "Get issue"): https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-put (texto e schemas conferidos no OpenAPI oficial: https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json)
- **[J02]** Atlassian, Jira Cloud REST API v3, Issue comments ("Add comment", "Get comments"): https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/#api-rest-api-3-issue-issueidorkey-comment-post
- **[J03]** Atlassian, Jira Cloud REST API v3, Permissions ("Get my permissions"): https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permissions/#api-rest-api-3-mypermissions-get
- **[J04]** Atlassian, Jira Cloud REST API v3, Issues ("Get changelogs"): https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-changelog-get
- **[J05]** Atlassian, Jira Cloud platform, Rate limiting: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- **[J06]** Atlassian, Basic auth for REST APIs: https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
- **[J07]** Atlassian Support, Manage API tokens for your Atlassian account: https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
- **[J08]** Atlassian Support, Permissions for company-managed projects (consultada; não descreve *Edit issues*): https://support.atlassian.com/jira-cloud-administration/docs/permissions-for-company-managed-projects/
- **[J09]** Atlassian Support, Jira Cloud Migration Assistant pre-migration checklist (limite de 32.767 caracteres): https://support.atlassian.com/migration/docs/jira-pre-migration-checklist/
- **[J10]** Atlassian Support, Work item field limits in Jira Cloud: https://support.atlassian.com/jira/kb/work-item-field-limits-in-jira-cloud/
- **[J11]** Atlassian, Jira Cloud REST API v3, Issue attachments ("Add attachment", "Get Jira attachment settings"): https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/#api-rest-api-3-issue-issueidorkey-attachments-post
- **[J12]** Atlassian, Atlassian Document Format, nó `media`: https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/media/
- **[X01]** GraphQL Specification, October 2021, seções 6.2.2 "Mutation" e 6.3.1 "Normal and Serial Execution": https://spec.graphql.org/October2021/#sec-Mutation

**Limites do método.** As páginas de documentação foram lidas por extração automática; as citações de endpoints, schemas, códigos de resposta e descrições de parâmetros foram conferidas diretamente nos dois arquivos OpenAPI oficiais. As citações de [G05], [G07] a [G11], [G15], [J05] a [J10], [J12] e [X01] vêm só da leitura das páginas e merecem releitura antes de virarem texto normativo da spec.
