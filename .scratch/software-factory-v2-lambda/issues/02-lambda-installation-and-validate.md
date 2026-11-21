# 02: Instalação Lambda e `validate`

**What to build:** O Operador consegue preparar a própria conta e saber, sem gastar nada, se a instalação está pronta para o perfil Lambda. A release traz
um template que ele aplica para criar a role de operação com política mínima, a role de build e o bucket de artefatos de build; a Factory
nunca cria IAM e usa um perfil AWS nomeado na configuração, sem guardar credenciais. O perfil do adapter (região, arquitetura, tamanho,
duração, margem e intervalo de observação) fica encapsulado no adapter, fora do Controle. `validate` confere identidade, região,
permissões, quota e recursos de instalação sem iniciar MicroVM.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-29, V2-30 (validate), V2-31, V2-02 (Validar).

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 01

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] A configuração aceita o adapter Lambda com perfil próprio; padrões do perfil de aceite: `us-east-1`, ARM64, baseline 1 GB / 0,5 vCPU com pico 4 GB / 2 vCPU, `additionalOsCapabilities: ["ALL"]`, duração 3600 s, margem 600 s.
- [x] Duração acima de 3600 s é aceita e marcada como não provada no diagnóstico.
- [x] A release inclui o template da conta (role de operação, role de build, bucket). `CreateMicrovmImage` e `TagResource` ficam em `*`, a segunda condicionada à tag da instalação; o limite está documentado para o Operador.
- [x] `validate` não inicia MicroVM e diagnostica, cada um com causa própria: perfil AWS ausente ou sem identidade, região errada, permissão faltante (nomeando a ação), recurso de instalação ausente (role, bucket).
- [x] `validate` diagnostica quando concorrência de Builders × tamanho do perfil excede a quota de memória lida da conta, sem ajuste automático.
- [x] Nenhuma credencial AWS é gravada pela Factory; o Controle não recebe região, tamanho nem outro detalhe do perfil.
- [ ] Smoke em conta AWS real, no perfil de aceite (`us-east-1`, ARM64), com evidência registrada no `## Answer`. Exige autorização específica do Operador antes de rodar (conta, permissões, teto de consumo, prazo e cleanup), conforme `docs/agents/experiment-proofs.md`. Sem autorização, o critério fica desmarcado e declarado; nunca é dado por feito pelo fake.

## Answer

Entregue a instalação Lambda e o `validate` (`factory doctor`) sobre um fake da conta; nenhuma chamada AWS real foi feita.

- **Perfil do adapter (V2-29, V2-12):** `sandbox.adapter: lambda` é selecionado por `selectSandboxAdapter` com perfil próprio
  (`src/sandbox/lambda/profile.ts`, schema estrito): obrigatórios `awsProfile` (nome do perfil AWS) e `installation`; defaults do perfil
  de aceite (`us-east-1`, `arm64`, `baselineMemoryMiB` 1024, `additionalOsCapabilities: [ALL]`, `maxBootSeconds` 3600,
  `rotationMarginSeconds` 600, `observationIntervalSeconds` 30). `lambdaBootSize` deriva o pico (4x o baseline, 1 vCPU por 2 GB).
  Duração acima de 3600 s (até 28800) é aceita e sai como `lambda-boot-duration` `unverified`; região/arquitetura/tamanho fora do
  aceite saem como `lambda-acceptance-profile` `unverified`. A configuração efetiva Lambda mantém `adapter: 'lambda'` (é o
  discriminador entre as duas configurações efetivas). Capacidades declaradas: Docker, sem disco persistente, `bootDuration` do perfil,
  saída TCP pública sem mediação.
- **Porta do serviço:** `LambdaService` / `LambdaServiceFactory` em `src/sandbox/lambda/service.ts` (uma operação por método, dados
  simples, falhas tipadas `LambdaServiceFailure`). Produção: `createLambdaCliService` (`cli-service.ts`), o CLI `aws --profile <nome>
  --region <região>` atrás de um `AwsCliRunner` injetável; sem dependência npm nova. Injeção: `createSandbox({ lambdaService })`,
  `readConfiguration(root, guestAssets, { lambdaService })`, `doctor(root, { lambdaService })`.
