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
