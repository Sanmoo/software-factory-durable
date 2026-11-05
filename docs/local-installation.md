# Preparação e diagnóstico offline

Construir com a [baseline de desenvolvimento](development.md). Usar raiz explícita
(ou o diretório atual, se `--root` for omitido); não há busca de instalação no home.

```sh
./factory setup --root /caminho/privado/factory --json
# Editar somente a configuração da instalação, sem colocar valores secretos nela.
./factory doctor --root /caminho/privado/factory
./factory doctor --root /caminho/privado/factory --json
./factory --help
```

Use uma raiz curta e privada, preferencialmente conta dedicada. Setup cria somente
`releases/`, `assets/`, `credentials/`, `data/`, `environments/`, `run/` (0700) e
`config.yaml` (0600). Não cria banco operacional, lock/socket ou ambiente. Recursos
preexistentes nunca são sobrescritos nem recebem chmod recursivo; symlinks/tipos
incompatíveis nos paths conhecidos são recusados antes de criar filhos. A raiz é
canonicalizada. Repetição não autoriza nenhum repo nem altera configuração,
dados, credenciais ou filhos desconhecidos. Setup não instala pacotes, usa sudo,
registra serviços ou repara host. Corridas host adversariais não fazem parte do
perfil confiável aprovado; não prometemos instalador resistente a atacantes locais.

Setup retorna `SETUP_PREPARED` quando preparou/preservou recursos próprios e inclui
`diagnostics`. O exemplo inicial é **deliberadamente incompleto** (models e App ID
nulos), com `repositories: []` e `operators: []`; seu diagnóstico não é verde.
É preciso completar a configuração, não assumir que preparação é início operacional.

## YAML schemaVersion 1

Exemplo sintético estruturalmente completo; não acessa os serviços indicados:

```yaml
schemaVersion: 1
operators: [operador-github] # [] explícito não autoriza comentários remotos
models:
  builder:
    provider: provedor-explicito
    model: modelo-builder
    credentialFile: credentials/model.json # opcional; somente referência
  standards: {provider: provedor-explicito, model: modelo-standards}
  spec: {provider: provedor-explicito, model: modelo-spec}
githubApp:
  appId: 123
  privateKeyFile: credentials/github-app.pem
sandbox:
  schemaVersion: 1
  profile: gondolin-qemu-alpine-dev-v1
repositories:
  - repository: owner/repo
    base: main
    installationId: 456
    workflows: false # escolha obrigatória: true ou false, nunca presumida
```

`gondolin-qemu-alpine-dev-v1` é identidade fixa **de desenvolvimento**, sem assets
ou release homologados. A factory pública `createSandbox({root}).validate(configuration)`
possui a validação/probes do adapter; bootstrap delega os campos de sandbox, não
mantém flags QEMU/modelo paralelo. Não existem prepare/start stubs neste incremento.

Defaults aprovados, visíveis em `doctor --json` (`configuration.effective`):

| Campo | Default |
| --- | --- |
| `concurrency` | 1 |
| `pollingSeconds` | 60 |
| `retentionDays` | 30 |
| `repositories[].label` | `ready-for-agent` |
| `repositories[].correctionLimit`, `recoveryLimit` | 3 / 3 (inteiros >= 0) |
| `repositories[].timeoutSeconds` | ausente; se presente, inteiro positivo |
| `recoveryBackoffSeconds` | saída fixa `[5,15,45]`, não override arbitrário |
| `sandbox.memoryMiB`, `vcpus`, `diskGiB` | 2048 MiB, 2, 40 GiB |
| `sandbox.shutdownGraceSeconds`, `minFreeSpaceGiB` | 30 s, 4 GiB |

Recursos/prazos da sandbox são inteiros positivos, sem coerção; MiB/GiB são
binários. Capacidade virtual não é reserva física, vCPUs não são núcleos exclusivos,
e o piso livre não é garantia contra disco cheio. Sem argumentos QEMU, init/mounts
livres ou fallback TCG/krun/Docker. Model/provider por papel, operadores (inclusive
lista vazia explícita), repo/base, App/installation e Workflows não têm fallback.

