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