- **Fake compartilhado:** `test/sandbox/lambda-service-fake.ts` (`lambdaAccountFake`): modela a CONTA (perfis, regiões, roles, buckets,
  ações negadas, quota, imagens), com `calls` e `mutations`. Os tickets 03, 04, 14 e 15 estendem essa conta e a porta.
- **Recursos e política (V2-31):** `src/sandbox/lambda/installation.ts`: `installationResources` (nomes derivados de `installation`:
  `factory-<inst>-operation`, `factory-<inst>-build`, bucket `factory-<inst>-build-<conta>-<região>`, prefixo de imagem
  `factory-<inst>-`), tags `software-factory-installation` / `software-factory-work`, e `operationPolicy`, a lista única contra a
  qual o template e o `validate` são conferidos. Template CloudFormation em `assets/lambda/account-template.yaml`, distribuído na
  release junto de `docs/lambda-installation.md` (limite de `CreateMicrovmImage`/`TagResource` em `*` documentado ali).
- **`validate` (V2-02, V2-30):** `src/sandbox/lambda/validate.ts`, só leituras. Checks com causa própria: `lambda-aws-cli`,
  `lambda-aws-profile`, `lambda-identity`, `lambda-operation-role`, `lambda-region` (serviço não responde na região, ou bucket em outra
  região), `lambda-permission:<ação>`, `lambda-build-role`, `lambda-artifact-bucket`, `lambda-quota` (concorrência x pico > quota lida,
  sem ajuste). O que não pôde ser lido sai `unverified`. `doctor` não roda os diagnósticos de host do Gondolin numa instalação Lambda.
- **Credenciais:** nada é gravado; o schema não tem campo de credencial e recusa `awsProfile` com forma de access key; o processo `aws`
  não herda `AWS_ACCESS_KEY_ID`/`SECRET`/`SESSION_TOKEN`/`AWS_PROFILE`/`AWS_REGION` do ambiente (`awsCliEnvironment`).

Formas não provadas, cada uma isolada num ponto:

- **Leitura de quota:** `memoryQuota` em `cli-service.ts` (`aws service-quotas list-service-quotas --service-code lambda`, quota achada
  pelo NOME, valor lido como GiB). Nem o comando nem o código/nome da quota foram registrados nas provas. Ambiguidade vira `unverified`.
- **Permissões por simulação:** `iam simulate-principal-policy` é API antiga da AWS, mas nunca foi exercitada com as ações de MicroVM
  nem com a chave de contexto `aws:RequestTag/...`; o `validate` declara que simulação não é prova de cada chamada.
- **Escopo da política:** as provas rodaram com todas as ações `lambda:*` em `*`. O template restringe as ações de MicroVM ao ARN das
  imagens `factory-<inst>-*` e os logs ao log group dessas imagens, seguindo só a documentação.
- **Textos de erro do CLI:** `classify` em `cli-service.ts` usa mensagens conhecidas do AWS CLI/botocore; os erros do
  `lambda-microvms` (região sem endpoint, CLI sem o subcomando) não foram observados.

Pendências e limites:

- **Smoke em conta real: não executado, sem autorização do Operador.** O critério fica desmarcado; nada acima foi observado numa conta.
- O adapter Lambda ainda não tem ciclo de vida: `prepare`/`start` e a composição de produção recusam com
  `SANDBOX_ADAPTER_UNAVAILABLE`, e o `doctor` mostra o check `sandbox-adapter` `blocked`. O ticket que compuser o adapter (03/04)
  remove esse check e a recusa em `composeProductionExecution`; ao compor, o perfil não deve ir em `ports.configuration` (hoje o
  Controle recebe ali a configuração do sandbox como valor opaco).
- Não é conferido se a região oferece a imagem base gerenciada para a arquitetura (`list-managed-microvm-images`, só documentado).
- `tag:GetResources` não está na política (inventário por tag é do ticket 15, que estende `operationPolicy` e o template juntos; o
  teste `lambda-account-template` falha se divergirem).
- O `controller` e o `upgrade` chamam `readConfiguration`, logo executam o `aws` numa instalação Lambda válida antes de recusar.

Testes: `test/sandbox/lambda-profile.test.ts`, `lambda-validate.test.ts`, `lambda-cli-service.test.ts`,
`lambda-account-template.test.ts`, `test/entrypoints/lambda-doctor.test.ts`, mais ajustes em `adapter-selection`, `configuration`,
`release-composition` e `release-artifact`.
