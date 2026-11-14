# 07 — Admissão única de Trabalho por Ticket elegível: incremento local

Autoridade: [ticket 07](../../.scratch/software-factory-mvp/issues/07-unique-ticket-admission.md),
[spec §§3.2/3.3/3.4/4.1/11.2/12.1](../../.scratch/software-factory/spec.md),
[interfaces Q3/Q4A/Q4B/Q11/Q13](../../.scratch/software-factory/module-public-interfaces.md),
[cenários V-04/V-15](../../.scratch/software-factory/acceptance-and-incremental-plan.md).

**Estado: implementação e suíte local verdes; integração GitHub real ainda NÃO executada.**
Nenhum checkbox foi marcado. Dublê não comprova a fronteira gh/GitHub substituída.

## Composição implementada

- `IssueTracker.listCandidates(scope)` e `IssueTracker.readTicket(ticket)` (operações aprovadas Q4A):
  `GET /repos/{r}/issues?state=open&labels=<label>` paginado e `GET /repos/{r}/issues/{n}`. Devolvem
  `TicketRef` qualificado (`repositoryId`, `issueId`, `nodeId`, número/URL de apresentação), estado,
  motivo de fechamento e labels com ID. Corpo/título não são lidos para o resultado (spec não capturada).
  PRs devolvidos pelo endpoint de issues são excluídos. Repo não configurado é recusado sem requisição.
- `CodeRepository.findPublication({repo, issueNumbers, knownBranches})` (Q4B), após a revisão
  independente: **uma** listagem `GET /repos/{r}/pulls?state=all` paginada por chamada, compartilhada
  por todos os Tickets autorizados do repo no ciclo, mais `GET /repos/{r}/issues/{N}/timeline` paginado
  por Ticket. Associação = palavra-chave de fechamento (`close[sd]/fix(e[sd])/resolve[sd]` + `#N`,
  `owner/repo#N` ou URL) no título/corpo; eventos nativos `cross-referenced` e `connected`/`disconnected`
  cuja fonte é PR **deste** repo; ou head em branch própria conhecida. Resultado por Ticket:
  `complete` com candidatos deduplicados, ou `incomplete` (timeline falhou, link "Development" sem PR
  identificável → `ASSOCIATION_UNIDENTIFIED`, PR associado ausente da listagem) → `PUBLICATION_UNKNOWN`,
  nunca admissão. Falha da listagem de PRs → `unavailable` para todos. PRs de outros repos que
  referenciam o Ticket não são tratados como associados (limitação declarada). O adapter não decide propriedade.
- `platform/github`: além de `diagnose` (inalterado em comportamento), `read(scope, purpose, fn)` com
  finalidades reduzidas somente leitura `tracker-read {metadata:read, issues:read}`,
  `repository-read {metadata:read, pull_requests:read}` e `association-read {metadata:read, issues:read}`
  (timeline é endpoint de issues: menor privilégio, sem pull_requests nem escrita; grant próprio do
  CodeRepository, não compartilhado com o tracker). O grant é reutilizado **em memória** até 5 min
  antes do vencimento (sem POST por polling); janela de rate limit (`retry-after` em segundos **ou HTTP-date**, `x-ratelimit-*`, 429 na emissão do token,
  inclusive `remaining: 0` em resposta 200) impede novas requisições até expirar; emissão de resultado
  **desconhecido** fica travada (sem novo POST) até reinício deliberado do controlador. Paginação
  preserva os parâmetros da consulta e aceita o caminho `/repositories/{id}/…` do mesmo repo em `Link`.
  Toda chamada operacional continua `gh api --method GET` com ambiente privado.
- Controle (`src/control`): regras puras em `rules/admission.ts` (entrada, PR alheio, atraso de polling,
  chave do índice `github:repository:<id>:issue:<id>`); `durable/admission.ts` faz a transação
  **Admitir Trabalho** (§3.4) num único commit Session: índice Ticket→ciclo, pausa, documento do
  Trabalho e sequência de admissão. `durable/polling.ts`: um laço sequencial dentro de `Control.run`
  (sem scheduler/broker), por repositório configurado, sem consultas sobrepostas. Ciclo em duas fases:
  entrada por candidato, depois um `findPublication` por repositório configurado e admissões na ordem
  da listagem. Falhas transitórias por candidato (`POLLING_QUERY_FAILED`, transporte/consulta) alimentam
  o mesmo backoff do repositório.
