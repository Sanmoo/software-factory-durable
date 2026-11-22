# Instalação Lambda (adapter `lambda`)

O adapter `lambda` roda cada boot numa MicroVM do serviço Lambda MicroVMs, na conta AWS do
Operador. A Factory **nunca cria IAM** e **não guarda credenciais AWS**: o Operador prepara a
conta com o template da release e configura um perfil AWS nomeado; a Factory passa só o nome do
perfil ao `aws` (CLI), que resolve as credenciais.

Nesta release o adapter é **validado** por `factory doctor`, **prepara** a imagem de MicroVM de um
ambiente (seção 5) e o controlador **executa Trabalhos** sob ele, do Ticket ao PR (seção 6).

**Requisito da instalação: a branch base de cada repositório precisa estar protegida** por branch
protection ou por um ruleset que exija pull request, sem bypass para a GitHub App da Factory. Neste
perfil o Builder tem o token de escrita durante toda a Execução (ele precisa publicar trabalho em
andamento a qualquer momento, porque o ambiente não guarda disco). A política de push do host é uma
conferência do texto do comando, **não é um sandbox**: quem impede escrita fora da branch do
Trabalho é a proteção do repositório. O Controle, por sua vez, só pede a publicação quando lê que a
base exige pull request (senão bloqueia com `BASE_PROTECTION_NOT_VERIFIED`) e confere a ponta da
branch no `origin` antes de vincular o PR. (Decisão 10 do Operador, 2026-11-21.) O `doctor` não
confere a proteção da base.

## 1. Preparar a conta (uma vez por instalação)

Pré-requisito no host: AWS CLI com os comandos `aws lambda-microvms`.

O template fica na release em `assets/lambda/account-template.yaml` (CloudFormation). Aplique-o
com uma identidade administrativa **sua**, na região do perfil, com o nome da instalação:

```sh
aws cloudformation deploy --region us-east-1 --stack-name factory-acme \
  --template-file releases/<release>/assets/lambda/account-template.yaml \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides Installation=acme
```

Ele cria exatamente três recursos, todos com a tag `software-factory-installation=<instalação>`:

| Recurso | Nome | Uso |
| --- | --- | --- |
| Role de operação | `factory-<instalação>-operation` | Assumida pela Factory pelo perfil AWS nomeado. Política mínima abaixo. |
| Role de build | `factory-<instalação>-build` | Assumida só pelo build de imagem do serviço: lê o artefato e escreve o log do build. |
| Bucket de artefatos de build | `factory-<instalação>-build-<conta>-<região>` | Recebe o artefato de cada build de imagem. Acesso público bloqueado. |

Os nomes são derivados do nome da instalação (até 20 caracteres, minúsculas, dígitos e hífen); não
há campo de configuração para eles. O parâmetro opcional `OperatorPrincipalArn` restringe quem pode
assumir a role de operação; vazio, vale a política da própria conta.

### Política da role de operação e limite conhecido

A role opera só sobre recursos da instalação: imagens `factory-<instalação>-*` (as ações de
MicroVM são autorizadas pelo ARN da imagem), o bucket, a role de build (`iam:PassRole`,
`iam:GetRole`) e os logs de build dessas imagens. Lê a própria política
(`iam:SimulatePrincipalPolicy`) e as quotas (`servicequotas:ListServiceQuotas`) para o `doctor`.

**Limite conhecido do serviço:** `lambda:CreateMicrovmImage` e `lambda:TagResource` não aceitam
restrição por recurso. Por isso a política as concede em `*`: a primeira sem condição, a segunda
só quando a requisição leva a tag `software-factory-installation` da instalação. Consequência: a
role consegue criar imagens de MicroVM com qualquer nome na conta e região, e marcar com a tag da
instalação qualquer recurso Lambda que aceite tag. `lambda:ListMicrovmImages` e
`lambda:ListMicrovms` também ficam em `*` (listagem). Use uma conta dedicada se esse alcance for
inaceitável.

