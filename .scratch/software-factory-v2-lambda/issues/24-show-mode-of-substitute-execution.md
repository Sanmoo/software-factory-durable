# 24: `show` informa o modo correto de uma Execução substituta

**What to build:** Depois de três recusas do portão, o boot foi encerrado como perda e a substituta consumiu um orçamento de recuperação, mas `show.execution.mode` exibiu `initial`. O modo exibido passa a refletir que a Execução é uma recuperação.

Origem: [Aceite da v2 no perfil Lambda](16-v2-acceptance-on-lambda-profile.md), campanha de 2026-11-21 e 22. Os caminhos de evidência são relativos ao diretório local da campanha.

**Blocked by:** nenhum

**Type:** task

**Status:** migrado para [#29](https://github.com/Sanmoo/software-factory-durable/issues/29) em 2026-11-22; a issue é a versão canônica.
## Observed

- Ticket #33 do repositório de apoio (Trabalho `67f6c34e`): `budget-consumed recoveries` às 09:41:43 UTC e `mode: initial` no `show`.
- Evidência: `final-works/67f6c34e-f14e-4c99-a5b3-66e700aade5e.show.json`, `final-works/67f6c34e-f14e-4c99-a5b3-66e700aade5e.history.json`.

## Why it matters

O CLI contradiz o histórico; quem lê o `show` não vê que houve perda e substituição.

## Acceptance criteria

- [ ] Execução iniciada por `recovery-requested` aparece com modo de recuperação no `show`.
- [ ] Teste de regra cobrindo a substituta que espera uma Pergunta pendente antes de iniciar (o caso observado).
