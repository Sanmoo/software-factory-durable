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

## Falta exata para aceite real

**Ticket permanece aberto; não há Answer/resolução nem homologação real.**
Nenhuma credencial/identidade pessoal foi lida/usada, nenhuma App/token real foi
emitida, nenhuma chamada GitHub ou mutação remota foi realizada.

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
