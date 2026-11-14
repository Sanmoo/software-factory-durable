# 08 — Liberação somente com dependências nativas satisfeitas: incremento local

Autoridade: [ticket 08](../../.scratch/software-factory-mvp/issues/08-native-dependency-gating.md),
[spec §§3.3/3.4/4.2/4.3/8/11.2/12.4/13.4](../../.scratch/software-factory/spec.md),
[interfaces Q4A/Q11](../../.scratch/software-factory/module-public-interfaces.md),
[decisão de dependências](../../.scratch/software-factory/issues/09-dependency-compatibility.md#answer),
[cenários V-05/V-06](../../.scratch/software-factory/acceptance-and-incremental-plan.md).

**Estado: implementação e suíte local verdes; integração GitHub real ainda NÃO executada** (procedimento abaixo).
Nenhum checkbox foi marcado e o ticket não foi resolvido. Dublê não comprova a fronteira gh/GitHub substituída.
O despacho continua fechado (`EXECUTION_NOT_ENABLED`) até o ticket 09; este incremento torna real a decisão de
gating e sua evidência.

## Composição implementada

- **`IssueTracker.readDependencyGraph(ticket)`** (operação aprovada Q4A). Travessia em largura a partir do Ticket:
  para cada nó, `GET /repos/{r}/issues/{n}` e a listagem **completa** `GET /repos/{r}/issues/{n}/dependencies/blocked_by`
  (paginada por `Link`, `per_page=100`), sempre `gh api --method GET`, versão REST `2026-03-10`, ambiente privado.
  Somente `blocked_by` nativo: nem prosa (`Depends on`), nem `blocking` (inversa), labels, duplicatas ou timeline.
  Identidade do nó = `issueId` GitHub (global) + repositório; números iguais em repos distintos ficam distintos.
  Cada issue é visitada uma vez por avaliação (ciclo termina, nó compartilhado não é relido). Inclui nós encerrados.
  O adapter **não** decide satisfação: devolve nós (`state`, `stateReason`, `access: read|edge-only`,
  `repositoryRole: executable|dependency-only|not-configured`, `blockedBy`), `principals` sem token e `problems`:
  `DEPENDENCY_REPOSITORY_NOT_CONFIGURED` (repo do bloqueador não configurado: nunca lido com outra identidade),
  `DEPENDENCY_READ_UNAVAILABLE` (com `observedCode`, p.ex. falha após página emitida, JSON inválido, 404/oculto,
  rate limit com `waitSeconds`), `INVALID_DEPENDENCY_RELATION` (PR, auto-relação, URL de outro repo, payload inesperado,
  deriva de identidade do destino), `DEPENDENCY_LISTING_UNSTABLE` (mesmo bloqueador em páginas diferentes),
  `DEPENDENCY_COUNT_MISMATCH` (listados ≠ `issue_dependencies_summary.total_blocked_by`/`blocked_by`),
  `DEPENDENCY_ROOT_MISMATCH`, `DEPENDENCY_GRAPH_TOO_LARGE` (> 100 nós). Qualquer problema → `incomplete`.
  Ausência do resumo é limitação declarada ("omissão silenciosa não detectável"), nunca suporte.
- **`platform/github`**: finalidade reduzida `dependency-read {metadata:read, issues:read}`, um token por repositório
  (executável ou só-dependência) com a instalação configurada daquele repositório; `dependency` para o pré-voo.
  `readPermissions` exporta só metadados das concessões (evidência de principal/escopo; nunca o token).
- **`IssueTracker.checkAccess({…, role: 'dependency-only'})`**: pré-voo com finalidade `dependency`
  (`metadata:read, issues:read`, nunca o teto `issues:write` do tracker), lê issues e o `blocked_by` de uma amostra;
  não cria issue nem relação; limita-se a declarar que pares/relações ocultas não são certificados.
- **Configuração**: `dependencyRepositories: [{repository, installationId}]` (default `[]`), somente leitura de
  dependências, sem base/label/limites, disjunto de `repositories` (um repo é executável **ou** só-dependência).
  O proprietário compõe esses escopos no tracker; `inspect access`/`doctor --authenticated` reportam
  `dependencyResults` separadamente (CLI sai 3 se algum não for `ok`).
- **Controle**:
  - Regras puras `rules/dependencies.ts`: `analyseGraph` (DFS a partir da raiz: aresta para nó no caminho = ciclo;
    para nó concluído = compartilhado), `evaluateDependencies`, `dependencyImpediments`, `dispatchBlockers`, `selectNext`.
  - Satisfação dos bloqueadores **diretos**: externo só `closed + completed`; próprio (Ticket no índice da fábrica)
    só `delivered` com merge confirmado do ciclo aplicável (o vigente do índice); aberto/cancelado/PR fechado sem
    merge/entrega não confirmada/memória ausente não satisfazem, mesmo com a issue `closed/completed`; ciclos
    anteriores entregues são ignorados. Validade estrutural é exigida no **grafo inteiro**: problema do adapter,
    destino de aresta não lido, raiz não lida ou ciclo → `inconclusive` (mesmo com intermediário encerrado).
  - `durable/polling.ts`, fase 3 de cada rodada por repositório (no mesmo laço, sem scheduler): todo Trabalho aberto e
    pendente do repo é reavaliado em ordem FIFO com leitura **nova** do grafo, também durante pausa (acompanhamento).
    Rate limit/espera indicada interrompe a rodada e prevalece no próximo atraso; falhas transitórias alimentam o backoff.
  - `durable/admission.ts`: `recordDependencies` grava num único commit a última avaliação, a última completa, os
    impedimentos de dependência (os demais intocados; `since` preservado) e histórico **somente** quando a conclusão muda.
    `ownCycles` classifica por `issueId` contra o índice durável (Ticket indexado sem registro → `missing`, nunca externo).
    O placeholder de admissão `DEPENDENCIES_NOT_EVALUATED` só persiste até a avaliação da mesma rodada.
  - Registro `DependencyEvaluation`: `evaluationId`, `attemptId` (rodada), `source: github-rest`, `observedAt`,
    `evaluatedAt`, `principals` (instalação/repo/repoId/papel/finalidade/permissões, sem token), `completeness`,
    `conclusion: satisfied|pending|inconclusive`, `blockers` (classificação própria/externa, `work_id`, direto/transitivo,
    satisfeito, motivo), `cycles`, `shared`, `reasons` com próximo passo, `limitations`.
  - Moeda da avaliação: cada rodada recebe novo `attemptId` em memória **no início**; só a avaliação da rodada atual
    do repositório conta. Avaliação de rodada anterior, do proprietário anterior (reinício) ou de outra tentativa
    acrescenta `DEPENDENCIES_NOT_CURRENT` — observação antiga nunca concede novo despacho.
  - Vistas: `WorkView.dependencies {latest, lastComplete}`, impedimentos `DEPENDENCY_PENDING` e/ou
    `DEPENDENCY_EVALUATION_INCONCLUSIVE` (coexistem), `dispatch.reasons` = bloqueadores do Trabalho + barreira + pausa;
    `ListView.selection {next, skipped}` (FIFO que pula impedidos sem perder posição); `status.dependencies`
    (contagens) e `status.selection.next`.

### Decisões de interpretação (não alteram contratos aprovados; revisar)

1. **Satisfação transitiva.** Satisfação é exigida dos bloqueadores **diretos**; o grafo alcançável inteiro precisa ser
   completo/válido/acíclico. Um nó transitivo aberto atrás de um direto satisfeito é mostrado (`direct: false,
   satisfied: false`) mas não retém. Leitura de "inacessibilidade transitiva … impedem liberação, mesmo com
   intermediário encerrado" (§4.2/Answer 09). Se a intenção for exigir satisfação transitiva, é mudança de regra de uma linha.
2. **Moeda por rodada.** A rodada é a "tentativa" de seleção deste incremento. O ticket 09 deve refazer a avaliação
   imediatamente antes de cada início/retomada/reparo e conferir, no commit "Admitir Execução", que o `attemptId`
   é da própria tentativa (`dispatchBlockers` já recusa qualquer outro). Durante uma rodada em curso, as vistas mostram
   `DEPENDENCIES_NOT_CURRENT` para os Trabalhos ainda não reavaliados (honesto, mas transitório).
3. **Merge próprio.** Nenhum Trabalho chega a `delivered` antes dos tickets de publicação; `ownCycles` informa
   `mergeConfirmed: false` e o fato de merge virá do registro durável de entrega confirmado via `CodeRepository`.
   Por isso entrega/cancelamento/novo ciclo/memória mínima são provados no nível de **regras**; no nível de **fluxo**
   prova-se o caso alcançável: bloqueador próprio fechado/completed com PR aberto não libera.
4. **Memória mínima.** Exclusão (`forget`) ainda não existe; a regra aceita `source: 'minimal-memory'` com a mesma
   semântica, e o Controle já devolve `missing` (nunca externo) para Ticket indexado sem registro.
5. **Detecção de omissão.** Contagem de `issue_dependencies_summary` é usada quando presente; contagens iguais não
   certificam ausência de relações invisíveis (limitação sempre declarada). A presença/forma real do campo na versão
   `2026-03-10` precisa ser confirmada no ensaio real.
6. **Custo.** Por rodada e Trabalho pendente: 2 GET por nó alcançável (+páginas). Sem cache temporal; tokens
   reutilizados em memória por finalidade/repo; limite de 100 nós por avaliação.

## Mapa AC → evidência

Níveis: **R** = regras puras com dados controlados; **S** = Control real + Pi Durable/SQLite temporário real + dublês de
tracker/repo/relógio (`test/control/doubles.ts`); **I-local** = adapters/emissor/transporte gh reais (e, no teste de
CLI, CLI/flock/socket/proprietário/SQLite reais) com **gh/GitHub e HTTPS da App substituídos** pelo executável local
`test/entrypoints/github-world-fixture.ts` (agora com vários repositórios/instalações e `blocked_by` nativo).
Nenhum deles prova a fronteira GitHub real.

| AC | Testes | Nível | Lacuna |
| --- | --- | --- | --- |
| 1 Só `blocked_by` nativo via gh api/REST; páginas/destinos completos; identidades qualificadas; sem fallback | `github-dependency-reads` (páginas de 1 item, prosa/labels/duplicata ignorados, sem `blocking`/timeline, só GET, identidades e números iguais em repos distintos), `dependency-cli` (páginas `Link` seguidas na composição completa) | I-local | Paginação real (≤ 50 relações por issue cabem em uma página de 100) |
| 2 Travessia inclui encerrados; compartilhado × ciclo; inválida/ciclo/inacessível/erro após página impedem | `dependency-rules` (diamante vs ciclo, ciclo pela raiz, alvo não lido, raiz não lida, transitivo inacessível atrás de encerrado), `github-dependency-reads` (502 na página 2 → sem lista parcial; JSON inválido; PR/auto/URL alheia/payload; contagem divergente; deriva de identidade; cada nó lido uma vez), `dependency-flow` (ciclo e rate limit → `inconclusive`) | R + I-local + S | Ciclo/relação inválida reais dependem do que o GitHub permite criar |
| 3 Externo só closed/completed | `dependency-rules` (open, reopened, not_planned, duplicate, null, desconhecido), `dependency-flow` (sequência reopened → not_planned → duplicate → null → completed; só o último libera) | R + S | GitHub real |
| 4 Próprio exige merge do ciclo vigente/último; fechamento/cancelamento/ciclo anterior não satisfazem, inclusive memória mínima | `dependency-rules` (delivered+merge, delivered sem confirmação, open, cancelled, closed-unmerged, novo ciclo após entrega, `minimal-memory`, `missing`), `dependency-flow` (bloqueador próprio closed/completed com PR aberto → `OWN_CYCLE_NOT_DELIVERED`; classificação própria sobrevive a reinício), `dependency-cli` | R + S + I-local | Entrega/cancelamento/`forget` não têm produtor ainda (decisões 3/4) |
| 5 Registro com origem/principal/escopo sem token, instante, completude e motivos; refeito a cada rodada; observação antiga não concede | `dependency-flow` (campos do registro; novo `evaluationId`/`attemptId` por rodada; 1 leitura por Trabalho por rodada; `lastComplete` visível mas não libera; reinício → `DEPENDENCIES_NOT_CURRENT` até reavaliar; banco sem token), `dependency-rules` (`dispatchBlockers`), `dependency-cli` (principals reais por repo) | R + S + I-local | Despacho real (ticket 09) |
| 6 Executáveis × só-dependência; pré-voo sem criar issues/arestas nem certificar pares | `configuration.test` (lista explícita, disjunta, sem campos executáveis), `github-dependency-reads` (papéis, instalação própria por owner, um token por repo, repo não configurado nunca lido, pré-voo `dependency` só GET), `dependency-flow` (`inspect access` → `dependencyResults`), `dependency-cli` | I-local + S | Pré-voo real |
| 7 Cenários reais locais/cross-repo/cross-owner/visibilidade sob autorização; omissão não detectável levada ao operador | Procedimento abaixo; `DEPENDENCY_COUNT_MISMATCH`/limitação de resumo ausente (I-local) | — | **Pendente: ensaio real autorizado** |
| 8 Mesmos contratos com storage real; próprio fechado com PR aberto não libera; impedido não bloqueia independente | `dependency-flow` (todos com SQLite temporário real; `selection.next` pula o impedido; FIFO original volta quando libera), `dependency-cli` (`selection.next` = independente) | S + I-local | — |

Mutações de controle (no JS compilado, depois restaurado): (M1) remover `DEPENDENCIES_NOT_CURRENT` → `dependency-flow`
falha (reinício); (M2) tratar bloqueador próprio como externo → falha (próprio fechado com PR aberto); (M3) seleção que
para no primeiro impedido → falha (independente não selecionado).

## TDD observado

1. `dependency-rules.test.ts` antes: compilação vermelha (módulo inexistente) → verde 7/7.
2. `github-dependency-reads.test.ts` antes: vermelho (`readDependencyGraph`/`dependencyScopes`/tipos ausentes) → 6/7;
   a falha restante era do próprio teste (a limitação declarada cita "Depends on") → asserção refinada → 7/7.
   Fixture generalizada (vários repos/instalações, token por repo) com regressões 07/04 verdes (13 + 35).
3. `dependency-flow.test.ts` antes: vermelho (`dependencies`/`selection` ausentes) → verde 4/4; dois testes do 07
   que codificavam o placeholder foram atualizados (agora `impediments: []`, razão só da barreira).
4. `configuration.test` antes: vermelho (`dependencyRepositories` indefinido) → verde. `dependency-cli` primeiro
   falhou por observar uma rodada em curso (`DEPENDENCIES_NOT_CURRENT`, comportamento correto) → intervalo de 30 s.

## Gate local

Node 24.21.0 com `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 60`, sem npm/npx, sobre `e96a54e`:
`eslint . --max-warnings 0` exit 0; `dependency-cruiser` sem violações (221 módulos, 1182 dependências);
`tsc -p tsconfig.json` exit 0 (após `rm -rf dist`); **91 arquivos** `dist/test/**/*.test.js`, um por vez
(`--experimental-test-module-mocks --test --test-concurrency=1`): **740 pass, 0 fail, 10 skipped, 0 cancelled**
(os mesmos 10 skips de antes: sandbox/Gondolin dependentes de host). `test/sandbox/gondolin.test.ts` continua `skip:true`.
Novos arquivos: `dependency-rules` (7), `github-dependency-reads` (7), `dependency-flow` (5), `dependency-cli` (1);
`configuration.test` +1.

## Procedimento para o ensaio real autorizado (supervisor)

Não executado por este agente (sem credenciais/rede). Mesmo padrão dos tickets 04/07: raiz exclusiva nova 0700,
chave copiada com criação exclusiva 0600 para `credentials/app.pem` e removida ao fim, `gh`/`flock` do sistema no PATH,
driver com os mesmos guards (HTTPS só `/app`, instalação e `access_tokens`; wrapper `gh` só GET no repo configurado).

Repositório: `Sanmoo/java-springboot-event-sourcing` (instalação `177599217`, `repositoryId 1256893534`), issues abertas
rotuladas **#1** e **#3**. Configuração:

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

Mutações remotas são do **operador** (credencial própria, não a da Factory), sob autorização própria; registrar
antes/depois. Criar relação: UI "Relationships → Mark as blocked by" ou
`gh api -X POST repos/Sanmoo/java-springboot-event-sourcing/issues/<dependente>/dependencies/blocked_by -F issue_id=<id do bloqueador>`
(o `id` numérico vem de `gh api repos/…/issues/<n> --jq .id`). Remover:
`gh api -X DELETE repos/…/issues/<dependente>/dependencies/blocked_by/<id do bloqueador>`.

Comandos (worktree compilada, Node 24.21.0): `CLI="node dist/src/entrypoints/cli.js"`; `$CLI run --root "$R" &`;
entre rodadas (`status.polling.cycles` aumentou e `state: sleeping`) registrar `$CLI status|list --root "$R" --json` e
`$CLI show <work_id>`. Esperar ≥ 1 rodada após cada mutação. Registrar `dependencies.latest` sanitizado.

| Passo | Mutação do operador | Esperado (`list`) |
| --- | --- | --- |
| E0 | nenhuma relação | #3 seq 1, #1 seq 2; ambos `conclusion: satisfied`, `blockers: []`, `impediments: []`, `dispatch.reasons: [EXECUTION_NOT_ENABLED]`; `selection.next` = Trabalho de #3; `principals: [{installationId: 177599217, repository: …, repositoryId: 1256893534, role: executable, purpose: dependency-read, permissions: {metadata: read, issues: read}}]` |
| E1 (local, próprio) | #3 *blocked by* #1 | #3 `pending`, motivo `OWN_CYCLE_NOT_DELIVERED`, bloqueador #1 `classification: own`, `work_id` do Trabalho de #1; `dispatch.reasons: [DEPENDENCY_PENDING, EXECUTION_NOT_ENABLED]`; `selection.next` = Trabalho de #1 (#3 pulado sem perder sequência 1) |
| E2 (próprio fechado) | fechar #1 como *completed* (opcional; reabrir ao fim) | #3 continua `pending/OWN_CYCLE_NOT_DELIVERED` (fechamento não é merge); #1 continua Trabalho aberto |
| E3 (externo) | criar issue **sem** label `#X`; #1 *blocked by* #X (se E2 foi feito, reabrir #1 antes) | #1 `pending/EXTERNAL_BLOCKER_OPEN`, `classification: external` |
| E4 | fechar #X como *not planned* | `EXTERNAL_BLOCKER_NOT_COMPLETED`, `stateReason: not_planned` |
| E5 | reabrir #X | `EXTERNAL_BLOCKER_OPEN`, `stateReason: reopened` |
| E6 | fechar #X como *completed* | #1 sem `DEPENDENCY_PENDING` por #X (`satisfied: true`); se E1 ainda existir, #3 continua `pending` |
| E7 (ciclo, opcional) | #X *blocked by* #1 (com #1 *blocked by* #X ainda presente) | Se o GitHub aceitar: #1 `inconclusive/DEPENDENCY_CYCLE`. Se o GitHub recusar criar o ciclo, registrar a recusa como garantia observada do serviço |
| E8 (repo não configurado, opcional) | #1 *blocked by* uma issue de outro repositório visível ao operador (p.ex. outro repo Sanmoo ou público de outro owner), se o GitHub permitir | Aresta aparece no payload do #1: `inconclusive/DEPENDENCY_REPOSITORY_NOT_CONFIGURED`, nó `edge-only`, nenhuma requisição ao outro repo e nenhum token para ele |
| E9 | reinício do proprietário (SIGTERM → exit 0; `run` novamente) | antes da primeira rodada: `dispatch.reasons` inclui `DEPENDENCIES_NOT_CURRENT`; depois da rodada, nova `evaluationId`; nenhuma duplicata de Trabalho |
| Fim | remover relações criadas; fechar #X; reabrir/ajustar #1 | registrar estado final igual ao inicial (labels/assignees inalterados pela Factory) |

Requisições reais esperadas por proprietário: `GET /app`, `GET /app/installations/177599217` e um
`POST …/access_tokens` por finalidade: `tracker-read`, `association-read`, `dependency-read` (todos
`metadata:read, issues:read`) e `repository-read` (`metadata:read, pull_requests:read`). Por rodada e Trabalho pendente:
`GET /repos/Sanmoo/java-springboot-event-sourcing/issues/<n>` e
`GET …/issues/<n>/dependencies/blocked_by?per_page=100&page=1` para cada nó alcançável (o bloqueador também é
lido). Nenhum POST/PATCH/PUT/DELETE pela Factory. Banco sem `ghs_`, `PRIVATE KEY` ou corpo de issue.

Registrar também: se o objeto issue real traz `issue_dependencies_summary` (se não, `limitations` declara omissão não
detectável) e se o payload de `blocked_by` passa no esquema (falha aparece como `DEPENDENCY_READ_UNAVAILABLE/INVALID_GITHUB_PAYLOAD`
ou `INVALID_DEPENDENCY_RELATION` — nunca liberação).

### Cenários que um único repositório não exercita (declarados, não suportados por inferência)

- **Cross-repo do mesmo owner com leitura** (bloqueador em repo listado em `dependencyRepositories` com a mesma
  instalação): exige um segundo repositório com a App instalada. Coberto só em I-local (`acme/deps`).
- **Cross-owner** (instalação distinta por owner): exige outra conta/organização com a App instalada. I-local (`other/lib`, instalação 6).
- **Visibilidade reduzida** (bloqueador privado que a instalação não lê): exige repo privado fora da instalação. Se o
  GitHub listar a aresta, a Factory reporta `DEPENDENCY_REPOSITORY_NOT_CONFIGURED` ou `DEPENDENCY_READ_UNAVAILABLE`
  (404/oculto); se o GitHub **omitir** a aresta da listagem e a contagem do resumo também, a omissão é **indetectável** —
  incompatibilidade a levar ao operador, não suporte. Divergência de contagem → `DEPENDENCY_COUNT_MISMATCH`.
- **Paginação real** de `blocked_by`: não alcançável com o limite de 50 relações por issue e `per_page=100`.

Até o ensaio, AC 7 permanece sem evidência real; nenhuma combinação acima é declarada suportada.
