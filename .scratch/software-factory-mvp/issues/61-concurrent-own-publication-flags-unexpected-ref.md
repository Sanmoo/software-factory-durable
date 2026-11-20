# 61: Publicação concorrente de outro Trabalho bloqueia como mudança inesperada de ref

**What to build:** no piloto 2 (janela 2, concorrência 2), a publicação do #124 (Work `2dd8c691`) foi bloqueada às 13:24:02 UTC com
`UNEXPECTED_REF_CHANGE:refs/heads/factory/125-f4f421b6` e `GUEST_EFFECT_OUT_OF_SCOPE`. O retrato `refsBefore` foi tirado no pedido (13:12:04),
e a sessão de publicação rodou às 13:22. Entre os dois, o #125 (Work `f4f421b6`) publicou a PRÓPRIA branch no head verificado dele
(`c40fe48`, PR #130). A branch do #124 está no head verificado dele (`b3716af`, PR #131 rascunho). `unexpectedRefChanges`
(`src/control/rules/publication.ts`) só exclui a branch do próprio Trabalho, então qualquer publicação concorrente bloqueia a outra. Não há
comando de operador para reavaliar o bloqueio.

**Blocked by:** —

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Uma ref que é a branch própria de OUTRO Trabalho desta instalação, que apareceu ou mudou para um head que o Control registrou para a
  publicação desse Trabalho (pedido/tentativa), não conta como mudança inesperada. Qualquer outra mudança (outra ref, outro head, branch
  própria de outro Trabalho em head não registrado, remoção) continua bloqueando.
- [ ] O motivo do bloqueio continua explícito e a regra de defesa (Contents W é do repositório todo) não é enfraquecida.
- [ ] Uma publicação já bloqueada SÓ por esse falso positivo pode ser reavaliada por um comando explícito do operador, com motivo, que relê
  o remoto e reaplica a regra corrigida (sem repetir a publicação, sem adotar nada que a regra não aceite).
- [ ] Testes: duas publicações concorrentes → nenhuma bloqueia; branch de outro Trabalho em head não registrado → bloqueia; reavaliação do
  caso do piloto → aceita; reavaliação com outra mudança real → continua bloqueada.

## Comments

- Evidência: `/home/sanmoo/software-factory-test/pl2-pilot-evidence/show-124-w2.json` (`publication.refsBefore`, `reasons`); PRs #130 e #131.
