# 36: Runner de testes em camadas, paralelo e com lock da máquina

**What to build:** Um ponto único de entrada para os testes (`npm run test:fast`, `npm run test:ci`, `npm run test:full`) que substitui a regra "um arquivo compilado por vez" do handoff. O runner compila uma vez, roda os arquivos em paralelo, isola só as exceções numa fila serial, aplica um teto de tempo por camada e serializa as camadas pesadas entre sessões com um lock da máquina. Motivo: medição de 2026-11-15 em a2f0a76 (177 arquivos, 1106 testes) deu 7,2 min em série e ~3,2 min em 8 vias; a lentidão percebida veio da execução serial forçada e da contenção de várias baterias simultâneas, não do volume de testes.

**Blocked by:** —

**Type:** task

**Status:** ready-for-agent

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

- [ ] `npm run test:fast|test:ci|test:full` chamam `scripts/test-runner`, que encapsula o prefixo de Node do handoff (`env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1`, Node 24, `--experimental-test-module-mocks`), compila uma vez e roda `dist/test/**/*.test.js`.
- [ ] Lane paralela e lane serial conforme `test/tiers.json`; `fast` exclui `slow`; `ci` inclui tudo; `full` acrescenta os testes de sandbox condicionados e uma passada em ordem aleatória.
- [ ] Teto por camada aplicado (3 / 10 min) com saída não-zero e mensagem explícita no estouro; o relatório final traz tempos de análise estática, de cada lane, da espera no lock e os 10 arquivos mais lentos.
- [ ] Lock da máquina em `ci`/`full`; duas execuções simultâneas de `ci` provadas serializadas por teste.
- [ ] O runner falha cedo se `node_modules` não corresponder ao lockfile (incluindo dependências ausentes, como gondolin e pi-coding-agent) e se o manifesto citar arquivo inexistente.
- [ ] `workers/sdk-profile.test` passa a ser paralelizável ou fica como `serial` justificado: não altera o SDK compartilhado em `.scratch` no lugar e não depende de temporizador fixo de 15 s.
- [ ] `ci` passa verde em 8 vias nesta máquina dentro do teto, três vezes seguidas, sem falha só-em-paralelo; `fast` dentro de 3 min.
- [ ] Timer noturno documentado (unit systemd do usuário versionada em `docs/` ou `scripts/`, instalação explícita pelo operador; não instalado automaticamente).
- [ ] `AGENTS.md` e `docs/agents/` registram as regras para quem escreve teste: entrada no manifesto quando lento/serial com justificativa; relógio falso em vez de `sleep`; sem caminho ou porta fixos; crash/SIGKILL reais só fora de `fast`, com um cenário representativo por mecanismo e as variações como testes de regra pura.
- [ ] O gate de desenvolvimento passa a ser `npm run test:ci`; a regra "um arquivo por vez" do handoff é registrada como substituída por esta decisão.

## Referências e validação

- Medição: `scratchpad/testaudit-report.md` da sessão de 2026-11-15 (resumo neste ticket); 79 arquivos criam processos (360 s seriais), 54 temp-dir+dublês (57 s), 24 SQLite (12 s), 20 puros (3,5 s); paralelo 8 vias 164–170 s com carga 13,5; única falha só-em-paralelo: `workers/sdk-profile`.
- Não remove nem reescreve testes de produto (isso é o ticket 37).
- `test/sandbox/gondolin.test.ts` continua `skip: true`.

## Autorização e limites

Sem rede, GitHub, VM, modelo ou credenciais. Não instala timer nem altera configuração do host; só versiona os arquivos e documenta a instalação.
