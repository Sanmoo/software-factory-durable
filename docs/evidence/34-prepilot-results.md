# Evidência 34 / ensaios pré-piloto: R-INSPECT, R-GH-DEP, R-CAND e R-CRASH-A

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

## Pendências deste registro

- Novo ticket para o flake `test/records/raw.test.ts` sob carga de VM:
  [42](../../.scratch/software-factory-mvp/issues/42-records-raw-test-flake-under-load.md).
- G4 e G5 continuam bloqueados. As obrigações restantes estão em `R-GH-CHECKS`, `R-GH-ADV`, `R-LONG`, `R-THREE`, `R-REL` (V-16.b) e
  `R-INSTR`. Este resultado continua liberando no máximo a preparação da solicitação de autorização do piloto (35).
