# Lambda MicroVMs — revalidação documental e de preços

## Data e método

- Data da revalidação: **2026-11-20**.
- Escopo: somente pesquisa documental. Nenhuma chamada à AWS, nenhum acesso a conta, nenhum recurso criado, nenhuma instalação.
- Método: leitura das páginas públicas (documentação AWS, referência de API, página de preços, anúncios) e de fontes secundárias. Os preços unitários foram lidos do arquivo público de preços que a própria página de pricing consome (`meteredUnitMaps`), porque as tabelas da página são preenchidas por JavaScript e não aparecem no HTML estático.
- Nenhum identificador pessoal, de repositório ou de conta foi enviado a serviços externos.
- Marcação usada em cada afirmação:
  - **DOCUMENTED** — consta em fonte primária da AWS (guia, API reference, pricing, anúncio oficial).
  - **THIRD-PARTY REPORT** — relato de terceiro ou material auxiliar (inclui o toolkit da organização `aws` no GitHub, que não é a documentação normativa).
  - **INFERENCE** — dedução minha a partir das fontes; não está escrito em lugar algum.
  - **NOT FOUND** — procurado e não encontrado nas fontes consultadas.
- Limite do método: as páginas foram lidas por um extrator automático que converte HTML em texto. Números e nomes de API foram conferidos entre páginas quando possível; divergências internas da documentação estão listadas na seção 11.

## Fontes e status de leitura

| # | Fonte | Tipo | Status |
| --- | --- | --- | --- |
| 1 | https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html | Primária | OK |
| 2 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html | Primária | OK |
| 3 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-getting-started.html | Primária | OK |
| 4 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html | Primária | OK |
| 5 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html | Primária | OK |
| 6 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-base-image-release-notes.html | Primária | OK |
| 7 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html | Primária | OK |
| 8 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html | Primária | OK |
| 9 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html | Primária | OK |
| 10 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-monitoring.html | Primária | OK |
| 11 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-best-practices.html | Primária | OK |
| 12 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-troubleshooting.html | Primária | OK |
| 13 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-integrations.html | Primária | OK (só índice; subpáginas de integração não lidas) |
| 14 | https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html | Primária | OK (seção "Lambda MicroVMs" contém as quotas) |
| 15 | https://docs.aws.amazon.com/lambda/latest/dg/microvms-quotas.html | Primária (tentativa) | **FALHOU** — página vazia; as quotas estão na fonte 14 |
| 16 | https://docs.aws.amazon.com/lambda/latest/microvm-api/API_Operations.html | Primária | OK |
| 17 | https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmImage.html | Primária | OK |
| 18 | https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html | Primária | OK |
| 19 | https://docs.aws.amazon.com/lambda/latest/microvm-api/API_GetMicrovm.html | Primária | OK |
| 20 | https://docs.aws.amazon.com/lambda/latest/microvm-api/API_ListMicrovms.html | Primária | OK |
| 21 | https://docs.aws.amazon.com/lambda/latest/microvm-api/API_TerminateMicrovm.html | Primária | OK |
| 22 | https://docs.aws.amazon.com/lambda/latest/microvm-api/API_SuspendMicrovm.html | Primária | OK |
| 23 | https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmAuthToken.html | Primária | OK |
| 24 | https://docs.aws.amazon.com/lambda/latest/microvm-api/API_DeleteMicrovmImage.html | Primária | OK |
| 25 | https://docs.aws.amazon.com/lambda/latest/microvm-api/API_DeleteMicrovmImageVersion.html | Primária | OK |
| 26 | https://docs.aws.amazon.com/lambda/latest/microvm-api/API_IdlePolicy.html e https://docs.aws.amazon.com/lambda/latest/microvm-api/API_Resources.html | Primária | OK |
| 27 | https://aws.amazon.com/lambda/pricing/ | Primária | **PARCIAL** — texto e exemplos OK; tabelas de preço (inclusive x86) não renderizam sem JavaScript |
| 28 | https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/lambda/USD/current/lambda.json | Primária (dados da fonte 27) | OK — `hawkFilePublicationDate` 2026-11-18T17:30:43Z |
| 29 | Arquivos equivalentes de `cloudwatch`, `s3`, `datatransfer` no mesmo endpoint | Primária | OK (publicados em 2026-11-19/20); `ec2` e `vpc` baixaram mas usam chaves opacas e **não foram interpretados** |
| 30 | https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms | Primária | OK |
| 31 | https://aws.amazon.com/about-aws/whats-new/2026/08/lambda-microvms-5-additional-regions | Primária | OK |
| 32 | https://aws.amazon.com/about-aws/whats-new/2026/11/aws-lambda-microvms-x86-architecture/ | Primária | OK |
| 33 | https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/ | Primária | **FALHOU** — só navegação carregou, corpo do post ausente |
| 34 | https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/specialized-skills/serverless-skills/aws-lambda-microvms/SKILL.md e `references/networking.md`, `references/troubleshooting.md`, `references/iam-and-security.md` da mesma pasta | Secundária (organização AWS, material auxiliar) | OK |
| 35 | https://awsteele.com/blog/2026/06/23/some-notes-on-lambda-microvms.html | Secundária (2026-06-23) | OK |
| 36 | https://github.com/sealant-sh/sealant/pull/247 | Secundária (merge em 2026-09-16) | OK (descrição do PR; diff não lido) |
| 37 | https://theburningmonk.com/2026/06/what-you-need-to-know-about-lambda-microvms | Secundária (junho/2026) | OK |
| 38 | https://dev.classmethod.jp/en/articles/aws-lambda-microvms-x86-architecture/ | Secundária (2026-11-13) | OK |
| 39 | https://dev.classmethod.jp/articles/lambda-microvms-shell-ingress-browser-webshell/ | Secundária (2026-06-23) | OK |
| 40 | https://github.com/vi/websocat , https://github.com/erebe/wstunnel , https://github.com/jpillora/chisel | Secundária (componentes) | PARCIAL — README e licença OK; data/versão do último release não aparecem no texto extraído |

