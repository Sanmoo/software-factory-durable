# 22: Processo dono sem supervisão quando o lançador ou o supervisor morrem

**What to build:** Matar só o lançador `factory run` ou só o supervisor do controller não derruba a Factory: o processo dono segue respondendo `status`, agora sem supervisão. Investigar e decidir o comportamento esperado (o dono encerra de forma limpa, ou o estado sem supervisor fica visível e é reassumido).

Origem: [Aceite da v2 no perfil Lambda](16-v2-acceptance-on-lambda-profile.md), campanha de 2026-11-21 e 22. Os caminhos de evidência são relativos ao diretório local da campanha.

**Blocked by:** nenhum

**Type:** task

**Status:** migrado para [#27](https://github.com/Sanmoo/software-factory-durable/issues/27) em 2026-11-22; a issue é a versão canônica.
## Observed

- Janela 5, 04:37:35–04:38:29 UTC: `kill -KILL` em sequência no lançador, no supervisor e no dono. Depois dos dois primeiros o dono continuou respondendo; só o terceiro deixou `CONTROLLER_UNAVAILABLE`.
- Evidência: `lambda-acceptance-human-steps.log` (04:37:35, 04:37:58, 04:38:29); registro corrido, janela 5. Não investigado na campanha; fora da rubrica.

## Why it matters

Um dono órfão continua despachando sem quem o reinicie ou o pare; o Operador pode achar que parou a Factory.

## Acceptance criteria

- [ ] Está descrito o que acontece com o dono quando o lançador morre e quando o supervisor morre.
- [ ] O comportamento escolhido tem teste (fora do tier `fast`) com `SIGKILL` em cada um dos dois processos.
- [ ] `factory status` deixa visível um dono sem supervisão, se esse estado continuar possível.
