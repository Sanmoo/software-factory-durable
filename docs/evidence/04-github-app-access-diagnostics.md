# 04 — Diagnóstico GitHub App: incremento local, aceite BLOCKED

## Composição implementada

`factory doctor --authenticated --root <instalação> --json` consulta o proprietário
pelo socket privado existente, após obter o boot ID via `inspect(status)`. Sem
controlador retorna `CONTROLLER_UNAVAILABLE`/exit 3, sem abrir SQLite ou ler chave
pela CLI. O doctor sem flag continua offline e não lê valores de credenciais.
O controlador compõe `IssueTracker.checkAccess(scope)` e
`CodeRepository.checkAccess(repo, base)` distintos com infraestrutura GitHub
privada compartilhada; nenhum adapter consulta/importa o outro.

O emissor privado lê somente a referência explícita da chave no controlador:
paths privados/da conta, arquivo regular, sem symlink/hardlink, tamanho limitado,
`O_NOFOLLOW` e verificação do descritor. JWT RS256 verifica App/instalação/owner;
a concessão pede um repo e permissões explícitas por finalidade. Escopo, validade,
permissões e identidade devolvidos são conferidos antes de consultas com o token.
Nenhuma projeção Builder/revisor, engine de workflow ou serviço de credenciais
foi acrescentado. Concessões de diagnóstico não são persistidas e expiram no prazo
informado; revogação/renovação e entrega aos agentes não são implementadas neste
incremento (não afirmar revogação ou contenção de cópias).

`gh api` usa argv estruturado, REST `2026-03-10`, host `github.com`, sem shell,
login, alias ou fallback. `GH_TOKEN` fica somente no ambiente explícito, com
HOME/config temporários privados e sem herdar o ambiente pessoal. Timeout e
limites de resposta/páginas falham explicitamente; página posterior negada,
malformada ou indisponível não produz sucesso parcial. Erros externos crus não
são expostos; valores conhecidos são registrados em memória antes de uso e
filtrados na projeção final. Rate limit informa segundos, repo e finalidade,
sem retry automático.

Tracker lê issues/comentários e, havendo issue não-PR acessível, sonda dependências
nativas de uma amostra. Sem issue, informa explicitamente que essa capacidade
não foi verificada. CodeRepository valida repo/base/SHA. Permissões de escrita
são observadas na concessão, **não exercitadas**. `limitations` distingue essa
observação de prova de escrita, grafo completo ou snapshot atômico. Workflows é
escolha explícita já validada na configuração; nunca entra em tokens de doctor.
Não há leitura/certificação de bypass, barreiras da base/merge/CI, mutações de
issues/PRs/branches ou provas negativas dessas barreiras.

## Evidência efetivamente executada

Node `24.21.0` e npm do mesmo PATH, dependências do lockfile (`npm ci`).
`test/entrypoints/github-access.test.ts` executa os adapters/emissor reais sobre
um **executável local que substitui gh e GitHub**, com RSA gerada no teste e tokens
sintéticos. O fixture valida assinatura/claims JWT, argv, verbos e allowlist de
env; nunca se conecta à rede. O teste de CLI/controlador usa flock, protocolo,
Session/SQLite reais da composição local e verifica ausência de chave/token no
resultado e no banco após parada.

| Subcaso | Expectativa / observado | Nível fiel e lacuna |
| --- | --- | --- |
| V-03: redução repo/papel/finalidade; grant mais amplo, outro repo, token inválido | Recusa antes de consulta autorizada; passou | Emissor/adapters reais, gh/GitHub substituídos; sem prova de escopo real |
| V-03: chave não privada/symlink; identidade pessoal no ambiente da CLI | Sem fallback; passou | Filesystem/subprocessos locais reais; sem guest/SDK/sessão de agentes |
| V-03: segredo sintético no erro remoto e grant | Não aparece em diagnóstico/stdout/stderr/storage; passou | Projeção doctor real; não cobre streaming/ferramentas/SDK nem transformações arbitrárias |
| V-05: página posterior falha; Link fora do host; payload incompleto | Incomplete/blocked, não sucesso; passou | Paginação real do transporte contra fixture; sem GitHub real ou grafo transitivo |
| V-05: leitura de dependência negada na amostra | Causa `GITHUB_ACCESS_DENIED`; passou | Endpoint simulado; visibilidade/cross-owner invisível não certificada |
| V-16: doctor autenticado com/sem proprietário | Socket/controlador necessários; sem comando durável/token no banco; passou | Composição local real; App/gh real substituídos |
| Rate limit | `GITHUB_RATE_LIMITED`, espera 37 s e repo/finalidade; passou | Headers sintéticos; sem induzir falha remota |

