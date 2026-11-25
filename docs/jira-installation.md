# Jira Cloud como origem de Tickets

Uma instalação com `config.yaml` **schemaVersion 2** pode receber Tickets de um projeto Jira Cloud ao
lado do GitHub. O Card marcado vira um Trabalho num repositório GitHub já autorizado como destino; a
conversa (perguntas, respostas, cancelamento) acontece no Card; o PR continua no GitHub e o Card recebe
um *remote link* para ele e um aviso quando o merge é confirmado. A Factory **nunca** escreve status,
responsável ou resolução no Jira.

No YAML **schemaVersion 1** nada disso existe: nenhum cliente Jira é criado e nenhum arquivo de
credencial Jira é aberto. Para manter só o GitHub, não é preciso mudar nada.

## 1. Preparar a conta e o token (no host)

- Use uma conta Atlassian que consiga, **no projeto configurado**: *Browse projects* (ler projeto,
  Tickets, vínculos, categoria de status e comentários), *Add comments* (comentários comuns, sem
  restrição de visibilidade) e *Link issues* (manter os *remote links* da Factory). Nada além disso.
- **Não** é preciso uma conta exclusiva nem informar `accountId`: a Factory reconhece os próprios
  comentários pelo cabeçalho reservado `[Software Factory · …]` e descobre a conta pela própria leitura.
  Comentários seus, feitos pela mesma conta, continuam valendo como conversa ou comando.
- Crie um token de API dessa conta e grave-o **somente** num arquivo sob `credentials/` da raiz,
  arquivo regular seu, com uma única ligação, modo `0600`, dentro de diretórios `0700`:

```sh
umask 077
printf '%s\n' "$TOKEN_COLADO_NO_TERMINAL" > /caminho/privado/factory/credentials/jira-token
chmod 600 /caminho/privado/factory/credentials/jira-token
```

O token é lido pelo controlador a cada requisição Jira (trocar o conteúdo do arquivo troca o token, sem
reinício). Ele vai apenas no cabeçalho de autenticação para a origem configurada: não entra em
prompts, no agente, em observações, Records, comentários, logs, `status` ou `doctor`. Valores com
formato de token (`ATATT…`) dentro do `config.yaml` fazem a configuração inteira ser recusada.

## 2. Configurar a fonte (`config.yaml` v2)

```yaml
schemaVersion: 2
# ... operators, models, githubApp, sandbox como no v1 ...
repositories:
  - {repository: equipe/payments-api, base: main, installationId: 456, workflows: false}
  - {repository: equipe/checkout-web, base: main, installationId: 456, workflows: false}
ticketSources:
  - {tracker: github, repository: equipe/payments-api, discover: true}
  - tracker: jira
    discover: true
    siteId: site-A                       # nome estável escolhido por você para este site
    url: https://equipe.atlassian.net    # só a origem https, sem caminho
    email: fabrica@example.org           # e-mail da conta do token
    tokenFile: credentials/jira-token
    projectId: '10010'                   # ID numérico do projeto (não a chave PAG)
    label: factory-ready                 # etiqueta que marca o Card (sem espaços)
    routes:                              # componente (por ID) -> repositório de destino
      - {componentId: '10021', repository: equipe/checkout-web}
      - {componentId: '10022', repository: equipe/payments-api}
    linkTypes:                           # opcional: sentido de tipos de vínculo customizados (por ID)
      - {id: '10500', blocks: inward}    # o vizinho em inwardIssue bloqueia o Card
      - {id: '10501', blocks: none}      # nunca bloqueia
```

- No v2, um repositório só é origem GitHub se aparecer em `ticketSources` com `tracker: github`.
  Rotas só podem apontar para repositórios de `repositories` (nunca para `dependencyRepositories`).
- Um Card é admitido quando tem a etiqueta, está no projeto, os componentes levam a **um único**
  destino e os bloqueadores visíveis (`is blocked by`) estão em *Done*. Rota ausente, destinos
  divergentes ou bloqueador aberto viram um aviso no Card; leitura incompleta fica só no diagnóstico
  local. A Factory só enxerga o que a conta enxerga: ausência visível não prova ausência global.
- O tipo `Blocks` padrão do site (nome e rótulos originais, único) é interpretado sozinho. Um tipo de
  vínculo customizado (`JIRA_LINK_TYPE_CUSTOM`) ou um `Blocks` editado/duplicado
  (`JIRA_LINK_DIRECTION_AMBIGUOUS`) **impede a admissão** até você indicar o sentido em `linkTypes`, pelo
  ID do tipo (`GET /rest/api/3/issueLinkType`; o diagnóstico mostra o ID): `inward` = o vizinho que vem
  como `inwardIssue` bloqueia o Card, `outward` = o que vem como `outwardIssue` bloqueia, `none` = o tipo
  nunca bloqueia. A indicação nunca substitui o `Blocks` padrão nem os tipos padrão que não bloqueiam.
  Como o catálogo é do site, todas as fontes de um mesmo `siteId` precisam da mesma lista.
- A configuração é lida no início do controlador: depois de editar, reinicie o serviço.

## 3. Conferir o acesso

Com o controlador no ar:

```sh
./factory doctor --authenticated --root /caminho/privado/factory --json
```

