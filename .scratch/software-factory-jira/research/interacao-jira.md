# Interação da Software Factory por comentários no Jira Cloud

**Conclusão para a spec:** o Jira fornece a conta que criou o comentário, a conta da última edição, o conteúdo atual e um ID para releitura. Isso permite reconhecer uma conta reservada à fábrica e correlacionar uma mensagem visível. **Não** permite distinguir pessoa de automação quando ambas usam a mesma conta, decidir quem pode comandar um Trabalho, nem garantir publicação única de um comentário após perda da resposta. São três problemas distintos: atribuição, autorização e recuperação. [Comentários][C] · [Esquemas][O] · [Contas de serviço][S]

**Recorte e método.** Consulta pública em **21/11/2026** por `curl`, somente à documentação Atlassian; exemplos abaixo são fictícios. Jira **Cloud Platform REST v3**, ADF v1. Para tornar verificável a evidência negativa, o [OpenAPI][O] consultado declara `openapi: 3.0.1` e `info.version: 1001.0.0-SNAPSHOT-eac1257d8e1582ed7dd2a97a93dbea3c277d24be` (o URL acompanha novas versões). Jira Service Management (JSM) é indicado separadamente. Nenhum acesso a tenant, credencial ou ensaio; não há escolha de política nem de credencial.

## 1. Em nome de quem a instalação age?

| Opção para a equipe | Principal efetivo e contrapartida operacional |
|---|---|
| Script com Basic + token de API de uma pessoa | No fluxo Basic documentado, e-mail da conta + token, não senha. A chamada tem os direitos da conta; um comentário via script não ganha um autor diferente de um comentário manual dessa pessoa. Simples para script interno, mas acopla o processo ao acesso e ao ciclo de vida individual. A Atlassian distingue esse uso de um app distribuído que coleta tokens dos clientes. [Basic][B] |
| OAuth 2.0 delegado (3LO) | O usuário consente nos escopos; o app atua **em seu nome**, limitado às permissões dele. `GET https://api.atlassian.com/oauth/token/accessible-resources` identifica sites acessíveis, não permissões por Ticket. Chamada via `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`. Para operação posterior sem o usuário presente, `offline_access` e refresh token rotativo; revogação ou perda de acesso importa. Resolve delegação, não separação de autoria se a pessoa também responde no Ticket. [3LO][L] |
| Conta de serviço da organização + token de API com escopos | Identidade não associada a pessoa; admin concede acesso ao app, papéis e permissões no Jira. Token com expiração configurável (1–365 dias), revogável; para token com escopos, gateway `api.atlassian.com/ex/jira/{cloudId}`, com Bearer ou Basic conforme o guia. Distingue a conta técnica dos respondentes se for exclusiva; quem opera a credencial não é identificado pelo comentário. Há gestão de concessões e rotação. [Conta][S] · [Token de serviço][T] |
| Mesma conta de serviço + OAuth 2.0 de duas pernas (2LO) | Em organizações com **gestão centralizada de usuários**, `POST https://auth.atlassian.com/oauth/token` com `grant_type=client_credentials`, `client_id` e `client_secret` gera Bearer válido por 60 min; escopos são selecionados para a credencial. Usa o mesmo gateway Jira. Não requer consentimento interativo a cada Trabalho nem representa um respondente humano. Troca a gestão do token de API pela do segredo do cliente e pela emissão de tokens curtos; não dispensa permissões da conta. [2LO de serviço][K] · [Conta][S] |
| App instalado (Forge) | `api.asApp().requestJira(...)` atua como usuário do app; `asUser()` atua como usuário, com requisitos de consentimento/contexto. `asUser(accountId)` tem requisitos próprios de impersonação offline. O primeiro separa a autoria técnica, mas executar como app **não** autoriza o iniciador humano; o segundo não cria um autor técnico separado. Envolve instalação, escopos no manifesto e contexto de execução Forge, em vez de só um cliente REST externo. [Forge][F] · [Escopos][SC] |