YAML com chave duplicada/alias, schema desconhecido, campo/override desconhecido,
valor/tipo inválido ou segredo inline é recusado. Arquivos de credencial são
referências relativas de um único arquivo sob `credentials/`, nunca paths pessoais,
URLs, `..`, tokens ou chaves inline. O validador rejeita campos secretos e formatos
conhecidos de tokens; isso não é detector universal de segredos disfarçados de nomes.
Doctor não lê conteúdo das credenciais nem testa autenticação/provider.
Configuração inválida não produz `effective`, aplicação parcial, escrita de estado
ou substituição pelo perfil pessoal. Alterações operacionais futuras entram por
reinício, não hot reload; este incremento nunca aplica configuração ao controlador.

## O que doctor prova (e o que não prova)

Read-only, sem banco operacional: informa Node e versões QEMU/qemu-img/systemctl,
paths canônicos, permissões/ownership/tipos de diretórios e arquivos referenciados,
acesso à KVM, presença de systemd, espaço/tipo de filesystem e limite de socket
Linux (107 bytes UTF-8, excluindo NUL). Probes de executáveis usam somente
`--version`, ambiente limitado a PATH/locale, timeout de 2 s e saída limitada.
Não usa `gh auth`, perfis pessoais, credenciais remotas ou Docker host.

Cada check tem `id`, `status` (`ok`, `blocked`, `unverified`), motivo e `nextStep`.
Diagnósticos não imprimem valores rejeitados nem mensagens cruas do parser YAML.
Config incompleta, pré-requisito ausente e runtime não qualificado são distintos:

| Resultado | Exit | Semântica |
| --- | --- | --- |
| `SETUP_PREPARED` | 0 | Setup criou/preservou recursos próprios; ler diagnostics, não inicia operação. |
| `INVALID_CONFIGURATION` | 2 | Doctor encontrou YAML/campos requeridos inválidos; nenhum effective. |
| `PREREQUISITES_MISSING` | 3 | Config válida, mas ao menos um pré-requisito está bloqueado. |
| `RUNTIME_UNQUALIFIED` | 0 | Diagnóstico executado sem bloqueio estático; checks não comprovados permanecem `unverified`. **Não significa runtime pronto.** |
| `INVALID_ARGUMENTS` / `LOCAL_IO_FAILED` | 2 | Uso inválido ou falha local; sem reparo automático. |

Acesso RW a `/dev/kvm` não prova KVM funcional/nested; presença/versão de systemd não
prova supervisão/permissões. Statfs/free-space não prova locks, fsync ou recuperação
após perda de energia. Não se faz boot/TCG fallback, teste Docker/TLS, montagem FUSE,
criação de units, alteração de permissões ou reparo. Esses checks permanecem
explicitamente `unverified` e exigem integração real autorizada antes da operação.
A prova de release autocontida/manifestos/assets e atualização não foi realizada.

`run`, status operacional e demais comandos da spec ainda não são implementados
neste ticket: são recusados com `INVALID_ARGUMENTS`, não simulados com sucesso.

## Diagnóstico autenticado pelo proprietário (incremento 04)

Com o controlador disponível, `factory doctor --authenticated --root <raiz>
--json` verifica acesso operacional pela App configurada. A CLI não lê a chave,
abre SQLite ou usa identidade pessoal; sem proprietário retorna
`CONTROLLER_UNAVAILABLE` (exit 3). Saída `access` contém resultados separados de
tracker/repositório com origem, instante, identidade, completude, limitações,
metadados de concessão sem segredo, causa/ação e espera de rate limit quando
pertinente. Resultado bloqueado retorna exit 3; observações bem-sucedidas retornam
0, **sem qualificar escrita não exercida, runtime ou barreiras de merge/CI**.
Sem `--authenticated`, o doctor conserva o comportamento offline acima.

Esse caminho lê a chave protegida e emite concessões somente no controlador;
usá-lo com recursos reais requer autorização e configuração explícitas.
A implementação foi validada apenas com fronteira gh/GitHub substituída por
fixture local e segredos sintéticos; o [aceite real permanece bloqueado](evidence/04-github-app-access-diagnostics.md).
