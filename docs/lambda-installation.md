# Instalação Lambda (adapter `lambda`)

O adapter `lambda` roda cada boot numa MicroVM do serviço Lambda MicroVMs, na conta AWS do
Operador. A Factory **nunca cria IAM** e **não guarda credenciais AWS**: o Operador prepara a
conta com o template da release e configura um perfil AWS nomeado; a Factory passa só o nome do
perfil ao `aws` (CLI), que resolve as credenciais.

Nesta release o adapter é **validado** por `factory doctor` e sabe **preparar** a imagem de
MicroVM de um ambiente (seção 5). Iniciar Trabalhos nele ainda é recusado
(`SANDBOX_ADAPTER_UNAVAILABLE`, check `sandbox-adapter`).

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
| `lambda-aws-cli` | `aws` ausente ou sem os comandos `lambda-microvms`. |
| `lambda-aws-profile` | O perfil nomeado não existe. |
| `lambda-identity` | O perfil não dá identidade (sem credenciais, sessão expirada). |
| `lambda-operation-role` | O perfil não assume `factory-<instalação>-operation` (role ausente ou outro perfil). |
| `lambda-region` | O serviço não responde na região, ou o bucket está em outra região. |
| `lambda-permission:<ação>` | A role não tem a ação nomeada (simulação da política, ou leitura negada). |
| `lambda-build-role`, `lambda-artifact-bucket` | O recurso de instalação não existe. |
| `lambda-quota` | `concurrency` x memória de pico por MicroVM excede a quota de memória alocada lida da conta. Nada é ajustado: reduza `concurrency` ou o tamanho, ou peça aumento de quota. |

`unverified`: `lambda-boot-duration` (duração acima de 3600 s), `lambda-acceptance-profile` (fora
do perfil de aceite), `lambda-runtime` (build, boot e canal só são provados numa execução real
autorizada), e qualquer leitura que não pôde ser feita (por exemplo `lambda-quota` quando a quota
não pôde ser lida; a leitura de quota ainda não foi observada numa conta real).

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
- Imagens não são apagadas pelo Preparar; a remoção é do cleanup explícito.

## 6. Boots (Iniciar, Observar, Parar)

Nesta release o adapter inicia, observa e para um boot, mas o controlador ainda não executa
Trabalhos sob ele (o `doctor` mostra `sandbox-adapter` bloqueado).

- **Pré-requisitos do host:** `ssh` (cliente OpenSSH) e `websocat` no `PATH`, além do `aws`. O
  canal é SSH transportado em WebSocket pelo `HTTP_INGRESS` da MicroVM. O `doctor` ainda não
  confere esses dois executáveis.
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

## 7. Consumo e custo

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

Limites conhecidos, nenhum deles conferido numa conta real: se o serviço atribui o uso de uma
MicroVM às tags passadas no `RunMicrovm` (o campo de tags do `RunMicrovm` não é documentado); o
bucket de artefatos e as imagens levam a tag, o log group do build não. Recursos sem a tag não
entram no filtro: confira também o total do serviço na conta dedicada.

### Recusa por quota ao iniciar

Quando o serviço recusa o `RunMicrovm` por quota ou capacidade, nada inicia e nada é consumido. O
Trabalho mostra o impedimento com a causa devolvida pelo serviço e não tenta de novo sozinho.
Confira o que está ocupando a quota (boots de outros Trabalhos, MicroVMs deixadas para trás) e o
que o `factory doctor` diz sobre concorrência contra a quota; depois peça o retry indicado no
impedimento (`factory resume <trabalho> --retry-blocked-start START_SERVICE_CAPACITY_REFUSED
--request-id <id>`), que **não consome retomada operacional**, ou cancele o Trabalho. O nome do erro
de quota do serviço nunca foi observado: a classificação fica num único ponto do adapter.