**Identificação observável.** `GET /rest/api/3/myself` retorna o usuário corrente; exige acesso ao Jira e, em OAuth, `read:jira-user` clássico (granulares: `read:application-role:jira`, `read:group:jira`, `read:user:jira`, `read:avatar:jira`). Serve para confrontar o `accountId` efetivo com a identidade esperada da instalação. No comentário retornado, `id`, `author`, `updateAuthor`, `created`, `updated` e `self` são de leitura; não se escolhe o autor no corpo do POST. Comparar `author.accountId`, não `displayName` (pode variar por privacidade), e-mail (pode ser nulo), prefixo do texto, menção ou assinatura. O esquema `UserDetails` exemplifica tipos de conta (`atlassian`, `app`, `customer`), mas não promete um sinal de “digitado por humano” nem uma classificação própria das contas de serviço no comentário. Escopo de correlação: instalação/site + ID do Ticket + ID do comentário; manter à parte o ID da conta técnica. [Myself][M] · [Comment/UserDetails][O] · [Conta de serviço][S]

## 2. O que se pode ler e escrever no Ticket?

Caminhos relativos a `/rest/api/3`. Escopo da credencial/app e permissão Jira do principal são condições **cumulativas**. Escopos clássicos e granulares são alternativas; a referência recomenda clássicos para 3LO/Forge. As operações de comentários não são isentas das regras de acesso de apps. “Pode ser acessado anonimamente” na documentação não contorna as permissões e não identifica um operador. [Comentários][C] · [Escopos][SC]

| Operação | Permissões e resultado | Escopo OAuth clássico |
|---|---|---|
| `GET /issue/{issueIdOrKey}/comment` ou `GET /issue/{issueIdOrKey}/comment/{id}` | `Browse projects` + acesso ao Ticket se houver segurança no nível da issue + pertencer ao grupo/papel se o comentário for restrito. `200`: página dos visíveis ou comentário por ID. | `read:jira-work` |
| `POST /issue/{issueIdOrKey}/comment` | `Browse projects` + `Add comments` + acesso ao Ticket protegido. `201 Created` com `Comment`, inclusive `id` e `self`. A representação aceita `body`, `visibility` e `properties`. | `write:jira-work` |
| `PUT /issue/{issueIdOrKey}/comment/{id}` | Leitura/visibilidade acima + `Edit own comments` para o próprio ou `Edit all comments` para outro. `200` com estado atualizado. `DELETE` exige a permissão de apagar próprios/todos, conforme o autor; criação não requer edição nem exclusão. | `write:jira-work` |
| `GET /comment/{commentId}/properties/{propertyKey}` | Mesmas barreiras de leitura do comentário. Há também listagem das chaves. `PUT` na chave cria/atualiza JSON, requer `Edit own comments` ou `Edit all comments`; não é preciso esse segundo passo para enviar propriedades junto da criação. | `read:jira-work` / `write:jira-work` |

Para dimensionar uma instalação granular: a lista e o GET individual declaram **todos** `read:comment:jira`, `read:comment.property:jira`, `read:group:jira`, `read:project:jira`, `read:project-role:jira`, `read:user:jira`, `read:avatar:jira`. O POST e o PUT do comentário declaram esses mesmos escopos **mais** `write:comment:jira`. O GET/PUT dedicado de propriedade declara respectivamente `read:comment.property:jira`/`write:comment.property:jira`. Não confundir os escopos do endpoint com a necessidade de dar papéis administrativos ao principal. [Comentários][C] · [Propriedades][P] · [OpenAPI][O]

**Exemplo de pergunta, não uma chamada executada.** Corpo ilustrativo de `POST /rest/api/3/issue/FAB-42/comment`; `fab:tr-17:q-2` identifica *esta* pergunta, não a pessoa habilitada a respondê-la. O papel é apenas ilustrativo:

```json
{
  "body": {"version": 1, "type": "doc", "content": [
    {"type": "paragraph", "content": [
      {"type": "text", "text": "[fab:tr-17:q-2] Qual variante deve seguir para o PR?"}
    ]}
  ]},
  "visibility": {"type": "role", "value": "Developers"},
  "properties": [{"key": "factory.operation", "value": {"id": "fab:tr-17:q-2", "kind": "pergunta"}}]
}
```

O `body` de v3 é uma árvore ADF (`doc` versão 1 → blocos → nós inline); o leitor deve percorrer a estrutura, não presumir uma string, um único `text` nem analisar HTML de `expand=renderedBody`. Uma resposta pode ser outro comentário ADF com `Resposta a fab:tr-17:q-2: variante B`; um comando requer autorização própria. Um vínculo pode trazer a URL do PR e um resultado pode dizer `PR #18 integrado`, cada publicação com seu identificador de operação. São convenções possíveis, **não** tipos de mensagem, unicidade ou aprovação atestados pelo Jira. Nem o vínculo nem a notícia do merge exigem editar status ou resolução do Ticket. [ADF][A] · [Comentários][C] · [Esquema e exemplo de 201][O]

**Audiência.** `visibility.type` admite `group` ou `role`; `identifier` é ID do grupo ou nome do papel; `value` é nome, mutável para grupos. Omitir a restrição do comentário não remove a segurança do Ticket. A documentação alerta que comentários filhos herdam a visibilidade do pai e que alterá-la no filho dá `400`. Um marcador conhecido, um `id` ou um `self` não fazem um comentário aparecer para quem não o pode ler. Resultado vazio ou `404` não é prova de inexistência; não se deve transcrever a pergunta, a resposta ou seus dados para um comentário ou PR de audiência mais ampla por causa de uma falha de leitura. [Comentários][C] · [Visibility][O]

**JSM não é sinônimo dessa restrição.** Em solicitação de cliente existe `GET`/`POST /rest/servicedeskapi/request/{issueIdOrKey}/comment` com `body` textual e `public` (público ao cliente vs. nota interna). Para ler é preciso ver a solicitação; cliente só recebe comentários públicos. Para publicar é preciso `Add Comments`; cliente só publica como público. Escopos clássicos `read:servicedesk-request` e `write:servicedesk-request`. Não inferir `public:false` de `visibility.role` nem supor que criar um comentário Platform v3 já produz nota interna: `Comment.jsdPublic` é de leitura e o esquema descreve padrão `true` para criações na Platform. É necessário delimitar a superfície suportada antes de prometer confidencialidade. [JSM Request][J] · [Comment][O]

## 3. De comentário atribuído a comando autorizado

`author.accountId` prova **a qual conta o Jira atribuiu a criação**, não que a pessoa certa digitou o comando nem que ela pode iniciar, responder pelo Trabalho ou determinar o repositório de destino. `Add comments` autoriza comentar, não operar a fábrica. Ao interpretar o corpo **atual**, importa também `updateAuthor.accountId`: outra conta com `Edit all comments` pode substituir o texto sem mudar o criador. Por exemplo, um `id=10041` criado por A como pergunta e reescrito por B como comando não é um comando assinado por A. Reciprocamente, uma edição pela conta da fábrica não converte o texto original em autorização humana. [Comentários][C] · [Comment][O]

Alternativas de autorização a decidir pela equipe, sempre vinculadas à instalação, ao Ticket/Trabalho e à ação em análise:

