# 03: Imagem de MicroVM por chave de ambiente (Preparar)

**What to build:** Um repositório com `.factory/environment.yaml` (esquema do MVP, sem mudança) tem sua imagem de MicroVM pronta antes do primeiro boot.
O adapter constrói uma imagem por (repositório, hash do arquivo, pin da release) com um `Dockerfile` fixo montado pelo host a partir dos
valores validados, partindo de Alpine, sem comandos livres. Trabalhos com a mesma chave reutilizam a imagem; repetir Preparar é
reconhecível. Falha de build é impedimento visível com causa.

A [prova do guest Alpine](../../software-factory-v2/research/alpine-guest-results.md) deixou três obrigações: ler a causa da falha no log
de build (a API devolve só um motivo genérico); fixar no pin da release as versões dos pacotes do molde; desbloquear a conta do usuário
para o `sshd`. O código descartável da prova está na branch `prototype/v2-alpine-guest` e serve de referência, não de implementação.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-27, V2-02 (Preparar), V2-33 (tags).

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 02

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Preparar garante a imagem da chave (repositório, hash do arquivo, pin da release); segunda chamada com a mesma chave reutiliza, sem novo build.
- [x] O `Dockerfile` é montado só pelo host a partir de valores validados; nenhum texto livre do repositório entra nele. Pacotes `apk` nas versões exatas declaradas; versões dos pacotes do molde fixadas no pin da release.
- [x] Falha de build vira impedimento visível com a causa lida do log de build; sem fallback de imagem ou versão e sem retry implícito.
- [x] Imagem e artefatos de build levam as tags de instalação e de Trabalho.
- [x] A imagem contém o necessário para o hook de início (`dockerd`, `sshd`, conta de usuário desbloqueada); imagens Docker declaradas não são embutidas.
- [x] Mudança do arquivo de ambiente ou do pin da release gera chave nova; Trabalhos em andamento continuam com a imagem com que começaram.
- [ ] Smoke em conta AWS real, no perfil de aceite (`us-east-1`, ARM64), com evidência registrada no `## Answer`. Exige autorização específica do Operador antes de rodar (conta, permissões, teto de consumo, prazo e cleanup), conforme `docs/agents/experiment-proofs.md`. Sem autorização, o critério fica desmarcado e declarado; nunca é dado por feito pelo fake.

## Answer

Preparar funciona no adapter Lambda sobre o fake da conta; nenhuma chamada AWS real foi feita e nenhuma MicroVM foi iniciada.
`start` continua recusado (`SANDBOX_ADAPTER_UNAVAILABLE`), assim como a composição de produção (ticket 04).

- **Molde e pin da release (V2-27):** `src/sandbox/lambda/guest-image.ts`. `lambdaGuestPin` fixa a base gerenciada (`al2023-1` versão 3),
  o Alpine por digest, os repositórios `v3.23`, os dez pacotes do molde nas versões exatas observadas na prova (`s1-apk-all.txt`), os hooks
  e o usuário; `guestPinSha256` cobre o pin e os bytes dos arquivos fixos do guest (`guest-files.ts`: agente dos hooks, script de início,
  `sshd_config`). `renderGuestImage` revalida a declaração com o validador de produção e monta o contexto de build: só pares
  `nome=versão` entram no `Dockerfile`; as imagens Docker declaradas vão no arquivo de dados `declared-images`, baixado por digest no
  boot. A conta `builder` é desbloqueada no `shadow`; `sshd`, `dockerd` e a host key nascem no script de início, nunca no build.
- **Chave e nome:** `lambdaImageKey` = sha256 de (id do repositório, hash do arquivo, hash do pin, perfil da imagem: arquitetura, memória
  baseline e capacidades de SO, que o serviço fixa na criação da imagem). Nome `factory-<instalação>-<32 hex da chave>` (`lambdaImageName`).
- **Preparar (V2-02):** `prepareLambdaImage` em `src/sandbox/lambda/image.ts`, chamado por `createSandbox().prepare` quando o adapter
  selecionado é o Lambda. Como o nome é derivado da chave, todo Preparar acha o que outro fez: imagem `CREATED` é reutilizada
  (`base.reused`), `CREATING` é aguardada, só a ausente é construída (upload do zip + um `CreateMicrovmImage`). A espera
  (`LambdaImageWait`, 10 s por leitura, até 900 s, `sleep` injetável) não cancela o build: estourada, devolve incompleto e o próximo
  Preparar reconhece a mesma imagem. O resultado traz `environment` (`env-<sha256 do Trabalho>`) e `base` (chave, hash da declaração,
  hash do artefato, pacotes e imagens declarados), sem `checkout` nem `seeds`: não há workspace no host.
- **Trabalho mantém a imagem:** no primeiro Preparar concluído grava-se `<root>/lambda/works/<environment>/image.json` (`WorkImage`,
  lido por `readWorkImage`). Preparos seguintes do mesmo Trabalho usam essa imagem, qualquer que seja a declaração ou o pin atuais; se ela
  sumiu, o Trabalho é recusado, nunca movido para outra imagem.
