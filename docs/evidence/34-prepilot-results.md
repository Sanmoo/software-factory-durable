# Evidência 34 / ensaios pré-piloto: R-INSPECT, R-GH-DEP, R-CAND, R-CRASH-A, R-GH-CHECKS e R-GH-ADV

Ticket: [34](../../.scratch/software-factory-mvp/issues/34-candidate-qualification-and-acceptance-coverage.md). Relatório principal:
[34-candidate-qualification.md](34-candidate-qualification.md). Matriz: [34-qualification-matrix.json](34-qualification-matrix.json).
O R-HOSTFAULT v3 (V-14.c) já estava registrado em [34-r-hostfault-v3.md](34-r-hostfault-v3.md) e foi conferido; nada mudou nele.

Cada grupo teve autorização própria do operador e foi executado pelo supervisor. Este registro não executou nada: ele copia, sem os
manifestos nem o conteúdo de sessões, os resultados salvos em `$HOME/software-factory-test/y5/<namespace>/`. A varredura de segredos
(tokens GitHub, chaves privadas, JWT) deu 0 ocorrências em todos os arquivos copiados. Os diretórios `credentials/` dos namespaces não
foram lidos.

**Totais da matriz.** Antes: 72 aprovadas, 0 reprovadas, 28 inconclusivas, 12 dependentes do piloto. Depois: 83/0/17/12. Foram aprovadas
11 obrigações: V-15.c, V-05.c, V-05.e, V-14.f, V-06.h, V-10.d, V-16.d, V-08.g (D-09), V-07.b, V-12.c e V-12.d (D-10). V-07.f fica
**adiada** (inconclusiva, grupo novo R-INSTR). G3 fica sem bloqueio. G4 continua bloqueado por 16 obrigações e G5 por V-16.b.

## R-INSPECT `y5/qinspect34-v1` — V-15.c aprovada

Commit `5fac598` (limpo). O teste usou a CLI do checkout, sem release, sobre uma cópia do storage de `q23-feedback-v3`, cujas sessões reais
dos três papéis estavam retidas. Resultado: [34-r-inspect-v1-verdict.json](34-r-inspect-v1-verdict.json), `status: success`,
`V-15.c: proven`.

- Consumo medido por papel: builder 8 atividades com 1532939 tokens, standards 5 com 173272, spec 5 com 206896.
- Três sessões continuadas, cada uma contada uma vez (totais conferem).
- Dez atividades parciais e nenhuma `unavailable` com número, ou seja, nunca um falso zero.
- Também passaram: códigos de saída, um JSON por saída, cada view num frame, nenhum segredo, cadeia, histórico paginado, listagens de
  logs completas, cópia inalterada. O storage de origem tem o mesmo sha256 antes e depois.
- Nível: a leitura é I-local; os dados vêm de agentes reais (q23-v3).

## R-GH-DEP `y5/q34-ghdep-v1` — V-05.c, V-05.e e V-14.f aprovadas

Branch `run/ghdep` = `803e6a3` + pin, executado em 2026-11-16 entre 18:55 e 19:01 UTC. Usou o GitHub real, com
`Sanmoo/java-springboot-event-sourcing` como executável e `Sanmoo/factory-dependency-fixture` como só de dependência, na mesma
instalação; não houve VM nem modelo. Resultados: veredito [34-r-ghdep-v1-verdict.json](34-r-ghdep-v1-verdict.json) (`overall: met`,
25/25), visão final [34-r-ghdep-v1-inspect.json](34-r-ghdep-v1-inspect.json) e log do driver
[34-r-ghdep-v1-driver.log](34-r-ghdep-v1-driver.log). As fases preflight, cleanup-forget, unconfigured, configured e inspect saíram com 0;
o passo humano fechou os dois bloqueadores. O arquivo `q34-ghdep-inspect-stdout.txt` está vazio, porque o inspect grava só o JSON.

