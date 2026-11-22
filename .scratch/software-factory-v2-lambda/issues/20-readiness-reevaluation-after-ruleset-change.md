# 20: Prontidão reavaliada depois que a regra de merge muda (A16)

**What to build:** Um PR vinculado fica `not-ready` com `MERGE_BLOCKED_UPDATE_RESTRICTED` enquanto o ruleset restringe o merge. Removida a regra, nada dispara a reavaliação: o PR continua em rascunho até uma releitura completa. A prontidão passa a ser reavaliada em prazo curto e conhecido depois de um bloqueio por regra de merge.

Origem: [Aceite da v2 no perfil Lambda](16-v2-acceptance-on-lambda-profile.md), campanha de 2026-11-21 e 22. Os caminhos de evidência são relativos ao diretório local da campanha.

**Blocked by:** nenhum

**Type:** task

**Status:** migrado para [#25](https://github.com/Sanmoo/software-factory-durable/issues/25) em 2026-11-22; a issue é a versão canônica.
## Observed

- Repositório real, PRs #136 e #137: regra `update` removida às 12:44 UTC; em cerca de 3 minutos nenhuma reavaliação; o humano marcou como pronto (`readiness-human-flag ready-not-placed-by-factory`) e mesclou.
- Na janela 1 (PR #134) a conversão para pronto veio só 10 minutos depois do ajuste do ruleset.
- Evidência: `final-works/9436bb22-344b-4a10-be99-7f68e28a8f2e.history.json`, `final-works/efc54451-96d5-4fce-9fda-fea0091a04b8.history.json`, `final-works/a23f433b-2e61-4e36-a1cc-770757201a19.history.json` (23:43 → 23:53 UTC).

## Why it matters

O merge humano espera por um passo que a Factory deveria dar sozinha; o Operador acaba marcando o PR como pronto à mão.

## Acceptance criteria

- [ ] Com a prontidão bloqueada por regra de merge, a Factory relê a regra em intervalo documentado, menor que a releitura completa.
- [ ] Removida a regra, o PR é convertido para pronto pela Factory dentro desse intervalo, sem comando.
- [ ] O `show` informa quando será a próxima reavaliação.
