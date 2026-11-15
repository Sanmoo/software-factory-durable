# 37: Otimizações dirigidas da suíte de testes

**What to build:** Cortar os desperdícios medidos da suíte sem perder cobertura, em vez de uma auditoria completa dos ~1100 testes. A auditoria geral de redundância só volta a ser avaliada se `npm run test:ci` passar de 6 min nesta máquina.

**Blocked by:** [36: Runner de testes em camadas, paralelo e com lock da máquina](36-tiered-parallel-test-runner.md)

**Type:** task

**Status:** ready-for-agent

## Alvos medidos (a2f0a76, 2026-11-15)

1. `entrypoints/normal-oauth` (55,5 s): esperas reais — modo `deadline` com `deadlineMs: 30_000` e `held-ack` com o timeout de ACK fixo de 5000 ms em `src/workers/worker-process.ts:148`. Tornar o timeout de ACK injetável (sem mudar o padrão de produção) e usar prazos curtos ou relógio falso. Ganho estimado ~35 s.
2. Três arquivos de release (`release-install`, `release-artifact`, `release-upgrade`, 74,5 s) constroem uma release completa cada um no seu `before`; compartilhar um build por execução (ganho ~20 s).
3. `architecture-gate` (19 s) cria um processo de depcruise/eslint por regra; uma execução com todas as regras.
4. Nove arquivos de fork do adaptador (`normal-*`, `public-*`, `owner-registration`, `adapter-diagnostics`; 111 s, 26% do serial): cada modo sobe uma cadeia adaptador → owner → worker Node 24 nova. Consolidar modos numa cadeia reutilizada onde o isolamento não é o que está sendo provado.
5. Seis arquivos de crash sobrepostos em "SIGKILL do controlador e reinício na mesma storage" (30 s): manter um cenário real representativo por mecanismo e mover variações para testes de regra pura.

## Acceptance criteria

- [ ] Cada alvo tem antes/depois medido pelo runner do ticket 36.
- [ ] Toda remoção ou fusão de teste é proposta numa tabela (teste, motivo, AC/achado de revisão que continua coberto e por qual teste) e só é aplicada após aprovação explícita do operador, em lote.
- [ ] Nunca remover o único teste de um AC ou de um achado de revisão.
- [ ] Mudança de produto limitada a tornar injetável o que hoje é fixo (ex.: timeout de ACK), com padrão de produção inalterado e testado.
- [ ] `npm run test:ci` verde, dentro do teto, três vezes seguidas; tempo total registrado no ticket.

## Autorização e limites

Sem rede, GitHub, VM, modelo ou credenciais. Remoções dependem de aprovação do operador.

## Comments

- 2026-11-15 (ticket 36): `entrypoints/admission-cli` está em **quarentena** em `test/tiers.json` (não é
  cobertura): controlador real com polling de 1 s; `list` no meio de um ciclo vê `DEPENDENCIES_NOT_CURRENT`.
  Falhou em 4 de 6 execuções de `ci` (lane paralela e serial) e em 1 de 4 execuções isoladas (carga entre 1 e 10);
  ao falhar deixa o controlador vivo e o processo do arquivo não termina. Tem ainda `timeout: 45000` fixo.
  `sandbox/bash-credential` ficou `serial`: o teste do AC2 espera 20 ms fixos por um comando em voo e falhou
  1 vez em paralelo. Corrigir ambos com evento/relógio injetado e remover as entradas. Também ficam em `fast` arquivos com crash/SIGKILL reais
  (`control/recovery-crash`, `control/credential-lifecycle`, `control/timeout-flow`,
  `entrypoints/control-public`, `entrypoints/upgrade`): consolidar conforme o alvo 5 e a regra de
  `docs/agents/testing.md`. Em `full`, `sandbox/sandbox-storage` falha de forma determinística
  (`observe().cessationConfirmed` é `true`; o teste espera `false`), visto pela primeira vez porque antes ficava
  sempre pulado: precisa de ticket próprio (deriva entre teste e produto), não de quarentena.

- 2026-11-15 (ticket 17 implementer, por instrução do supervisor): `entrypoints/normal-worker` entrou em quarentena (`test/tiers.json`, ticket 37). Ele tem um `timeout: 15000` fixo no próprio teste, sobre uma cadeia inteira adapter→owner→worker Node24. Expirou em 2 de 2 execuções de `ci` (carga 11-19, `ERR_TEST_FAILURE`, cancelado) e passou sozinho (1/1).
  Na mesma janela, `workers/public-copy-read` falhou 1 vez (`spawnSync … ETIMEDOUT`, `timeout: 25000` fixo no `spawnSync`). Ele reapareceu na execução seguinte (2 de 3 `ci`) e também entrou em quarentena.
  Na execução seguinte, `entrypoints/publication-composition` (do ticket 14) também falhou. Ele espera `publication.state === 'published'` com um laço fixo de 600 × 10 ms e ainda estava em `awaiting-discovery` após 15,9 s, com carga 10-20. Passa sozinho em 5,6 s. Também entrou em quarentena.
  Instruções de correção, para os dois e para qualquer timer fixo nas camadas `fast`/`ci`:
  1. Remover o `timeout` fixo de `test(...)` e de `spawnSync`, e os laços de espera com contagem fixa (600 × 10 ms).
  2. Sincronizar por eventos observáveis: mensagens `worker-message` / `worker-exit` e o fim do filho, com `spawn` assíncrono e `once('exit')` em vez de `spawnSync`.
  3. Se um limite for indispensável contra travamento, injetá-lo, derivado de um orçamento relativo informado pelo runner (por exemplo, uma variável de ambiente com o teto da camada dividido pelo número de arquivos da lane). Nunca uma constante de 15 s ou 25 s.
  4. Ao estourar, o teste falha com a etapa em que parou e mata a árvore de processos, para não vazar filhos.
  5. Depois da correção, remover a entrada de quarentena e comprovar 3 execuções verdes de `ci` sob carga.