- `inspect` ganhou `list` e `show`; status ganhou `works`, `queues` e `polling`. CLI: `factory list`
  e `factory show <work_id>` (`--json`), sempre pelo controlador (sem leitor offline; exit 3).

### Decisões de interpretação (não alteram contratos aprovados; revisar)

1. **Pausa x admissão.** Pausado, o polling continua listando (acompanhamento), mas não relê nem admite
   candidatos novos: aparecem `held/GLOBAL_PAUSE`. A pausa é reconferida dentro do commit de admissão.
   Leitura de "respeitadas pausa" (§4.1) e "pausa impede novos disparos, não acompanhamento" (AC5).
2. **"PR associado".** Sem definição operacional aprovada; após revisão: palavras-chave de fechamento +
   timeline nativa (cross-reference/Development link) do mesmo repo + branches próprias. PRs fechados/
   mergeados associados continuam bloqueando; o próximo passo não sugere fechá-los (fechar não remove
   a associação). **Questão aberta:** uma cross-reference nativa (mera menção num PR) não pode ser
   apagada no GitHub, então tal Ticket fica bloqueado até decisão do operador, e não existe comando
   aprovado de "ignorar associação"; isso requer decisão de desenho se for indesejado.
3. **Acompanhamento pós-admissão.** Retirada de label/fechamento depois da admissão não suspende nada
   neste incremento (ticket 25); a ausência numa listagem nunca é tratada como retirada.
4. **Observações de candidatos** são somente em memória (último polling), com instante/completude, e
   não viram histórico persistido de cada polling. O Trabalho admitido guarda a evidência da admissão.
5. **Backoff de polling:** intervalo em sucesso; espera indicada pelo serviço prevalece; falha sem espera
   usa intervalo×2^(n−1), teto max(intervalo, 900 s). Valores de projeto, não SLA.
6. Despacho segue fechado: cada Trabalho tem impedimento durável `DEPENDENCIES_NOT_EVALUATED` e
   `dispatch.state: held` (ticket 08 e ativação pendentes).

## Mapa AC → evidência

Níveis: **S** = Control real + Pi Durable/SQLite temporário real + dublês de tracker/repo/relógio;
**I-local** = composição real CLI/flock/socket/SQLite/adapters/emissor/transporte gh, com **gh/GitHub e
HTTPS da App substituídos** por executável local (`test/entrypoints/github-world-fixture.ts`).
Nenhum dos dois é prova da fronteira GitHub real.

| AC | Testes | Nível | Lacuna |
| --- | --- | --- | --- |
| 1 Repo/issue aberta/label efetiva; identidades qualificadas | `test/control/admission-rules.test.ts` (entrada, case-insensitive, deriva de identidade), `admission-flow` AC1 (PR, identidade divergente, repo não configurado, fechada, sem label), `github-admission-reads` (listagem/identidade/sem corpo), `admission-cli` | S + I-local | GitHub real |
| 2 Atomicidade; polling repetido/concorrente/restart sem duplicatas | `admission-atomicity` (25 admissões concorrentes do mesmo Ticket → 1; sequência contígua; reabertura), `admission-flow` AC2 (restart), `admission-cli` (dois proprietários sucessivos) | S + I-local (SQLite real) | Crash físico/energia não exercitados |
| 3 PR associado não próprio bloqueia e é reportado | `admission-rules`, `admission-flow` AC3 (`FOREIGN_PULL_REQUEST` com IDs, texto do próximo passo, `PUBLICATION_UNKNOWN`) e AC5 (incompleto por Ticket), `github-admission-reads` (palavra-chave, cross-reference, Development link, link não identificado/timeline falha → incompleto), `admission-cli` | S + I-local | PRs de outros repos não tratados como associados; timeline real não exercitada |
| 4 list/status/show sem colapsar; parcial/falha ≠ ausência | `admission-flow` AC4, `github-admission-reads` (página posterior falha → unavailable), `admission-cli` | S + I-local | — |
| 5 60 s configurável; headers/rate limit/backoff; sem sobreposição; pausa | `admission-rules` (atraso), `admission-flow` AC5 (backoff 5/10/20/40, espera 300 s, consulta pendente sem novo disparo, pausa), `github-admission-reads` (janela de rate limit sem requisição, `remaining: 0`), `configuration.test` (default 60), `admission-cli` (`pollingSeconds: 1` efetivo) | S + I-local | Rate limit real não induzido |
| 6 Sem labels/assignees/Projects/status; sem captura da spec | `github-admission-reads` (somente GET, grants só leitura), `admission-cli` (trace: só GET operacional, POST só access_tokens sem `write`; banco sem corpo/token/chave), `admission-flow` AC6 | I-local | GitHub real |
| 7 Testes com persistência real e GitHub autorizado; despacho aguarda | Todos acima; `dispatch.reasons` = `DEPENDENCIES_NOT_EVALUATED` + barreira | S + I-local | **Integração GitHub real pendente** (procedimento abaixo) |