O escopo por ARN de imagem das demais ações segue a documentação do serviço; as provas rodaram com
todas as ações em `*`. Se o `doctor` passar e uma operação real for negada, o diagnóstico nomeia a
ação.

## 2. Perfil AWS nomeado

No `~/.aws/config` da conta do host que roda a Factory, um perfil que assume a role de operação
(a saída `OperationRoleArn` do stack):

```ini
[profile factory]
role_arn = arn:aws:iam::<conta>:role/factory-acme-operation
source_profile = <seu perfil de origem>   # ou credential_process / sso_session
```

As credenciais de origem ficam com o tooling AWS. Não coloque chave de acesso em `config.yaml`:
o schema não tem campo para isso e recusa valor com forma de access key. A Factory chama o `aws`
sem herdar `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE` nem
`AWS_REGION` do ambiente: valem só o perfil e a região do `config.yaml`.

## 3. `config.yaml`

```yaml
sandbox:
  schemaVersion: 1
  adapter: lambda
  awsProfile: factory     # NOME do perfil AWS, obrigatório
  installation: acme      # nome usado no template, obrigatório
```

Perfil do adapter (defaults = perfil de aceite), visível em `doctor --json`:

| Campo | Default | Observação |
| --- | --- | --- |
| `region` | `us-east-1` | Outra região é aceita e marcada como não provada. |
| `architecture` | `arm64` | `x86_64` é aceito e marcado como não provado. |
| `baselineMemoryMiB` | 1024 | Baseline 1 GB / 0,5 vCPU; o guest enxerga o pico, 4x: 4 GB / 2 vCPU. A quota conta o pico. |
| `additionalOsCapabilities` | `[ALL]` | |
| `maxBootSeconds` | 3600 | 1 a 28800. Acima de 3600 é aceito e marcado como **não provado**. |
| `rotationMarginSeconds` | 600 | Menor que a duração. |
| `observationIntervalSeconds` | 30 | |

Região, tamanho e os demais campos ficam no adapter. O Controle recebe só as capacidades
declaradas: Docker, sem disco que sobrevive ao boot, duração e margem do boot, saída TCP pública
sem mediação.

## 4. `factory doctor`

Não inicia MicroVM, não cria nem marca nada e não grava nada na instalação. Checks (cada causa
tem o seu):

| Check | Bloqueia quando |
| --- | --- |
| `lambda-ssh` | `ssh` (cliente OpenSSH) não pode ser executado a partir do `PATH` do processo. |
| `lambda-websocat` | `websocat` não pode ser executado a partir do `PATH` do processo. |
| `lambda-aws-cli` | `aws` ausente ou sem os comandos `lambda-microvms`. |
| `lambda-aws-profile` | O perfil nomeado não existe. |
| `lambda-identity` | O perfil não dá identidade (sem credenciais, sessão expirada). |
| `lambda-operation-role` | O perfil não assume `factory-<instalação>-operation` (role ausente ou outro perfil). |
| `lambda-region` | O serviço não responde na região, ou o bucket está em outra região. |
| `lambda-permission:<ação>` | A role não tem a ação nomeada (simulação da política, ou leitura negada). Exceção: `lambda-permission:lambda:PassNetworkConnector` nunca bloqueia pela simulação, só aparece como `unverified` (ver abaixo). |
| `lambda-build-role`, `lambda-artifact-bucket` | O recurso de instalação não existe. |
| `lambda-quota` | `concurrency` x memória de pico por MicroVM excede a quota de memória alocada lida da conta. Nada é ajustado: reduza `concurrency` ou o tamanho, ou peça aumento de quota. |

`unverified`: `lambda-boot-duration` (duração acima de 3600 s), `lambda-acceptance-profile` (fora
do perfil de aceite), `lambda-runtime` (build, boot e canal só são provados numa execução real
autorizada), e qualquer leitura que não pôde ser feita (por exemplo `lambda-quota` quando a quota
não pôde ser lida; a leitura de quota ainda não foi observada numa conta real).