- **Falha de build:** imagem `CREATE_FAILED` vira `ENVIRONMENT_BASE_PREPARATION_FAILED` com a causa lida do log
  (`buildFailureCause`: o bloco ` > [n/m] RUN ...:` do BuildKit com a saída do passo, uma linha de até 400 caracteres). Log ilegível é
  dito no impedimento, junto do motivo genérico da API. Repetir Preparar devolve a mesma falha sem novo build; só o retry explícito do
  Operador (`retryEnvironmentBase`, já existente no Controle) apaga a imagem falha e reconstrói a mesma chave. Conta inacessível, permissão
  negada ou build ainda em curso dão `ENVIRONMENT_BASE_PREPARATION_INCOMPLETE` com a causa. Os códigos são os que o Controle já trata
  (o nome do adapter não chega a ele).
- **Tags (V2-33):** imagem e artefato de build levam `software-factory-installation` e `software-factory-work` (o Trabalho cujo
  Preparar criou a imagem). A política ganhou `s3:PutObjectTagging` em `operationPolicy` e no template, juntos.
- **Porta e fake:** `LambdaService` ganhou `putBuildArtifact`, `createImage`, `image`, `imageBuilds`, `buildLog`, `deleteImageVersion`,
  `deleteImage` e a falha `conflict`. O fake (`test/sandbox/lambda-service-fake.ts`) modela imagens com build assíncrono sobre um relógio
  falso (`account.clock`), dois registros de build por pedido, log de build, objetos S3 e passa a preencher `mutations` em toda operação
  que muda a conta. O artefato é um zip sem compressão escrito em `zip.ts` (sem dependência nova).

Formas não provadas, cada uma isolada:

- **Leitura dos builds e do log de build:** `imageBuildsCommand`, `buildLogCommand` e `buildLogLines` em `cli-service.ts`. A prova
  guardou os resultados, não os comandos. Supõe-se `list-microvm-image-builds --image-identifier <arn>` e
  `logs filter-log-events --log-group-name /aws/lambda-microvms/<imagem>` sobre o grupo inteiro; o nome dos streams e a seleção do stream
  de um build são desconhecidos.
- **Upload com tags:** `s3api put-object --tagging` (a prova usou `s3 cp`, sem tags). `--tags` do `create-microvm-image` vai como mapa
  JSON (a prova passou um único `chave=valor`). Se criar com tags exige `lambda:TagResource` é suposição do fake.
- **`conflict`:** o texto de erro de um nome já existente nunca foi observado (`classify` usa os nomes de exceção documentados).
- **Pacotes do molde fixados:** as versões são as observadas, mas a prova instalou sem fixar; o build com `nome=versão` do molde não
  rodou. Só os dez pacotes do molde são fixados; as dependências deles são resolvidas pelo mirror. O mirror do Alpine guarda só o build
  atual: um pin envelhecido falha o build com causa visível e pede release com pin novo.
- **Reuso por chave e retry** (apagar a imagem falha e recriar com o mesmo nome) são lógica do adapter provada só no fake; limites de nome
  de imagem e a consistência eventual depois do delete são desconhecidos (delete ainda visível vira incompleto, nunca um segundo nome).
- **Agente dos hooks e script de início** vêm da prova com caminhos e nomes novos, sem porta de diagnóstico e com `run` atendido uma vez;
  não rodaram num guest. O conteúdo do `runHookPayload` (hoje a chave pública de `builder`) é do ticket 04; qualquer mudança nesses
  arquivos muda o pin e, com ele, as chaves.

Pendências e limites:

- **Smoke em conta real: não executado, sem autorização do Operador.** O critério fica desmarcado; nada acima foi observado numa conta.
- A tag de Trabalho de uma imagem compartilhada nomeia só o Trabalho que a criou; quais Trabalhos usam uma imagem está nos registros
  `image.json` do host. O ticket 15 decide o cleanup a partir deles (e apaga o registro ao remover o ambiente).
- O log group do build é criado pelo serviço e fica sem tags; é localizável pelo prefixo `/aws/lambda-microvms/factory-<instalação>-`.
- Preparar não apaga imagens nem artefatos (exceto a imagem falha no retry explícito); o zip fica no bucket.
- Trabalho sem declaração fixada é recusado com `ENVIRONMENT_NOT_PINNED`: no Lambda não há guest genérico.
- Não é conferido se a base gerenciada do pin ainda está disponível na região (`list-managed-microvm-images`); base expirada aparece
  como falha de criação da imagem.
- Pelo Controle, um Preparar Lambda bem-sucedido hoje pararia em `PREPARE_CHECKOUT_MISSING` (o despacho exige `checkout`); a composição
  de produção continua recusando o adapter, então isso é do ticket 04, junto com o check `sandbox-adapter` do `doctor`.

Testes: `test/sandbox/lambda-guest-image.test.ts`, `lambda-image.test.ts`, mais casos em `lambda-cli-service.test.ts` e
`adapter-selection.test.ts`; `lambda-account-template.test.ts` cobre a política nova sem mudança.