TDD observado: primeiro build vermelho por módulos inexistentes; verde no primeiro
checkAccess. Doctor autenticado vermelho (flag recusada exit 2 em vez de controlador
indisponível exit 3), depois verde na composição. Probe de dependências negada
vermelha (`ok` indevido), depois verde com consulta nativa. Token contendo newline
vermelho (`ok` indevido), depois verde com validação antes do uso. O primeiro teste
CodeRepository falhou por fixture ainda sem sua finalidade/base; a correção foi do
fixture, não deve ser contada como regressão de implementação descoberta.
Demais negativos foram adicionados como regressão e já passaram ao serem executados.

Gate completo: `npm run typecheck`, `npm test` (arquitetura estática + build + suíte
completa, 59 testes), `git diff --check`. Gate e testes anteriores preservados.
`npm ci` informou cinco vulnerabilidades moderadas transitivas preexistentes;
nenhuma atualização fora de escopo ou `audit fix` foi aplicada.

## Correção local F1/P1 — seletor REST de repositório

Revisão independente do checkpoint `4da6ad2` identificou que o pedido de emissão
usava `repository_names`, também exigido pelo fixture. Corrigido **somente F1**:
`src/platform/github/index.ts` envia agora `{ repositories: [name], permissions: required }`.
A validação de escopo/identidade/permissões/validade devolvidos permanece intacta.