`lambda-permission:lambda:PassNetworkConnector` também sai como `unverified`: o simulador de
políticas do IAM não avalia essa ação e responde negação (`implicitDeny`, nenhuma declaração
casada) para qualquer recurso, mesmo quando a role tem a declaração `NetworkConnectors` do
template (observado numa conta real em 2026-11-21, em que um RunMicrovm real funcionou com a
mesma role). Não é falha de instalação e não exige ação: só um RunMicrovm real prova essa
permissão. As demais ações continuam bloqueando quando a simulação as nega.

## 5. Imagens de MicroVM (Preparar)

Cada repositório declara o ambiente em `.factory/environment.yaml` (mesmo esquema do Gondolin). No
Preparar, o adapter garante uma imagem de MicroVM por **chave de ambiente**: repositório, hash do
arquivo e pin da release (o perfil da imagem, arquitetura e memória baseline, entra junto).

- O `Dockerfile` é montado pela Factory a partir dos valores validados: parte de Alpine por digest,
  instala os pacotes do molde nas versões do pin da release e os pacotes declarados nas versões
  exatas. Nenhum texto do repositório entra nele. As imagens Docker declaradas não são embutidas:
  são baixadas por digest a cada boot.
- A imagem se chama `factory-<instalação>-<32 hex da chave>`; o artefato de build vai para o bucket
  como `<nome da imagem>.zip`. Os dois levam as tags `software-factory-installation` e
  `software-factory-work` (o Trabalho cujo Preparar criou a imagem; outros Trabalhos com a mesma
  chave reutilizam a imagem sem novo build). O log group do build
  (`/aws/lambda-microvms/<nome da imagem>`) é criado pelo serviço, sem tags.
- Mudar o arquivo de ambiente ou atualizar a release gera chave e imagem novas. Um Trabalho em
  andamento continua na imagem com que começou.
- Falha de build vira impedimento do Trabalho com a causa lida do log de build (por exemplo o
  pacote e a versão que o `apk` recusou). Não há outra versão, outra imagem nem nova tentativa
  automática: corrija a declaração (chave nova) ou peça o retry do ambiente, que apaga a imagem
  falha e constrói a mesma chave de novo.
- O mirror do Alpine guarda só o build atual de cada pacote: uma versão fixada (do molde ou da
  declaração) deixa de construir quando o Alpine publica outra revisão. A causa aparece no
  impedimento; para o molde, o remédio é uma release com pin novo.
- Imagens não são apagadas pelo Preparar nem pela remoção do ambiente de um Trabalho; saem só pelo
  cleanup explícito (seção 8).

## 6. Boots (Iniciar, Observar, Parar)

O adapter inicia, observa e para cada boot, e o controlador executa Trabalhos sob ele: cada boot é
uma MicroVM nova, o commit de partida é clonado do `origin` dentro do guest e nada do disco
sobrevive ao fim do boot.

- **Pré-requisitos do host:** `ssh` (cliente OpenSSH) e `websocat` no `PATH`, além do `aws`. O
  canal é SSH transportado em WebSocket pelo `HTTP_INGRESS` da MicroVM. O `doctor` confere se os
  dois podem ser executados (`lambda-ssh`, `lambda-websocat`); o canal em si só é provado num boot real.
- **Iniciar** é sempre uma MicroVM nova da imagem do Trabalho, com `INTERNET_EGRESS`, sem execution
  role e sem suspensão por ociosidade, com as tags `software-factory-installation` e
  `software-factory-work`. Só há sucesso com o canal estabelecido e o commit de partida clonado do
  `origin` dentro do guest. Cada boot começa vazio: sem caches, sem dados do Docker; as imagens
  Docker declaradas são baixadas por digest de novo.
