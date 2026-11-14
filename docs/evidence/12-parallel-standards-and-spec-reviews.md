# 12 — Obter Standards e Spec paralelos sobre a proposta completa: incremento local

Autoridade: [ticket 12](../../.scratch/software-factory-mvp/issues/12-parallel-standards-and-spec-reviews.md),
[spec §§5.6/6.3/6.4/7.5](../../.scratch/software-factory/spec.md), [interfaces Q3/Q5/Q6](../../.scratch/software-factory/module-public-interfaces.md),
cenários V-02/V-08 da [matriz de aceite](../../.scratch/software-factory/acceptance-and-incremental-plan.md).

**Estado: implementação e suíte local verdes (níveis R/S/I-local); ensaio real NÃO executado por este agente** (sem VM/modelo/GitHub/credenciais).
A receita one-shot está em [§ Ensaio real](#ensaio-real-receita-one-shot). Nenhum checkbox marcado; ticket não resolvido. Dublê não comprova fronteira substituída.

## Composição implementada

Uma rodada de revisão acontece **dentro da Execução do Builder** (mesmo Slot, mesmo boot/VM, mesmo relógio), sem broker, scheduler ou DI novos:

1. **Handoff (Workers, Builder).** Com a política Host `handoff: { baseCommit }` (só Builder; Control a define quando `ExecutionPorts.reviews` está composto),
   a sessão Builder ganha a ferramenta Factory `handoff`. Ao ser chamada, o host fecha síncronamente uma comporta: **toda** ferramenta do Builder passa a
   recusar (`BUILDER_SUSPENDED_FOR_REVIEW`, `terminate`) antes de qualquer chamada ao Sandbox; um `turn_start` enquanto suspenso aborta a sessão.
   Não é uma frase do modelo nem `agent_end`: é estado do host. Uma rodada por invocação neste incremento (segunda chamada recusada explicitamente).
2. **Captura (guest, iniciada pelo host).** Com o modelo parado, o host do Builder executa pelo **próprio binding Bash do Builder** um programa Python
   constante (`src/workers/handoff.ts`, nunca entrada do modelo; heredoc citado). No guest, com git sem hooks/fsmonitor/pager/diff externo, grava de forma
   **exclusiva** `/artifacts/review/r<N>/{index.json, committed.patch, staged.patch, unstaged.patch}` (rodada existente nunca sobrescrita) e imprime um resumo:
   commitado (base..HEAD), staged, não staged, novos (não ignorados), removidos, com presença/modo/sha256 por caminho, HEAD/branch/base/merge-base e a
   última versão **completa** de `spec/vN` e `instructions/vN` (caminho + sha256 de `sources.json`). Não exige commit candidato, árvore limpa, cópia ou snapshot.
3. **Notificação e identidade.** O resumo (filtrado por Records) vai ao owner por IPC (`worker-handoff`) e do owner ao Control no canal `host-boot`.
   Control pede ao Sandbox `observeProposal(environment, round)`: **identidade do host** por leituras confinadas (sem git do host, sem seguir symlink do guest):
   sha256 do índice, de cada caminho indexado e de `.git/HEAD`, `.git/index`, `packed-refs` e da ref da branch; `consistent` compara com os hashes do guest.
4. **Commit do handoff (intenção antes do efeito).** `recordHandoff` grava, num commit, a rodada/tentativa, o resumo, a identidade *antes*, as versões de
   pedido/instruções/perfil (skill pack, políticas Builder e revisor) e **as duas intenções de revisor** (identidade de invocação, entrada exigida/ausente,
   hash do prompt). Sem handoff utilizável (captura falha ou identidade indisponível) os dois revisores ficam `failed: HANDOFF_UNAVAILABLE`/`PROPOSAL_IDENTITY_UNAVAILABLE`, explícitos.
5. **Standards e Spec em paralelo.** `Workers.activate` para `standards` e `spec` na mesma VM (`phaseId review-r<N>`, mesma `executionId`), sem credencial,
   com `modelBudget: reviewer-v1` (24 requisições, 80 ferramentas, 15 min, retries 0) e `imageSourceMaxBytes`. Perfil/modelo **por papel**
   (`createWorkers({ profiles })`). Cada revisor tem **somente `read` nativo** (paginação/imagens) com backend confinado do owner (programa guest);
   Bash/Write/Edit são negados pelo owner ao papel. O prompt (Control, regra pura) entrega índice/patches/caminhos e as fontes preservadas: Spec → pedido
   preservado (`basis: requirement`); Standards → instruções preservadas, separando `rule` de `heuristic`.
6. **Parecer completo e durável antes da notificação.** Ao fim da sessão o host do revisor lê **a mensagem final** (nunca streaming parcial), exige um único
   bloco ```json``` validado, aplica verificações do host que **só rebaixam** (leitura falha → `SOURCE_UNREADABLE`; entrada exigida não lida por completo,
   inclusive truncamento não superado → `REQUIRED_INPUT_NOT_FULLY_READ`; versão preservada ausente → `CONTEXT_INSUFFICIENT`; limitação declarada) e grava o
   parecer em Records (`review-opinion`) **antes** de enviar `worker-result`. Veredito ausente/inválido/papel errado/base de achado indevida → `failure`
   durável com código, nunca zero achados; sessão interrompida → `cancelled`.
7. **Conclusão e entrega.** Com as duas atividades encerradas (conclusão recebida e handle fechado → binding de ferramentas revogado no owner), Control
   re-observa a identidade, conclui (`clean` só com os dois pareceres `clean` e identidade consistente e inalterada; mudança → `invalidated`/`incomplete`),
   grava a conclusão e a intenção de entrega, e só então `deliver({kind:'review-results'})` à **mesma sessão** do Builder (owner → IPC `deliver`). O Builder
   retoma com os resultados/falhas efetivos; depois termina normalmente (`recordEnd` → stop → Slot após cessação). Nenhum retry de revisor; falha de entrega → `held`.

Novos tipos: `ReviewOpinion`, `ProposalHandoff`, `ProposalIdentity`, `reviewVerdictFormat` (`src/contracts`); `ExecutionView.review.rounds[]`
(`src/control/types.ts`). Mensagens novas no canal existente: `worker-handoff`, `deliver-directive`/`delivery-result` (host-boot) e `worker-handoff`/`deliver` (IPC fixo).

## Mapa AC → evidência

Níveis: **R** regras puras; **S** Control real + Pi Durable/SQLite temporário + dublês (GitHub, relógio, Sandbox/Workers); **I-local** SDK Pi real
(laço nativo, sessão JSONL), Records/owner/transporte reais, VM `exec` e HTTP do provider dublês; **H** programa guest executado num repositório
local de teste (git real, nunca árvore do guest).

| AC | Testes | Nível | Lacuna |
| --- | --- | --- | --- |
| 1 Handoff registra rodada/tentativa, identidade, Git/base, versões pedido/instruções/perfil, staged/não staged/novos/removidos, sem commit/árvore limpa | `handoff-capture` (índice cobre A/M/D/untracked, ignorado fora, hashes, versões completas mais recentes, patches; rodada nunca sobrescrita; entrada inválida recusada), `proposal-identity`, `review-flow` AC1 (round com contagens, versões, perfil, identidade antes/depois) | H + I-local + S | Git/Python reais do guest Alpine (ensaio) |
| 2 Índice/diff/referências; contexto além dos hunks; Spec→pedido, Standards→instruções, heurística ≠ violação | `review-rules` (planos/prompts por papel, `rule`/`heuristic`, versão ausente declarada), `review-session` AC4 (leitura do índice, fonte e arquivo inteiro), AC6 (Standards mantém `rule` e `heuristic` distintos; Spec com base `heuristic` → falha) | R + I-local | Qualidade do julgamento do modelo real |
| 3 Host suspende Builder antes dos revisores; libera só após cessação deles; mesmo Slot/relógio | `review-session` AC3 (bash em lote recusado antes do Sandbox, nenhum turno até a diretiva, resultados na mesma sessão, 2ª rodada recusada), `worker-handoff-process` (novo Node24: `worker-handoff` → nenhum provider → `deliver` → continua), `owner-handoff`, `activate-review` AC3, `review-flow` AC1/AC3 (Slot 1/1 durante revisores; entrega após os dois `close`; Spec retido segura a entrega) | I-local + S | Processo físico do revisor: cessação = conclusão + binding revogado, não saída de processo observada |
| 4 Papel com sessão/modelo próprios e só `read` nativo confinado; sem shell/busca/listagem/escrita/token/rede/fallback | `review-session` AC4 (provider só recebe a ferramenta `read`; leituras pelo programa guest), `activate-review` AC4 (perfil por papel, `reviewer-v1`, política Builder recusada para revisor), `review-flow` AC1 (sem credencial), `proposal-identity` (sem seguir symlink), owner existente nega Write/Bash a revisores (`normal-builder`, `owner-credential`) | I-local + S | Rede do guest não é usada pela ferramenta; confinamento real da VM no ensaio |
| 5 Parecer completo/durável antes da notificação, com papel, sessão/modelo/perfil, entrada, cobertura, conclusão/falha/cancelamento, achados; parcial não conta | `review-session` AC4/AC5 (registro `complete.json` existe ao retornar; campos), AC5/AC6 (veredito ausente/inválido → falha durável), `review-flow` AC1 (round `concluded` com os dois pareceres e intenção de entrega no instante do `deliver`), `review-rules` AC5 | I-local + S + R | — |
| 6 Fonte ilegível, truncamento não superado, revisor indisponível, contexto insuficiente impedem conclusão limpa, sem omitir Spec nem ampliar ferramentas | `review-session` AC6 (rebaixamentos do host), `review-flow` AC6 (revisor indisponível e interrompido registrados, sem retry; captura falha → ambos explícitos; Spec sem versão preservada ainda roda com `missing`), `review-rules` AC6/AC7 | I-local + S + R | Truncamento real de arquivos grandes do repo de teste |
| 7 Provas reais com os dois agentes (leitura, paralelismo, confinamento, Builder inativo); mudança observada invalida a aplicabilidade | `proposal-identity` AC7, `review-flow` AC7 (dois `clean` + identidade alterada → `invalidated`/`incomplete`), receita `review12-qualification` (+ teste de inércia/guarda/parser de sessão) | I-local + S | **Ensaio real a executar pelo supervisor** |

Mutações (JS compilado, restauradas): (M1) sem `suspendable` → `review-session` AC3 falha; (M2) sem rebaixamento do host → AC6 falha;
(M3) revisores sem `await` (entrega antes do fim) → os 5 testes de `review-flow` falham; (M4) aplicabilidade sempre `current` → `review-flow` AC7 falha.

## TDD observado (honesto)

Testes escritos antes de cada fatia e executados contra o código novo; os primeiros vermelhos reais foram `review-flow` (exceção ao clonar o proxy Pi Durable
com `structuredClone` → `REVIEW_UNEXPECTED_FAILURE`, corrigido com cópia JSON) e a violação de arquitetura de um teste que importava `src/workers` a partir de
`test/sandbox`. Programa de captura, sessão e facade passaram ao primeiro verde; a detecção foi confirmada pelas mutações M1–M4.

## Decisões de interpretação e questões abertas (operador)

1. **Captura pelo binding Bash do Builder.** O índice/diff é computado **no guest** por programa constante executado pelo host do Builder com o modelo
   suspenso (não por um Bash do modelo). É uma extensão de uso do `executeTool` existente, não nova operação Sandbox. Alternativa rejeitada: git do host
   na árvore do guest (proibido) ou cópia/snapshot (a spec dispensa).
2. **Identidade do host limitada aos caminhos indexados + metadados Git.** Arquivo novo não indexado criado depois do handoff não muda a identidade;
   não se promete congelamento (spec §6.4). `consistent=false` (hash do guest ≠ host) torna a rodada `incomplete`.
3. **Uma rodada por invocação Builder.** Nova rodada após correção, sessões compatíveis e "commit idêntico" são do ticket 13; recuperação parcial
   (parecer válido + retry do falho) é do ticket 28. Aqui: nenhum retry; falha fica registrada e é entregue ao Builder.
4. **"Cessação" dos revisores** = conclusão recebida + `close()` do handle (o owner aborta o lifetime e revoga o binding de ferramentas daquela invocação).
   A saída física do processo filho não é observada pelo Control.
5. **Pacote `factory-skills-v3` (novo, v1 intacto).** Pedido do supervisor: o `implement` de v1 mandava terminar com mensagem final, risco de o Builder
   nunca chamar `handoff`. Por coordenação com o ticket 10 (que publica `factory-skills-v3` com `ask_user`), v3 (`assets/skill-pack/factory-skills-v3/`,
   3.0.0, manifesto/hashes/créditos próprios) = o `implement` do ticket 10 (bloqueios por `ask_user`, §4 retomada) **mais** a §3 de handoff: com
   `reviews=factory-handoff` a implementação termina chamando `handoff` uma vez, sozinho, espera os resultados, trata cada achado (corrigido / não acolhido
   com justificativa; decisão de requisito → `ask_user`) e só então termina. A receita 12 usa v3; o ensaio 09 continua em v1; o v2 do ticket 10 entra na
   integração. `loadSkillPack` só carrega um pacote como a versão que ele declara. Teste: `skill-pack-v3`. A composição Control não força a versão.
6. **Perfil por papel com fallback configurado.** `createWorkers({ profiles })` escolhe o perfil do papel; sem entrada para o papel usa o `profile`
   padrão **configurado** (decisão explícita da composição, não fallback silencioso de modelo). A receita configura os três papéis.
7. **Relógio compartilhado.** O prazo de 30 min do Builder (`builder-v1`) inclui o período suspenso; cada revisor tem o próprio teto `reviewer-v1`
   (15 min) dentro da mesma Execução. Timeout de Execução configurável é o ticket 19.
8. **Composição de produção.** `entrypoints/controller/owner.ts` continua sem portas de execução (ticket 32); só a receita compõe `reviews`.

## Correções da revisão estática independente (ec07894)

Testes escritos antes e vistos vermelhos (compilação e execução) para 1–10; 11 escrito junto da correção.

| # | Achado | Correção | Teste |
| --- | --- | --- | --- |
| 1 MED | patch truncado podia concluir `clean` | `required` = índice + fonte preservada + patches não vazios + arquivos alterados presentes (≤ 20, resumo `changed`/`changedTruncated`; total ≤ 32); prompt exige leitura completa de cada um | `review-rules` fix 1, `review-flow` AC1 |
| 2 MED | hash da proposta sem limite | `limits.totalBytes` aplicado; caminho duplicado e `counts.entries` ≠ nº de entradas → `PROPOSAL_INDEX_INVALID` | `proposal-identity-limits` fix 2 |
| 3 MED-LOW | TOCTOU nos diretórios-pai → oráculo de hash do host | caminhada relativa a descritor (`/proc/self/fd/<dirfd>/<nome>`, `O_NOFOLLOW|O_DIRECTORY` por componente) em `observeConfined`/`readConfinedAt`; `mismatches` por caminho removido, só `consistent` global | `proposal-identity-limits` fix 3 |
| 4 MED-LOW | Builder podia retomar sem cessação confirmada do revisor | `cessation` por revisor; lançamento incerto ou `started/completed` rejeitado → `unconfirmed` → Execução `held` `REVIEWER_CESSATION_UNCONFIRMED`, sem conclusão nem entrega | `review-flow` fix 4 |
| 5 LOW-MED | índice lido pelo host ≠ resumo | `indexSha256` diferente → nenhum revisor, `PROPOSAL_INDEX_MISMATCH`, rodada `incomplete` | `review-flow` fix 5 |
| 6 LOW-MED | fallback de perfil por papel | com `profiles`, todo papel precisa de entrada; revisor com `review` sempre exige perfil próprio (`WORKER_PROFILE_NOT_CONFIGURED`) | `activate-review` fix 6 |
| 7 LOW | handoff em lote misto | `handoff` só é aceito sozinho no turno (`HANDOFF_MUST_BE_ALONE`); `streamSimple` recusa síncronamente qualquer requisição enquanto suspenso | `review-session` AC3 |
| 8 LOW | redação do parecer | o worker devolve o registro protegido **redigido** (relido), e o owner reprocessa o parecer pelo seu Records (todos os segredos do boot, incluindo o grant vivo do Builder) antes de encaminhar | `review-session` fix 8, `owner-handoff` fix 8 |
| 9 LOW | entrega não confirmada como "failed" | recusa conhecida → `failed`; demais → `uncertain` (`REVIEW_DELIVERY_UNCERTAIN`), ambos `held` | `review-flow` fix 9 |
| 10 cond. | leitura `isError` contada como lida | resultado `isError` é falha de leitura e não cobre o caminho | `review-session` fix 10 |
| 11 | inspect da receita | `inspect`/`stop-environment` abrem só uma **cópia exclusiva** do SQLite (o original nunca é escrito); sessões lidas com limite (8 arquivos × 4, 8 MiB, sem symlink) | `review12-recipe-safety` |

Gate após as correções e o pacote v3 (`rm -rf dist`): dependency-cruiser sem violações, eslint exit 0, tsc exit 0;
**115 arquivos: 815 pass, 0 fail, 10 skipped, 0 cancelled**.

## Ensaio real 1 (supervisor, namespace q12-review-v1, consumido) e correções

O Builder (v3) escreveu, commitou e chamou `handoff` corretamente, mas a captura falhou (saída vazia, exit ≠ 0) e a rodada ficou `incomplete`
(`HANDOFF_CAPTURE_FAILED`), sem revisores (fail-closed). Causa: o programa usa `GIT_CONFIG_NOSYSTEM=1`, ignorando o `safe.directory=/workspace/*`
de `/etc/gitconfig` do perfil (o FUSE mostra uid 1000 ao root do guest) → git recusou "dubious ownership" → `SystemExit(3)` silencioso.

| # | Correção | Teste |
| --- | --- | --- |
| 1 | `-c safe.directory=<checkout>` na linha de comando do git (isolamento NOSYSTEM/GLOBAL mantido; só o checkout exato é confiável) | `handoff-capture` real-run fix 1 (reproduz "dubious ownership" com `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`) |
| 2 | Toda falha escreve uma linha `FACTORY_HANDOFF_ERROR <CODE> <stage>` em stderr (inclusive exceção inesperada); o host a extrai e a rodada registra `handoff.detail` | `handoff-capture` real-run fix 2, `review-flow` |
| 3 | Identidade fixa de commit em todo comando Bash do Builder (`GIT_AUTHOR/COMMITTER_NAME/EMAIL` = `Software Factory Builder` / `software-factory-builder@users.noreply.invalid`, substituível só por configuração Host `commitIdentity`); v3 `implement` proíbe configurar/copiar identidade humana | `native-builder-bash`, `bash-credential`, `worker-bash-process`, `skill-pack-v3` |
| 4 | Receita no namespace `q12-review-v3` | `review12-qualification` |

Gate (`rm -rf dist`): depcruise/eslint/tsc ok; **116 arquivos: 820 pass, 0 fail, 10 skipped, 0 cancelled**.

Gate após estas correções (`rm -rf dist`): depcruise/eslint/tsc ok; **115 arquivos: 817 pass, 0 fail, 10 skipped, 0 cancelled**.

## Ensaio real 2 (supervisor, namespace q12-review-v2, consumido) e correções

Fluxo completo real: captura ok (identidade antes = depois, `current`), Standards e Spec reais em paralelo, entradas exigidas lidas por inteiro,
pareceres duráveis, entrega após os dois, Slot liberado após cessação confirmada. Os dois pareceres ficaram `failure / REVIEW_VERDICT_INVALID`
(fail-closed correto): Standards pôs prosa antes do bloco; Spec mandou só o bloco ```json```, mas com caminho examinado relativo ao checkout
(`docs/factory-smoke.md`), recusado pelo schema.

| # | Correção | Teste |
| --- | --- | --- |
| 1 | A mensagem final INTEIRA é o veredito: objeto JSON puro ou exatamente um bloco cercado (```json ou ```) com o objeto, só com espaços em volta; prosa, dois blocos ou texto depois → `REVIEW_VERDICT_INVALID` (nunca extraído de prosa). Caminho relativo vira `/workspace/checkout/<caminho>`; `..` recusado | `verdict-format` |
| 2 | `reviewVerdictFormat` (prompt Control) diz que a mensagem final é SÓ o objeto, sem prosa antes/depois, com exemplos `clean` e com achados (os próprios exemplos são verificados pelo parser); prompts de sistema dos revisores na receita idem. O `code-review` do pacote não é carregado pelos revisores (só o Builder tem pacote), então o pacote não muda | `verdict-format`, `review-rules` |
| 3 | Mensagens finais reais como regressão (`test/workers/fixtures/real-run-q12v2-{spec,standards}-final.txt`, sem segredos): Spec agora conclui `clean`; Standards (prosa + bloco) continua inválida | `verdict-format` |
| 4 | Receita no namespace `q12-review-v3` | `review12-qualification` |

Gate (`rm -rf dist`): depcruise/eslint/tsc ok; **116 arquivos: 820 pass, 0 fail, 10 skipped, 0 cancelled**.

## Ensaio real 3 (supervisor, namespace q12-review-v3, consumido) e correção

O Builder tentou ler `/artifacts/factory/skill-pack/factory-skills-v3/skills/implement/SKILL.md` → `READ_PATH_DENIED` (duas vezes) e terminou
sem handoff: a política de leitura do Builder não permitia o pacote semeado. Correção: o facade Host carrega o pacote **verificado** da política
do Builder e envia a lista exata dos seus arquivos semeados (`skillPackFiles`, manifesto + arquivos, todos sob `/artifacts/factory/skill-pack/<versão>/`,
só para Builder com aquele pacote, validado no schema); o owner permite ao Builder ler **exatamente** esses caminhos, pelo programa guest confinado em
modo Builder com o próprio caminho como única seleção (o alvo aberto deve ser igual ao caminho: sem redirecionamento por link); a ferramenta `read` é
registrada para o Builder com pacote mesmo sem cópia de saída. Nada mais fica legível (outra versão, workspace). Teste `builder-pack-read` (I-local:
lê v3 → sucesso; v1 e workspace → `READ_PATH_DENIED` sem chegar ao guest; facade envia só a lista do pacote ativo). Receita em `q12-review-v4`.
Gate (`rm -rf dist`): depcruise/eslint/tsc ok; **117 arquivos: 822 pass, 0 fail, 10 skipped, 0 cancelled**.

## Rebase sobre a integração (tickets 10 e 20, `baa15a8`)

Commits do ticket 12 reunidos em um (histórico original preservado em `backup/software-factory-mvp-12-pre-rebase`) e rebaseados.
Unificações: pacotes `skillPacks` v1/v2 (ticket 10) + v3 (= v2 + §3 handoff + regra de identidade; v1/v2 intactos); regra de leitura dos
arquivos do pacote: **uma** implementação (a do ticket 10, `skillPackGuestFiles` + `skillPackFiles`, leitura pelo programa guest em modo Builder
com o próprio caminho, páginas só de capturas do pacote); testes `builder-pack-read` (v2, ticket 10) e `builder-pack-read-v3`. `Workers.deliver`
é uma união: credencial/retirada (ticket 20) e `review-results` (ticket 12, só ao Builder com política de handoff); mensagens `worker-handoff`/
`delivery-result` passam pela caixa estrita do facade como respostas esperadas da própria launch/entrega. Um prelúdio: `env -i` + identidade
Factory + prelúdio de credencial do ticket 20. Revisores nunca recebem credencial; durante a suspensão para revisão a renovação por tempo do grant
continua (`renewWhile` cobre a rodada) e todo `held` da rodada retira a credencial (`withdraw('held')`); as ferramentas continuam recusadas.
Gate (`rm -rf dist`, normal-oauth com 90 s): depcruise/eslint/tsc ok; **132 arquivos: 902 pass, 0 fail, 10 skipped, 0 cancelled**.

## Ensaio real (receita one-shot)

Receita: `dist/test/entrypoints/review12-qualification.js` (fonte `test/entrypoints/review12-qualification.ts`). `--plan` é inerte. Fases one-shot com
tombstone `*-intent.json` exclusivo em `$HOME/software-factory-test/y5/q12-review-v4/` (criado na `preflight`; existir = consumido). Sem retry; falha grava `*-held.json`.

Pré-requisitos (operador/supervisor): os mesmos do ensaio 09 (raiz `y5` 0700 com store OAuth da Factory em `credentials/` e `run/`; chave da App copiada com
criação exclusiva 0600 para `y5/credentials/app.pem` e removida ao fim; `gh`, `git`, `flock`, `qemu-img`, `systemd --user`, KVM; assets `assets34` pin
`8efa506a…`; SDKs de desenvolvimento preparados). A issue **#3** de `Sanmoo/java-springboot-event-sourcing` deve ser a **única** aberta com `ready-for-agent`
(retirar temporariamente de #1; restaurar ao fim), com pedido somente de documentação e aprovação explícita de que não precisa de testes/seams.
Storage novo: o Trabalho #3 é admitido de novo nesta storage (novo ambiente/branch `factory/3-<work8>`); o ambiente do ensaio 09 não é reutilizado.

```sh
NODE="env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node"
$NODE dist/test/entrypoints/review12-qualification.js --plan
$NODE dist/test/entrypoints/review12-qualification.js preflight   # GitHub somente leitura
$NODE dist/test/entrypoints/review12-qualification.js run         # efeito real: 1 VM, 1 Builder + 2 revisores, modelo real (até 50 min)
$NODE dist/test/entrypoints/review12-qualification.js inspect     # somente leitura
# se run terminar com o boot próprio possivelmente ativo (reserved/started/held, ou ended sem cessação confirmada):
$NODE dist/test/entrypoints/review12-qualification.js stop-environment
```

Efeitos e limites:

- **GitHub**: só a App. Controlador: leituras por finalidade + `repository-fetch {metadata, contents: read}`; Builder: um `builder-start {metadata, contents,
  issues: read}`; **revisores: nenhuma credencial**. Nenhum POST/PATCH/PUT/DELETE além de `access_tokens`. Push/PR impossíveis.
- **VM**: 1 ambiente novo (40 GiB qcow2 de assets34 + checkout + pacote), 1 boot (4096 MiB, 2 vCPU) compartilhado pelos três workers; parada pública ao fim; sem `remove`.
- **Modelo**: `openai/gpt-6-luna/openai-responses` pelo store OAuth da Factory, o mesmo para os três papéis (perfis/prompt de sistema por papel).
  Builder ≤ 60 requisições/120 ferramentas/30 min (inclui o período suspenso); **cada revisor ≤ 24 requisições/80 ferramentas/15 min**; total ≤ 108
  requisições; retries SDK/provider 0; sem teto de cobrança no provedor (custo real desconhecido).
- **Guardas da receita**: `prepare` uma vez e só para o Trabalho #3; no máximo **um** Builder, **um** Standards e **um** Spec, todos da mesma Execução
  (`activationGuard`); prazo 50 min; ao fim o Control é parado e o estado salvo em `run-result.json` (com eventos e instantes monotônicos).

Observações esperadas (`run-result.json`, `inspect-result.json`):

1. `final.works[#3].execution`: `state: ended`, `slot.held: false`, `end.cessation: confirmed`; `review.rounds[0]`: `state: delivered`, `handoff.status: captured`
   com contagens/head/branch/base e `versions.spec/instructions` (`v1`), `identity.before/after` `observed` e iguais (`applicability: current`), revisores
   `standards`/`spec` `ended` com `receiptId`, `opinion.model.modelId: gpt-6-luna`, `conclusion` `clean|findings|incomplete` (falha registrada nunca vira zero achados).
   Histórico: `… execution-started → review-handoff → reviewer-started ×2 → reviewer-ended ×2 → review-concluded → review-delivered → execution-ended → slot-released`.
2. `events`: um `activate` builder (com `handoff.baseCommit`), um `handoff` captured, dois `observe-proposal`, `activate` standards e spec **antes** de qualquer
   `completed` de revisor (paralelismo), `deliver` só depois dos dois `completed`; nenhum `credentialDelivered: true` para revisores; um `stop`.
3. `inspect`: `review/r1/index.json` e patches presentes; `sessions[]`: sessões dos revisores com **somente** `read` em `toolCalls` (caminhos sob
   `/workspace` e `/artifacts`); sessão do Builder com `handoff` seguido de nenhuma ferramenta até os resultados; `opinions.*` com o registro `review-opinion`;
   `tokenPattern: false` em todas as sessões.
4. Nenhum `ghs_`/chave em `control.sqlite*`, observações, recibos, pareceres ou sessões (verificar com `grep -c`).
5. Resultados que exigem disposição: `held` (código em `execution.held`, ex.: `REVIEW_DELIVERY_FAILED`), rodada `incomplete` (motivos em `reasons`),
   Builder sem `handoff` (rodada ausente: o Builder terminou sem pedir revisão — falha de seguir instrução, registrar), prazo atingido.

## Gate local

Node 24.21.0 com `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 60`, sem npm/npx, após `rm -rf dist` (HEAD `f5f5f56`):
`dependency-cruiser` sem violações (259 módulos, 1461 dependências); `eslint . --max-warnings 0` exit 0; `tsc -p tsconfig.json` exit 0;
**112 arquivos** (antes do pacote v2) `dist/test/**/*.test.js`, um por vez (`--experimental-test-module-mocks --test --test-concurrency=1`): **802 pass, 0 fail, 10 skipped, 0 cancelled**.
Os 10 skips são os mesmos de antes (host-dependentes); `test/sandbox/gondolin.test.ts` continua `skip:true`. Uma execução anterior do gate pegou uma
regressão real: `native-builder-write` confere o texto exato do bloco de ferramentas com portão do host em `worker-session.ts`; o bloco foi restaurado
e a observação das leituras do revisor passou a envolver a ferramenta depois dele.
Novos arquivos: `handoff-capture` (2), `review-session` (4), `activate-review` (2), `worker-handoff-process` (1), `proposal-identity` (2),
`owner-handoff` (1), `review-flow` (5), `review-rules` (3), `review12-qualification` (3).

## Ensaio real v4 — 2026-11-14 (supervisor) — aceito

HEAD `25d1d88` (rebaseado sobre 10+20), namespace `q12-review-v4`. Registros: [run](12-real-review-run-2026-11-14.json), [inspect](12-real-review-inspect-2026-11-14.json). Tentativas anteriores, todas preservadas: v1 falhou na captura (`safe.directory`); v2 teve vereditos rejeitados (caminho relativo); v3 teve o pack ilegível pela Read. Cada uma falhou fechada e foi corrigida com TDD.
- Builder real (pack v3) implementou a #3 com commit da identidade **Software Factory Builder** (nenhuma identidade humana na evidência) e chamou `handoff` sozinho.
- Captura ok, com identidade antes = depois (`current`).
- **Standards e Spec reais** (`gpt-6-luna`) ativados em paralelo na mesma VM, Execution e Slot, só com `read` e sem credencial. Standards leu 13 entradas, Spec 5; nenhuma leitura falhou nem ficou truncada. Ambas as opiniões `clean`, duráveis antes da notificação.
- Conclusão `clean` registrada, depois entrega ao mesmo Builder (`delivered`), que terminou. Cessação confirmada e Slot liberado.
- Segredos: 0 em `control.sqlite*` e na evidência.
