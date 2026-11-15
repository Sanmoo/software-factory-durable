# Testes: camadas, runner e regras para quem escreve teste

Decisão do operador no ticket 36 (`.scratch/software-factory-mvp/issues/36-tiered-parallel-test-runner.md`).
Ela **substitui** a regra anterior do handoff, "um arquivo compilado por vez"
(`node --test --test-concurrency=1 <arquivo>` em série): o gate agora é `npm run test:ci`.

## Comandos

| Comando | Conteúdo | Teto (relógio, nesta máquina) | Lock |
| --- | --- | --- | --- |
| `npm run test:fast` | `tsc --incremental` + ESLint dos arquivos alterados (vs `HEAD` + não rastreados) + todos os arquivos sem `slow`, em paralelo com metade dos núcleos | 3 min | não |
| `npm run test:ci` | `dist/` limpo + `tsc` + ESLint `--max-warnings 0` + dependency-cruiser completos + **todos** os arquivos (lane paralela com N = núcleos, depois a lane serial) | 10 min | sim |
| `npm run test:full` | `ci` + testes de sandbox condicionados a `FACTORY_SANDBOX_TEST_ROOT` (raiz privada nova) + segunda passada em ordem aleatória (semente no relatório) | sem teto | sim |

Os três chamam `scripts/test-runner/run`, que aplica o prefixo de Node do projeto
(`env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1`, Node fixado em `engines`,
`--experimental-test-module-mocks`), compila uma vez e roda `dist/test/**/*.test.js` (apenas os que
têm fonte `test/**/*.test.ts`; saída obsoleta de teste apagado nunca roda).

- Antes de qualquer trabalho o runner falha cedo se `node_modules` não corresponder ao `package-lock.json`
  (pacote ausente, inclusive dev como `pi-coding-agent`, ou versão diferente) e se `test/tiers.json`
  citar arquivo inexistente.
- `ci`/`full` pegam `flock` em `$XDG_RUNTIME_DIR/software-factory-test-runner.lock`: uma por vez na
  máquina, entre worktrees e sessões. A espera aparece à parte ("lock wait") e não conta no teto.
- Estouro do teto mata os processos em curso e sai não-zero com `BUDGET_EXCEEDED`; a saída é
  reclassificar no manifesto ou otimizar. Carga de outras sessões não é desculpa.
- O relatório final traz tempos da análise estática, de cada lane, da espera no lock, a carga
  (`loadavg`) no início e no fim e os 10 arquivos mais lentos.
- Filtro por arquivo (`npm run test:fast -- workers/sdk`) é conveniência manual: o relatório marca
  "never a gate".
- O histórico de duração (para começar pelos mais longos) fica em
  `node_modules/.cache/software-factory-test-runner/timings.json`.

Agentes: `fast` no ciclo de TDD; `ci` uma vez antes de entregar e de novo após rebase; o supervisor lê o
resultado do `ci` e integra. `full` é noturno e nunca bloqueia integração (vermelho vira ticket).
Receitas reais `*-qualification` (GitHub/VM/modelo) ficam fora das camadas e continuam exigindo
autorização do operador por execução; seus testes de plano/guarda continuam nas camadas.

## Manifesto `test/tiers.json`

Lista **apenas exceções**. Arquivo sem entrada é `fast` e paralelo.

```json
{ "schemaVersion": 1, "files": {
  "test/x/y.test.ts": { "slow": true, "reason": "por que é lento, medido" },
  "test/x/z.test.ts": { "serial": true, "reason": "qual estado compartilhado impede paralelo" },
  "test/x/w.test.ts": { "quarantine": "ticket NN", "reason": "o flake observado" }
} }
```

- `slow`: fica fora de `fast`, roda em `ci`/`full`. `serial`: roda na lane serial, depois da paralela.
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
- Sem caminho ou porta fixos: `mkdtemp` para tudo, porta 0 quando houver servidor; nunca escrever no
  estado compartilhado do checkout (`.scratch/factory-development-*`, `dist/`). Quem precisa mutar uma
  preparação usa uma cópia privada do projeto (padrão de `test/workers/sdk-profile.test.ts` e
  `test/sandbox/gondolin-sdk-profile.test.ts`).
- Nunca usar `$HOME/software-factory-test`; os testes de sandbox recebem `FACTORY_SANDBOX_TEST_ROOT`
  apenas do `full`, numa raiz privada nova.
- Crash/SIGKILL reais só fora de `fast` (arquivo `slow`), com **um** cenário representativo por mecanismo;
  as variações viram testes de regra pura.