- **Rede do guest:** qualquer destino público IPv4 por TCP, sem mediação nem filtro; sem UDP e sem
  IPv6 de saída; sem acesso à rede privada do Operador (sem VPC).
- **Credenciais:** a chave SSH de sessão é gerada no host a cada boot (só a pública vai ao guest,
  no payload do hook de início) e a host key do guest, gerada no boot, é fixada pelo host no
  primeiro contato; conexão com outra host key é recusada. O token do serviço vale para uma porta e
  só é necessário para abrir conexão. Retirar acesso é fechar a conexão ou encerrar a MicroVM. O
  token Git do clone vai por ambiente de processo pelo canal e não é gravado no guest. Credenciais
  AWS nunca saem do host.
- **Observar** lê a condição no serviço (`GetMicrovm`), de qualquer processo.
- **Parar** pede `TerminateMicrovm` e só confirma quando o serviço informa `TERMINATED`; sem essa
  confirmação o resultado é indeterminado. Nada do disco é preservado.
- **Registros:** `<raiz>/lambda/works/<ambiente>/boots/<boot>/boot.json` guarda identidade, motivo
  de início (início ou troca planejada) e de fim (troca planejada, perda ou fim), tamanho, início e
  fim. A evidência do guest é a que o host leu pelo canal (`evidence/`); o que não foi lido antes
  de uma morte consta como perdido.

## 7. Tags, evidência e reconciliação depois de crash

Todo recurso que a Factory cria na conta leva `software-factory-installation=<instalação>` e
`software-factory-work=<Trabalho>`: a imagem de MicroVM, o artefato de build e a MicroVM (a tag de
Trabalho de uma imagem compartilhada nomeia o Trabalho cujo Preparar a criou).

**Evidência de ciclo de vida.** `RunMicrovm` e `TerminateMicrovm` **não aparecem no CloudTrail por
padrão**, e sem execution role não há logs de runtime do guest. A evidência de início e fim de uma
MicroVM é a resposta do `GetMicrovm` (estado, `startedAt`, `terminatedAt`, motivo), gravada pelo
host no registro do boot e no registro de cada inventário. A evidência do guest é a que o host leu
pelo canal; o que não foi lido antes de uma morte consta como perdido. Quem precisar de trilha no
CloudTrail deve habilitar os eventos de dados do serviço na própria conta; a Factory não depende
disso.

**Reconciliação.** O dono de um boot vive no processo do controlador: se o controlador morre, a
MicroVM continua rodando sem dono (até a duração máxima do boot). Ao subir, depois do lock
exclusivo e antes de abrir o armazenamento, o controlador inventaria a conta:

- Lista as MicroVMs (`ListMicrovms`) e considera só as da instalação: as que levam a tag da
  instalação ou, como a listagem observada não mostra tags de MicroVM, as que rodam de uma imagem
  `factory-<instalação>-<32 hex>` que tem a tag da instalação (`GetMicrovmImage`). MicroVM de outra
  instalação ou de terceiros não é lida por id, alterada nem registrada.
- MicroVM que um registro de boot ainda detém é listada com o Trabalho. O Controle encerra o boot
  de toda Execução que não está viva (nunca adota), com cessação confirmada por `GetMicrovm`, e
  grava a reconciliação no histórico da Execução.
- MicroVM da instalação que nenhum registro de boot detém (o `RunMicrovm` respondeu a um processo
  que morreu antes de gravar o id) é encerrada pelo próprio inventário, com a mesma confirmação.
- Um início cujo `RunMicrovm` nunca foi respondido só é dado por encerrado quando a listagem foi
  lida e tudo o que ele poderia ter deixado foi confirmado como encerrado.
- Cada inventário que achou algo da instalação fica em `<raiz>/lambda/reconciliations/`.

Se a conta não puder ser listada, o inventário é **desconhecido**: nada é encerrado, o despacho
fica fechado e o controlador escreve `RUNTIME_INVENTORY_UNKNOWN` com a causa. Restaure o acesso
(`factory doctor`) e reinicie. Uma MicroVM cujo fim o serviço não confirmou, ou cuja imagem não
pôde ser lida, aparece como recurso desconhecido e também mantém o despacho fechado.