Mutação de controle: mover a verificação do índice para fora do commit fez `admission-atomicity`
falhar (25 Trabalhos para o mesmo Ticket); restaurado, voltou a passar.

## TDD observado

1. `github-admission-reads.test.ts` escrito antes: build vermelho (`listCandidates`/`readTicket`/
   `findPublication`/`scopes` inexistentes) → verde 9/9 após platform/adapters; regressões 04 (35) verdes.
2. Testes de Controle (`admission-*`) antes: build vermelho (módulos `durable/store`/`admission` ausentes,
   status sem `works/queues/polling`) → verde. Uma falha intermediária foi do próprio helper de teste
   (parâmetro default engolindo `undefined`), corrigida no teste.
3. Regressão real encontrada: sem poller, a promessa resolvida imediatamente vencia `Promise.race` e o
   proprietário saía com 1 (`controller.test` vermelho) → corrigido; testes 02 verdes.
4. `admission-cli.test.ts` antes: vermelho (`list` recusado com exit 2) → verde após owner/CLI.

## Correções após revisão independente (2026-11-14)

| Achado | Correção | Teste (RED → GREEN) |
| --- | --- | --- |
| 1 `findPublication` declarava `complete` com pontos cegos | Timeline nativa + `association-read`; incompleto → `PUBLICATION_UNKNOWN` | `github-admission-reads`: timeline/Development/incompleto (RED: compilação + asserções), `admission-flow` AC5 incompleto por Ticket |
| 2 Listagem de PRs por candidato por ciclo | Um `findPublication` por repo por ciclo; limite de páginas → incompleto mantido | `github-admission-reads` "lists pull requests once" (2 páginas para 3 Tickets, 3 timelines), `admission-flow` "one findPublication per repository cycle" |
| 3 Próximo passo sugeria fechar PR | Texto: aberto/fechado/mergeado bloqueiam; remover referência/desvincular ou decisão do operador | `admission-flow` AC3 (`doesNotMatch /close it/`) |
| Menor: falha por candidato sem backoff | Falhas transitórias por candidato → backoff 60/120/240 s | `admission-flow` "unexpected per-candidate evaluation failures" |
| Menor: Retry-After HTTP-date | Data convertida em segundos | `github-admission-reads` HTTP-date (RED com o trecho revertido: 60 s; GREEN ~120 s) |
| Menor: 429 na emissão abre janela | Já coberto por `TokenIssuanceFailure extends AccessFailure`; teste de regressão adicionado (passou de início) | `github-admission-reads` "a 429 on token issuance" (1 POST, sem nova emissão) |

Mudança de contrato interno: `PublicationCorrelation.issueNumber` → `issueNumbers[]` e resultado por
Ticket em `issues`. Uma finalidade a mais por proprietário (3 POST de token por início, reutilizados).

## Gate local