Não lidas (fora do necessário ou não localizadas): referência de API dos network connectors (CLI `aws lambda-core`), subpáginas de integração (Claude Managed Agents, Cursor, OpenAI), página "AWS Capabilities by Region" (https://builder.aws.com/build/capabilities).

## 1. Status do serviço, regiões, arquiteturas, opt-in

- Lançado em **2026-06-22** como "available today"; nenhuma página da AWS lida usa o rótulo "preview" nem o rótulo "generally available". **DOCUMENTED** (fonte 30) quanto à data; tratar como GA é **INFERENCE** (o blog da Classmethod chama o lançamento de GA — **THIRD-PARTY REPORT**, fonte 38).
- Regiões anunciadas: lançamento em US East (N. Virginia), US East (Ohio), US West (Oregon), Asia Pacific (Tokyo), Europe (Ireland); em **2026-08-19** mais Mumbai, Singapore, Sydney, Frankfurt, Stockholm — total 10. **DOCUMENTED** (fontes 30, 31).
- O anúncio de x86 (2026-11-11) cita também Asia Pacific (Hong Kong), Asia Pacific (Malaysia), Asia Pacific (Thailand) e Europe (Spain) como regiões onde o serviço existe, e o arquivo de preços tem linhas de MicroVM para exatamente essas 14 regiões. **DOCUMENTED** (fontes 28, 32). Concluir que são 14 regiões hoje é **INFERENCE**; a lista autoritativa (https://builder.aws.com/build/capabilities) não foi lida.
- **South America (São Paulo) não tem preço de MicroVM** no arquivo de preços. **DOCUMENTED** (fonte 28). Indisponibilidade em `sa-east-1` é **INFERENCE** decorrente.
- Arquiteturas: `ARM64` (padrão) e `x86_64`. Na API os valores são `ARM_64` e `X86_64`, em `cpuConfigurations`. x86 exige base image **versão 3 ou posterior**. **DOCUMENTED** (fontes 4, 14, 17).
- x86 disponível em todas as regiões do serviço **exceto** Hong Kong, Malaysia, Thailand e Spain. **DOCUMENTED** (fonte 32).
- Verificação de disponibilidade por conta/região: `aws lambda-microvms list-managed-microvm-images` e `list-managed-microvm-image-versions` (campo `supportedCpuConfigurations`). A doc avisa: "If no version lists your architecture, the architecture might not be available in your account or Region yet." **DOCUMENTED** (fonte 4).
- Opt-in ou allow-list: **NOT FOUND** — nenhum passo de habilitação aparece no tutorial (fonte 3). Há, porém, quotas reduzidas para contas novas (seção 7).
- CLI: os comandos vivem em `aws lambda-microvms` (e `aws lambda-core` para network connectors). Versão mínima da AWS CLI: **NOT FOUND**.
- Base image gerenciada: `arn:aws:lambda:<region>:aws:microvm-image:al2023-1` (Amazon Linux 2023). Versão 2 liberada em **2026-11-05** com kernel `6.1.166-24.303.amzn2023`; versão 3 (x86) sem data na página. **DOCUMENTED** (fonte 6). Ciclo de depreciação: `AVAILABLE` → `DEPRECATED` (60 dias) → `EXPIRING` (30 dias, não cria imagens novas) → `EXPIRED` (não constrói nem executa). **DOCUMENTED** (fonte 4).

## 2. Ciclo de vida

- **Teto de vida: 8 horas (28.800 s), não ajustável.** `maximumDurationInSeconds` aceita 1–28.800. **DOCUMENTED** (fontes 14, 18).
- **Tempo suspenso conta.** Texto do guia: "The maximum total lifespan of the MicroVM, including both running and suspended time. Lambda terminates the MicroVM when this duration is exceeded." **DOCUMENTED** (fonte 7).
- Valor padrão de `maximumDurationInSeconds` quando omitido: **NOT FOUND** (o parâmetro é opcional).
- Estados: `PENDING | RUNNING | SUSPENDING | SUSPENDED | TERMINATING | TERMINATED`. `TERMINATED` é terminal: "cannot be resumed or restarted". **DOCUMENTED** (fontes 2, 19).
- Transições documentadas: `RUNNING → TERMINATING` por `terminate-microvm` ou por `maximumDurationInSeconds` excedido; `SUSPENDED → TERMINATING` por `suspendedDurationSeconds` excedido ou `terminate-microvm`; `TERMINATING → TERMINATED` quando o hook `/terminate` termina e os recursos são liberados. Se o hook `/run` falhar ou expirar, a MicroVM pode ir direto a `TERMINATING` sem nunca chegar a `RUNNING`. **DOCUMENTED** (fonte 2).
- **Pedido de término ≠ cessação.** `TerminateMicrovm` (HTTP `DELETE /2025-09-09/microvms/{id}`) retorna 200 com corpo vazio e é idempotente; não devolve estado. A confirmação é por `GetMicrovm` até `state = TERMINATED`, com `terminatedAt` e `stateReason`. **DOCUMENTED** (fontes 19, 21).
- Ressalva: "The state field is eventually consistent — determine readiness by connecting to the endpoint." **DOCUMENTED** (fonte 19). Não há garantia documentada de latência entre a cessação real e `TERMINATED` visível — **NOT FOUND**.
- `ListMicrovms` devolve `microvmId`, `state`, `startedAt`, imagem; filtra por imagem/versão, não por estado; máximo 50 por página. Por quanto tempo uma MicroVM `TERMINATED` continua listável ou consultável: **NOT FOUND** (fonte 20).
- Suspend/resume: `SuspendMicrovm` preserva "full memory and disk state"; `ResumeMicrovm` ou tráfego (com `autoResumeEnabled=true`) retoma. Durante o resume a MicroVM permanece `SUSPENDED` até o hook `/resume` devolver 200. Falha de auto-resume devolve 502 ao cliente. **DOCUMENTED** (fontes 7, 22).
- `idlePolicy` (opcional em `RunMicrovm`; se informado, os três campos são obrigatórios): `maxIdleDurationSeconds` (mínimo 60, máximo 28.800), `suspendedDurationSeconds` (mínimo 0), `autoResumeEnabled`. **DOCUMENTED** (fontes 7, 26).
- **Ociosidade é medida por tráfego de entrada no endpoint**, não por atividade interna: "Idle time is measured by inbound traffic through the MicroVM proxy endpoint". A doc recomenda desabilitar a suspensão automática para aplicações assíncronas. **DOCUMENTED** (fontes 7, 26). Omitir `idlePolicy` impedir a suspensão automática é **INFERENCE** (a doc diz "When enabled, the idle policy controls...").
- Não existe auto-suspensão de dentro da MicroVM; `SuspendMicrovm` é chamado de fora. Conectores de rede não mudam em suspend/resume. **THIRD-PARTY REPORT** (fonte 34).
- Hooks de runtime (`/run`, `/resume`, `/suspend`, `/terminate`) são endpoints HTTP da aplicação, chamados por POST em `/aws/lambda-microvms/runtime/v1/<hook>` na porta configurada. **DOCUMENTED** (fonte 7). Timeout de 1–60 s (padrão 1 s) e hooks de build `ready`/`validate` com padrão 30 s: **THIRD-PARTY REPORT** (fonte 34); o guia só documenta 1–3600 s para `ready`/`validate` (fonte 4). Consequência: o hook `/terminate` não comporta um `git push` confiável — coerente com a direção "não depender exclusivamente de hooks de terminação" (**INFERENCE**).
- Quem snapshotou o quê: a imagem é um snapshot Firecracker de memória + disco + conexões/descritores no instante em que o build termina; toda MicroVM da mesma versão parte desse estado idêntico. Identificadores, segredos e entropia gerados no build são compartilhados. **DOCUMENTED** (fonte 5).

## 3. Dimensionamento, disco, imagens e build

- Modelo baseline/pico: define-se a memória baseline (`resources[].minimumMemoryInMiB`); vCPU segue 2 GB = 1 vCPU; a MicroVM escala verticalmente até **4x** o baseline. **DOCUMENTED** (fontes 4, 26).

| Baseline | Pico | Disco máximo |
| --- | --- | --- |
| 0,5 GB / 0,25 vCPU | 2 GB / 1 vCPU | 10 GB |
| 1 GB / 0,5 vCPU | 4 GB / 2 vCPU | 16 GB |
| 2 GB / 1 vCPU (padrão) | 8 GB / 4 vCPU | 32 GB |
| 4 GB / 2 vCPU | 16 GB / 8 vCPU | 64 GB |
| 8 GB / 4 vCPU | 32 GB / 16 vCPU | 128 GB |

  **DOCUMENTED** (fonte 4). O tamanho é fixado na imagem ("An image is single-size" — **THIRD-PARTY REPORT**, fonte 34): comparar tamanhos exige uma imagem por tamanho.
- "4 vCPU / 8 GB" pode ser obtido de duas formas: como **baseline máximo** (pico 16 vCPU / 32 GB, disco até 128 GB) ou como **pico** do baseline padrão de 2 GB / 1 vCPU (disco até 32 GB). Não existe tamanho "médio" fixo sem burst. **INFERENCE** a partir da tabela.
- Como o disco é configurado (parâmetro, valor padrão, se o "disco máximo" é sempre provisionado): **NOT FOUND**. A API de `CreateMicrovmImage` não expõe campo de disco (fonte 17).
- Limite de tamanho de imagem/snapshot: **NOT FOUND** na documentação. Relato: a máquina de build aparentou ~7,2 GB livres e o tamanho máximo não é documentado — **THIRD-PARTY REPORT** de junho/2026 (fonte 35), possivelmente desatualizado. Erro documentado: `DISK_STORAGE_FULL` ("MicroVM ran out of storage during build") (fonte 12).
- Como a imagem é construída: zip com `Dockerfile` na raiz + artefatos, enviado ao S3 **na mesma região**; `create-microvm-image` busca o zip, sobe uma MicroVM da base image gerenciada, executa o `Dockerfile`, inicia a aplicação por `ENTRYPOINT`/`CMD`, espera o hook `/ready` (se configurado) e captura o snapshot. Não há entrada direta por imagem OCI pronta; o `FROM` pode apontar para registro público ou ECR privado da mesma conta. **DOCUMENTED** (fontes 2, 4, 12).
- **A aplicação roda como container dentro do SO da MicroVM**: "Lambda MicroVMs runs your application as a container within the MicroVM operating system environment." **DOCUMENTED** (fonte 4). O troubleshooting mostra `ctr task ls` / `ctr task exec` no shell, ou seja, há containerd no SO da MicroVM (fonte 12).
- Versionamento: cada create/update gera uma versão; estados da imagem (`CREATING`, `CREATED`, `UPDATING`, `UPDATED`, `DELETING`, `DELETED` e falhas), da versão (`PENDING`, `IN_PROGRESS`, `SUCCESSFUL`, `FAILED`) e ativação (`ACTIVE`/`INACTIVE`). `update-microvm-image` exige sempre `--base-image-arn` e `--build-role-arn`. **DOCUMENTED** (fonte 4).
- Variáveis de ambiente: fixadas no build, máximo 50, valor até 4096 caracteres, compartilhadas por todas as MicroVMs da versão. **DOCUMENTED** (fontes 4, 17).
- Tempo de build: **NOT FOUND** na documentação. Relato de 2–3 minutos para imagem trivial — **THIRD-PARTY REPORT** (fonte 35). Uma imagem com Docker Engine, Buildx e Compose tende a levar mais (**INFERENCE**).
- Custo do build em si (compute da MicroVM de build): **NOT FOUND**. A página de preços lista apenas compute, leitura/escrita/armazenamento de snapshot e transferência (fonte 27).
- Compatibilidade com snapshot: gerar segredos/IDs no hook `/run`, usar CSPRNG; para OpenSSL usar `public.ecr.aws/lambda/microvms:al2023-minimal` ou o pacote `openssl-snapsafe-libs`. **DOCUMENTED** (fonte 5). Relevante para host keys de SSH: uma host key gerada no build seria idêntica em todas as MicroVMs da versão (**INFERENCE**).

## 4. Capacidades do SO e Docker

- `additionalOsCapabilities`: array de strings, **único valor válido `ALL`**, definido em `CreateMicrovmImage`/`UpdateMicrovmImage` (por imagem, não por execução). **DOCUMENTED** (fontes 4, 17).
- Semântica documentada, na íntegra: "By default, Lambda MicroVMs run with a standard set of Linux capabilities. You can grant elevated Linux capabilities using the `additionalOsCapabilities` field [...] The only supported value is `["ALL"]`. Elevated capabilities enable operations such as mounting filesystems, creating network namespaces, or running eBPF programs. Capabilities are applied within the VM isolation boundary and do not affect the host or other MicroVMs." **DOCUMENTED** (fonte 4).
- Quais capabilities compõem o conjunto "standard" e o que exatamente `ALL` acrescenta (lista de `CAP_*`, seccomp, dispositivos, `/sys` gravável): **NOT FOUND**.
- **Docker não é mencionado na documentação primária** (guia, API, troubleshooting, best practices, release notes): cgroups, storage driver, iptables/nftables, rede aninhada e modo privilegiado são todos **NOT FOUND**.
- O toolkit da organização AWS lista como caso de uso de `ALL`: "nested containers (containerd inside the MicroVM)", montagens (EFS, FUSE) e eBPF. **THIRD-PARTY REPORT** (fonte 34).
- Relatos de Docker funcionando:
  - Junho/2026: Docker funciona; houve incompatibilidade de versão do containerd resolvida com `dockerd --containerd=/run/containerd/containerd.sock`. **THIRD-PARTY REPORT** (fonte 35).
  - Setembro/2026 (Sealant PR 247, imagem ARM64 com `additionalOsCapabilities: ["ALL"]`, `dockerd` como root do guest em socket Unix privado): Docker 29.8.1 `info`, build e run, Compose, escrita em bind mount e HTTP funcionaram; primeiro teste falhou no start do Docker e a validação pós-snapshot encontrou diretórios `/run` ausentes, corrigidos na imagem 3.0. Não testados: suspend/resume nativo, limites sustentados de recursos. **THIRD-PARTY REPORT** (fonte 36).
- **Testcontainers/Ryuk: NOT FOUND em qualquer fonte**, primária ou secundária.
- Consequência estrutural: como a aplicação já é um container no containerd da MicroVM, o `dockerd` da fábrica rodaria **dentro de um container** (Docker aninhado), não diretamente no SO da VM. **INFERENCE** a partir das fontes 4 e 12; os dois relatos são compatíveis com isso.
- Outras observações de terceiros (junho/2026): `/proc/kcore` mascarado por tmpfs, `/sys` somente leitura (sem indicar se com ou sem `ALL`), PID 1 da imagem de teste não coletava zumbis. **THIRD-PARTY REPORT** (fonte 39).

## 5. Rede

### Ingress

- Conectores de ingress gerenciados pela AWS, referenciados por ARN em `--ingress-network-connectors` (`arn:aws:lambda:<region>:aws:network-connector:aws-network-connector:<NOME>`): **`HTTP_INGRESS`**, **`SHELL_INGRESS`**, **`NO_INGRESS`**. Podem ser combinados (ex.: HTTP + SHELL). Conectores são fixados no `run-microvm` e não mudam depois. **DOCUMENTED** (fonte 8).
- `SHELL_INGRESS`: "Shell access is intended for development and troubleshooting. Don't attach SHELL_INGRESS to production MicroVMs." Token próprio (`create-microvm-shell-auth-token`). **DOCUMENTED** (fonte 8). Coerente com o ticket.
- Endpoint: uma URL HTTPS pública e dedicada por MicroVM (`<id>.lambda-microvm.<region>.on.aws`), TLS sempre terminado pela AWS; o tráfego chega em porta interna 8080 por padrão; outra porta por header `X-aws-proxy-port` ou subprotocolo WebSocket `lambda-microvms.port.<N>`. **DOCUMENTED** (fontes 7, 8).
- Protocolos: HTTP/1.1, HTTP/2, **WebSockets**, gRPC, SSE. **DOCUMENTED** (fonte 8).
- **Autenticação do ingress não é SigV4.** Toda requisição exige token JWE obtido por `CreateMicrovmAuthToken` (essa chamada sim é API AWS assinada por IAM). O token é escopado a uma MicroVM, a portas (`port`, `range` ou `allPorts`) e a uma expiração; **máximo 60 minutos**. Vai no header `X-aws-proxy-auth` ou, em WebSocket, no subprotocolo `lambda-microvms.authentication.<token>` junto do subprotocolo base `lambda-microvms`. Não existe acesso sem autenticação. A doc de PrivateLink confirma: "Connections to a MicroVM endpoint are authenticated with a MicroVM auth token rather than AWS Signature Version 4." **DOCUMENTED** (fontes 7, 8, 23).
- O proxy remove headers `X-aws-proxy-*` e subprotocolos `lambda-microvms.*` antes de entregar à aplicação. **DOCUMENTED** (fontes 7, 8). Logo o servidor dentro da MicroVM não vê o token e não pode usá-lo como segundo fator (**INFERENCE**).
- O proxy roteia por porta e **não filtra por path**: quem tem token para a porta dos hooks pode chamar os hooks. Recomendação: hooks em porta dedicada, excluída de `allowedPorts`. **DOCUMENTED** (fontes 7, 8).
- O que acontece com um WebSocket já estabelecido quando o token expira: **NOT FOUND**.
- **Duração máxima de conexão e timeout ocioso do WebSocket no `HTTP_INGRESS`: NOT FOUND** como número. O que existe: linha do troubleshooting "Connections dropping — Idle timeout triggered. Implement ping/pong keepalives. Or extend `maxIdleDurationSeconds` in the idle policy." **DOCUMENTED** (fonte 12). Se um WebSocket aberto sem mensagens conta como tráfego para o idle policy, e se frames de saída (VM→cliente) contam: **NOT FOUND**.
- Limites por MicroVM: conexões simultâneas com piso de 150, +50 por vCPU adicional, até 600; requisições por segundo 40 (em 4 vCPU / 8 GB) e 160 (em 16 vCPU / 32 GB); respostas 429 quando excedido. **DOCUMENTED** (fontes 8, 14).
- **Banda do endpoint: 2 MB/s por vCPU sustentado, com burst de 10 MB por vCPU** (a partir da base image v2), valendo para requisições e respostas. Em baseline de 4 vCPU: 8 MB/s sustentados, burst de 40 MB; em 1 vCPU: 2 MB/s. Excesso vira latência, não erro. **DOCUMENTED** (fontes 6, 8). Impacta transferência de arquivos binários pelo túnel SSH (**INFERENCE**). Se a banda acompanha o pico de vCPU ou só o baseline: **NOT FOUND** (a tabela é por tamanho baseline).

### Egress

- Padrão: internet pública (`INTERNET_EGRESS`, conector gerenciado, sem recurso na conta). **DOCUMENTED** (fontes 3, 8).
- VPC: conector próprio (`aws lambda-core create-network-connector`, tipo `VPC_EGRESS`, com subnets, security groups, `IPv4` ou `DualStack` e uma operator role que cria ENIs). Até 10 conectores de egress por `RunMicrovm`, 1 no build. **DOCUMENTED** (fontes 8, 17, 18).
- **VPC egress não obriga NAT gateway**: para alcançar a internet pela VPC usa-se NAT **ou** Elastic IPs gerenciados pelo serviço (`ElasticIpConfiguration.Type = ServiceManaged`) em subnets públicas com internet gateway. Esses EIPs são cobrados enquanto o conector tiver ENIs, mesmo ocioso ou em `FAILED`; versões antigas do conector mantêm os EIPs até serem apagadas. **DOCUMENTED** (fonte 8).
- PrivateLink: endpoint `com.amazonaws.<region>.lambda` para as APIs e `com.amazonaws.<region>.lambda-microvm` para o tráfego de dados. Opcional; é recurso de custo fixo. **DOCUMENTED** (fonte 8).
- **DNS e UDP: NOT FOUND na documentação primária.** Relatos divergentes:
  - Junho/2026: todo UDP de saída bloqueado por padrão no egress público; resolver padrão é um stub em localhost; containers Docker caem em 8.8.8.8 e falham; contorno `docker run --dns 169.254.169.253`; UDP funciona via VPC. **THIRD-PARTY REPORT** (fontes 35, 37).
  - Setembro/2026: "Nested-container DNS worked by default, without a resolver override." **THIRD-PARTY REPORT** (fonte 36).
  - As duas observações são incompatíveis entre si ou refletem mudança de plataforma/configuração entre junho e setembro; só o experimento decide (**INFERENCE**).
- **Metadados/credenciais**: a documentação primária não descreve o mecanismo (**NOT FOUND**). O toolkit afirma que as credenciais da execution role ficam em IMDSv2, `http://169.254.169.254/latest/meta-data/iam/security-credentials/execution_role`. **THIRD-PARTY REPORT** (fonte 34). Consequência: qualquer processo do guest (inclusive código do repositório e containers Docker com rota para o link-local) poderia ler credenciais da execution role, se houver uma (**INFERENCE**).
- Isolamento de redes privadas no `INTERNET_EGRESS` (o que é alcançável além da internet pública, ex.: faixas link-local, endpoints internos da AWS): **NOT FOUND**.
- Mediação/filtragem HTTP(S) de saída equivalente à do MVP: **NOT FOUND** — não há allow-list de destinos no egress público; restrição só via VPC + security groups/NACLs (fonte 8). É um relaxamento frente ao MVP que precisa de aprovação explícita (**INFERENCE**).

## 6. Modelo de segurança e IAM

- Ações IAM listadas na referência do guia (prefixo `lambda:`): `CreateMicrovmImage`, `UpdateMicrovmImage`, `DeleteMicrovmImage`, `GetMicrovmImage`, `ListMicrovmImages`, `RunMicrovm`, `GetMicrovm`, `ListMicrovms`, `SuspendMicrovm`, `ResumeMicrovm`, `TerminateMicrovm`, `CreateMicrovmAuthToken`, `CreateMicrovmShellAuthToken`. **DOCUMENTED** (fonte 9).
- Operações que existem na API mas não estão nessa tabela: `DeleteMicrovmImageVersion`, `GetMicrovmImageVersion`, `ListMicrovmImageVersions`, `UpdateMicrovmImageVersion`, `GetMicrovmImageBuild`, `ListMicrovmImageBuilds`, `ListManagedMicrovmImages`, `ListManagedMicrovmImageVersions`, `ListTags`, `TagResource`, `UntagResource`. **DOCUMENTED** como operações (fonte 16); que a ação IAM de cada uma seja `lambda:<Operação>` é **INFERENCE**.
- `lambda:PassNetworkConnector` seria exigida em **todo** `RunMicrovm`, mesmo com conectores padrão; `iam:PassRole` para a execution role. **THIRD-PARTY REPORT** (fonte 34); não constam na página de segurança primária. `iam:PassRole` também para a build role é **INFERENCE**.
- `lambda:ConnectMicrovm` existe apenas em políticas de VPC endpoint; não é ação de identidade. **DOCUMENTED** (fonte 8).
- Formato de ARN de recurso: `arn:aws:lambda:<region>:<account>:microvm-image:<nome>` e `...:network-connector:<id>`. O exemplo de least-privilege da doc escopa `RunMicrovm`, `GetMicrovm`, `SuspendMicrovm`, `ResumeMicrovm`, `TerminateMicrovm`, `CreateMicrovmAuthToken`, `GetMicrovmImage` ao recurso `microvm-image:*` — ou seja, as ações sobre MicroVMs são autorizadas pelo ARN da **imagem**. **DOCUMENTED** (fonte 9). Não há ARN por MicroVM documentado; isolar uma MicroVM de outra por IAM dentro da mesma imagem: **NOT FOUND**.
- Tags em imagens podem ser usadas em condições IAM (ABAC). **DOCUMENTED** (fontes 9, 17).
- Rascunho de conjunto mínimo para o operador do teste (a validar na conta; combina fontes 9, 16 e 34): leitura `lambda:ListManagedMicrovmImages`, `lambda:ListManagedMicrovmImageVersions`, `lambda:ListMicrovmImages`, `lambda:ListMicrovms`, `lambda:GetMicrovmImage`, `lambda:GetMicrovmImageVersion`, `lambda:ListMicrovmImageVersions`, `lambda:ListMicrovmImageBuilds`, `lambda:GetMicrovmImageBuild`, `lambda:GetMicrovm`; escrita `lambda:CreateMicrovmImage`, `lambda:UpdateMicrovmImage`, `lambda:DeleteMicrovmImage`, `lambda:DeleteMicrovmImageVersion`, `lambda:RunMicrovm`, `lambda:SuspendMicrovm`, `lambda:ResumeMicrovm`, `lambda:TerminateMicrovm`, `lambda:CreateMicrovmAuthToken`, `lambda:TagResource`, `lambda:PassNetworkConnector` (restrita aos ARNs `aws-network-connector:HTTP_INGRESS` e `INTERNET_EGRESS`), `iam:PassRole` (restrita à build role); mais S3 (`PutObject`/`GetObject`/`DeleteObject`/`ListBucket` no bucket de artefatos) e CloudWatch Logs (leitura e `DeleteLogGroup` em `/aws/lambda-microvms/*`). `lambda:CreateMicrovmShellAuthToken` só se a depuração por `SHELL_INGRESS` for autorizada. **INFERENCE**.
- **Build role** (assumida por `lambda.amazonaws.com`): `s3:GetObject` no artefato, `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`; ECR só se o `FROM` usar repositório privado. O guia de segurança diz que é opcional; a API a marca como **Required: Yes** (divergência, seção 11). **DOCUMENTED** (fontes 3, 9, 17).
- **Execution role** (opcional, `--execution-role-arn` no `RunMicrovm`): dá ao guest acesso a serviços AWS e é o que permite enviar stdout/stderr ao CloudWatch. Sem ela: sem logs de runtime e sem acesso a outros serviços AWS. **DOCUMENTED** (fontes 9, 10). Para o experimento, rodar **sem** execution role (ou com uma que só escreva logs) elimina credenciais AWS dentro do guest (**INFERENCE**).
- Trust policy: `lambda.amazonaws.com` com `sts:AssumeRole` (**DOCUMENTED**, fonte 9); adicionar `aws:SourceAccount`/`aws:SourceArn` contra confused deputy é recomendação do toolkit (**THIRD-PARTY REPORT**, fonte 34).
- Injeção de configuração e segredos:
  - `environmentVariables`: por imagem, fixadas no build, compartilhadas — inadequadas para segredos por sessão. **DOCUMENTED** (fonte 4).
  - `runHookPayload`: string por MicroVM entregue no corpo do hook `/run` junto com `microvmId`; a doc sugere "tenant IDs, session tokens, signed URLs, or Secrets Manager paths". Limite: guia diz 16 KB, a API diz "Maximum: 16,384 bytes" mas restringe o comprimento a 4096 (divergência, seção 11). **DOCUMENTED** (fontes 7, 18). É o canal natural para a chave pública SSH efêmera da sessão (**INFERENCE**). O payload aparece nos parâmetros da chamada; se é registrado em CloudTrail: **NOT FOUND**.
- Auditoria: CloudTrail registra por padrão apenas eventos de gerenciamento (imagens, `Get`/`List`). **`RunMicrovm`, `TerminateMicrovm`, `SuspendMicrovm`, `ResumeMicrovm`, `CreateMicrovmAuthToken` e `CreateMicrovmShellAuthToken` são data events, desligados por padrão**, com tipo de recurso `AWS::Lambda::MicrovmImage`. **DOCUMENTED** (fonte 10). Evidência de término via CloudTrail exigiria trail com data events (recursos e custo adicionais).
- Isolamento: Firecracker, uma MicroVM por tenant/sessão; capabilities elevadas ficam dentro da fronteira da VM. **DOCUMENTED** (fontes 1, 4).
- Boas práticas oficiais: tokens de 15–30 minutos com refresh, tokens escopados por porta, separar build role de execution role, sempre definir `maximumDurationInSeconds`. **DOCUMENTED** (fonte 11).

## 7. Quotas e limites

Todas **DOCUMENTED** (fonte 14), por conta e por região:

| Recurso | Padrão | Ajustável |
| --- | --- | --- |
| Memória alocada somando todas as MicroVMs (`RUNNING` + `SUSPENDED`) | 800 GB; 2.048 GB em N. Virginia, Oregon, Ohio, Tokyo, Ireland, Frankfurt, Sydney; burst até 4x | Sim |
| Duração máxima por MicroVM | 8 horas (28.800 s) | **Não** |
| Imagens por conta/região | 100 | Sim |
| Versões por imagem | 50 | Sim |
| Builds de imagem simultâneos | 5; 10 em N. Virginia, Oregon, Ohio, Tokyo | Sim |
| Conexões simultâneas por MicroVM | piso 150, +50 por vCPU adicional, máximo 600 | Não |
| Requisições por segundo por MicroVM | 40 (4 vCPU / 8 GB), 160 (16 vCPU / 32 GB) | Não |

| API | TPS | Burst |
| --- | --- | --- |
| `RunMicrovm` | 5 | 5 |
| `ResumeMicrovm` | 5 | 5 |
| `SuspendMicrovm` | 2 | 2 |
| `TerminateMicrovm` | 10 | 10 |
| `GetMicrovm` | 100 | 100 |
| `CreateMicrovmAuthToken` | 50 | 50 |
| `CreateMicrovmShellAuthToken` | 5 | 5 |

- Possível bloqueio para um teste pequeno: "New AWS accounts have reduced concurrency and memory quotas for Lambda Functions and Lambda MicroVMs [...] AWS raises these quotas automatically based on your usage." **DOCUMENTED** (fonte 14). O valor reduzido: **NOT FOUND** — conferir no console Service Quotas da conta escolhida antes de autorizar.
- Limites de taxa das APIs de imagem (`CreateMicrovmImage` etc.): **NOT FOUND** na tabela específica; a mesma página lista 15 req/s para o restante do control plane do Lambda, sem dizer se vale para MicroVMs.
- `InsufficientCapacityException` existe em `RunMicrovm` (fonte 18): capacidade não é garantida.
- Os limites padrão comportam com folga o experimento (1–3 MicroVMs de 8 GB, ~10 builds, 1–3 imagens) em conta não nova (**INFERENCE**).

## 8. Preços vigentes e estimativa

### Preços unitários

Fonte: arquivo de preços da página de pricing, publicado em **2026-11-18** (fonte 28); exemplos de cálculo da própria página (fonte 27). Todos **DOCUMENTED**. Valores em USD.

| Dimensão | US East (N. Virginia) = Ohio = Oregon | Europe (Ireland) | Asia Pacific (Tokyo) |
| --- | --- | --- | --- |
| vCPU-segundo, ARM (Graviton) | 0,0000276944 | 0,0000291572 | 0,0000322421 |
| GB-segundo de memória, ARM | 0,0000036667 | 0,0000038603 | 0,0000042688 |
| vCPU-segundo, x86 | 0,0000326557 | 0,0000340538 | 0,0000371569 |
| GB-segundo de memória, x86 | 0,0000043235 | 0,0000045086 | 0,0000049195 |
| Snapshot escrito (por GB, no suspend) | 0,0037977138 | 0,0040636422 | 0,0046556039 |
| Snapshot lido (por GB, no launch e no resume) | 0,0015467699 | 0,0016403088 | 0,0018548941 |
| Armazenamento de snapshot (por GB-hora) | 0,0001111111 (= 0,08 por GB-mês de 720 h) | 0,0001322222 | 0,0001333333 |

- x86 custa cerca de 17,9% a mais que ARM em N. Virginia (0,0000326557 / 0,0000276944).
- Regras de cobrança (**DOCUMENTED**, fonte 27):
  - Compute por segundo. Paga-se o baseline enquanto a MicroVM está `RUNNING`; acima do baseline paga-se "only for the active duration of the additional memory and vCPU consumed – not for the peak capacity".
  - Suspensa: sem compute; paga armazenamento do snapshot suspenso, mais escrita no suspend e leitura no resume.
  - Leitura de snapshot também é cobrada a cada launch (nos exemplos: launches × tamanho da imagem em GB × preço de leitura).
  - "MicroVM Image storage has a 1-week minimum retention period": cada versão de imagem é cobrada por pelo menos uma semana, mesmo se apagada antes.
  - Versões `INACTIVE` continuam cobradas (**THIRD-PARTY REPORT**, fonte 34).
  - Preço por requisição ou por conexão no ingress: não existe linha de preço. **NOT FOUND** como cobrança; a página descreve o serviço como "priced per instance-second".
  - Free tier para MicroVMs: **NOT FOUND**.
- Custos adjacentes em US East (N. Virginia) (**DOCUMENTED**, fonte 29, arquivos de 2026-11-19/20):
  - CloudWatch Logs, ingestão padrão ("Logs Collected Data Ingestion"): 0,50 por GB. Preço de armazenamento de logs não foi isolado no arquivo (**NOT FOUND** nesta leitura).
  - S3 Standard: 0,023 por GB-mês; PUT 0,000005 por requisição; GET 0,0000004 por requisição.
  - Transferência de dados: entrada da internet 0,00; saída para a internet 0,09 por GB (faixa até 10 TB). Franquia mensal gratuita de saída: não revalidada (**NOT FOUND** nesta leitura).
- Recursos de custo fixo, **todos evitáveis** se o experimento usar apenas `INTERNET_EGRESS` e `HTTP_INGRESS`: NAT gateway, Elastic IPs gerenciados do conector VPC, interface VPC endpoints (PrivateLink), trail de CloudTrail com data events (bucket S3 + eventos). Preços de NAT, EIP e endpoints **não foram revalidados** (arquivos `ec2`/`vpc` não interpretados): se testes de VPC entrarem no escopo, levantar esses preços antes.

### Estimativa para a campanha de teste

Parâmetros pedidos: ~20 MicroVM-horas em 4 vCPU / 8 GB, ~10 builds de imagem, ~20 GB-mês de armazenamento de imagem. Região de referência: **US East (N. Virginia)**.

Premissas (todas minhas, **INFERENCE**, exceto os preços):

1. "4 vCPU / 8 GB" é o **baseline** (maior tamanho; pico possível 16 vCPU / 32 GB; disco até 128 GB).
2. As 20 horas são de estado `RUNNING`.
3. Cenário de planejamento: 25% do tempo em pico total e 75% no baseline (mesma proporção do exemplo 1 da AWS). Builds e testes Docker são intensivos; a fração real é desconhecida.
4. Cada build é cobrado como compute de uma MicroVM no baseline por 15 minutos e escreve um snapshot de 8 GB cobrado como escrita. A documentação **não diz** se o build é cobrado (pode ser zero).
5. Snapshot de imagem de 8 GB (Docker Engine + ferramentas + memória inicializada). Tamanho real desconhecido.
6. 40 launches no total; 10 ciclos suspend/resume com 16 GB de estado suspenso cada, suspensos por pouco tempo.
7. 2 GB de logs ingeridos; 10 GB de saída para a internet, sem franquia; artefatos S3 desprezíveis.
8. Nenhum recurso de VPC, NAT, endpoint ou trail.

Aritmética, ARM:

- Compute no baseline por hora: (4 × 0,0000276944 + 8 × 0,0000036667) × 3600 = (0,0001107776 + 0,0000293336) × 3600 = 0,0001401112 × 3600 = **0,5044 por hora**.
- 20 h só no baseline: 20 × 0,5044 = **10,09**.
- 20 h com 25% em pico (pico = 4 × baseline, logo fator 0,75 + 0,25 × 4 = 1,75): 10,09 × 1,75 = **17,65**.
- 20 h com 100% em pico (fator 4): 10,09 × 4 = **40,35**.
- Builds, compute: 10 × 0,25 h × 0,5044 = **1,26**.
- Builds, escrita de snapshot: 10 × 8 GB × 0,0037977 = **0,30**.
- Armazenamento de imagem: 20 GB-mês × 0,08 = **1,60** (conferência: 10 versões × 8 GB × 168 h de retenção mínima = 13.440 GB-h = 18,7 GB-mês; coerente com os ~20 GB-mês pedidos).
- Leitura de snapshot nos launches: 40 × 8 GB × 0,0015468 = **0,49**.
- Suspend/resume: escrita 10 × 16 × 0,0037977 = 0,61; leitura 10 × 16 × 0,0015468 = 0,25; armazenamento suspenso desprezível (< 0,01) → **0,87**.
- Logs: 2 GB × 0,50 = **1,00**.
- Saída para a internet: 10 GB × 0,09 = **0,90**.
- S3: **0,01**.
- Soma dos itens que não são compute de execução: 1,26 + 0,30 + 1,60 + 0,49 + 0,87 + 1,00 + 0,90 + 0,01 = **6,43**.

Aritmética, x86 (mesmas premissas):

- Baseline por hora: (4 × 0,0000326557 + 8 × 0,0000043235) × 3600 = 0,0001652108 × 3600 = **0,5948 por hora**; 20 h = **11,90**; com 25% em pico = **20,82**; com 100% em pico = **47,58**.
- Builds, compute: 10 × 0,25 × 0,5948 = 1,49; demais itens iguais → soma dos outros itens = **6,66**.

| Cenário | ARM (USD) | x86 (USD) |
| --- | --- | --- |
| Piso: só baseline, sem burst (10,09 + 6,43) | **16,52** | **18,56** |
| Planejamento: 25% do tempo em pico | **24,08** | **27,48** |
| Teto: 100% do tempo em pico | **46,78** | **54,24** |

- Alternativa mais barata: baseline padrão de 2 GB / 1 vCPU com pico de 4 vCPU / 8 GB custa 0,1261 por hora no baseline (ARM) — entre 2,52 e 10,09 pelas 20 horas — mas limita o disco a 32 GB e a banda sustentada do endpoint a 2 MB/s.
- Em Ireland os preços de compute são ~5% maiores e em Tokyo ~16% maiores que em N. Virginia (ARM).
- **Maior incerteza: a cobrança acima do baseline.** O fator vai de 1x a 4x sobre o item dominante, e a documentação não diz como "active duration of the additional memory and vCPU consumed" é medida (granularidade, se memória de page cache conta, se o `dockerd` ocioso mantém memória acima do baseline). Segunda incerteza: se e como o build de imagem é cobrado, e o tamanho real dos snapshots.
- Sugestão de teto a submeter ao operador: **US$ 60** (teto x86 de 54,24 mais margem), com `maximumDurationInSeconds` curto em toda execução e inventário de versões de imagem ao final. É sugestão, não aprovação.

## 9. Componentes prontos para SSH sobre WebSocket

- **Nenhuma fonte, primária ou secundária, mostra SSH sobre WebSocket funcionando pelo `HTTP_INGRESS`.** **NOT FOUND.** O que existe:
  - WebSocket no `HTTP_INGRESS` é suportado e documentado, com autenticação por header ou subprotocolo. **DOCUMENTED** (fontes 7, 8).
  - `websocat` foi usado com sucesso contra o endpoint de **shell** (`SHELL_INGRESS`), passando `--header="X-aws-proxy-auth: <token>"` e `--binary`. **THIRD-PARTY REPORT** (fonte 35). Isso mostra que um cliente WebSocket de linha de comando autentica por header no proxy; não prova o caminho `HTTP_INGRESS` + `sshd`.
  - O PR da Sealant usa "authenticated control forwarding" HTTP com daemon próprio (`sealantd`), não SSH. **THIRD-PARTY REPORT** (fonte 36).
  - O padrão OpenSSH + websocat com `ProxyCommand` é documentado por outro provedor de sandbox (https://docs.e2b.dev/sandbox/ssh-access), não para Lambda MicroVMs. **THIRD-PARTY REPORT**.
- Candidatos (licença e recursos lidos nos READMEs; versão/data do último release não apareceram no texto extraído — conferir antes de fixar versões):

| Componente | Licença | Recursos relevantes | Observações |
| --- | --- | --- | --- |
| `websocat` (https://github.com/vi/websocat) | MIT | `--header` (header customizado no upgrade), `--protocol` (`Sec-WebSocket-Protocol`), `--binary`, ponte `ws-l:` ↔ `tcp:127.0.0.1:22` | Help mostra versão 1.13.0. Como `ProxyCommand` do `ssh` no cliente e ponte para `sshd` no guest. Um binário por lado. |
| `wstunnel` (https://github.com/erebe/wstunnel) | BSD-3-Clause | `-H`/`--http-headers`, `--http-upgrade-path-prefix`, `--websocket-ping-frequency` (padrão 30 s), exemplo oficial `ssh -o ProxyCommand="wstunnel client -L stdio://%h:%p ws://..."`, servidor em `ws://` puro | Reescrito em Rust desde a v7. Subprotocolo WebSocket customizado não mencionado. |
| `chisel` (https://github.com/jpillora/chisel) | MIT | `--header`, `--keepalive` (padrão 25 s), `stdio:<host>:<port>` com exemplo de `ProxyCommand` | Usa camada SSH própria (`crypto/ssh` do Go) dentro do WebSocket; changelog até 1.12. Acrescenta um segundo protocolo/autenticação a auditar. |
| `sshd` (OpenSSH) + ponte ws↔tcp | BSD (OpenSSH) | host key, chaves por sessão, `ForceCommand`, `PermitOpen`, `AllowTcpForwarding no`, subsistema SFTP controlável | O servidor SSH em si; a ponte é um dos itens acima. |

- Pontos de compatibilidade a provar (**INFERENCE**, com base nas fontes 7 e 8):
  - Os três clientes conseguem enviar `X-aws-proxy-auth` e `X-aws-proxy-port` por header; se o proxy aceita upgrade WebSocket autenticado só por header (sem o subprotocolo `lambda-microvms`) no `HTTP_INGRESS` não está escrito — o relato existente é do endpoint de shell.
  - Se for preciso usar subprotocolos, o servidor no guest não os verá (são removidos), o que pode quebrar a negociação de `Sec-WebSocket-Protocol` em clientes estritos.
  - O servidor da ponte deve escutar em `ws://` puro (o TLS termina no proxy) e em `0.0.0.0`.
  - Keepalive (ping/pong) é recomendado pela própria AWS contra quedas; `wstunnel` e `chisel` têm por padrão, `websocat` precisa de opção de ping.
  - Token de no máximo 60 minutos: sessões longas dependem de o WebSocket sobreviver à expiração ou de reconexão com token novo.
  - Banda de 2 MB/s por vCPU e 40 requisições/s por MicroVM (4 vCPU) limitam SFTP e multiplexação.
- Escopo por papel não vem do transporte: o token JWE escopa **portas**, não usuários nem comandos. Builder versus revisores somente leitura teria de ser imposto no guest (usuários Unix distintos, `sshd` com `ForceCommand`/`PermitOpen`/SFTP restrito, eventualmente portas e tokens distintos por papel). **INFERENCE**. Atenção: com `ALL` e Docker, quem controla o socket do Docker é efetivamente root no guest.

## 10. Cleanup: recursos, remoção e verificação

Comandos `aws lambda-microvms` e os nomes de operação são **DOCUMENTED** (fontes 3, 4, 7, 16, 24, 25, 34), salvo indicação. Comandos de IAM, S3, Logs, CloudTrail e EC2 são os usuais desses serviços e não foram revalidados aqui (**INFERENCE** quanto à forma exata).

| Recurso | Criado por | Remove | Verifica |
| --- | --- | --- | --- |
| MicroVM | `run-microvm` | `aws lambda-microvms terminate-microvm --microvm-identifier <id>` (idempotente; resposta vazia) | `aws lambda-microvms get-microvm --microvm-identifier <id>` até `state = TERMINATED` com `terminatedAt`; `aws lambda-microvms list-microvms` sem itens fora de `TERMINATED` |
| Estado suspenso (snapshot da MicroVM suspensa) | suspend manual ou idle policy | termina junto com a MicroVM (`terminate-microvm` ou `suspendedDurationSeconds`) | mesmo `get-microvm`; a doc afirma "Terminated MicroVMs incur no charges" |
| Versão de imagem (snapshot) | cada `create-`/`update-microvm-image` | `aws lambda-microvms delete-microvm-image-version --image-identifier <img> --image-version <v>` | `aws lambda-microvms list-microvm-image-versions --image-identifier <img>`; estado `DELETING` → `DELETED` |
| Imagem | `create-microvm-image` | `aws lambda-microvms delete-microvm-image --image-identifier <img>` (idempotente; devolve `state`) | `aws lambda-microvms get-microvm-image` (`DELETED` ou `ResourceNotFoundException`) e `list-microvm-images` |
| Zip de artefato no S3 | upload | `aws s3 rm s3://<bucket>/<key>` | `aws s3 ls s3://<bucket>/` |
| Bucket S3 (se criado para o teste) | operador | `aws s3 rb s3://<bucket>` (vazio; cuidar de versões se versionado) | `aws s3api head-bucket --bucket <bucket>` deve falhar |
| Log group `/aws/lambda-microvms/<image-name>` (build e runtime) ou customizado | build role / execution role, automaticamente | `aws logs delete-log-group --log-group-name <nome>` | `aws logs describe-log-groups --log-group-name-prefix /aws/lambda-microvms/` |
| Build role, execution role e políticas | operador | `aws iam detach-role-policy` / `delete-role-policy`, depois `aws iam delete-role` | `aws iam get-role --role-name <nome>` deve falhar |
| Usuário/role do operador de teste e chaves de acesso | operador | `aws iam delete-access-key`, remoção das políticas e do principal | `aws iam list-access-keys`, `get-user`/`get-role` |
| Repositório ECR (só se `FROM` privado) | operador | `aws ecr delete-repository --repository-name <r> --force` | `aws ecr describe-repositories` |
| Network connector VPC (só se VPC for testado) | `aws lambda-core create-network-connector` | comando de remoção em `aws lambda-core` — nome exato **NOT FOUND** nas páginas lidas (o estado `DELETING` e a orientação "delete the connector" estão documentados); apagar também versões antigas | `aws lambda-core get-network-connector`; `aws ec2 describe-network-interfaces` com `IncludeManagedResources=true` (**THIRD-PARTY REPORT**, fonte 35); `aws ec2 describe-addresses` para EIPs `ServiceManaged = lambda-network-connector` |
| Operator role do conector, VPC, subnets, security groups, internet gateway, NAT gateway, VPC endpoints | operador (só em teste de VPC) | comandos `aws ec2 delete-*` / `aws iam delete-role` correspondentes | `aws ec2 describe-*` correspondentes |
| Trail de CloudTrail com data events e seu bucket (só se habilitado) | operador | `aws cloudtrail delete-trail` e remoção do bucket | `aws cloudtrail describe-trails` |
| Tags | junto dos recursos | somem com o recurso | — |

Observações:

- Pré-condições de `delete-microvm-image` (por exemplo, MicroVMs ainda ativas da imagem): **NOT FOUND**; a API prevê `ConflictException`. Ordem segura (**INFERENCE**): terminar e confirmar todas as MicroVMs → apagar versões → apagar imagem → logs → S3 → roles.
- A retenção mínima de 1 semana significa que apagar a imagem não zera o custo de armazenamento daquela semana. **DOCUMENTED** (fonte 27).
- Marcar todos os recursos com uma tag do experimento facilita o inventário; imagens aceitam tags. Tags em MicroVMs individuais: **NOT FOUND** (`RunMicrovm` não tem campo `tags`).
- A cobrança final só fecha no Cost Explorer/fatura com atraso (**INFERENCE**); o relatório de custo real deve registrar a data de leitura.

## 11. Contradições e ajustes frente às premissas do ticket

Premissas confirmadas:

- Teto de 8 horas: confirmado, não ajustável, e **inclui tempo suspenso**. **DOCUMENTED**.
- Nome da capacidade: `additionalOsCapabilities` com `["ALL"]`, único valor aceito. **DOCUMENTED**.
- Nomes de ingress/egress: `HTTP_INGRESS`, `SHELL_INGRESS`, `INTERNET_EGRESS` confirmados; existe também `NO_INGRESS`. São sufixos de ARNs de conectores gerenciados, não valores de enum. **DOCUMENTED**.
- `SHELL_INGRESS` fora de produção: a própria AWS diz o mesmo. **DOCUMENTED**.

Pontos em que a documentação diverge do que o ticket supõe ou acrescenta restrição:

1. **"Expiração de token AWS" são duas camadas distintas.** O ingress não usa SigV4: usa token JWE de no máximo 60 minutos, emitido por uma chamada IAM. O experimento precisa tratar separadamente a credencial IAM do host (para emitir tokens e controlar o ciclo de vida) e o token JWE da conexão. **DOCUMENTED**.
2. **Docker não tem suporte documentado.** A doc primária nunca menciona Docker; só "nested containers (containerd inside the MicroVM)" no toolkit auxiliar. Todo o perfil Docker da fábrica é observação experimental ou relato de terceiro. **NOT FOUND / THIRD-PARTY REPORT**.
3. **A aplicação já roda como container** no containerd da MicroVM; o `dockerd` seria aninhado. O ticket fala em "capacidades efetivas, cgroups, storage driver" como se fosse o SO da VM; medir dentro do container da aplicação. **DOCUMENTED** (container) + **INFERENCE** (aninhamento).
4. **Ociosidade = ausência de tráfego de entrada no endpoint.** Uma MicroVM trabalhando sem tráfego de entrada pode ser suspensa pelo idle policy; ao suspender, conexões caem ("Connections dropping"). Para a fábrica, omitir `idlePolicy` ou usar `maxIdleDurationSeconds` alto, e suspender apenas por decisão explícita. **DOCUMENTED** (medição) + **INFERENCE** (recomendação).
5. **O estado em `GetMicrovm` é eventualmente consistente** e `TerminateMicrovm` não devolve estado. "Confirmar cessação" precisa de polling com timeout e de um critério para o caso em que `TERMINATED` demora. **DOCUMENTED**.
6. **Run/Terminate não aparecem no CloudTrail por padrão** (são data events). Evidência de propriedade e término não vem "de graça". **DOCUMENTED**.
7. **Hooks de runtime têm no máximo 60 s** segundo o toolkit; o `/terminate` não sustenta commit + push. Coerente com a direção, mas é limite concreto. **THIRD-PARTY REPORT**.
8. **Não há tamanho médio fixo**: 4 vCPU / 8 GB é o maior baseline ou o pico do padrão; o disco máximo depende do baseline (32 GB no padrão, 128 GB no maior). O limite de disco publicado no lançamento era de 32 GB segundo resumo de busca do post de lançamento, que não carregou (fonte 33) — tratar a tabela atual como vigente. **DOCUMENTED** (tabela).
9. **Banda do endpoint limitada a 2 MB/s por vCPU** e 40 req/s por MicroVM de 4 vCPU: restringe transferência de arquivos e streaming pelo túnel. Não previsto no ticket. **DOCUMENTED**.
10. **Imagem não é imagem OCI pronta**: é Dockerfile em zip no S3, construído pela AWS, com snapshot de memória. Reconstrução "por Git" parte de um snapshot já inicializado; processos vivos no build (inclusive um `dockerd`) entram no snapshot, e o relato da Sealant mostra falha exatamente aí (`/run` ausente após restore). **DOCUMENTED** + **THIRD-PARTY REPORT**.
11. **Segredos por sessão** não cabem em variáveis de ambiente (são da imagem); o canal é `runHookPayload`. Host key de SSH gerada no build seria compartilhada por todas as MicroVMs da versão. **DOCUMENTED** + **INFERENCE**.
12. **DNS/UDP**: o ticket cita "particularidades de UDP/resolver"; os relatos de junho e setembro se contradizem e a doc é omissa. Nenhum dos dois pode ser assumido. **THIRD-PARTY REPORT**.
13. **Região**: não há preço de MicroVM em São Paulo; o experimento terá de usar outra região (as mais baratas são N. Virginia, Ohio e Oregon). **DOCUMENTED** (preço) + **INFERENCE** (indisponibilidade).
14. **x86 existe desde 2026-11-11** (base image v3). Notas de meses atrás que diziam "somente ARM64" estão desatualizadas. **DOCUMENTED**.
15. **Retenção mínima de 1 semana** no armazenamento de imagem: "apagar logo" não elimina esse custo. **DOCUMENTED**.

Divergências internas da própria documentação (registrar no relatório do experimento o que a API realmente aceitar):

- Build role: "optional" no guia de segurança (fonte 9) versus `buildRoleArn` **Required: Yes** na API (fonte 17).
- `runHookPayload`: "max 16 KB" no guia e "Maximum: 16,384 bytes" na API, mas com restrição de comprimento máximo 4096 na mesma página (fonte 18).
- Estados de falha da imagem: `CREATION_FAILED`/`DELETION_FAILED` no guia (fonte 4) versus `CREATE_FAILED`/`DELETE_FAILED` na API (fontes 17, 24).
- Campo `terminationMessage` citado no troubleshooting (fonte 12) não existe na resposta de `GetMicrovm`, que tem `stateReason` (fonte 19).
- Prefixo do ID: `mvm-...` no guia (fontes 3, 7), `microvm-...` em relatos e no toolkit (fontes 34, 35), `ai-...` no exemplo de CloudTrail (fonte 10).
- Pricing descreve o burst como "up to 8GB / 4vCPU" (texto geral, fonte 27) enquanto a tabela de tamanhos e o exemplo 2 vão até 32 GB / 16 vCPU (fontes 4, 27).
- Banda: "~1 MB/s per vCPU" no toolkit (fonte 34) versus 2 MB/s por vCPU no guia e nas release notes da base image v2 (fontes 6, 8) — o toolkit está defasado.
- Página de segurança afirma que "Lambda MicroVM images support AWS resource tags"; a tabela de ações IAM omite as operações de tag e de versão.

## Lacunas

O que a documentação não responde e só o experimento (ou suporte da AWS) pode responder:

**Docker**

- Se `dockerd` sobe e opera dentro do container da aplicação com `ALL`: capabilities efetivas, seccomp, versão de cgroups e delegação, storage driver utilizável (overlay2 sobre o rootfs da MicroVM), iptables/nftables, bridge e port mapping.
- Compose com rede e DNS entre serviços, bind mounts, volumes.
- **Testcontainers com Ryuk** (criação, comunicação pelo socket, cleanup): nenhuma fonte cobre.
- DNS de containers aninhados e saída UDP no `INTERNET_EGRESS`: relatos contraditórios (junho versus setembro de 2026).
- Comportamento de `dockerd` capturado no snapshot de build versus iniciado no hook `/run`; integridade de daemon, containers e rede após suspend/resume.
- Disco realmente disponível no guest por tamanho, como é provisionado e se o "disco máximo" é automático; limite real de tamanho de imagem/snapshot e do disco de build.
- Diferenças entre ARM64 e x86_64 para as imagens e ferramentas do perfil da fábrica.

**Transporte**

- Se SSH sobre WebSocket atravessa o `HTTP_INGRESS` com cada componente candidato; se o upgrade autenticado só por header funciona sem o subprotocolo `lambda-microvms`.
- Duração máxima e timeout ocioso de um WebSocket; se frames de ping/pong e tráfego de saída contam como atividade para o idle policy.
- O que acontece com conexões abertas quando o token JWE expira; custo e latência de reconexão com token novo.
- Throughput real pelo túnel (banda por vCPU do baseline ou do pico), comportamento com arquivos binários grandes, e efeito do limite de requisições/conexões por MicroVM.
- Distinção observável entre canal fechado, processo encerrado e MicroVM suspensa/terminada (códigos 502/403/429 do proxy versus fechamento do WebSocket).
- Se o isolamento por papel (Builder versus revisores somente leitura) é imponível no guest quando há Docker com `ALL`.

**Ciclo de vida**

- Latência entre `terminate-microvm` e `TERMINATED` visível; por quanto tempo uma MicroVM terminada continua consultável; conteúdo real de `stateReason` em término por duração máxima, por falha de hook e por pedido explícito.
- Valor padrão de `maximumDurationInSeconds` quando omitido e comportamento exato ao atingir o teto (o hook `/terminate` é chamado? com que prazo?).
- Comportamento sem `idlePolicy` (nunca suspende?).
- Timeouts efetivos dos hooks de runtime.

**Rede e segurança**

- O que o guest alcança no `INTERNET_EGRESS` além da internet pública: 169.254.169.254 e demais link-local, endpoints internos, outras MicroVMs da mesma conta.
- Mecanismo real de entrega das credenciais da execution role e se containers aninhados conseguem lê-las; comportamento sem execution role.
- Nomes exatos das ações IAM para operações de versão, build e tags; necessidade real de `lambda:PassNetworkConnector` e `iam:PassRole`; possibilidade de restringir por MicroVM e não só por imagem.
- Se `runHookPayload` fica registrado em CloudTrail ou em logs.
- Visibilidade dos componentes de transporte e dos segredos de sessão para o código do repositório dentro do guest.

**Custo e quotas**

- Como a cobrança acima do baseline é medida na prática (maior incerteza da estimativa).
- Se o build de imagem gera cobrança de compute e de escrita de snapshot; tamanho real dos snapshots de imagem e de suspensão.
- Quota reduzida efetiva da conta escolhida (contas novas) e limites de taxa das APIs de imagem.
- Preços de NAT gateway, Elastic IP e VPC endpoints (não revalidados; só relevantes se VPC entrar no escopo) e franquia de transferência de saída.
- Versão mínima da AWS CLI/SDK com `lambda-microvms` e `lambda-core`.