O `RunMicrovm` não aceita tags (observado em conta real em 2026-11-21: o comando é recusado inteiro com
a opção `--tags`), então a MicroVM não leva tag própria: o inventário decide a quem ela pertence pelas
tags da imagem e pelos registros de boot do host.

Não provado em conta real: a paginação do
`ListMicrovms` (50 por página); e a consistência da listagem logo depois de um `RunMicrovm` (uma
MicroVM criada instantes antes do crash e ainda ausente da listagem só seria achada no inventário
seguinte, ou encerrada pelo serviço na duração máxima). `tag:GetResources` não é usado nem está na
política: o inventário usa só ações que a role já tinha.

## 8. Cleanup explícito de imagens

```sh
factory cleanup-images                  # plano: lista as imagens da instalação e o que as detém
factory cleanup-images --yes            # apaga toda imagem removível
factory cleanup-images <nome> --yes     # apaga uma imagem; recusa se estiver em uso
```

Uma imagem está **em uso**, e nunca é apagada, enquanto: o ambiente de algum Trabalho a registra
(o registro nasce no primeiro Preparar do Trabalho e some quando o ambiente do Trabalho é removido,
o que só acontece com Trabalho encerrado); ou alguma MicroVM não encerrada roda dela; ou ela ainda
está em build. Pedir pelo nome uma imagem em uso é recusado com `IMAGE_IN_USE` (saída 1) e nada
muda. Sem `--yes` nada é alterado. O cleanup apaga a imagem (a versão antes), o artefato de build
no bucket e o log group do build. Só imagens com o nome **e** a tag da instalação são consideradas;
uma imagem cujas tags não puderam ser lidas é mostrada e deixada como está.

O comando roda no próprio CLI, ao lado do controlador, sem lock: use-o para imagens de Trabalhos
encerrados (uma mudança do arquivo de ambiente ou uma release nova deixam para trás a imagem da
chave antiga).

## 9. Consumo e custo

A Factory mede **MicroVM-segundos** e não calcula valor em dinheiro: não há preço, estimativa nem
teto em dólares em lugar nenhum. Os limites de um Trabalho continuam sendo as retomadas
operacionais, o timeout por Execução e a duração máxima do boot.

- **Por boot:** `boot.json` guarda também os segundos, que são o `terminatedAt` menos o `startedAt`
  informados pelo serviço (`GetMicrovm`), nunca o relógio do host. Um boot cujo fim o serviço não
  confirmou, ou cujo início ficou sem resposta legível, fica com consumo **desconhecido**, não
  zero. Um início recusado antes de existir MicroVM consta como não executado.
- **Por Trabalho:** `factory usage <trabalho>` mostra, em `boots`, cada boot (identidade, motivo de
  início e de fim, tamanho, início, fim, segundos) e a soma dos segundos medidos por todos os boots
  e Execuções do Trabalho, sem reinício. Com algum boot ainda rodando ou desconhecido, `lowerBound`
  é verdadeiro: o total real é pelo menos a soma mostrada. A soma continua visível depois do
  Remover.
- **Builds de imagem:** `factory usage` (instalação) mostra, em `environmentBuilds`, os builds
  pedidos por chave de ambiente, quantos Trabalhos usam cada chave e o resultado do último build.
  O registro fica em `<raiz>/lambda/image-builds.jsonl`. O retry de um build falho conta como outro
  build da mesma chave.

### Conferir o custo pela tag da instalação

O custo é o que a AWS cobra, e a conferência é do Operador, na própria conta:

1. No console de Billing, em **Cost allocation tags**, ative a tag definida pelo usuário
   `software-factory-installation` (e, se quiser o custo por Trabalho, `software-factory-work`).
   A tag só aparece na lista depois de existir num recurso cobrado, e só vale para o uso posterior
   à ativação; os dados costumam levar até 24 horas para aparecer.
