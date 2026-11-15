# 36: Runner de testes em camadas, paralelo e com lock da máquina

**What to build:** Um ponto único de entrada para os testes (`npm run test:fast`, `npm run test:ci`, `npm run test:full`) que substitui a regra "um arquivo compilado por vez" do handoff. O runner compila uma vez, roda os arquivos em paralelo, isola só as exceções numa fila serial, aplica um teto de tempo por camada e serializa as camadas pesadas entre sessões com um lock da máquina. Motivo: medição de 2026-11-15 em a2f0a76 (177 arquivos, 1106 testes) deu 7,2 min em série e ~3,2 min em 8 vias; a lentidão percebida veio da execução serial forçada e da contenção de várias baterias simultâneas, não do volume de testes.

**Blocked by:** —

**Type:** task

**Status:** resolved

## Decisões do operador (grilling de 2026-11-15)

- Camadas por natureza, com teto obrigatório medido em relógio nesta máquina; estouro falha o gate e exige reclassificar ou otimizar. Carga de outras sessões não é desculpa.
  - **fast** (≤3 min): `tsc --incremental` + `eslint` nos arquivos alterados + todos os arquivos não listados como exceção, em paralelo com no máximo metade dos núcleos, sem lock. Roda sempre inteira; filtro por arquivo é conveniência manual, nunca gate.
  - **ci** (≤10 min): `tsc` + `eslint --max-warnings 0` + `dependency-cruiser` completos + todos os arquivos (lane paralela com N = núcleos, depois a lane serial). Obrigatória antes de cada integração por fast-forward e de novo após rebase.
  - **full** (sem teto): `ci` + os testes de sandbox condicionados a `FACTORY_SANDBOX_TEST_ROOT` (hoje sempre pulados) + uma segunda passada em ordem aleatória. Noturna, por timer systemd do usuário, sobre `integration/software-factory-mvp` (depois `main`); relatório em arquivo; vermelho vira ticket; nunca bloqueia integração.
- Receitas reais `*-qualification` (GitHub/VM/modelo) ficam fora das três camadas; continuam exigindo autorização do operador por execução. Seus testes unitários/de plano continuam nas camadas.
- Manifesto versionado `test/tiers.json` lista **apenas exceções** (arquivo → `slow` e/ou `serial`, com justificativa). Arquivo sem entrada é `fast` + paralelo. Arquivo listado que não existe faz o runner falhar.
- `ci` e `full` pegam `flock` num lock da máquina (fora do repositório, em `$XDG_RUNTIME_DIR`); só uma roda por vez. Tempo de espera na fila é reportado à parte e não conta no teto.
- Flake é bug do teste: corrigir ou colocar em quarentena explícita (lista no repo com ticket); sem retry automático; teste em quarentena não conta como cobertura. Temporizador interno fixo é proibido em `fast`/`ci`.
- Agentes: `fast` no ciclo de TDD, `ci` uma vez antes de entregar e após rebase; o supervisor lê o resultado e integra.

## Acceptance criteria

- [x] `npm run test:fast|test:ci|test:full` chamam `scripts/test-runner`, que encapsula o prefixo de Node do handoff (`env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1`, Node 24, `--experimental-test-module-mocks`), compila uma vez e roda `dist/test/**/*.test.js`.
- [x] Lane paralela e lane serial conforme `test/tiers.json`; `fast` exclui `slow`; `ci` inclui tudo; `full` acrescenta os testes de sandbox condicionados e uma passada em ordem aleatória.
- [x] Teto por camada aplicado (3 / 10 min) com saída não-zero e mensagem explícita no estouro; o relatório final traz tempos de análise estática, de cada lane, da espera no lock e os 10 arquivos mais lentos.
- [x] Lock da máquina em `ci`/`full`; duas execuções simultâneas de `ci` provadas serializadas por teste.
- [x] O runner falha cedo se `node_modules` não corresponder ao lockfile (incluindo dependências ausentes, como gondolin e pi-coding-agent) e se o manifesto citar arquivo inexistente.
- [x] `workers/sdk-profile.test` passa a ser paralelizável ou fica como `serial` justificado: não altera o SDK compartilhado em `.scratch` no lugar e não depende de temporizador fixo de 15 s.
- [x] `ci` passa verde em 8 vias nesta máquina dentro do teto, três vezes seguidas, sem falha só-em-paralelo; `fast` dentro de 3 min.
- [x] Timer noturno documentado (unit systemd do usuário versionada em `docs/` ou `scripts/`, instalação explícita pelo operador; não instalado automaticamente).
- [x] `AGENTS.md` e `docs/agents/` registram as regras para quem escreve teste: entrada no manifesto quando lento/serial com justificativa; relógio falso em vez de `sleep`; sem caminho ou porta fixos; crash/SIGKILL reais só fora de `fast`, com um cenário representativo por mecanismo e as variações como testes de regra pura.
- [x] O gate de desenvolvimento passa a ser `npm run test:ci`; a regra "um arquivo por vez" do handoff é registrada como substituída por esta decisão.

