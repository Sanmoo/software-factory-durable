# 0003. Mudanças entram em `main` só por pull request, com rebase-merge feito por humano

Status: aceita (migração do tracker para GitHub Issues, 2026-11-22).

**Contexto.** Até aqui o agente integrava o trabalho em `main` por fast-forward e fazia push sem pedir confirmação, sem PR e sem proteção de branch. O tracker passou a ser o GitHub Issues, e o mantenedor quer revisar cada mudança antes de ela entrar. Os PRs são abertos pela conta do mantenedor, e o GitHub não aceita a aprovação do próprio autor. A validação por mudança continua local (ADR 0001).

**Decisão.** Um ruleset sem bypass em `main` exige pull request, o check `offline-checks` e proíbe push direto, push forçado e exclusão. O único método de merge é rebase-merge, e a branch é apagada depois dele. São exigidas zero aprovações: o review humano é garantido pela regra de que agente nunca faz merge. A branch não precisa estar atualizada com `main`: sem conflito com a base, não há rebase. Com rebase, o agente roda `npm run test:ci` de novo e faz `git push --force-with-lease` só na branch de trabalho. Provas e evidências não citam SHA de commit deste repositório; a referência é a issue ou o PR (`#n`).

**Razão.** Exigir uma aprovação travaria o próprio mantenedor, e mover `npm run test:ci` para o CI tem o custo descrito no ADR 0001. O rebase-merge recria os commits em `main`, então nenhum SHA da branch sobrevive à integração; citar um SHA deixaria de identificar o que foi integrado. Exigir branch atualizada obrigaria um rebase e uma nova validação a cada avanço de `main`, sem proteção proporcional quando não há conflito.