`jiraResults` traz uma linha por fonte Jira, de **uma** leitura das permissões da conta no projeto
(`/rest/api/3/mypermissions`): `facts.projectRead`, `facts.commentCreate` e `facts.remoteLinks` são
`granted`, `missing` ou `unverified`; `commentAudience` e `blockerVisibility` são sempre `unverified`
(nenhuma conta prova quem vê os comentários nem bloqueadores em projetos que ela não lê). Permissão
faltando dá `JIRA_PERMISSION_MISSING` com a permissão a pedir ao administrador do Jira; token ilegível
dá `JIRA_CREDENTIAL_UNAVAILABLE`. Qualquer resultado diferente de `ok` sai com exit 3. A Factory nunca
pede nem amplia acesso por conta própria.

## 4. Usar pelo Card

- **Pergunta**: a Factory comenta `[Software Factory · Pergunta Q-n]`. Responda num comentário **novo**
  que comece por `/factory <resposta>` (se for a única pergunta aberta do Card), `/factory qN: <resposta>`
  ou `/factory answer Q-N <resposta>`. Comentário editado, restrito ou sem o prefixo não é instrução.
  Comentário sem autor observado pela API, ou cujo corpo não é um documento ADF válido, também não:
  fica registrado localmente como entrada ignorada (`JIRA_COMMENT_AUTHOR_UNOBSERVED`,
  `JIRA_COMMENT_ADF_INVALID`), sem resposta no Card; para valer, publique um comentário novo.
- **Cancelar**: exatamente `/factory cancel` (a palavra `cancel` em minúsculas, sozinha) cancela o
  Trabalho daquele Card (resposta no próprio Card). `cancel` seguido de qualquer coisa
  (`/factory cancel PAG-43`) recebe orientação e não cancela nada. Outra palavra, mesmo parecida
  (`/factory cancelado não, siga`, `/factory CANCEL`), é texto livre: vale como resposta à pergunta
  aberta, nunca como cancelamento.
  Comandos globais (`pause`, `resume`, `forget`, `cleanup`, `new`…) continuam só na CLI local.
- **PR**: a descrição do PR leva `Jira Card <CHAVE>: <url>` e nenhuma palavra de fechamento do GitHub.
  O Card recebe o *remote link* `Trabalho T-n · …` (atualizado na entrega ou no fechamento sem merge) e,
  após o merge confirmado no GitHub, o aviso `[Software Factory · Entrega T-n]`.

## 5. Suspender novas entradas

Para parar de admitir Cards, troque `discover: true` por `discover: false` na fonte Jira e reinicie.
Isso desliga **só novas admissões** daquela fonte (o Jira não é nem listado). Trabalhos já admitidos
continuam ligados ao Card persistido: perguntas, respostas, `/factory cancel`, link e aviso de entrega
seguem no mesmo Card.

**Não remova a fonte** (nem o site) de `ticketSources` enquanto houver Trabalhos dela em andamento:
sem a fonte configurada a autorização do Trabalho deixa de ser confirmada (`JIRA_SOURCE_NOT_CONFIGURED`)
e os avisos pendentes deixam de ser enviados. Nada é redirecionado para o GitHub nem para outra fonte.

## 6. Recuperar acesso

Se o arquivo do token sumir, ficar ilegível ou com modo inseguro, nada é enviado e nada é perdido:

- `./factory status --json` mostra cada efeito pendente com o Card (`destination.key`, ex. `PAG-42`), o
  Trabalho (`purpose.workId` / `workId`), o motivo (`diagnostic.code = JIRA_CREDENTIAL_UNAVAILABLE`) e a
  ação segura (`diagnostic.nextStep`): em `jiraNotices.unpublished` (perguntas, respostas, avisos de
  entrega) e em `jiraLinks.pending` (*remote links*).
- O merge continua sendo registrado como **Entregue** a partir do GitHub, sem esperar o Jira.
- Restaure o arquivo (`0600`, mesmo caminho). Na leitura seguinte os efeitos são enviados uma vez, no
  mesmo Card, sem comando do operador. Enquanto o token falta, um efeito nunca é abandonado.
- Outras recusas do Jira (401, 403, 404, 429) também ficam visíveis em `status`. Nenhum comentário é
  abandonado: recusado ou com POST incerto, ele continua pendente com o motivo e é reenviado (sempre
  com a mesma referência) com espera crescente e limitada, de 1 a 15 minutos; um 429 respeita o
  `Retry-After`.
- Quando uma resposta do Jira se perde depois de um POST, a Factory relê os comentários antes de
  reenviar; duas cópias próprias ficam como pendência `JIRA_COMMENT_MULTIPLE` para você apagar a sobra.

## 7. Atualizar para esta release

A release com Jira usa o formato de armazenamento 3 ou posterior (a release com Triagem usa o 4). A
atualização segue `factory upgrade` com a migração explícita que `factory upgrade check` informa em
`migration.required`: os passos do formato atual até o da release, em ordem e separados por vírgula
(`--migrate factory-storage-3-to-4` a partir do formato 3,
`--migrate factory-storage-2-to-3,factory-storage-3-to-4` a partir do 2). O rollback é pré-checado
contra dados **e** `config.yaml`: um `config.yaml` v2 não volta para release que só aceita v1.

## Limites da evidência

Todo o fluxo foi validado offline, com sites Jira e GitHub simulados, IDs e token sintéticos
(`test/entrypoints/jira-coexistence-composed.test.ts` e os testes `test/control/jira-*`). Isso **não**
homologa permissões reais, audiência dos comentários, comportamento real do *remote link* nem acesso ao
PR num tenant. Uma homologação exige ensaio separado e autorizado, conforme os
[guardrails de ensaios](agents/experiment-proofs.md).
