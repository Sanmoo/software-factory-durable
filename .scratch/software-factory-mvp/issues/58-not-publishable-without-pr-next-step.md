# 58: Trabalho `not-publishable` sem PR fica sem próximo passo

**What to build:** com a publicação recusada (`not-publishable`) e sem PR próprio, o #125 ficou com dispatch `executing`, sem impedimento,
sem slot e sem próximo passo em `status`/`show`. `factory repair` foi recusado (`REPAIR_REQUIRES_OWN_PULL_REQUEST`), e só o texto da recusa
indicava `update-scope`, mesmo sem nenhuma mudança de escopo. O operador precisa ver o motivo da recusa e um caminho direto para "uma ativação
a mais com esta instrução".

**Blocked by:** —

**Type:** task

**Status:** migrado para [#20](https://github.com/Sanmoo/software-factory-durable/issues/20) em 2026-11-22; a issue é a versão canônica.
## Acceptance criteria

- [ ] `not-publishable` aparece como impedimento do Trabalho, com os motivos e o próximo passo.
- [ ] Existe um comando do operador para reativar o Builder com instrução sem PR publicado (`repair` aceito nesse estado, ou comando próprio),
  sem fingir mudança de escopo.
- [ ] Teste de fluxo: `not-publishable` → instrução do operador → nova ativação.

## Comments

- Evidência: `/home/sanmoo/software-factory-test/pl2-pilot-evidence/findings.md` itens 9 e 11.
