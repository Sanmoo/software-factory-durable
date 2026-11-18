# 43: A revisão de uma reconciliação julga o patch próprio do Builder (ponta humana autorizada..HEAD)

**What to build:** nos ensaios R-GH-ADV v2 e v3 (ticket 34) o reviewer Standards de TODAS as rodadas de uma reconciliação autorizada por
`incorporate` (v2 r7–r9, v3 r7–r10: 7 de 7) esgotou o orçamento de 24 requisições do reviewer (`WORKER_QUALIFICATION_CLOSED` →
`WORKER_INTERRUPTED`), relendo os mesmos 6–8 arquivos, sobretudo `docs/FACTORY_ADVERSE.md` e o arquivo humano `docs/FACTORY_ADVERSE_HUMAN.md`.
Nas revisões de implementação e reparo o mesmo reviewer concluiu com 5–21 requisições. O prompt da reconciliação dizia "julgue só as mudanças
do Builder por cima dos commits autorizados" (`src/control/rules/review.ts`, nota de mudanças preservadas), mas a captura só entregava o
patch relativo à base (`src/workers/handoff.ts`, `git diff base HEAD`), que inclui o commit humano, e exigia o arquivo humano como entrada a
ler. Com só a ferramenta read, o reviewer não tinha como separar o trabalho próprio. A verificação recusou a revisão
(`STANDARDS_OPINION_MISSING`, `REVIEW_INCOMPLETE`): no v2 o Builder perguntou ao operador, no v3 a reconciliação falhou
(`RECONCILIATION_FAILED`) e nada foi publicado.

Decisão do operador (2026-11-17): corrigir o produto e rodar o v4. O orçamento do reviewer fica em 24.

**Blocked by:** —

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] A captura de uma reconciliação (com `preserve` ancestral de HEAD) escreve `own.patch` = `git diff <ponta autorizada> HEAD` e lista em
  `ownChanged` só os arquivos presentes alterados desde essa ponta ou na árvore de trabalho; sem ancestral, nada disso é oferecido, e o parse
  recusa listagem própria sem ancestral preservado (`test/workers/handoff-capture.test.ts`).
- [x] Os reviewers de uma reconciliação recebem `own.patch` como assunto da revisão ("Review subject") e os arquivos próprios como entradas
  obrigatórias. O `committed.patch` relativo à base é rotulado CONTEXT ONLY, e o arquivo humano nunca é uma mudança obrigatória a julgar
  (regressão em `test/control/divergence-rules.test.ts`). Capturas antigas, sem `own`, e revisões fora de reconciliação ficam inalteradas.
- [x] Orçamento do reviewer inalterado (24 requisições).
- [x] Divergência de versão de instruções (v2 × v3) investigada: NÃO confirmada. Em cada ensaio, o reparo e a reconciliação usaram a mesma
  versão (v2: v3/v3; v3: v2/v2). A comparação inicial misturava ensaios diferentes, então nada foi alterado.
- [x] Prova real: R-GH-ADV v4 (`q34-ghadv-v4`): human-commit passou; a reconciliação foi publicada com lease na ponta humana e o V-10.f foi aprovado.

## Comments

- Evidência: `y5/q34-ghadv-v2/` e `y5/q34-ghadv-v3/` (human-commit-result.json), sessões dos reviewers em
  `y5/r/T_4gPIBJSyyyCiHwAEu9Xw/` (v2) e `y5/r/V6TdMlf8QoK_Tc3K_SwOGQ/` (v3).
