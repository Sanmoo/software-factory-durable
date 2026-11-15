# 39: Tratar regras da base que impedem o merge como impedimento de prontidão

**What to build:** Os tickets 15 e 16 classificam as regras de ruleset `update` ("Restrict updates") e similares como `not-check-related` e declaram o PR pronto. No ensaio real de 2026-11-15, o PR #5 foi convertido para ready pela Factory, mas o GitHub recusou o merge humano com "Cannot update this protected ref": a regra `update` do ruleset `mastra-factory-proof-main-review` impede qualquer atualização da `main`, inclusive merge de PR, sem bypass. A Factory declarou prontidão sobre um caminho de merge que não existe sem bypass. Regras que bloqueiam o merge para quem não tem bypass devem virar impedimento explicado (nunca prontidão), sem que a Factory use ou sugira bypass.

**Blocked by:** —

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] A interpretação de modalidades do ticket 15 distingue regras que bloqueiam o merge de PR (ex.: `update` sem `update_allows_fetch_and_merge`, `merge_queue`, `required_deployments`, `required_signatures`, `required_linear_history` versus o método permitido, `pull_request` com requisitos não atendidos além da aprovação humana) das que não afetam o merge (`non_fast_forward`, `deletion`, `creation`), com fonte e motivo por regra; modalidade desconhecida continua indeterminada.
- [x] A prontidão do ticket 16 não converte para ready quando uma regra bloqueia o merge para quem não tem bypass; o Work mostra impedimento explicado com a regra, a fonte e o próximo passo do operador (ajustar a proteção), sem sugerir bypass.
- [x] Se o bloqueio aparecer depois de um ready posto pela Factory, aplica-se a regra de perda confirmada do ticket 16 (retira prontidão interna; volta a draft somente se for flag posta pela Factory).
- [x] O `mergeable_state: blocked` agregado continua não sendo lido como conflito nem como check falho; a decisão vem das regras lidas.
- [x] Testes com fixtures dos payloads reais de rules/branches (incluindo o ruleset 26435808 com `update`) e prova real de leitura (só GET) sobre um PR do repositório de teste.

## Referências e validação

- Evidência: `docs/evidence/16-evidence-based-readiness.md` e `docs/evidence/15-required-checks-evaluation.md` (modalidades interpretadas como `not-check-related`); ensaio real do ticket 17 bloqueado no merge humano.
- Spec §9.2/§9.3 (prontidão só com evidências atuais; bloqueios explicados).

## Autorização e limites

Ensaio real só de leitura exige autorização do operador. A Factory nunca usa nem sugere bypass, nunca aprova e nunca faz merge.

## Answer

Regras ativas da base agora têm interpretação de merge por regra (fonte + motivo): `update` (sempre, mesmo com
`update_allows_fetch_and_merge`, que só sincroniza fork), `merge_queue`, `required_deployments` com ambientes, `required_signatures`,
`required_linear_history` sem squash/rebase permitido e interseção vazia de `allowed_merge_methods` bloqueiam o merge humano → motivo
confirmado `MERGE_BLOCKED_<motivo>` na prontidão (nunca ready; após ready da Factory, perda confirmada volta a draft), com próximo passo
"ajustar a proteção" e nenhum bypass sugerido. `non_fast_forward`/`deletion`/`creation`/nomes não afetam; revisão é etapa humana; regras de
padrão de commit/arquivo e desconhecidas ficam indeterminadas. `mergeable_state` continua não lido. Gate `test:ci` verde. Ensaio real
`q39-mergeblock-v1` (só GET, 16 requisições): ruleset 26435808 lido com `update` classificado `merge-blocking UPDATE_RESTRICTED`. Decisões
do operador: `update` sempre bloqueia; tipos não avaliados → prontidão indeterminada. Evidência: `docs/evidence/39-merge-blocking-base-rules.md`.

## Comments

- 2026-11-15 (implementation, branch `implement/software-factory-mvp-39`): increment and read-only recipe; real run pending authorization.
- 2026-11-15: real run `q39-mergeblock-v1` passed (supervisor, operator-authorized); ticket resolved.
