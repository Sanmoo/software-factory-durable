# 40: Guardas de orçamento no lugar dos timers fixos restantes de `fast`/`ci`

**What to build:** Trocar os ~110 `timeout:` fixos restantes em testes de `fast`/`ci` (`test()`, `spawnSync`, `fork`). Os maiores são `controller-ownership` 17, `protocol` 8, `upgrade` 7, `review-session` 7 e `sandbox-adapter-diagnostics` 5; o resto está quase todo em `workers/*-process` e `native-*`. Trocar também os ~25 laços de espera com contagem fixa (`for (let i = 0; i < 400/600/800/1500/2000 …)` em `control/*-flow`, `upgrade-fixture`, `*-cli`, `github-readiness-composed`, `review28-*`, `recovery-crash`). O substituto é o guarda do ticket 37 (`test/runner/budget.ts`): `ended()` para filhos (spawn destacado, evento de fim, árvore morta, etapa nomeada), `until()` para condições sem evento e `remainingMs()` onde um `spawnSync` continuar.

Por quê: é a mesma classe de flake que o ticket 37 corrigiu. Sob carga 15-20 de outras sessões, já estouraram naquela onda `worker-process` (30 s), `public-bash-copy` (15 s), `normal-edit` (15 s), `github-checks-composed` (800 × 10 ms) e `publication-composition` (600 × 10 ms). Origem: texto proposto no `## Comments` do [ticket 37](37-targeted-test-suite-optimizations.md).

**Blocked by:** [37: Otimizações dirigidas da suíte de testes](37-targeted-test-suite-optimizations.md)

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Nenhum `timeout:` numérico nem laço de espera com contagem fixa em `test/**` fora das receitas `*-qualification`, garantido por um teste estático.
- [ ] Os substitutos usam o guarda de `test/runner/budget.ts` (`ended()`, `until()`, `remainingMs()`), derivado de `FACTORY_TEST_DEADLINE`; ao estourar, o teste falha nomeando a etapa e mata a árvore de processos.
- [ ] Nenhuma cobertura removida: as mesmas asserções continuam em cada teste alterado.
- [ ] `npm run test:ci` verde três vezes seguidas com carga ≥ 12; tempos e carga registrados no ticket.

## Autorização e limites

Sem rede, GitHub, VM, modelo ou credenciais. Nunca usar `$HOME/software-factory-test`. Remoção ou fusão de teste depende de aprovação do operador (regra do ticket 37).