Fonte independente consultada por HTTPS público, sem autenticação:
[Create an installation access token for an app](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#create-an-installation-access-token-for-an-app),
versão REST `2026-03-10`. A tabela Body parameters especifica `repositories`
(array de nomes) ou `repository_ids` (array de IDs), não `repository_names`;
o exemplo oficial envia `{"repositories":["Hello-World"],"permissions":{"issues":"write","contents":"read"}}`.
A documentação informa que omitir ambos herda todos os repositórios da instalação.
A consulta usou apenas `curl -q` para docs.github.com (artigo Markdown público e
página HTML), **não** `gh api`, api.github.com, credenciais ou emissão real.

Seams já aprovadas e preservadas: `IssueTracker.checkAccess(scope)` e
`CodeRepository.checkAccess(repo, base)`, com adapters/emissor reais e substituição
somente da fronteira externa gh/GitHub. O fixture modela agora instalação com
`acme/project` (ID 3) e `acme/other` (ID 4), selecionando a resposta a partir do
seletor REST explícito em vez de devolver sempre o repo desejado. Teste direto do
executável sintético confirma que nomes e IDs selecionam somente o repo pedido,
e que `repository_names`, ausência de seletor e lista vazia são recusados sem
emitir resposta de grant. **Essa recusa é uma guarda deliberadamente mais estrita
do fixture**, não afirma que o servidor GitHub rejeita ausência/campos desconhecidos:
justamente impede que herança implícita do teto pareça redução explícita no teste.

RED → GREEN observado, nesta ordem, com PATH
`/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin:$PATH`:

```sh
npm run build && node --test --test-name-pattern='local GitHub fixture requires explicit REST selectors|IssueTracker.checkAccess explicitly narrows' dist/test/entrypoints/github-access.test.js
```

- **RED (exit 1):** fixture corrigido antes do código de produção; 2 testes,
  1 passou (contrato independente do fixture) e 1 falhou (`checkAccess` retornou
  `blocked`, esperado `ok`). O fixture recusou o seletor não suportado da
  implementação do checkpoint, em vez de fabricar grant de um só repo.
- **GREEN (exit 0):** alterado apenas `repository_names` → `repositories` na
  emissão; mesmo comando, 2/2 passaram. O diagnóstico público só consegue sucesso
  se a resposta do fixture tiver exatamente o repo solicitado.
- Preservados negativos de permissões mais amplas/outro repo e adicionados
  negativos de escopo devolvido ausente (`INVALID_CREDENTIAL_GRANT`) e múltiplos
  repos (`CREDENTIAL_SCOPE_MISMATCH`), sem sucesso parcial ou vazamento sintético.
- Gate após correção: `npm run typecheck` passou; `npm test` passou (arquitetura,
  ESLint, build e **62/62** testes, zero skips/falhas); `git diff --check` passou.

Isso corrige a compatibilidade local do pedido e a falsa premissa do fixture;
**não comprova emissão, redução ou autenticação reais por gh/GitHub**. Ticket 04
continua BLOCKED para aceite autenticado, sem checkbox ou resolução alterados.

## Lacuna anterior ao ensaio real (histórico do checkpoint F1)

**Naquele checkpoint**, ticket permanecia aberto, sem Answer/resolução nem
homologação real. Nenhuma credencial/identidade pessoal havia sido lida/usada,
nenhum token real emitido e nenhuma chamada GitHub ou mutação remota realizada.
O ensaio autorizado abaixo substitui esse estado histórico; não o aceite.

Requer autorização específica e configuração de teste pelo operador para executar
o doctor composto com o `gh` real, App/instalação/repos/base explícitos e chave
protegida, autorizar emissão de installation tokens de teste e registrar versão
real de gh/REST, identidades, escopos/validade, permissões, completude e resultados
sem segredos. Exercitar acesso operacional real permitido/negado e compatibilidade
de dependências em issue conhecida (com autorização separada para preparar qualquer
recurso remoto), rate/consulta parcial sem injetar falhas em sistemas existentes.
Não declarar que fixture prova a fronteira gh/GitHub. Não criar/mudar barreiras de
merge/base/CI nem cobrar provas negativas delas. V-03 completo (renovação,
revogação/crash, guest/SDK/streaming), V-05 completo (grafo/visibilidades/piloto) e
V-16 completo (release/atualização) continuam fora deste incremento e não estão
implicitamente aceitos.

## Ensaio real autorizado de 2026-11-05 — BLOCKED em App JWT / gh

**Ticket 04 não resolvido; critérios reais incompletos.** Continuado HEAD
`71287cf`, sem refazer F1. A integração local estava em `b591ec7`, já ancestral;
`git rebase integration/software-factory-mvp` informou up to date. Nenhum merge,
push, escrita em main/integração ou identidade pessoal. O operador autorizou
apenas observações remotas e emissão de teste neste primeiro ensaio; a emissão
não chegou a ocorrer.

### Segurança e composição efetivamente executadas

Revalidados por metadados a chave exata autorizada e **todos os ancestrais**:
arquivo regular da conta, **0600**, uid/gid 1000, um link, 1675 bytes; diretórios
ancestrais sem symlinks nem escrita de grupo/outros, donos root/conta atual.
Leitura com `O_NOFOLLOW`, conferência do descritor e cópia `wx`/0600 somente em
`credentials/app.pem` dentro de cada instalação própria 0700 sob
`/home/sanmoo/software-factory-test`. A raiz compartilhada preexistente é 0755,
sem escrita alheia, e não foi alterada; instalações/chaves permanecem privadas.
Fonte nunca modificada, com inode/modo/mtime conferidos após os ensaios. Cópias
privadas de teste foram removidas individualmente após encerrar os controladores;
nenhum material emissor foi colocado no Git ou neste relatório.

Um primeiro início local falhou antes de qualquer uso da credencial/API. A
[correção pré-requisito do flock real em Btrfs](04-controller-lock-prerequisite.md)
foi explicitamente aprovada, testada RED/GREEN e commitada separadamente em
`76ff8f1`; requer revisão independente do seam de ticket 02.

Dois ensaios seguintes iniciaram **o controlador real**, observaram status pelo
socket, executaram `doctor --authenticated --json` e encerraram o controlador
com SIGTERM/exit **0**. Sem proprietário, doctor retornou exit **3**. Configuração:
App **5569788**, instalação candidata **177599217**, repo
`Sanmoo/java-springboot-event-sourcing`, base `main`, operador `Sanmoo`,
**Workflows false explícito**. Modelos foram configurados como `unused`, sem
qualquer chamada; nenhuma VM foi necessária ou iniciada.

O transporte usou o binário real `/usr/bin/gh` com argv estruturado e HOME/config
temporários privados, sem herdar configuração/token pessoal. Um observador
transparente executou esse binário sem substituir respostas, reteve stdout HTTP
somente no pipe de memória destinado ao controlador e gravou apenas uma projeção
allowlisted de metadados. Stderr cru não foi encaminhado. Token/JWT somente em
memória/ambiente, nunca argv, artefato ou log; nenhum `GH_DEBUG` real foi usado.
Os controladores registraram **historyLength 0**: diagnóstico, não comando durável.

### Resultado remoto real (não confundir com fixture)

[Artefato JSON sanitizado com resultados e requisições](04-real-github-access-2026-11-05.json).

| Horário UTC | Finalidade | Requisição real | Resultado |
| --- | --- | --- | --- |
| 21:43:24.756 | tracker | GET /app | HTTP 401, gh exit 1 |
| 21:43:25.261 | repository | GET /app | HTTP 401, gh exit 1 |
| 21:44:28.626 | tracker | GET /app | HTTP 401, gh exit 1 |
| 21:44:29.159 | repository | GET /app | HTTP 401, gh exit 1 |

Ambos os doctors: exit **3**, ambos os adapters `GITHUB_ACCESS_DENIED`,
`completeness: incomplete`, `certifiesMergeSafety: false`, com ação explícita e
sem resposta externa crua. A formatação HTTP real de `gh --include` foi analisada
com sucesso nos quatro casos. No segundo ensaio, header Date real coincidiu com
o relógio da máquina, e classificador de palavras fixas encontrou somente
`decode` no erro (não persistiu mensagem crua).

**Zero** consultas de instalação/repo/base/issues/dependências, **zero** pedidos
`access_tokens`, concessões, escritas remotas ou push. App e instalação fornecidas
**não foram autenticadas**; IDs continuam candidatos, não fatos confirmados.
REST `2026-03-10` foi enviado explicitamente, mas nenhuma resposta 2xx/versão
selecionada comprovou suporte. Repositório, base, permissões, escopo e validade de
grant continuam não observados. Acesso negado não autoriza inferir falta de
permissões de repo/instalação: falhou **antes** dessa etapa.

### Incompatibilidade concreta e limite da correção

Versão instalada: `gh version 2.46.0 (2025-12-17 Ubuntu 2.46.0-1ubuntu0.3)`.
Fonte pública exata de referência:
[`api/http_client.go`, tag v2.46.0, AddAuthTokenHeader](https://github.com/cli/cli/blob/v2.46.0/api/http_client.go)
formata `Authorization: token <valor>` a partir do token de ambiente. A
[documentação oficial de JWT GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
exige **Authorization: Bearer** para JWT, diferentemente de installation tokens.
[`gh api` http.go nessa tag](https://github.com/cli/cli/blob/v2.46.0/pkg/cmd/api/http.go)
recebe overrides de headers por argumentos, não uma projeção de segredo por stdin.

Prova separada com **o binário instalado**: servidor HTTP somente loopback,
credencial sintética, HOME/config isolados; `/usr/bin/gh api` enviou esquema
**token**, valor sintético esperado, exit 0. Isso confirma o comportamento do
binário, **não** a fronteira GitHub nem a aceitação de um JWT real. Nenhum segredo
real entrou nesse probe. Também verificada localmente, sem imprimir valores, a
chave RSA **2048 bits**, assinatura RS256 e verify com chave pública derivada,
issuer configurado, iat 60s no passado e duração de claims 600s. Essa verificação
local não comprova que a chave pertence à App configurada.

O fixture anterior validava assinatura/claims e ambiente, mas **não** o header
HTTP que gh real produz. Por isso seu sucesso não detectou esta incompatibilidade.
Não adicionamos falso teste verde nem alteramos o fixture para reivindicar uma
fronteira não exercitada. O erro 401 mais documentação/probe estabelecem uma
incompatibilidade de esquema; não provam ausência de eventual erro adicional de
App/chave. Sua identidade só poderá ser confirmada após transporte compatível.

Não foi contornado o contrato com segredo em `-H`/argv, perfil pessoal, proxy,
novo serviço ou HTTPS nativo. Esse trade-off volta ao operador: escolher um modo
aprovado de autenticação App que preserve segredo fora de argv e o contrato gh,
ou autorizar mudança explícita de desenho. Nenhuma ampliação de permissão corrige
a autenticação JWT deste transporte. Não há lacuna de direitos remotos comprovada
para recomendar; **não solicitar grants mais amplos por suposição**.

Após corrigir essa incompatibilidade, ainda será necessário autenticar App e
instalação **antes** de emitir, e conferir o retorno exato de repo/permissões/
validade. Pedidos previstos permanecem: tracker `metadata:read, issues:write`;
repository `metadata:read, contents:read, pull_requests:write, checks:read,
statuses:read, actions:read, administration:read`, um repo por finalidade,
**Workflows ausente**. Esses são pedidos do contrato, não permissões instaladas
observadas nem direitos de escrita exercitados. Nenhum merge/base/CI/bypass,
piloto humano, renovação/revogação ou contenção de cópia foi certificado.

### Gate final

Node **24.21.0**, npm **11.19.0**, QEMU/qemu-img **11.1.2** (somente versões).
`npm ci`, `npm run typecheck`, suíte completa `npm test` com
`FACTORY_TEST_ROOT=/home/sanmoo/software-factory-test` **duas vezes**: arquitetura
44 módulos/157 dependências, ESLint, build e **63/63** testes, zero falhas/skips.
`git diff --check` passou. Os dois fracassos prévios de readiness sob concorrência,
o probe isolado verde e a correção de teste aprovada estão preservados no relatório
do pré-requisito, não ocultados por rerun. `npm ci`: cinco vulnerabilidades
moderadas transitivas e avisos de aprovação de scripts, sem atualização fora de
escopo. O gate local final verde não remove o bloqueio remoto do ticket.

## Continuação com HTTPS App explicitamente aprovado — 2026-11-05

**Resultado: BLOCKED/PARTIAL, não resolvido.** Continuação do HEAD limpo `d54b95f`,
na branch/worktree 04 existente; nenhum commit anterior refeito. A nova aprovação
do operador está registrada no adendo canônico de
[11 — contrato GitHub App](../../.scratch/software-factory/issues/11-github-app-contract.md)
(seção “Adendo aprovado — HTTPS privado de autenticação App”), na spec e no contrato
de interfaces. Proveniência: instrução desta execução e autorização atualizada em
`/tmp/software-factory-mvp-test-authorization.md`. A exceção permite somente os
três endpoints App configurados; **todas as demais operações continuam gh api**.
Nenhuma ADR/glossário global, serviço emissor, proxy ou interface de URL para modelo.

### Implementação e regressões

HTTPS Node privado no controlador: host/porta fixos `api.github.com:443`, TLS
validado, `agent: false`, JWT Bearer em memória, versão `2026-03-10`, deadline total
15s, corpo até 2 MiB e headers até 16 KiB. Valida 200 em GET/201 em emissão,
JSON/content-type, headers únicos, resposta completa, identidades, escopo e validade.
Sem redirects, retry automático, fallback ou descoberta de credenciais do ambiente.
Falha POST distingue rejeição conhecida de emissão desconhecida; o diagnóstico de
resultado desconhecido exige reconciliação antes de uma nova emissão deliberada.
Chave/JWT/token são registrados para filtro antes de uso; corpos de erro nunca
são encaminhados. As superfícies Tracker e CodeRepository continuam distintas.

Seams: `IssueTracker.checkAccess`, `CodeRepository.checkAccess` e doctor autenticado
através do controlador. Fixture HTTPS substitui **a fronteira externa** do Node,
não adapters/emissor; exige independentemente os três pares método/path, host,
porta, TLS, agent, Bearer, versão, Accept e User-Agent. O executável gh sintético
rejeita chamadas App fora dessa simulação e JWT em leituras de repo; testa ambiente
privado, argv sem token, redução exata por finalidade/repo e schemas REST próprios.
Preload/launcher de fixture ficam só em testes; produção não ganhou opção de
transporte, endpoint ou bypass TLS. **Esse dublê não é prova HTTPS/GitHub real.**

RED inicial: `npm run build` + teste `dist/test/entrypoints/github-access.test.js`,
17 falhas significativas (gh recusa JWT/App e seam retorna bloqueado em vez de ok),
antes do transporte nativo. GREEN subsequente exigiu também corrigir propagação
do preload apenas no launcher sintético do controlador. Primeiro gate detectou
import dinâmico não permitido; corrigido com helper de teste importado estaticamente,
sem relaxar arquitetura/lint. RED adicional: token opaco válido e ação exata de
permissões falharam; GREEN com gramática RFC 6750 token68 e mínimos explícitos.
RED de status 202 mostrou falso sucesso; GREEN exigiu status REST exato. A fixture
foi corrigida para retornar 201 na emissão, conforme contrato oficial, não 200.
Regressões adicionais: POST incerto e rejeitado conhecido, redirect, versão errada,
resposta incompleta, header duplicado e corpo excessivo; nenhum erro cru vaza.
Logs locais sanitizados: `/tmp/04-native-red.log`, `04-native-red-token.log`,
`04-native-green-token.log`, `04-native-red-status.log`, `04-native-final-gate.log`.

### Prova real (não fixture)

[Artefato sanitizado completo, inclusive ensaios prévios](04-native-real-github-access-2026-11-05.json).
Fonte autorizada revalidada antes de **cada** ensaio por ancestrais e descritor:
regular 0600, uid da conta, nlink 1, sem symlink ou ancestral gravável por terceiros.
Cópias `wx` 0600 somente em quatro raízes próprias `native04-*` 0700 dentro de
`/home/sanmoo/software-factory-test`; todas removidas após encerramento. Fonte
reconferida sem leitura de conteúdo após os ensaios e não modificada.

Controlador proprietário real sob `/usr/bin/flock` + owner compilado, socket real,
doctor real; preload observador **transparente**, sem substituir nenhuma resposta,
persistiu somente projeção allowlisted de metadados. O launcher foi composto
explicitamente com `--import` para observar o processo proprietário; o launcher CLI
normal foi exercitado no teste sintético do controlador. gh observado é o binário
real `/usr/bin/gh` 2.46.0; wrapper encaminha stdout somente pelo pipe ao controlador,
retém stderr e grava apenas método/path/status/exit. Nem chave nem JWT/token foram
colocados em argv, logs, sessão ou arquivos (exceto cópia protegida da chave).
Node **24.21.0**, npm **11.19.0**; nenhum perfil/token pessoal herdado.

Quatro ensaios deliberados, todos com POST de resultado **conhecido 201 completo**,
nunca retry de emissão incerta. Os dois primeiros pararam no schema antigo de token:
GitHub devolveu token opaco de 390 caracteres que a allowlist alfanumérica rejeitava.
Somente booleans/length de formato foram observados, nunca caracteres do segredo.
Gramática token68 corrigida com RED/GREEN sintético antes dos dois ensaios finais.

Nos ensaios finais:
- GET `/app` **200**, App **5569788** confirmada.
- GET `/app/installations/177599217` **200**, mesma App, owner **Sanmoo**, não suspensa.
- POST exato para instalação configurada, `repositories: [java-springboot-event-sourcing]`,
  `permissions: {metadata: read, issues: write}`: **201**, repo **1256893534**,
  `Sanmoo/java-springboot-event-sourcing`, somente permissões pedidas, validade
  aproximadamente uma hora. Workflows ausente. TLS/respostas nativas completas,
  versão selecionada **2026-03-10**.
- gh real: GET repo, lista issues, dependências nativas de issue acessível e comentários,
  todos **200 / exit 0**; tracker **ok / complete**, com limitações explícitas:
  leituras não são snapshot atômico; prova de dependências é de uma issue acessível,
  não de relações ocultas/outros repos; escritas não exercitadas.
- CodeRepository bloqueia **antes de emitir**: instalação observada tem somente
  `contents:write, issues:write, metadata:read, pull_requests:write`. Mínimos ausentes
  **checks:read, statuses:read, actions:read, administration:read**, sem exigir
  escrita/Workflows ou ampliar direitos automaticamente. Base `main` e demais leituras
  de CodeRepository não foram alcançadas; **nenhum token repository emitido**.
- Doctor exit **3**, historyLength **0**, controlador exit **0** em todos os ensaios;
  doctor sem controlador exit **3**. Identidade agora comprovada, não se atribui o
  antigo 401 exclusivamente ao esquema de auth. Nenhuma mutação de repo/push,
  chamada de modelo, VM, sandbox/harness03, merge, deploy ou certificação de barreiras.

### Gate e lacunas restantes

Gate final desta worktree 04, após inspeção de todos os testes conhecidos (sem
fixtures sandbox03): `npm run typecheck`; `timeout 180 npm test`: arquitetura,
ESLint, build, **73/73**, zero falhas/skips, Node 24.21.0 fixado no PATH.
`git diff --check` passou. A suíte inicial executou inadvertidamente com Node
24.14.0 antes de localizar o binário fixado; **não** é contada como gate final.
O deadline de 15s está implementado, mas não foi forçado por teste de relógio nem
por falha de rede real; falha de transporte/POST incerto é simulada na fronteira.
Não houve prova real de rate limit, grant excessivo, revogação ou expiração;
regressões negativas existentes usam valores sintéticos. Quatro tokens tracker
conhecidamente emitidos podem continuar válidos até o último `expiresAt` do JSON;
nenhuma revogação remota foi tentada (ensaio de leitura, sem ampliar operações).

Aceite completo de 04 permanece bloqueado pelos quatro mínimos acima; não houve
pedido de aumento ao GitHub nem assunção de acesso à base. Após correção explícita
pelo operador, repetir diagnóstico CodeRepository com redução exata de finalidade,
sem Workflows e sem mutação; isso ainda não certifica merge/base/CI/bypass nem
piloto humano. Nenhum critério foi marcado como provado integralmente.
