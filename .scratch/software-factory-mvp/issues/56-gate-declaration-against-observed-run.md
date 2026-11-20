# 56: Handoff aceita declaração de gate que contradiz a execução observada

**What to build:** no piloto 2, o #125 foi recusado na publicação com `REVIEW_NOT_VERIFIED, GATE_FAILED:check-acceptance`, embora o código
estivesse revisado (Standards e Spec limpos) e o gate tivesse passado. A última execução **exata** do comando documentado (04:08) falhou.
Depois o Builder corrigiu o código e só rodou o gate dentro de comandos compostos (`git add && git commit && ./gradlew …`,
`git status && git log && ./gradlew check acceptanceTest`), que passaram. Em três handoffs ele declarou `status: run`, "passed". O Host
mantém o último resultado exato (correto pela regra), mas o handoff não avisa o Builder de que a declaração contradiz o que o Host observou.
O Builder termina achando que entregou, e o Trabalho fica `not-publishable` sem nenhum próximo passo.

**Blocked by:** —

**Type:** task

**Status:** needs-triage

## Acceptance criteria

- [ ] O handoff recusa (erro do tool, com motivo) uma declaração de gate `run`/passed quando a última execução exata observada falhou ou não
  existe, e diz qual comando rodar sozinho.
- [ ] O pacote de skills manda rodar o gate exato, sozinho, como último comando antes do handoff (nunca dentro de comando composto).
- [ ] Teste: declaração "passed" com última execução exata falha → handoff recusado; depois de uma execução exata verde → aceito.

## Comments

- Evidência: `/home/sanmoo/software-factory-test/pl2-pilot-evidence/findings.md` item 9; sessão do Builder
  `pl2/r/Jq2-y9vsSneRiSjwO4r2Ng/w-hjE27a/`.