Node 24.21.0 com `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 60`, sem npm/npx.
Após `c641071` (rebase sobre a integração com ticket 06, `dfcfba7`): `eslint . --max-warnings 0` exit 0;
`dependency-cruiser` sem violações (216 módulos, 1153 dependências); `tsc -p tsconfig.json` exit 0;
**87 arquivos** `dist/test/**/*.test.js`, um por vez (`--experimental-test-module-mocks --test
--test-concurrency=1`): **719 pass, 0 fail, 10 skipped, 0 cancelled**. `test/sandbox/gondolin.test.ts`
continua `skip:true`. A falha anterior `GONDOLIN_PROFILE_DRIFT` (artefato gitignorado com
`dependencyLink` duplicado) não se repetiu após a correção do ambiente pelo supervisor.

## Procedimento para o ensaio real autorizado (supervisor)

Não executado por este agente (sem credenciais/rede). Mesmo padrão do ticket 04: raiz exclusiva nova
0700, chave copiada com criação exclusiva 0600 para `credentials/app.pem`, removida ao fim.

Configuração (`<raiz>/config.yaml`). **Label efetiva: `ready-for-agent`** (default do schema quando
omitida; explícita abaixo). Use `pollingSeconds: 15` para encurtar o ensaio; omitindo, `status` deve
mostrar `polling.intervalSeconds: 60`.

```yaml
schemaVersion: 1
operators: [Sanmoo]
models:
  builder: {provider: unused, model: unused}
  standards: {provider: unused, model: unused}
  spec: {provider: unused, model: unused}
githubApp: {appId: 5569788, privateKeyFile: credentials/app.pem}
sandbox: {schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}
repositories:
  - {repository: Sanmoo/java-springboot-event-sourcing, base: main, installationId: 177599217, workflows: false, label: ready-for-agent}
pollingSeconds: 15
```

Pré-condição remota (mutação do **operador**, não da Factory, sob autorização própria): uma issue
aberta com a label `ready-for-agent` e sem PR com "Fixes/Closes/Resolves #N". Opcional (subcaso AC3):
outra issue rotulada com um PR cujo corpo contenha `Fixes #M`. Registrar antes/depois labels,
assignees e Projects das issues para conferir que não mudaram.

Comandos (worktree compilada; Node 24.21.0; `/usr/bin/gh` e `/usr/bin/flock` no PATH):

```sh
R=<raiz-exclusiva>; CLI="node dist/src/entrypoints/cli.js"
$CLI setup --root "$R" --json            # depois escrever config.yaml e a chave
$CLI list --root "$R" --json             # esperado: exit 3, CONTROLLER_UNAVAILABLE (sem leitor offline)
$CLI run --root "$R" &                   # proprietário em primeiro plano/background
$CLI status --root "$R" --json           # repetir até polling.cycles >= 1
$CLI list --root "$R" --json
$CLI show <work_id> --root "$R" --json
# aguardar >= 2 ciclos adicionais; list deve manter o MESMO work_id e sequence
kill -TERM <pid do run>                  # esperado: exit 0
$CLI run --root "$R" &                   # reinício
$CLI list --root "$R" --json             # mesmo work_id/sequence; nenhum Trabalho novo para o mesmo Ticket
kill -TERM <pid>
```

Saída esperada:

- `status`: `dispatch: "closed"`, `dispatchReason: "EXECUTION_NOT_ENABLED"` (ou `RECONCILIATION_REQUIRED`
  se houver recursos desconhecidos em `environments/`/`run/`), `historyLength: 0`,
  `polling.repositories[0].state: "observed"`, `completeness: "complete"`, `absenceProven: false`.
- `list.works[*]`: `ticket` com `repositoryId: 1256893534`, `issueId`/`nodeId` reais da issue,
  `result: "open"`, `authorization.state: "authorized"` com `basis.label.name: "ready-for-agent"`,
  `queue: {category: "normal", sequence: 1, pending: true}`, impedimento `DEPENDENCIES_NOT_EVALUATED`,
  `dispatch: {state: "held", reasons: ["DEPENDENCIES_NOT_EVALUATED", "EXECUTION_NOT_ENABLED"]}`,
  `execution/branch/pullRequest: null`.