2. No **Cost Explorer**, filtre por `software-factory-installation = <instalação>` e agrupe por
   serviço, ou por `software-factory-work` para ver por Trabalho. Pela CLI, com um perfil que tenha
   `ce:GetCostAndUsage` (a role de operação da Factory não tem e não precisa ter):

   ```sh
   aws ce get-cost-and-usage --time-period Start=2026-11-01,End=2026-12-01 \
     --granularity DAILY --metrics UnblendedCost \
     --filter '{"Tags":{"Key":"software-factory-installation","Values":["<instalação>"]}}' \
     --group-by Type=TAG,Key=software-factory-work
   ```

3. Compare com `factory usage`: os MicroVM-segundos por Trabalho e os builds por chave dizem o que
   a Factory pediu; a cobrança diz o que a AWS mediu.

Limites conhecidos: a MicroVM não leva tag (o `RunMicrovm` não aceita tags, observado em conta real em
2026-11-21), então o uso de MicroVM não aparece no filtro por tag da cobrança; o bucket de artefatos e
as imagens levam a tag, o log group do build não. Recursos sem a tag não
entram no filtro: confira também o total do serviço na conta dedicada.

### Recusa por quota ao iniciar

Quando o serviço recusa o `RunMicrovm` por quota ou capacidade, nada inicia e nada é consumido, e a
Factory espera e tenta de novo sozinha: não há impedimento, não há comando a executar e nenhuma
retomada operacional é consumida. O Trabalho mantém a posição na fila atrás de uma espera persistida
de 15 s, depois 60 s, depois 300 s repetidos enquanto a recusa continuar (a mesma espera de falta de
memória ou disco do host); a espera volta ao início quando um boot inicia. A causa fica visível em
`factory show <trabalho>`: motivo de despacho `BOOT_CAPACITY_WAIT`, o campo `bootDeferral` (código
`START_SERVICE_CAPACITY_REFUSED`, a causa devolvida pelo serviço em `detail`, `notBefore`, tentativa),
o resumo `dispatch.capacityWait` (código, causa, `notBefore`, tentativa) em `factory status` e na
visão do Trabalho, e o evento `boot-deferred` no histórico.

A mesma regra vale quando a recusa atinge o boot novo de uma **troca planejada**: o trabalho já está
no `origin` e o boot anterior já cessou, então a Execução espera (15 s, 60 s, 300 s) e tenta de novo
ali mesmo, sem consumir retomada operacional e mantendo a sessão; a causa fica na troca
(`execution.swaps[].startWait`) e no evento `boot-deferred`. O timeout da Execução continua contando.

Se a espera não termina, confira o que está ocupando a quota (boots de outros Trabalhos, MicroVMs
deixadas para trás) e o que o `factory doctor` diz sobre concorrência contra a quota; liberar a quota
basta, a próxima tentativa acontece sozinha. `factory cancel <trabalho>` continua disponível. O nome
do erro de quota do serviço nunca foi observado: a classificação fica num único ponto do adapter.

## 10. Perda e ref de marcador

Sem disco persistente, o que não estava na branch do Trabalho no `origin` morre com a MicroVM. Quando
o serviço confirma o fim de um ambiente em uso, a Factory registra uma **perda** no Trabalho
(`factory show <trabalho>`, campo `losses`, e o evento `loss-recorded` no histórico): a Execução e o
boot, o motivo informado pelo serviço, o último commit confirmado (a ponta da branch do Trabalho lida
pela própria Factory no `origin` naquele momento), o tempo da Execução e a sessão antiga, que fica
guardada como evidência e nunca é continuada.

