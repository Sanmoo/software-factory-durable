# 38: Reconciliar `sandbox/sandbox-storage` com o produto

**What to build:** `test/sandbox/sandbox-storage.test.ts` sempre foi pulado (dependia de `FACTORY_SANDBOX_TEST_ROOT`). Ao rodar pela primeira vez na camada `full` do ticket 36, falha de forma determinística: `observe().cessationConfirmed` é `true` onde o teste espera `false`. Decidir, com base na spec e nos tickets 04–06/26, se o produto ou o teste está errado, e corrigir o lado errado.

**Blocked by:** [36: Runner de testes em camadas, paralelo e com lock da máquina](36-tiered-parallel-test-runner.md)

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Diagnóstico registrado: qual contrato (spec/ticket) define `cessationConfirmed` no cenário do teste e por que o teste e o produto divergem.
- [ ] Se o produto estiver errado: correção com teste vermelho → verde, sem enfraquecer a fronteira de cessação usada pelo ticket 26.
- [ ] Se o teste estiver errado: teste atualizado com justificativa no próprio arquivo.
- [ ] `npm run test:full` passa os testes de sandbox condicionados (210/212 hoje → todos), e `npm run test:ci` continua verde.

## Autorização e limites

Sem rede, GitHub, VM, modelo ou credenciais. Raiz privada em `~/.cache/sft/` como no runner do ticket 36.
