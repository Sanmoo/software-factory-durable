# 40: Guardas de orçamento no lugar dos timers fixos restantes de `fast`/`ci`

**What to build:** Trocar os ~110 `timeout:` fixos restantes em testes de `fast`/`ci` (`test()`, `spawnSync`, `fork`). Os maiores são `controller-ownership` 17, `protocol` 8, `upgrade` 7, `review-session` 7 e `sandbox-adapter-diagnostics` 5; o resto está quase todo em `workers/*-process` e `native-*`. Trocar também os ~25 laços de espera com contagem fixa (`for (let i = 0; i < 400/600/800/1500/2000 …)` em `control/*-flow`, `upgrade-fixture`, `*-cli`, `github-readiness-composed`, `review28-*`, `recovery-crash`). O substituto é o guarda do ticket 37 (`test/runner/budget.ts`): `ended()` para filhos (spawn destacado, evento de fim, árvore morta, etapa nomeada), `until()` para condições sem evento e `remainingMs()` onde um `spawnSync` continuar.

Por quê: é a mesma classe de flake que o ticket 37 corrigiu. Sob carga 15-20 de outras sessões, já estouraram naquela onda `worker-process` (30 s), `public-bash-copy` (15 s), `normal-edit` (15 s), `github-checks-composed` (800 × 10 ms) e `publication-composition` (600 × 10 ms). Origem: texto proposto no `## Comments` do [ticket 37](37-targeted-test-suite-optimizations.md).

**Blocked by:** [37: Otimizações dirigidas da suíte de testes](37-targeted-test-suite-optimizations.md)

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Nenhum `timeout:` numérico nem laço de espera com contagem fixa em `test/**` fora das receitas `*-qualification`, garantido por um teste estático.
- [x] Os substitutos usam o guarda de `test/runner/budget.ts` (`ended()`, `until()`, `remainingMs()`), derivado de `FACTORY_TEST_DEADLINE`; ao estourar, o teste falha nomeando a etapa e mata a árvore de processos.
- [x] Nenhuma cobertura removida: as mesmas asserções continuam em cada teste alterado.
- [x] `npm run test:ci` verde três vezes seguidas com carga ≥ 12; tempos e carga registrados no ticket.

## Autorização e limites

Sem rede, GitHub, VM, modelo ou credenciais. Nunca usar `$HOME/software-factory-test`. Remoção ou fusão de teste depende de aprovação do operador (regra do ticket 37).

## Answer

Resolvido em 2026-11-15.

**Troca.** 109 `timeout:` numéricos (`test()`, `spawnSync`, `execFile`, `execFileSync`) viraram `remainingMs()`.
38 laços de espera com contagem fixa e um prazo fixo de 5 s (prontidão do socket em `controller-ingress`)
viraram `until()` ou o novo `untilHolds()` (`test/runner/budget.ts`, a versão booleana de `until()`), com o mesmo
intervalo de sondagem de antes. O `controller-ownership` lança cada `factory run` destacado e espera
`ended()`: ao estourar, mata a árvore (launcher, flock, owner) e nomeia a etapa com o fim do stderr. Os laços
que antes seguiam em frente em silêncio ao fim da contagem (as esperas de CLI `status`, o `upgrade-fixture`, o
`dependency-cli`) agora falham nomeando a condição. As asserções de cada teste são as mesmas, e nenhum teste
foi removido nem posto em quarentena. Não foi preciso mexer em código de produto.

**Guarda estático.** `test/runner/fixed-timers.test.ts` varre `test/**` (`.ts`/`.mjs`/`.js`) e falha em
`timeout:` numérico e em laço `for` contado que sonda, ou seja, que espera e para por condição (`&&` no
cabeçalho, ou `break`/`return` no corpo). Uma varredura com espera por rodada, como o
`credential-lifecycle` review 2, não conta. Ficam de fora as receitas `*-qualification`, os quatro providers
roteirizados delas (argumentos de Bash em segundos) e o `native-builder-bash` (o `timeout` da ferramenta é a
entrada sob teste). Uma linha nova em `docs/agents/testing.md` registra a regra.

**Gate.** Três `npm run test:ci` seguidos em 5e8805c, todos verdes com 1400 testes (1390 pass, 10 skip, 0 fail)
e quarentena vazia:

| Execução | Total (teto 600 s) | Lane paralela | Carga inicial → final (1 min) |
| --- | --- | --- | --- |
| 1 | 457,0 s | 379,5 s | 18,9 → 18,7 |
| 2 | 337,5 s | 312,2 s | 13,8 → 19,9 |
| 3 | 277,1 s | 255,8 s | 17,9 → 14,7 |

`npm run test:fast` com carga 12,7-15,9 não coube no teto de 3 min: 581 testes passaram, 0 falharam e 2
foram cancelados pelo corte do orçamento (`BUDGET_EXCEEDED` a 180,0 s; os seis arquivos "FAIL" são os
que estavam rodando no corte). O teto foi medido com carga 3-6. Não há falha de asserção nem de guarda.

**Restante.** O `worker-process` (saída do setup abortado) já esperava por `ended()` desde o ticket 37. A
corrida que resta ali é entre o `abort` por IPC e o fim do setup do SDK no filho, e não é um timer. Não
houve falha nesta onda e ela não foi alterada. O runner test #11 (processo vazado) também não falhou.

