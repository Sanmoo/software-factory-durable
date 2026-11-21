# Estratégia de testes

Decisão do operador no ticket 36 (`.scratch/software-factory-mvp/issues/36-tiered-parallel-test-runner.md`), reconciliada com a adoção do engineering harness ([ADOPTION-PLAN.md](../../ADOPTION-PLAN.md)).

## Intenção

Os testes fixam o comportamento observado da fábrica: um teste de regressão registra o que ela faz hoje, mesmo quando parece surpreendente, para que uma mudança que o altere falhe em vez de passar despercebida. Um teste verde diz que o comportamento não mudou, não que ele está certo.

## Níveis

- **Unit**: exercita um módulo pela interface pública, sem I/O em runtime e sem substituir nada que a fábrica possui; fixa o comportamento das regras de domínio (`src/control/rules`, `src/contracts`). Os arquivos de nível unit são declarados em [test/levels.json](../../test/levels.json), e o quality gate Context boundaries recusa um teste declarado unit que alcance I/O.
- **Integration**: todo outro arquivo de teste. Dirige um contexto contra a infraestrutura real (processos, sistema de arquivos, SQLite, preparação do SDK); só sistemas de terceiros são dublês na fronteira: GitHub pelo `gh` local de `test/entrypoints/github-world-fixture.ts` e provedores de modelo roteirizados.
- **E2E**: cenários Gherkin em português que dirigem o CLI do release construído (estágio S4 do plano).

Um comportamento novo é testado no nível mais baixo que o prova; um teste unit não ganha I/O para "testar de verdade" — vira integration e sai de `test/levels.json`.

## Entry Points

- `npm run test:fast`: Entry Point rápido, do ciclo de TDD e do hook versionado em `.githooks/pre-commit` (instalá-lo, com `git config core.hooksPath .githooks`, é passo do operador). Verde cobre os quality gates rápidos e os testes de nível unit; integração fica no Entry Point completo. Um filtro (conveniência, nunca um gate) ainda alcança qualquer teste no ciclo de TDD.
- `npm run test:ci`: Entry Point completo em **validação por mudança**. O supervisor local o roda uma vez antes de entregar e de novo após rebase ([ADR 0001](../adr/0001-local-supervisor-is-the-change-mode-ci.md)); uma mudança só está pronta quando ele está verde. Verde cobre o escopo afetado que o relatório nomeia, nunca a aplicação inteira.
- `npm run test:full`: Entry Point completo em **validação integral**, chamado pelo timer noturno. Roda todos os checks sobre a entrada inteira, inclusive os periódicos; seu resultado vale para aquela árvore, não é certificação permanente.

Quais checks cada modo roda, sobre qual escopo, com qual custo, cadência e orçamento está na política versionada [scripts/test-runner/policy.json](../../scripts/test-runner/policy.json), não aqui. Receitas reais `*-qualification` (GitHub/VM/modelo) ficam fora dos Entry Points e continuam exigindo autorização do operador por execução.

## Julgamento

- Comportamento já presente é fixado por um teste de regressão antes de mudar. Esse teste não audita se a regra de negócio está certa; evidência forte de erro óbvio vira uma decisão localizada do operador.
- Dublês só para sistemas de terceiros na fronteira: o `gh` local de `test/entrypoints/github-world-fixture.ts` e provedores de modelo roteirizados. Não substitua um módulo da própria fábrica por um dublê num teste que prova a integração dele.
- Prefira uma regra pura testada sem I/O a um cenário com processo real; um cenário real por mecanismo basta.

## Manifesto `test/tiers.json`

Lista **apenas exceções** de tempo e paralelismo. Arquivo sem entrada é paralelo; o nível (unit ou integration) vem de [test/levels.json](../../test/levels.json).

```json
{ "schemaVersion": 1, "files": {
  "test/x/y.test.ts": { "slow": true, "reason": "por que é lento, medido" },
  "test/x/z.test.ts": { "serial": true, "reason": "qual estado compartilhado impede paralelo" },
  "test/x/v.test.ts": { "full": true, "reason": "por que é caro demais para o gate de integração" },
  "test/x/w.test.ts": { "quarantine": "ticket NN", "reason": "o flake observado" }
} }
```

- `slow`: fica fora de um `fast` filtrado, roda em `ci`/`full`. `serial`: roda na lane serial, depois da paralela.
- `full`: só no noturno (fora de `fast` e `ci`; o relatório lista como "full only"). Para arquivo caro demais
  para o gate de integração; a regra que ele prova precisa de um teste barato em `fast`/`ci`.
- `quarantine`: o arquivo não roda em camada nenhuma e o relatório o lista como **não cobertura**;
  exige ticket. Não há retry automático.
- Toda entrada exige `reason`; chave desconhecida, flag `false`, caminho fora de `test/**/*.test.ts`
  ou arquivo inexistente fazem o runner falhar.

## Regras para quem escreve teste

- Lento (segundos sozinho) ou não paralelizável: entrada no manifesto com justificativa, no mesmo commit.
- Flake é bug do teste: corrigir, ou quarentena explícita com ticket. Nunca retry.
- Relógio falso (`mock.timers`, tempo/prazo injetado) em vez de `sleep`; temporizador interno fixo
  (por exemplo `timeout: 15000` num teste) é proibido em `fast`/`ci`. Coordene processos por eventos
  (linha no stdout, fim do stdin), não por espera.
- Limites e esperas vêm do orçamento do runner (`FACTORY_TEST_DEADLINE`), via `test/runner/budget.ts`:
  `ended()` para o fim de um filho (`detached: true`; ao estourar mata a árvore e nomeia a etapa),
  `until()`/`untilHolds()` para condições sem evento, `remainingMs()` como `timeout` de `test()`,
  `spawnSync` ou `execFile`. Nunca `timeout:` numérico nem laço de espera com contagem fixa
  (`for (let i = 0; i < 400; i++) … setTimeout`): `test/runner/fixed-timers.test.ts` falha neles
  (ticket 40; exceções listadas ali: receitas `*-qualification` e argumentos de ferramenta sob teste).
- Sem caminho ou porta fixos: `mkdtemp` para tudo, porta 0 quando houver servidor; nunca escrever no
  estado compartilhado do checkout (`.scratch/factory-development-*`, `dist/`). Quem precisa mutar uma
  preparação usa uma cópia privada do projeto (padrão de `test/workers/sdk-profile.test.ts` e
  `test/sandbox/gondolin-sdk-profile.test.ts`).
- Nunca usar `$HOME/software-factory-test`; os testes de sandbox recebem `FACTORY_SANDBOX_TEST_ROOT`
  apenas do `full`, numa raiz privada nova.
- Crash/SIGKILL reais só fora de `fast` (arquivo `slow`), com **um** cenário representativo por mecanismo;
  as variações viram testes de regra pura.
