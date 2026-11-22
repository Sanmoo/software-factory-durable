# 17: Handoff de revisão com a lista de commits (A10)

**What to build:** Os revisores recebem só o diff agregado da branch. Um requisito de processo do Ticket, como "um commit por passo", não é verificável por eles. O handoff de revisão passa a incluir a lista de commits da branch (hash curto, assunto, arquivos tocados) desde o commit de partida.

Origem: [Aceite da v2 no perfil Lambda](16-v2-acceptance-on-lambda-profile.md), campanha de 2026-11-21 e 22. Os caminhos de evidência são relativos ao diretório local da campanha.

**Blocked by:** nenhum

**Type:** task

**Status:** migrado para [#22](https://github.com/Sanmoo/software-factory-durable/issues/22) em 2026-11-22; a issue é a versão canônica.
## Observed

- Ticket #10 do repositório de apoio (Trabalho `0e0d892b`): 13 commits na branch; os dois revisores apontaram "um commit só / log feito à mão", o que era falso. O Builder não acolheu os achados sem autorização e a publicação ficou `not-publishable` (`REQUIREMENT_NON_ADOPTION_NOT_AUTHORIZED:1/spec/S1`).
- Evidência: `wf5/history.json` (03:45–03:47 UTC), `wf5/show.json`; registro corrido, janela 4.

## Why it matters

Um achado falso de revisão trava a publicação e só sai com comando do Operador. Não é efeito do perfil Lambda: vale para qualquer sandbox.

## Acceptance criteria

- [ ] O handoff de revisão traz a lista de commits da branch do Trabalho desde o commit de partida.
- [ ] Um revisor consegue confirmar ou negar "um commit por passo" só com o handoff, em teste automatizado.
- [ ] O limite de tamanho do handoff continua respeitado com branches longas (lista truncada de forma declarada).
