# 09 — Iniciar Builder com checkout próprio e pedido preservado: incremento local

Autoridade: [ticket 09](../../.scratch/software-factory-mvp/issues/09-builder-start-and-preserved-request.md),
[spec §§3.4/5.3/6.1–6.3/7.3/8.1](../../.scratch/software-factory/spec.md), [interfaces Q3/Q5/Q6/Q10/Q11](../../.scratch/software-factory/module-public-interfaces.md),
cenários V-04/V-07/V-08 da [matriz de aceite](../../.scratch/software-factory/acceptance-and-incremental-plan.md).

**Estado: implementação e suíte local verdes (níveis R/S/I-local); ensaio real NÃO executado por este agente** (sem VM/modelo/GitHub/credenciais).
A receita fixa de execução real está em [§ Ensaio real](#ensaio-real-receita-one-shot). Nenhum checkbox marcado; ticket não resolvido.
Dublê não comprova fronteira substituída.

## Composição implementada

- **Controle** (`src/control/durable/execution.ts`, `dispatch.ts`; tipos em `types.ts`). Com `openControl({ execution })` (portas injetadas:
  Sandbox `prepare/start/stop`, `Workers.activate`, `BuilderCredentials`, configuração da sandbox, capacidade e políticas Host do Builder),
  o despacho abre somente se o inventário de runtime está vazio e nenhum Slot ficou retido de execução anterior; senão `RECONCILIATION_REQUIRED`;
  sem portas, permanece `EXECUTION_NOT_ENABLED` (comportamento anterior). O despacho roda no mesmo laço do proprietário (`afterCycle` do poller),
  sem scheduler/broker:
  1. Seleção FIFO (`selectNext`) com bloqueadores da rodada atual; **revalida autorização** (releitura do Ticket: aberto/label/identidade) e
     faz **avaliação nativa nova** com `attemptId` próprio do despacho.
  2. Commit **Admitir Execução**: Trabalho aberto/pendente/ciclo vigente, sem pausa, sem impedimento, avaliação **desta tentativa** e
     `satisfied`, Slot livre (`factory.slots`) → Execução (`executionId`, `invocationId`), Slot, intenção `prepare-start-activate`, branch própria
     `factory/<n>-<work8>`, fila não pendente, histórico. Nada externo antes deste commit.
  3. `prepare` (checkout + seeds) → fase `prepared` (ambiente, `baseCommit`, pacote); `start` → `booted`. Cada fase só avança se a Execução
     ainda é a vigente no estado/fase esperados.
  4. **Revalidação imediatamente antes da ativação**: autorização + nova avaliação com outro `attemptId`; se não satisfeita, para o boot próprio e,
     com cessação confirmada, libera o Slot e devolve o Trabalho à sua posição FIFO (`released`); sem credencial emitida.
  5. Concessão do Builder (memória) → commit `activation-requested` com **apenas metadados** do grant e hash do prompt → `Workers.activate`
     com a credencial no argumento transitório `delivery`.
  6. Recibo de início → commit **Confirmar início**: consumido uma única vez (repetição = `already-confirmed`; outro recibo = `conflict`).
  7. Fim → `ended` (`completion.automatic: false`); `revoke` (não tentado, ticket 20); `stop` do boot próprio; **Slot só após cessação confirmada**.
  Qualquer falha/incerteza → `held` explícito com código/fase/próximo passo, Slot mantido, **sem retry**. Nada de push/PR/revisões/prontidão.
- **Sandbox** (`src/sandbox/checkout.ts`, `artifact-seeds.ts`; `createSandbox({ repositoryFetch, remoteUrl, artifactSeeds })`,
  `prepare({ workId, configuration, checkout })`). Cache bare exclusivo por repo em `<root>/cache/git/<repositoryId>.git` (fora de
  `environments/`, nunca montado: os mounts continuam só `workspace`/`artifacts` do ambiente). Por repo, `fetch` → clone local concluído →
  próximo preparo encadeados em memória no proprietário (sem lock/serviço); repos distintos em paralelo. `git clone --no-hardlinks --template=
  --no-checkout --single-branch` do cache, sem `--shared/--reference`, verificado sem `objects/info/alternates`; `origin` =
  `https://github.com/<repo>.git`; branch própria `--no-track` no `baseCommit`. Git do host com `HOME` temporário, `GIT_CONFIG_NOSYSTEM`,
  `GIT_CONFIG_GLOBAL=/dev/null`, `core.hooksPath=/dev/null`, template vazio, `core.fsmonitor=false`, LFS smudge desligado, sem submódulos;
  fetch com `GH_TOKEN` + `credential.helper=!gh auth git-credential` (token Contents R, só em memória, nunca em config/remoto). Metadados
  `checkout.json` (host, ao lado do workspace) e tombstone `checkout-intent.json`: continuação **reutiliza** branch/workspace/metadados sem
  rodar git na árvore gravável pelo guest; preparo parcial nunca é adotado/repetido. Seeds: pacote copiado uma vez para
  `/artifacts/factory/skill-pack/factory-skills-v1/`; versão existente só reutilizada se o manifesto for idêntico (nunca sobrescrita).
- **Credencial** (`platform/github`): finalidades `builder-start {metadata, contents, issues: read}` e `repository-fetch {metadata, contents: read}`;
  `GitHubAccess.transient` emite um grant novo (registrado no filtro, sem cache/retry; POST incerto → `GITHUB_TOKEN_ISSUANCE_UNKNOWN`).
  `createBuilderCredentials` (contrato §8.1 em `contracts`) só para o repo configurado do Trabalho, sem Workflows; metadados sem token.
  Entrega: `Workers.activate(invocation, { credential })` envia `deliver-credential` ao owner **antes** de `launch-worker`; o owner
  registra o token no **mesmo Records** antes do ACK e o vincula àquela invocação Builder; o processo worker/SDK **nunca** recebe o token.
  O Bash Builder recebe o token por **stdin** num prelúdio fixo do guest que exporta `GH_TOKEN`, `GH_HOST` e o credential helper via
  `GIT_CONFIG_*` (nunca argv, env do exec, remoto ou arquivo); saídas que ecoem o token são filtradas.
- **Workers**: pacote `assets/skill-pack/factory-skills-v1/` (manifesto com hash por arquivo, origem/upstream hash, `verbatim|adapted|factory-own`,
  créditos e licenças MIT; `implement`, `code-review`, `pr`, `tdd` (+ refs), `codebase-design` (+ refs), `alpine-diagnostics`, templates
  `/implement` e `/pr`). `loadSkillPack` verifica conjunto exato/hashes (deriva → `WORKER_SKILL_PACK_DRIFT`). Política Host `skillPack`
  (só Builder): resource loader com skills do pacote em caminhos guest e templates; o SDK resolve `/implement <link>`; nada de perfil pessoal.
  Política `modelBudget: 'builder-v1'` (só Builder): limites OAuth explícitos (60 requisições, 120 ferramentas, prompt 16 KiB, contexto 2 MiB,
  provider 16 MiB, 30 min), retries SDK/provider continuam 0. Recibo `worker-start` agora inclui `promptSha256`, `skillPack {id, version,
  manifestSha256}` e `modelBudget`.

## Mapa AC → evidência

Níveis: **R** regras; **S** Control real + Pi Durable/SQLite temporário + dublês (GitHub, relógio, portas de execução); **I-local** componentes
reais com fronteira externa substituída (git real sobre repos locais `file://`; issuer/gh/App HTTPS pelo `github-world-fixture`; owner +
Protocol + Records reais com VM/spawn dublês; SDK Pi real com fetch de provider offline).

| AC | Testes | Nível | Lacuna |
| --- | --- | --- | --- |
| 1 Revalida elegibilidade/dependências/capacidade; confirma Execução/Slot/intenção antes de preparar/ativar; recibo consumido uma vez | `execution-flow` (reserva visível no storage dentro do `prepare`; intenção `activation-requested` antes do `activate`; 3+ leituras do grafo/Ticket; label retirada → nada; bloqueador entre reserva e ativação → `released` sem ativar; capacidade 1 segura o 2º; falha → `held` sem retry; Slot retido fecha despacho após reinício), `execution-commits` (só avaliação da própria tentativa; `NO_SLOT_AVAILABLE`; `EXECUTION_ALREADY_ACTIVE`; recibo `confirmed`/`already-confirmed`/`conflict`/`stale`) | S | VM/worker reais (ensaio) |
| 2 Cache bare exclusivo; fetch → clone sequenciados por repo; sem mutex global; `--no-hardlinks`, sem alternates/shared/reference; remoto GitHub | `sandbox-checkout` (cache em `cache/git/<id>.git` 0700; nlink=1 em todos os objetos; sem alternates; origin GitHub; mesmo repo esperou o 1º clone, outro repo seguiu em paralelo), `github-builder-credentials` (fetch Contents R) | I-local | Fetch HTTPS real/gh helper real |
| 3 Preparo host sem hooks/scripts/plugins, cache não montado; branch/workspace/metadados reutilizados; sem escrita comum | `sandbox-checkout` (hook do repo, hooks/template/filtro do perfil pessoal e hook plantado pelo guest nunca rodam; continuação sem fetch/git; inodes `.git` disjuntos entre Trabalhos; tombstone), mutações M1/M2 abaixo | I-local | Mounts reais (adapter inalterado: só workspace/artifacts) |
| 4 Ticket/repo/base inequívocos; pacote próprio versionado com Alpine e origem/créditos/licenças; sem perfil pessoal | `skill-pack` (manifesto/hashes/licenças; deriva recusada; SDK real expande `/implement <link>`; skills listadas em caminhos guest; skill pessoal em `~/.pi` ausente; revisor recusado), `execution-flow` (prompt `/implement <url> repository= base= base-commit= branch=`, checkout args), `sandbox-checkout` (seed único, versão não sobrescrita) | S + I-local | Modelo real lendo o pacote |
| 5 Credencial restrita ao repo, transitória pelo caminho host antes das ferramentas; fora de estado/prompt/sessão/recibo/remoto | `github-builder-credentials` (finalidade/repo; outro repo recusado; POST incerto sem segundo), `activate-credential` (ordem `deliver-credential` → `launch-worker`; payload sem token; entrega recusada → sem launch; revisor recusado), `owner-credential` (registro antes do ACK; worker sem token; Bash recebe por stdin; eco filtrado; vínculo à invocação), `bash-credential` (token só em stdin; `GH_TOKEN`/helper no comando; sem credencial = argv anterior), `execution-flow` (SQLite sem token; invocação sem token) | I-local + S | gh/git reais no guest Alpine |
| 6 Começa por implement; preserva fontes/instruções fora da proposta; manifesto final completo; versões não sobrescritas; controlador não ingere | `skill-pack` (regras de `implement`: preservar antes, versão nova, `sources.json` por último com origem/data/sha256/revisão, nunca sobrescrever; `/implement` explícito, não invocável pelo modelo), `execution-flow` (controlador não lê `/artifacts`; só metadados) | I-local | Comportamento do modelo real (ensaio); integridade contra código hostil não prometida |
| 7 Fonte inacessível/aprovação ausente impede conclusão automática, explícita, sem ampliar token nem adotar fonte auxiliar | `skill-pack` (`BLOCKED:`, `complete:false` + `missing`, proibições), `tdd` adaptado (seams só por autorização concreta prévia), `execution-flow` (`completion.automatic:false` em toda Execução encerrada), `github-builder-credentials` (grant não ampliável) | S + I-local | Sem `ask user` durável até o ticket 10 (ver decisão 3) |
| 8 Prova com agente real relaciona autorização, reserva, recibo, perfil/spec, comandos e alteração; sem retry/publicação | Receita `builder09-qualification.ts` (+ teste de inércia) | — (pendente) | **Ensaio real a executar pelo supervisor** |

Mutações (JS compilado, restauradas): (M1) git do host com `HOME`/config global pessoal e sem `core.hooksPath` → `sandbox-checkout` falha
(hook pessoal executado); (M2) sem `--no-hardlinks` → falha (nlink>1 e metadados compartilhados); (M3) `registerSecret` removido no owner →
`owner-credential` falha (eco não filtrado); (M4) admissão aceitando avaliação de outra tentativa → `execution-commits` falha; (M5) sem
pré-checagem antes da credencial → `execution-flow` falha (credencial emitida para ativação recusada).

## TDD observado (honesto)

Vermelho primeiro: `bash-credential` (falhou sem o prelúdio), `sandbox-checkout` (módulo inexistente; depois falha real de ordem de diretórios),
`execution-flow` (falhas reais: proxy Pi Durable não clonável; credencial emitida antes da recusa), `execution-commits`. Implementação antes do
teste, verificada por mutação: `github-builder-credentials`, `owner-credential`, `activate-credential`, `skill-pack`.

## Decisões de interpretação e questões abertas (operador)

1. **Grant inicial somente leitura.** `builder-start` = `metadata/contents/issues: read` — abaixo do teto §8 (Contents W/PR W), porque push/PR
   são do ticket 14. O ticket 14 deve introduzir a finalidade de publicação. Consequência: push é impossível neste incremento.
2. **Revogação não tentada.** `revoke` devolve `not-attempted` (ticket 20); o token expira em ≤ 1 h. Nenhuma revogação é alegada.
3. **Bloqueio sem pergunta durável.** Não há `ask user` antes do ticket 10. O pacote instrui `sources.json` com `complete:false`/`missing` e
   mensagem final `BLOCKED:`; o controlador **não** interpreta texto nem lê `/artifacts` e nenhuma Execução encerrada conclui o Trabalho
   (`completion.automatic:false`). O ticket 10 deve transformar isso em pergunta/impedimento durável.
4. **Aprovação de seams TDD.** Adaptado: seams só por autorização concreta prévia (Ticket/fontes referenciadas/resposta registrada). Para a issue
   de teste #3, se ela não declarar seams/aprovação, o resultado **esperado e correto** é `BLOCKED` após preservar o pedido.
5. **Parada do controlador durante a Execução.** O canal host-boot do `activate` vive no controlador; sua perda revoga o worker (semântica
   existente do owner). "Parar não cancela Trabalhos" fica em tensão: ao reiniciar, o Slot retido mantém `RECONCILIATION_REQUIRED` (ticket 26).
6. **Composição de produção.** `entrypoints/controller/owner.ts` continua sem portas de execução (sem assets de release; ticket 32). Só a receita
   compõe execução com os assets de desenvolvimento fixados. Após uma Execução, `environments/` não fica vazio: um proprietário reiniciado
   ficaria fechado (inventário `unknown`) até a reconciliação.
7. **Sequenciamento do cache em memória.** A cadeia por repo vale dentro do proprietário único; reconciliação de processos de preparo após crash
   antes de mutar o cache (spec §7.3) **não** está implementada.
8. **Limites de ferramentas.** Write ≤ 8192 bytes e Edit com fonte ≤ 8192 bytes (perfil 05): arquivos maiores exigem Bash. O orçamento
   `builder-v1` (60/120/16 KiB/2 MiB/16 MiB/30 min) é escolha deste incremento — **requer aprovação do operador**.
9. **Pacote no `/artifacts` gravável.** O Builder pode alterar sua cópia; só o manifesto é conferido na reutilização. Imutabilidade contra código
   hostil não é prometida (spec §6.2). Revalidação de autorização antes do despacho é observação em memória; retirada durável é o ticket 25.

## Ensaio real (receita one-shot)

Receita: `dist/test/entrypoints/builder09-qualification.js` (fonte `test/entrypoints/builder09-qualification.ts`). `--plan` é inerte e imprime
os limites. Fases one-shot com tombstone `*-intent.json` exclusivo em `$HOME/software-factory-test/y5/q09-builder-v1/` (criado na `preflight`;
existir = consumido). Sem retry; falha grava `*-held.json`.

Pré-requisitos (operador/supervisor): raiz `y5` privada (0700) com o store OAuth da Factory já existente (`credentials/`, primeiro login do 05) e
`run/`; copiar a chave da App com criação exclusiva 0600 para `y5/credentials/app.pem` (remover ao fim); `gh`, `git`, `flock`, `qemu-img`,
`systemd --user`, KVM; assets `assets34` (pin `8efa506a…`); SDKs de desenvolvimento preparados (`.scratch/factory-development-sdk-v3`,
Gondolin). A issue **#3** de `Sanmoo/java-springboot-event-sourcing` deve ser a **única** aberta com `ready-for-agent` (a `preflight` exige isso;
remover a label de #1 se ainda estiver).

```sh
NODE="env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node"
$NODE dist/test/entrypoints/builder09-qualification.js --plan
$NODE dist/test/entrypoints/builder09-qualification.js preflight   # GitHub somente leitura
$NODE dist/test/entrypoints/builder09-qualification.js run         # efeito real: 1 VM, 1 Builder, modelo real (até ~45 min)
$NODE dist/test/entrypoints/builder09-qualification.js inspect     # somente leitura
# somente se run terminar com execution.state = held e boot ativo:
$NODE dist/test/entrypoints/builder09-qualification.js stop-environment
```

Efeitos e limites:

- **GitHub**: só a App da Factory. Controlador: tokens de leitura por finalidade (`tracker-read`, `association-read`, `dependency-read`,
  `repository-read`) + `repository-fetch {metadata, contents: read}` para o fetch do cache; Builder: um `builder-start {metadata, contents,
  issues: read}` restrito ao repo. Nenhum POST/PATCH/PUT/DELETE além de `access_tokens`. Push/PR impossíveis com essas permissões.
- **VM**: 1 ambiente novo (`prepare`: disco 40 GiB qcow2 a partir de assets34 + checkout + pacote), 1 boot (4096 MiB, 2 vCPU), parada pública ao
  fim; sem `remove`/cleanup. Cache em `y5/cache/git/1256893534.git`.
- **Modelo**: `openai/gpt-6-luna/openai-responses` pelo store OAuth da Factory; **≤ 60 requisições**, ≤ 120 ferramentas, prazo 30 min no worker,
  retries 0; sem teto de cobrança no provedor (custo real desconhecido; observar `usage` na sessão).
- **Prazo da receita**: 45 min; ao fim, o Control é parado e o estado salvo em `run-result.json`.

Observações esperadas (`run-result.json`, `inspect-result.json`):

1. `final.works[#3].execution`: `state: ended`, `dispatch.phase: stopped`, `slot.held: false`, `end.cessation: confirmed`, `start.receiptId`
   definido, `credential` = metadados `builder-start` (sem token), `admission.attemptId ≠ activationAttemptId`; histórico
   `execution-reserved → prepared → booted → activation-requested → started → ended → slot-released`.
2. `events`: exatamente um `prepare` (checkout `factory/3-<work8>`, base `main`), um `start`, um `activate` com prompt `/implement
   https://github.com/Sanmoo/java-springboot-event-sourcing/issues/3 …` e `credentialDelivered: true`, um `stop`.
3. `inspect`: `checkout.json` (`origin` GitHub, `baseCommit`), `remote -v` só `https://github.com/…` (sem credencial),
   `/artifacts/spec/v1/{ticket.json,sources.json}` e `/artifacts/instructions/v1/sources.json` com origem/data/sha256/revisão — ou
   `complete:false` + `missing` e sessão terminando em `BLOCKED:` (esperado se #3 não autoriza seams TDD, decisão 4); commits na branch
   própria (nunca publicados); recibo `worker-start` com `skillPack.manifestSha256`, `modelBudget: builder-v1`, `promptSha256`.
4. Nenhum `ghs_`/chave em `control.sqlite`, observações, recibo ou sessão (verificar com `grep -c`).
5. Resultados que exigem disposição do operador: `held` (código/fase em `execution.held`), `released` (revalidação recusou), prazo atingido.

## Gate local

Node 24.21.0 com `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 60`, sem npm/npx, após `rm -rf dist`:
`dependency-cruiser` sem violações (237 módulos, 1311 dependências); `eslint . --max-warnings 0` exit 0; `tsc -p tsconfig.json` exit 0;
**101 arquivos** `dist/test/**/*.test.js`, um por vez (`--experimental-test-module-mocks --test --test-concurrency=1`):
**768 pass, 1 fail, 10 skipped, 0 cancelled**. A falha única é intermitente e anterior a este incremento:
`native-owner-operation-ids` › "native write: independent owner IDs for punctuation" (asserção "each completed owner command lifetime
is closed"), caminho Write/owner não alterado aqui (`write-tools.ts`, `read-tools.ts`, fixture inalterados); reexecutado isoladamente passou
13 de 14 vezes. Registrado como flake a investigar, não corrigido neste ticket. Os 10 skips são os mesmos de antes (host-dependentes);
`test/sandbox/gondolin.test.ts` continua `skip:true`. Novos arquivos: `github-builder-credentials` (3), `sandbox-checkout` (4),
`bash-credential` (2), `owner-credential` (2), `skill-pack` (3), `activate-credential` (2), `execution-flow` (7), `execution-commits` (2),
`builder09-qualification` (1).