O mesmo registro é feito quando o canal de ferramentas cai com a MicroVM viva e não volta dentro do
limite de reconexão (5 tentativas): a Execução termina como `SANDBOX_CHANNEL_UNRECOVERABLE`, a
Factory encerra o boot inalcançável e o Trabalho volta sozinho pela fila num boot novo, com sessão
substituta, consumindo uma retomada operacional. Não há impedimento. Como o ambiente estava vivo mas
inalcançável, o que ele tinha e não estava no `origin` é perdido quando o boot é encerrado: a perda
traz esse motivo e `terminatedAt` nulo (foi a Factory que encerrou, não o serviço). O limite contra
repetição é o orçamento de retomadas operacionais do Trabalho.

A Factory também registra a perda quando é **ela mesma** que encerra um boot com trabalho não
publicado: falha do Builder, fim do orçamento do Builder, timeout da Execução, limite de novas
tentativas de um revisor e parada do controlador (`factory stop` ou sinal). Antes de encerrar, com o
ambiente ainda vivo, ela confere uma única vez, sem pedir correção a ninguém: workspace limpo e
`HEAD` na ponta da branch no `origin` **não é perda** (o commit fica confirmado e o próximo boot
continua dele); um workspace limpo no próprio commit que o boot clonou também não é. Qualquer outra
coisa é perda, com `cause: ended-unpublished` e o motivo do encerramento. Um boot que ficou para trás
com o controlador fora do ar (crash) não pode ser inspecionado: na reconciliação ele é encerrado e
registrado como perda com `cause: not-inspected`, a partir do que a Factory lê no `origin`. Em todos
os casos o boot entra no histórico de boots do Trabalho e a próxima sessão recebe o pacote da sessão
substituta. A parada limpa do controlador não consome retomada operacional; as demais seguem a regra
do motivo que encerrou a Execução (o timeout continua bloqueando, como no MVP).

**Sem progresso entre boots.** Dois boots seguidos do mesmo Trabalho encerrados por troca planejada
ou perda sem nenhum commit novo no `origin` bloqueiam o Trabalho com `NO_PROGRESS_BETWEEN_BOOTS`
em vez de um terceiro boot. Depois de corrigir a causa (em geral um passo maior que um boot),
`factory resume <trabalho> --request-id <id>` retira o bloqueio, zera a sequência e devolve o
Trabalho à fila como uma retomada operacional.

Como melhor esforço, o hook de término do guest empurra o `HEAD` commitado para
`refs/factory/lost/<trabalho>/<boot>`. O hook não aceita nenhum parâmetro de quem o chama: só aciona
um processo que o host armou pelo canal, com o remoto, a ref e o token reduzido do Builder em
ambiente de processo (nada gravado no guest, sem deploy key). Esse processo existe enquanto a
credencial do Builder vale: ele é encerrado quando a Factory retira a credencial e antes de toda
parada que não seja uma perda. Num boot que a Factory encerra como perda ele fica armado até o fim,
para o hook ainda empurrar o marcador.

- A ref de marcador **não é preservação**: não satisfaz o gate, não vira o commit confirmado e não é
  uma branch (nenhum PR a usa). Ela existe para a sessão substituta aproveitar em vez de refazer.
- Se ela existe é decidido pela leitura do `origin` feita pela Factory (`marker.state`: `present`
  com o commit, `absent` ou `unknown` quando a leitura falhou), nunca pelo que o guest disse.
- **Limites, não erros:** arquivos sem commit não entram; um push que não termina em 40 s é
  abandonado; remoto indisponível, token vencido ou revogado e morte que o serviço não anuncia pelo
  hook não deixam marcador; um boot sem credencial entregue (Execução retida, por exemplo) não tem
  processo armado. Em todos esses casos a perda é registrada do mesmo jeito, com `absent`.
- **Remover** (limpeza do Trabalho entregue, ou `factory cleanup <trabalho> --select environment` de
  um cancelado) apaga as refs `refs/factory/lost/<trabalho>/*` por exclusão condicional atômica e
  registra o resultado no recurso `lost-markers`; não toca a branch nem o PR.
