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
- `CodeRepository.findPublication(correlation)` (Q4B): `GET /repos/{r}/pulls?state=all` paginado;
  candidatos são PRs com palavra-chave de fechamento GitHub (`close[sd]/fix(e[sd])/resolve[sd]` +
  `#N`, `owner/repo#N` ou URL da issue) no título/corpo, ou cuja head é branch própria conhecida do
  mesmo repo. Menção simples não é associação. O adapter não decide propriedade.
- `platform/github`: além de `diagnose` (inalterado em comportamento), `read(scope, purpose, fn)` com
  finalidades reduzidas somente leitura `tracker-read {metadata:read, issues:read}` e
  `repository-read {metadata:read, pull_requests:read}`. O grant é reutilizado **em memória** até 5 min
  antes do vencimento (sem POST por polling); janela de rate limit (`retry-after`, `x-ratelimit-*`,
  inclusive `remaining: 0` em resposta 200) impede novas requisições até expirar; emissão de resultado
  **desconhecido** fica travada (sem novo POST) até reinício deliberado do controlador. Paginação
  preserva os parâmetros da consulta e aceita o caminho `/repositories/{id}/…` do mesmo repo em `Link`.
  Toda chamada operacional continua `gh api --method GET` com ambiente privado.
- Controle (`src/control`): regras puras em `rules/admission.ts` (entrada, PR alheio, atraso de polling,
  chave do índice `github:repository:<id>:issue:<id>`); `durable/admission.ts` faz a transação
  **Admitir Trabalho** (§3.4) num único commit Session: índice Ticket→ciclo, pausa, documento do
  Trabalho e sequência de admissão. `durable/polling.ts`: um laço sequencial dentro de `Control.run`
  (sem scheduler/broker), por repositório configurado, sem consultas sobrepostas.
- `inspect` ganhou `list` e `show`; status ganhou `works`, `queues` e `polling`. CLI: `factory list`
  e `factory show <work_id>` (`--json`), sempre pelo controlador (sem leitor offline; exit 3).

### Decisões de interpretação (não alteram contratos aprovados; revisar)

1. **Pausa x admissão.** Pausado, o polling continua listando (acompanhamento), mas não relê nem admite
   candidatos novos: aparecem `held/GLOBAL_PAUSE`. A pausa é reconferida dentro do commit de admissão.
   Leitura de "respeitadas pausa" (§4.1) e "pausa impede novos disparos, não acompanhamento" (AC5).
2. **"PR associado".** Não há definição operacional aprovada. Usou-se `findPublication` com palavras-chave
   de fechamento no mesmo repo + branches próprias conhecidas. Links manuais "Development" e PRs de
   outros repos **não são observáveis** por essa listagem e constam em `limitations` (não certificados
   ausentes). PRs fechados/mergeados associados também bloqueiam (leitura conservadora). Se o operador
   quiser outra semântica (p.ex. timeline da issue), é decisão de desenho a registrar.
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
| 3 PR associado não próprio bloqueia e é reportado | `admission-rules`, `admission-flow` AC3 (`FOREIGN_PULL_REQUEST` com IDs, `PUBLICATION_UNKNOWN`), `github-admission-reads` (detecção), `admission-cli` | S + I-local | Links manuais/cross-repo não observáveis |
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

## Gate local

Node 24.21.0 com `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 60`, sem npm/npx.
Após `ab7011c`: `eslint . --max-warnings 0` exit 0; `dependency-cruiser` sem violações (214 módulos,
1144 dependências); `tsc -p tsconfig.json` exit 0; **87 arquivos** `dist/test/**/*.test.js`, um por vez
(`--experimental-test-module-mocks --test --test-concurrency=1`): **710 pass, 1 fail, 10 skipped,
0 cancelled**. `test/sandbox/gondolin.test.ts` continua `skip:true`.

A única falha é **preexistente e alheia a esta mudança**: `gondolin-sdk-runtime.test.js` →
`GONDOLIN_PROFILE_DRIFT`. O artefato privado gitignorado
`.scratch/factory-development-gondolin-v1/profile.json` (gerado 2026-11-14 10:26, antes do commit-base
`f70ec2b`) tem `dependencyLink` com o prefixo do caminho duplicado. Esta branch não altera sandbox,
package/lockfile nem evidência Gondolin. A preparação privada do SDK não foi reparada aqui (decisão do
supervisor: reexecutar `prepare:gondolin-sdk` na worktree).

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
  `repository-read`: `metadata:read, pull_requests:read`), reutilizados entre ciclos; demais chamadas
  `gh api GET` em `/repos/Sanmoo/java-springboot-event-sourcing{,/issues…,/issues/N,/pulls…}`.
  Nenhum POST/PATCH/PUT/DELETE operacional.
- Após parar: `data/control.sqlite*` sem `ghs_`, sem `PRIVATE KEY` e sem texto do corpo da issue;
  labels/assignees/Projects inalterados.

Registrar no relatório real: HEAD, versão do gh, requisições (método/endpoint/status/versão), IDs
observados, saídas `list/show/status` sanitizadas, ausência de mutações e lacunas (rate limit não
induzido, links manuais "Development" não observáveis).
