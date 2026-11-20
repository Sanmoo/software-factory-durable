# 56: Handoff aceita declaração de gate que contradiz a execução observada

**What to build:** no piloto 2, o #125 foi recusado na publicação com `REVIEW_NOT_VERIFIED, GATE_FAILED:check-acceptance`, embora o código
estivesse revisado (Standards e Spec limpos) e o gate tivesse passado. A última execução **exata** do comando documentado (04:08) falhou.
Depois o Builder corrigiu o código e só rodou o gate dentro de comandos compostos (`git add && git commit && ./gradlew …`,
`git status && git log && ./gradlew check acceptanceTest`), que passaram. Em três handoffs ele declarou `status: run`, "passed". O Host
mantém o último resultado exato (correto pela regra), mas o handoff não avisa o Builder de que a declaração contradiz o que o Host observou.
O Builder termina achando que entregou, e o Trabalho fica `not-publishable` sem nenhum próximo passo.

**Blocked by:** —

**Type:** task

**Status:** resolved

## Acceptance criteria

- [ ] O handoff recusa (erro do tool, com motivo) uma declaração de gate `run`/passed quando a última execução exata observada falhou ou não
  existe, e diz qual comando rodar sozinho.
- [ ] O pacote de skills manda rodar o gate exato, sozinho, como último comando antes do handoff (nunca dentro de comando composto).
- [ ] Teste: declaração "passed" com última execução exata falha → handoff recusado; depois de uma execução exata verde → aceito.

## Comments

- Evidência: `/home/sanmoo/software-factory-test/pl2-pilot-evidence/findings.md` item 9; sessão do Builder
  `pl2/r/Jq2-y9vsSneRiSjwO4r2Ng/w-hjE27a/`.

## Answer

- **Handoff** (`src/workers/builder-handoff.ts`, ledger `lastExact` em `src/workers/gates.ts`, commit 31e4ccd): para cada gate declarado
  `run`, o Host procura a ÚLTIMA chamada bash de EXATAMENTE aquele comando (a mesma que `resolve` vincula ao gate; rodar dentro de comando
  composto continua não valendo). Recusa no tool, sem gastar rodada nem suspender as ferramentas:
  - `HANDOFF_GATE_NOT_RUN` quando não existe chamada exata (nunca rodou, ou só embutido): `<id>: run exactly this command ALONE as its own
    bash call, then hand off again: <comando>`. Antes, um gate `run` nunca executado era aceito e terminava `unverified` depois de uma rodada.
  - `HANDOFF_GATE_FAILED` quando a última chamada exata saiu ≠ 0 ou perdeu o exit code: `<id>: your last bash call of exactly this command
    failed (exit N); run it ALONE as its own bash call, as your last command, then hand off again: <comando>`, com a orientação de corrigir a
    proposta ou, se a falha não tiver solução, declarar `not-run` com o motivo e perguntar ao operador.
- **Inalterado:** `not-run`/`waived` continuam declaráveis (o Control os fecha depois); ledger esgotado não recusa (o gate já termina
  `GATE_LEDGER_EXHAUSTED`); a verificação de atualidade por conteúdo (`GATE_NOT_CURRENT` etc.) continua na resolução após a captura, não aqui.
- **Skills** (commit 1c597c1): pacote novo `factory-skills-v11` = v10 + `implement` §3 "Run each gate exactly, alone, last" (comando exato
  sozinho, como último comando antes do handoff, nunca em comando composto; o handoff recusa `run` cuja última execução exata falhou ou não
  existe). v1–v10 inalterados; o release escolhe v11 (último pacote com continuação).
- **Testes:** `test/workers/handoff-gate-observed.test.ts` (cenário do #125: exata falhou + verdes compostas → recusado; sem execução exata →
  recusado; exata verde depois → aceito; só a última exata conta; exit perdido; `not-run` e ledger esgotado inalterados) e
  `test/workers/skill-pack-v11.test.ts`; ajustados `handoff-gate-documented`, `handoff-treatments` e `review-rounds-session` à nova regra.