- `polling.repositories[0].candidates`: `admitted` no primeiro ciclo, `existing` depois; issue com PR
  `Fixes #M` → `held` com `FOREIGN_PULL_REQUEST`, ID/número/URL do PR e próximo passo; nenhum Trabalho.
- Sem issue rotulada: `works: []`, `candidates: []` — isso **não** é prova de ausência remota.
- Requisições reais esperadas por proprietário: `GET /app`, `GET /app/installations/177599217` e um
  `POST …/access_tokens` por finalidade (`tracker-read`: `metadata:read, issues:read`;
  `repository-read`: `metadata:read, pull_requests:read`; após a revisão também `association-read`:
  `metadata:read, issues:read`), reutilizados entre ciclos; demais chamadas `gh api GET` em
  `/repos/Sanmoo/java-springboot-event-sourcing{,/issues…,/issues/N,/issues/N/timeline…,/pulls…}`
  (pulls no máximo uma vez por ciclo). O ensaio real registrado abaixo precede essa revisão.
  Nenhum POST/PATCH/PUT/DELETE operacional.
- Após parar: `data/control.sqlite*` sem `ghs_`, sem `PRIVATE KEY` e sem texto do corpo da issue;
  labels/assignees/Projects inalterados.

Registrar no relatório real: HEAD, versão do gh, requisições (método/endpoint/status/versão), IDs
observados, saídas `list/show/status` sanitizadas, ausência de mutações e lacunas (rate limit não
induzido, links manuais "Development" não observáveis).

## Ensaio real autorizado — 2026-11-14 (supervisor)

HEAD `738f5e9`; raiz exclusiva `/home/sanmoo/software-factory-test/verify07-gEoqJdLv`; driver derivado do driver do 04, com os mesmos guards (HTTPS só em `/app`, instalação e `access_tokens`; wrapper `gh` só GET no repo configurado). Registro sanitizado: [JSON](07-real-github-admission-2026-11-14.json). Pré-condição remota feita pelo operador por meio do agente, sob autorização explícita: issue de teste **#3** criada com `ready-for-agent`. A issue #1 já tinha a label.

- `list` sem proprietário: exit 3. Com o proprietário real (flock): ciclo 1 admitiu **#3** (sequência 1, issueId `6391129588`, nodeId `I_kwDOSuqsXs8AAAABfPDl9A`, repositoryId `1256893534`) e **#1** (sequência 2). Autorização `authorized` pela label `ready-for-agent` (id 12918930265), publicação `complete` com 0 PRs associados, despacho `held` com `[DEPENDENCIES_NOT_EVALUATED, EXECUTION_NOT_ENABLED]`.
- Mais 2 ciclos (15 s): mesmos `work_id`/`sequence`. SIGTERM → exit 0; restart → mesma lista, sem duplicata; SIGTERM → exit 0.
- Status: `dispatch: closed / EXECUTION_NOT_ENABLED`, `historyLength: 0`, polling `observed / complete / absenceProven:false`, `consecutiveFailures: 0`.
- Requisições: só GETs (`/app`, instalação, repo, issues filtradas por label, `issues/N`, `pulls?state=all`) e POSTs de token **somente leitura** (`metadata+issues:read`, `metadata+pull_requests:read`), um por finalidade a cada início do proprietário. Nenhuma mutação. Labels e assignees das issues inalterados.
- Banco `control.sqlite*`: 0 ocorrências de `ghs_`, `PRIVATE KEY` ou texto do corpo da issue. Cópia da chave removida.

**Observação AC3 / limitação:** a issue #1 tem o PR #2 *merged* na branch `factory/issue-1-a49bd5a1e147`, de outra factory. O GitHub não liga esse PR à issue: não há palavra-chave de fechamento, evento de referência cruzada nem `closedByPullRequestsReferences`. A Factory não usa convenções de branch alheias como prova, então a admissão segue o contrato observável. Não houve PR real com palavra-chave para exercitar o bloqueio AC3 (criar PR está fora da autorização); esse caso está coberto pelos testes de fluxo locais.