## Referências e validação

- Medição: `scratchpad/testaudit-report.md` da sessão de 2026-11-15 (resumo neste ticket); 79 arquivos criam processos (360 s seriais), 54 temp-dir+dublês (57 s), 24 SQLite (12 s), 20 puros (3,5 s); paralelo 8 vias 164–170 s com carga 13,5; única falha só-em-paralelo: `workers/sdk-profile`.
- Não remove nem reescreve testes de produto (isso é o ticket 37).
- `test/sandbox/gondolin.test.ts` continua `skip: true`.

## Autorização e limites

Sem rede, GitHub, VM, modelo ou credenciais. Não instala timer nem altera configuração do host; só versiona os arquivos e documenta a instalação.

## Answer

Resolvido em 2026-11-15. `npm run test:fast|test:ci|test:full` (e `npm test` = `test:ci`) chamam
`scripts/test-runner/run`, que aplica o prefixo de Node e roda `scripts/test-runner/cli.ts` por type
stripping do Node 24.21.0 (sem compilar o próprio runner). Regras puras em `lib.ts` (manifesto, lanes,
tetos, embaralhamento com semente, relatório), `deps.ts` (lockfile × `node_modules`), `lock.ts` (`flock` em
`$XDG_RUNTIME_DIR/software-factory-test-runner.lock`, preso a um descritor do runner), `runner.ts`
(orquestração com efeitos injetados) e `steps.ts` (processos reais, um grupo por arquivo, morto no estouro e
ao terminar). 23 testes do próprio runner em `test/runner/` (fast tier, <1 s), incluindo duas execuções `ci`
simultâneas em processos separados provadas serializadas por eventos, sem `sleep`. Regras para quem escreve
teste: `docs/agents/testing.md`, `AGENTS.md`, `docs/development.md` (que registra a substituição da regra
"um arquivo por vez"); timer noturno versionado em `scripts/test-runner/{nightly,systemd/}`, **não instalado**.

- `test/tiers.json`: 11 `slow` (conjunto medido), `serial` `sandbox/bash-credential` (espera fixa de 20 ms,
  falhou 1× em paralelo) e **quarentena** `entrypoints/admission-cli` (ticket 37; flake também isolado e na
  lane serial: 4 de 6 `ci`, 1 de 4 execuções isoladas; ao falhar deixa o controlador vivo). Em quarentena não é
  cobertura.
- `workers/sdk-profile`: `prepareDevelopmentSdk(project = cwd)` aceita a raiz; o teste prepara e altera uma
  cópia privada do projeto em `mkdtemp`, sem o `timeout: 15000`; o SDK em `.scratch` fica intocado
  (SHA do README igual antes/depois). Passou nas 9 execuções `ci` em 8 vias.
- Tempos (relatórios em `docs/evidence/36-runs/`): `fast` 96,4 s / 180 s (N=4, carga 1,3→4,3).
  `ci` três seguidas, verdes, N=8: 179,8 s (carga 3,7→13,5), 182,7 s com 176,8 s de espera no lock
  à parte (lançada 3 s depois da primeira; 13,5→14,6) e 223,1 s (14,6→15,6), todas ≤ 600 s.
- `full` não foi rodado inteiro. Com o filtro `sandbox/sandbox-` os testes de disco real rodaram numa
  raiz privada nova em disco (`~/.cache/sft/s-*`; tmpfs é recusado pela admissão de storage e o caminho
  precisa ser curto por causa dos sockets): 210/212, com `sandbox/sandbox-storage` falhando de forma
  determinística (`cessationConfirmed` true), deriva de teste antes sempre pulado → precisa de ticket
  próprio (registrado em comentário no 37). `$HOME/software-factory-test` não foi tocado.
- Fora do escopo, registrado no 37: arquivos com crash/SIGKILL reais ainda em `fast`.