- **Relação explícita de `accountId` humanos e capacidades** por instalação/projeto/repositório: dispensa ler diretório a cada comando, mas entrada, revogação, conta técnica exclusiva e sincronização com a equipe ficam sob governança local. Um ID ausente/desconhecido ou só um nome não demonstra autorização. [UserDetails][O] · [Conta de serviço][S]
- **Delegar a elegibilidade a grupo/papel Jira**: `GET /rest/api/3/user/groups?accountId=…` exige permissão global `Browse users and groups` (`read:jira-user` ou `read:group:jira`). `GET /rest/api/3/project/{projectIdOrKey}/role/{id}` retorna atores diretos e grupos, exige `Administer Projects` ou `Administer Jira` (`read:jira-work` clássico); considerar associação indireta por grupo. Obtém-se associação presente, não uma decisão histórica da fábrica. O custo de privilégio e a regra que traduz um papel em capacidade precisam de decisão explícita. [Operações e escopos no OpenAPI][O]
- **Verificar uma permissão contextual**: `GET /rest/api/3/mypermissions?issueKey=FAB-42&permissions=BROWSE_PROJECTS,ADD_COMMENTS` consulta **o chamador** (`read:jira-work` ou `read:permission:jira`); sem contexto da issue, um resultado pode valer apenas para *alguma* issue. `POST /rest/api/3/permissions/check` admite `accountId` e IDs de issues/projetos; para terceiros exige em regra `Administer Jira` (exceção documentada para Connect server-to-product; escopo granular `read:permission:jira`). Não confundir a permissão presente do bot com a do autor, nem uma permissão Jira com um mandato para agir no GitHub. [Permissões][D]

Sem evidência suficiente sobre autor/editor, vigência da autorização ou vínculo com a pergunta e o Trabalho, a documentação só sustenta **“não verificado”**, não aceitação do comando. A spec ainda deve dizer quando avaliar/reavaliar essas condições e o que fazer com comandos já consumidos que sejam editados ou apagados. [Comentários][C] · [Permissões][D]

## 4. Reler edições e reconciliar publicação incerta

**Leitura incremental.** A lista aceita `startAt`, `maxResults`, `orderBy` (`created`, `+created`, `-created`) e `expand`; a página traz `comments`, `startAt`, `maxResults`, `total`. Não há na assinatura filtro `updatedSince`, ordenação por última edição nem consulta por marcador. O total pode mudar entre páginas e uma página pode vir vazia; percorrer os limites efetivamente retornados, deduplicando por ID, não oferece um instantâneo. Buscar só os “criados depois” perde a edição de ontem no comentário do mês passado. Para IDs conhecidos, reler pelo GET individual e comparar `updated`, `updateAuthor` e corpo com a observação anterior; para comentários desconhecidos, revarrer páginas visíveis. `POST /rest/api/3/comment/list` também lê por **IDs já conhecidos**, não resolve a descoberta de um POST sem ID. Os eventos `comment_created`, `comment_updated`, `comment_deleted` podem disparar releitura, mas a Atlassian prevê duplicatas e entregas perdidas; `X-Atlassian-Webhook-Identifier` deduplica entregas repetidas no site, não criações de comentários. Nada disso é um histórico completo das versões intermediárias. [Comentários][C] · [Paginação][I] · [Webhooks][W] · [Assinaturas][O]

**POST aplicado, resposta perdida.** A referência de `Add comment` descreve `201` com ID atribuído pelo servidor. Na operação/esquema consultados **não** há parâmetro ou cabeçalho `Idempotency-Key`, ID de comentário escolhido pelo cliente, unicidade de `properties`/texto, nem busca de comentários por valor de propriedade. Esta é evidência negativa **sobre o contrato publicado**, não uma afirmação sobre a implementação interna. Um timeout admite tanto “não criado” quanto “criado e sem confirmação”; repetir o POST pode publicar duas vezes. [Comentários][C] · [OpenAPI][O] · [Propriedades][P]