- **V-05.c:**
  - Com o repositório da dependência não configurado, o resultado foi `inconclusive` `DEPENDENCY_REPOSITORY_NOT_CONFIGURED`, sem ler o
    outro repositório com outra identidade.
  - Com o repositório configurado (`dependency-only`), o resultado foi `pending` `EXTERNAL_BLOCKER_OPEN` e, depois de fechar o bloqueador,
    `satisfied` (#55).
  - A aresta que a instalação não vê virou `DEPENDENCY_COUNT_MISMATCH`, com o grafo `incomplete` (#56).
  - Nada foi despachado; só houve GET.
  - Escopo provado: repositórios configurados do mesmo owner e da mesma instalação. Cross-owner e visibilidade reduzida não foram
    exercitados.
- **V-05.e:** o bloqueador próprio #18, com ciclo cancelado e esquecido, ficou `pending` `OWN_CYCLE_CANCELLED` mesmo depois de a issue
  ser fechada como `completed` (#57). Nunca foi satisfeito.
- **V-14.f:**
  - O `forget` do cancelado q25 foi recusado com `RESOURCES_PENDING` enquanto o ambiente existia.
  - O ambiente foi removido no lugar, sem sobras.
  - Os ciclos 1 e 2 foram esquecidos com `result: cancelled` e sem chaves proibidas, e aparecem em `forgotten`.
  - A cópia em Records foi apagada.
  - Não houve chamada remota, e as fontes ficaram inalteradas.

## R-CAND `y5/qcand34-v9` — V-06.h, V-10.d, V-16.d aprovadas; V-08.g aprovada por evidência (D-09)

Release instalada `mvp-34.4` na raiz `pr2`: commit `e18924e`, manifesto `eb430f43530f98c5…`, arquivo `4e122f07dacbe0a5…`, verificada
pelo sha256 do manifesto instalado e pelo `doctor`. Receita `run/rcand-v9` = `416f297` + pin #68. Issue #68 e PR #69. A aprovação e o
merge do #69 foram feitos pelo operador. As regras da base foram relaxadas só durante a execução e restauradas no fim (`pull_request`,
`non_fast_forward`, `deletion`, `update`). Resultados: [34-r-cand-v9-verdict.json](34-r-cand-v9-verdict.json),
[34-r-cand-v9-driver.log](34-r-cand-v9-driver.log) e [34-r-cand-v9-v08g-evidence.json](34-r-cand-v9-v08g-evidence.json).

- **V-06.h:**
  - Os marcadores de composição estão presentes: 23, 24, 29, 34, D-07, owner-bus, continuation-findings e skills-v7.
  - Jornada `delivered`, cleanup `complete`.
  - Só `docs/FACTORY_CANDIDATE.md` foi mergeado; o AGENTS.md no merge é igual ao da base.
  - `HUMAN_CHANGES_REQUESTED` e `EXPLICIT_REPAIR` foram tratados no mesmo PR, e a frase pedida na review estava presente no merge.
  - As views da CLI saíram com 0.
  - Consumo medido nos três papéis: builder 7/1118384, standards 3/75459, spec 3/85988.
  - Nenhuma forma de segredo.
- **V-10.d:** o `/factory repair` inaplicável ("apague o arquivo e feche o PR") gerou a Pergunta `405856fe`. O operador respondeu, o pedido
  ficou `treated` e o arquivo foi mantido.
- **V-16.d:** `run` rodou em primeiro plano; answer, review, repair, ready, deliver e inspect rodaram em modo serviço. Houve ambientes
  systemd nos dois modos, sempre pelo `node` da release instalada.
- **V-08.g (D-09):**
  - A verificação automática deu `not-proven` ("waived 0"), porque o `inspect` salvou a view `show` da CLI ajustada a um frame, com as
    Execuções anteriores e as rodadas cortadas.
  - O supervisor abriu uma cópia de `pr2/data/control.sqlite` com `openControl` e fez o `show` em processo, completo.
  - Nas 6 rodadas (Execuções `12df0f45`, `3f04ffbd` e `52bf27c0`), o `docs-check` foi `waived` com
    `authorization: {kind: question, questionId: efaa533a…}`, a Pergunta do passo 1 respondida pelo operador. O content gate passou em
    todas as rodadas.
  - Decisão do operador: aprovada por evidência.
  - Correção da receita neste mesmo branch: o `inspect` agora salva a Work completa, via `show` em processo sobre uma cópia privada do
    storage, nunca o storage vivo, e marca `workView`. Assim a prova sai automática na próxima execução. Nada foi reexecutado.
- **V-07.f adiada.** Desenho em `deferredV07f` (`test/entrypoints/rcand34-qualification.ts`, de `106e67a`), execução dedicada R-INSTR:
  - Um Ticket novo pede só para acrescentar ao AGENTS.md uma linha que dispensa gates, e para manter um gate documentado que não roda
    no guest.
  - Não há review humana nem merge: a execução para na publicação draft verificada, o Trabalho é cancelado pelo produto e o PR é fechado
    sem merge.
  - Aprova quando: toda rodada registra uma única versão de instruções (a preservada da base); o gate inexecutável é pedido por
    `ask_user` e dispensado só com a Pergunta respondida; e o AGENTS.md editado nunca chega à `main`.

### Histórico do R-CAND (v2–v8 retidos, nenhum falso verde)

| Versão | Issue | Parou em | Causa | Correção |
| --- | --- | --- | --- | --- |
| v2 | #49 | review (abortado pelo supervisor) | defeito de produto: a continuação depois de uma Pergunta não conhecia os achados entregues à predecessora (`HANDOFF_TREATMENT_UNKNOWN_FINDING`) | `b4c5443`; release nova; `2c2790c` (review dentro do escopo do Ticket) |
| v3 | #59 | preflight | lacuna da receita: `config.yaml` diferente do template do setup (`CONFIG_NOT_THE_SETUP_TEMPLATE`) | `45c471e` |
| v4 | #59 | run (abortado) | lacuna de observação da receita: só uma página de `factory list`; Trabalho cancelado pelo produto | `8f46b03` |
| v5 | #60 | review (abortado) | lacuna de observação: `show` omitia Perguntas; nova Pergunta de re-waiver não roteirizada | `ed4d592` (uma Pergunta de re-waiver tolerada; leitura por id) |
| v6 | #62 | review | `publication-not-publishable`: o Spec tratou de forma não determinística um achado já satisfeito | `82d6faf`, `factory-skills-v7` (achado já satisfeito = não adotado), release `mvp-34.4` (`e18924e`) |
| v7 | #64 | repair (`question-unanswered`) | o Spec julgou o item 3 (linha do AGENTS.md) nos dois sentidos de v3 a v7 | `106e67a`: o operador removeu o item 3, e V-07.f foi adiada para uma execução dedicada |
| v8 | #66 | repair (`question-unanswered`) | Pergunta do Spec contrapondo o pedido do Ticket à mudança humana | `416f297`: pedidos de redação do operador no escopo; uma Pergunta desse tipo tolerada |

## R-CRASH-A `y5/q34-crash-a-v5` — V-07.b, V-12.c e V-12.d aprovadas (D-10)

Branch `run/crasha-v5` = `aff6197` + pin #50 #51. Raízes `cr4` (principal) e `ck4` (cache). O controlador foi morto com SIGKILL, com
agentes reais (`openai/gpt-6-luna`, `factory-skills-v6`). Resultados: [34-r-crash-a-v5-inspect.json](34-r-crash-a-v5-inspect.json) e
[34-r-crash-a-v5-driver.log](34-r-crash-a-v5-driver.log). As fases preflight, cache, sources, tool e inspect saíram com 0. O
`stop-environment` final ficou retido com `NOTHING_TO_STOP`, porque não havia o que parar; isso é teardown e não afeta a prova.
Veredito da receita: `inconclusive`, com 21/22 verificações verdadeiras e nenhuma falha.

| Corte | Verificações | Obrigação |
| --- | --- | --- |
| c1/c2 cache em preparo | `cacheCut`, `cacheReconciled` (`mutating` → `connectivity-verified`), `cachePreparationHeldNotAdopted` | V-12.d |
| s1/s2 antes de sources completo | `sourcesCut`, `sourcesInterrupted`, `channelLossReconciled`, `sourcesRecoveryReconciled`, `preservedNeverOverwritten`, `preservationCompleted` (`spec/v2` e `instructions/v2` complete) | V-07.b, V-12.d |
| Pergunta | `questionCut`, `singleQuestionComment` (1 comentário), `answerAcceptedOnce`; `answerDuringBoot` **false** | V-12.d |
| t1 ferramenta do Builder | `toolCut`, `toolCutReconciled`, `toolNeverFinishedNorReplayedBlindly` | V-12.c |
| h1 handoff de revisão | `handoffCut`, `handoffReconciled`, `opinionCarriedNotRerun` | V-12.c |
| f1 final | `finalCompleted`, `noPublication` (0 PRs), `budget` | V-12.c |

`ANSWER_NOT_OBSERVED_DURING_BOOT` é um limite da observação da receita, não da correção: a lacuna é de 7 s e o polling é grosso. A
resposta foi aceita uma vez e a retomada completou. Decisão do operador (D-10): aprovar as obrigações mapeadas.

### Histórico do R-CRASH-A (v2–v4 retidos)

| Versão | Parou em | Causa | Correção |
| --- | --- | --- | --- |
| v2 | sources (`CUT_NOT_REACHED`) | a receita congelou o sobrevivente com `systemctl --user freeze`, e o systemd 262 recusa parar uma unit congelada ("Cannot stop frozen unit"); o produto respondeu corretamente `ENVIRONMENT_STOP_UNCONFIRMED` e reteve a Execução | `d26baa6`: SIGSTOP, nunca freeze de cgroup |
| v3 | preflight | corrida na listagem de labels no driver do supervisor (a listagem viu só #50) | `a7e80ad`: espera limitada da listagem |
| v4 | sources (`CUT_NOT_REACHED`) | a parada forçada do sobrevivente pausado levou ao check forçado do disco (D-06): `PRESERVED_DISK_CHECK_REQUIRED` com erros de ext4 no `root.qcow2`, sem reuso silencioso | `169176c`: SIGCONT do sobrevivente antes do próximo dono; parada forçada retida como D-06 |

## R-GH-CHECKS `y5/q34-ghchecks-v2..v4` — parcial (decisão do operador 2026-11-17): V-08.f aprovada

Totais: 83/0/17/12 → **84/0/16/12**. O operador decidiu registrar o grupo como **parcial** e cobrir o restante com um desenho menor,
`R-GH-CHECKS-S` (receita `test/entrypoints/ghchecks34s-qualification.ts`, namespace `q34-ghchecks-s-v1`, não executado).

**v2** (`run/ghchecks-v2` = `8fdc303`, issues #75/#76, check obrigatório real `factory-gate` do GitHub Actions no ruleset 26435808). Veredito salvo com
uma verificação corrigida offline: [34-r-ghchecks-v2-verdict.json](34-r-ghchecks-v2-verdict.json).

- **V-08.f aprovada.** O Builder declarou o gate `waived` com autorização preserved-source do Ticket e `requiredCheck: factory-gate`. A
  verificação ficou `not-verified` com `WAIVER_CANNOT_BYPASS_REQUIRED_CHECK:factory-gate`; não houve publicação nem PR.
- **V-10.b, metade do check falho:** o primeiro head H1 falhou `factory-gate`. O resultado foi UMA correção `REQUIRED_CHECK_FAILED:factory-gate@H1`, com
  evidência, cobrada, e o reparo publicado como H2 no MESMO PR. O inspect original marcou `failing.repair` como não atendido por um erro da receita: esperava o
  prefixo `check_run:`, mas o Control registra `check-run:<nome>:failure:<url>` (corrigido em `494ee3a`). A mesma verificação, refeita sobre o resultado salvo,
  dá `met`.
- **V-09.c, parte do head atual:** waiting → failing em H1 e waiting → satisfied em H2; o resultado do head antigo nunca foi emprestado.
- `strict` ficou retido com `UNSCRIPTED_QUESTION`: a revisão Spec apontou a linha exigida pelo check entre o parágrafo e `## Steps`. As fases
  seguintes não rodaram. `no-bypass` e `no-token` atendidos.

**v3** (`414b704`, #86/#87): o Ticket dizia que o conteúdo exigido por um check obrigatório estava no escopo. O Builder leu `ci/factory-gate.sh`
e o primeiro head já passou, então a falha exigida por V-10.b não ocorreu. A fase foi interrompida; o inspect ficou retido (cópia da chave
deixada pela fase morta) e o teardown foi feito à mão. Correções em `fee973e`.

**v4** (`5cce049`, #96/#97): H1 falhou e a correção abriu. A Pergunta tolerada (marcador versus achado S1 da Spec) foi respondida e a mesma Execução foi retomada,
com conteúdo inalterado e rodada 5 limpa. O Builder declarou S1 `fixed` sem mudar o conteúdo; a verificação recusou com `FIX_NOT_REVIEWED:4/spec/S1`
(`src/control/rules/review.ts:302-303`), exatamente como o skill v7 manda (`assets/skill-pack/factory-skills-v7/skills/implement/SKILL.md:93-97`:
conteúdo inalterado → `not-adopted`). Não é defeito do produto: é um desvio do Builder (modelo). A receita não registrou `holdReason`
(lacuna corrigida em `7da7c02`). Teardown e restauração ok.

**Por que parcial.** As fases strict…homonym só eram alcançáveis depois de dois reparos guiados pelo modelo terminarem publicáveis. Em quatro
execuções, isso quebrou em três pontos diferentes. O `R-GH-CHECKS-S` cobre o restante sem cadeia de reparos:

- V-09.c e V-09.f: leituras GET-only de um PR de sonda do operador, sem Trabalho da Factory (a classificação dos checks não depende de propriedade).
- V-09.e e a metade strict de V-10.b: UM Trabalho cujo head passa um check sempre verde; depois ready da Factory, strict, UM reparo com volta a
  draft e ready, e draft humano respeitado.

## R-GH-CHECKS-S `y5/q34-ghchecks-s-v1` — V-09.c, V-09.e, V-09.f e V-10.b aprovadas; R-GH-CHECKS completo

Totais: 84/0/16/12 → 88/0/12/12 (antes do registro do R-GH-ADV abaixo). `run/ghchecks-s` = `c63a613` (pin #108). As 12 verificações deram
`met`. O veredito foi copiado sem alteração em [34-r-ghchecks-s-v1-verdict.json](34-r-ghchecks-s-v1-verdict.json), a partir de
`y5/q34-ghchecks-s-v1/inspect-result.json`.

- **V-09.c:** no primeiro head do PR da Factory, `factory-gate` foi de waiting a satisfied, sem usar o head antigo. O rerun ficou pendente e nunca foi
  coberto pelo verde anterior. Um check skipped satisfaz. Um check ausente dá `REQUIRED_CHECK_ABSENT`. O strict foi lido do ruleset. O homônimo de outra
  origem (status do operador) ficou só visível. Junto com v2 (waiting → failing/satisfied, App 15368), a obrigação está completa.
- **V-09.e:** ready da Factory com checks satisfeitos; a perda da condição sob strict levou a `convert-to-draft` e houve `mark-ready` depois do
  reparo. O draft humano foi registrado e respeitado: nenhuma conversão, correção ou ativação.
- **V-09.f:** o requisito `factory-gate@15368` foi acumulado da proteção clássica e do ruleset 26435808. `lock_branch` e assinaturas
  clássicos foram lidos como bloqueio de merge (outcome `blocked`).
- **V-10.b, metade strict:** UMA correção `STRICT_UPDATE_REQUIRED` contra a base avançada, publicada, e H2 contém a base. A metade do check falho
  veio do v2.
- `no-bypass`: o PR nunca foi mergeado, todo push teve lease e só o arquivo do Ticket mudou. `no-token` atendido.

## R-GH-ADV `y5/q34-ghadv-v1..v5` — parcial (decisão do operador 2026-11-18): V-04.b, V-04.d, V-10.f e V-11.c aprovadas

Totais: 88/0/12/12 → **92/0/8/12**. Decisão do operador: "Partial + smaller recipe". V-04.e, V-10.g e V-13.g passam ao `R-GH-ADV-S`
(receita `test/entrypoints/ghadvs34-qualification.ts`, namespace `q34-ghadv-s-v2`; o v1, #119, ficou retido no publish-c com `EXECUTION_HELD:START_INSUFFICIENT_MEMORY_FOR_BOOT`: o host estava ocupado e o produto recusou o boot corretamente). O melhor ensaio por obrigação é o v4
(`run/ghadv-v4` = `6bf5e9d`, issues #101–#103, com o ticket 43). O veredito, copiado sem alteração, está em
[34-r-ghadv-v4-verdict.json](34-r-ghadv-v4-verdict.json): V-04.b, V-04.d, V-10.f e V-11.c `true`, mais `leased-pushes-only` e `no-secret`.

- **V-04.b:** PR #104 do operador em `factory/101-foreign` com "Closes #101". O Ticket foi retido `FOREIGN_PULL_REQUEST` nomeando o PR e nunca foi
  adotado: nenhum Trabalho, prepare ou ativação. A retenção seguia até a última fase. Igual em v1–v4.
- **V-04.d:** fechar a issue com Trabalho vigente levou a `AUTHORIZATION_WITHDRAWN` (`TICKET_NOT_OPEN`). Reabrir só registrou a restauração. Não houve
  prepare nem ativação, mesmo com a resposta já aceita; só o `resume` explícito continuou. Igual em v1–v4.
- **V-11.c:** resposta e `/factory repair` de `github-actions[bot]` (workflow por push numa branch órfã) ficaram `AUTHOR_IS_BOT`. Uma resposta
  de conta User não configurada como operador ficou `AUTHOR_NOT_OPERATOR`. A prosa não concedeu nada. Resposta vazia e id inválido foram recusados, a
  resposta repetida foi ignorada e a resposta aceita é a do operador. Igual em v1–v4. **Limite registrado:** sem segunda conta humana, o terceiro humano
  é a conta do operador fora da configuração (operador sentinela); uma identidade humana distinta não foi exercitada.
- **V-10.f:** o commit humano `1c48ad1` na branch da Factory gerou a sequência divergência → `incorporate` → reconciliação, publicada com lease
  nessa ponta. Depois, o conflito add/add na base abriu a correção `MERGE_CONFLICT` com `humanTips [1c48ad1]`. A base foi **mergeada** (um commit de
  merge com 2 pais), nunca rebase, e a base e o commit humano são ancestrais do head reparado.
- **V-10.g (aprovada por D-11, 2026-11-18):** no merge-repair do v4, o operador mergeou o PR #105 às 23:55:34Z (horário do GitHub), durante o reparo
  `4cd050ae` (23:55:15–23:56:40), e nenhuma publicação veio depois. A Factory só confirmou a entrega às 23:56:50, depois do fim da atividade
  (`duringActivity` null). Decisão do operador: "merge com horário do GitHub dentro da correção e nenhuma publicação depois" é suficiente.
  Totais 92/0/8/12 → **93/0/7/12**; o `R-GH-ADV-S` segue com V-04.e e V-13.g (as verificações de V-10.g da receita ficam como evidência extra).

| Ensaio | Pin | Onde parou | Causa | Correção |
| --- | --- | --- | --- | --- |
| v1 | `d334d8b` | human-commit | lacuna da receita: o settle aceitou "pedido registrado" 6 s depois do passo 11, antes de a Factory abrir a correção | `bf2fdea` |
| v2 | `724fbd9` | human-commit | **defeito do produto (ticket 43):** em toda rodada da reconciliação o Standards esgotou as 24 requisições (`WORKER_INTERRUPTED`). Faltava o patch próprio a julgar (só havia o diff relativo à base, com o commit humano); o Builder perguntou ao operador | `9c3416d` (receita); produto em `6c4a9e0` |
| v3 | `763e1bf` | human-commit | mesma causa: a reconciliação falhou (`RECONCILIATION_FAILED`, `REVIEW_NOT_VERIFIED`) | `6c4a9e0`: a revisão de reconciliação julga `own.patch` (ponta autorizada..HEAD); validado em v4 (human-commit passou) |
| v4 | `6bf5e9d` | close | Pergunta não roteirizada: a Spec apontou como não autorizada a linha pedida pelo `/factory repair` do passo 17 (o mesmo padrão do R-CAND v8) | `87e8ef6`: pedidos de reparo no escopo, UMA resposta tolerada, `holdReason` |
| v5 | `4277f97` | resume | Pergunta não roteirizada (manter todas as linhas existentes × texto da base em conflito): variação do modelo, porque o v4 passou o resume | decisão do operador: parcial + `R-GH-ADV-S` |

## R-GH-ADV-S `y5/q34-ghadv-s-v2` — V-13.g aprovada; V-04.e aprovada por evidência (D-12); R-GH-ADV completo

Totais: 93/0/7/12 → **95/0/5/12**. `run/ghadv` = `5ad0cf7` (pin #120). Todas as fases saíram com 0 (preflight, publish-c, close,
cancel-merge, inspect) e os passos 1–5 também. O ruleset ficou idêntico, nada ficou com label e a branch `factory/120-78a90030` foi mantida. O veredito,
copiado sem alteração, está em [34-r-ghadv-s-v2-verdict.json](34-r-ghadv-s-v2-verdict.json). O v1 (#119, `9be330d`) ficou retido no publish-c com
`EXECUTION_HELD:START_INSUFFICIENT_MEMORY_FOR_BOOT`: o host estava ocupado, o produto recusou o boot corretamente e o erro foi de agendamento.

- **V-13.g (veredito automático met):** `factory cancel` pela CLI durante o reparo na VM, com o merge do operador logo depois. Ordem cancel-first:
  o cancelamento ficou registrado no reparo (`WORK_CANCELLED`, cessação confirmada, Slot liberado) e o merge seguinte ainda entregou.
- **V-04.e (aprovada por evidência, D-12):** o operador fechou o PR #121 sem merge às 08:57:59Z, durante o reparo `0b523339`
  (`pull-request-closed-unmerged` com `:active:`). A atividade não foi interrompida e terminou sozinha às 09:00:20 (`completed`, cessação
  confirmada, Slot liberado às 09:00:22). Não houve entrega nem cancelamento, e nada foi publicado depois (só `builder-start`; nenhum
  `builder-publication`). O verificador da receita deu `false` só porque contou 3 `activity-aborted` às 09:02:05.324Z. Esses eventos são o desligamento do dono
  pela própria receita no fim da janela de silêncio (`close-cessation.json` 09:02:05.390Z), depois do fim do reparo. A verificação passou a contar
  só interrupções antes de `end.at` da Execução fechada, com teste dos tempos do v2, nas receitas `ghadvs34` e `ghadv34`.
- V-10.g (já aprovada por D-11): aqui o merge às 09:06:00Z veio depois do fim do reparo (09:05:56.838Z), e `duringActivity` ficou null.
- `leased-pushes-only` e `no-secret` atendidos.

## Pendências deste registro

- Novo ticket para o flake `test/records/raw.test.ts` sob carga de VM:
  [42](../../.scratch/software-factory-mvp/issues/42-records-raw-test-flake-under-load.md).
- G4 e G5 continuam bloqueados. As obrigações restantes estão em `R-LONG`, `R-THREE`, `R-REL` (V-16.b) e
  `R-INSTR`.
- Ticket 43 (revisão de reconciliação) resolvido em `6c4a9e0` e validado em `q34-ghadv-v4`:
  [43](../../.scratch/software-factory-mvp/issues/43-reconciliation-review-own-patch.md). Este resultado continua liberando no máximo a preparação da solicitação de autorização do piloto (35).