| Observação recuperável | O que ela permite concluir |
|---|---|
| `201` recebido e ID guardado | Há confirmação daquele comentário; reler por `(site, issueId, commentId)`. O `id` identifica a mensagem, não uma versão imutável do texto. |
| Sem ID; um candidato visível | Exemplo de reconciliação: registrar a operação antes do envio; listar páginas da mesma issue e confrontar **conta técnica, marcador e conteúdo esperado**. Se o marcador está em propriedade, ler `GET /comment/{commentId}/properties/factory.operation` para candidatos; não pressupor expansão da propriedade na listagem. Uma correspondência explica a operação observada, não exclui cópias ocultas. |
| Sem candidato, leitura parcial, `404`, ou identidade/visibilidade alterada | Continua incerto: pode não ter sido criado, ter sido editado, apagado, ocultado ou não observado na paginação concorrente. Falta de correspondência não torna seguro repetir. Marcador copiado por outra conta ou propriedade mutável não é prova de autoria. |
| Vários candidatos válidos | Há ambiguidade ou duplicatas; não há base documental para escolher o primeiro, emitir um novo efeito ou apagar comentários automaticamente. O tratamento operacional de pendência, nova tentativa ou intervenção é decisão da spec. |

O mecanismo de reconsulta da tabela é uma **alternativa de recuperação do cliente**, não idempotência do servidor. Há um contraste útil para o **vínculo externo**, não para a conversa: com issue linking habilitado, `POST /rest/api/3/issue/{issueIdOrKey}/remotelink` **cria ou atualiza** pelo `globalId` fornecido (p.ex. `factory:repo-7:pr-18`), e `GET` no mesmo recurso com `?globalId=…` reencontra o vínculo. POST exige `Browse projects` + `Link issues`, GET exige `Browse projects`, ambos sujeitos à segurança da issue; escopos clássicos `write:jira-work` / `read:jira-work`. Campos não enviados no update são zerados; não omitir dados que se pretenda preservar. Um comentário com URL exige menos capacidades funcionais e participa da conversa, mas não herda essa semântica. O *upsert* documentado é específico do remote link, não uma garantia transacional entre link, comentário de resultado e PR, nem de execução única sob concorrência. [Remote links][R] · [Comentários][C]

**Rate limits.** Pode haver `429 Too Many Requests`. A Atlassian diferencia cotas por pontos, rajadas e escritas repetidas na mesma issue; ressalva que tráfego com API token não foi incluído na mudança para pontos e segue sujeito a limites de rajada. Não fixar uma cota universal. Interpretar `RateLimit-Reason` quando presente (p.ex. `jira-per-issue-on-write`), respeitar `Retry-After` em segundos e aplicar espera exponencial com jitter em tentativas cabíveis. A orientação de retry pede operação idempotente e `Retry-After`; ela não torna `Add comment` idempotente. Uma releitura que parou por limite também não comprova ausência. [Rate limiting][Q]

**Limites para revisão.** Para este Ticket, há contrato suficiente para descrever leitura, atribuição, escopo e reconciliação **do que é visível**. Ficam em aberto: qual principal a equipe consegue isolar; quais pessoas podem fazer o quê, inclusive após edição/revogação; se JSM faz parte do recorte; e como tratar publicação inconclusiva sem presumir sucesso ou duplicar o efeito. A documentação não qualifica os papéis, políticas de acesso de apps, restrições e planos de uma instalação particular, nem oferece prova de humanidade, varredura completa do invisível ou publicação única de comentário. Nenhuma dessas propriedades foi homologada aqui.

[C]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
[O]: https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json
[S]: https://support.atlassian.com/user-management/docs/understand-service-accounts/
[B]: https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
[L]: https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
[T]: https://support.atlassian.com/user-management/docs/manage-api-tokens-for-service-accounts/
[K]: https://support.atlassian.com/user-management/docs/create-oauth-2-0-credential-for-service-accounts/
[F]: https://developer.atlassian.com/platform/forge/apis-reference/fetch-api-product.requestjira/
[SC]: https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/
[M]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/
[P]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comment-properties/
[A]: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
[J]: https://developer.atlassian.com/cloud/jira/service-desk/rest/api-group-request/
[D]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permissions/
[I]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
[W]: https://developer.atlassian.com/cloud/jira/platform/webhooks/
[R]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/
[Q]: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
