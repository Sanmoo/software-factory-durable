# 38: Reconciliar `sandbox/sandbox-storage` com o produto

**What to build:** `test/sandbox/sandbox-storage.test.ts` sempre foi pulado (dependia de `FACTORY_SANDBOX_TEST_ROOT`). Ao rodar pela primeira vez na camada `full` do ticket 36, falha de forma determinística: `observe().cessationConfirmed` é `true` onde o teste espera `false`. Decidir, com base na spec e nos tickets 04–06/26, se o produto ou o teste está errado, e corrigir o lado errado.

**Blocked by:** [36: Runner de testes em camadas, paralelo e com lock da máquina](36-tiered-parallel-test-runner.md)

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Diagnóstico registrado: qual contrato (spec/ticket) define `cessationConfirmed` no cenário do teste e por que o teste e o produto divergem.
- [x] (n/a) Se o produto estiver errado: correção com teste vermelho → verde, sem enfraquecer a fronteira de cessação usada pelo ticket 26.
- [x] Se o teste estiver errado: teste atualizado com justificativa no próprio arquivo.
- [x] `npm run test:full` passa os testes de sandbox condicionados (210/212 hoje → todos), e `npm run test:ci` continua verde.

## Autorização e limites

Sem rede, GitHub, VM, modelo ou credenciais. Raiz privada em `~/.cache/sft/` como no runner do ticket 36.

## Answer

Resolvido em 2026-11-15: **o teste estava errado; o produto segue o contrato.**

- **Contrato:** ticket 26 (evidência `docs/evidence/26-execution-recovery-without-survivor-adoption.md`, "Sandbox.observe sem
  boot" e decisão 2, extensão aditiva aprovada da observação Q5): ambiente próprio preparado sem `current.json` publicado ⇒
  `condition: 'not-booted'`, `cessationConfirmed: true`, `boot: null`, porque o `current.json` é renomeado e sincronizado antes
  de qualquer `systemd-run` (nenhuma unit pode existir). `test/sandbox/sandbox-inventory.test.ts` já fixa isso e a recuperação
  (`src/control/durable/recovery.ts`, `never-booted`) depende disso.
- **Deriva:** `sandbox-storage` (commit `1c99baf`, slice de storage do 03) é anterior ao 26 (`e09efc3`); na época, observar sem
  boot dava `indeterminate`/`false`. Como sempre era pulado (`FACTORY_SANDBOX_TEST_ROOT`), a mudança do 26 não o pegou.
  A intenção da asserção ("storage nunca fabrica prova de ausência de VM/cessação") continua válida, mas o cenário passou a
  ter prova de ciclo de vida legítima.
- **Correção (só no teste, justificada no arquivo):** o ambiente nunca iniciado agora espera `not-booted`/`true` (prova do 26),
  e a fronteira de cessação é verificada onde falta evidência de ciclo de vida: `observe` com um boot bem formado e não
  publicado dá `indeterminate`/`cessationConfirmed: false` mesmo com storage totalmente observado; com o disco virado FIFO
  (storage `unavailable`) a condição segue `not-booted` e o boot não publicado segue `false`. Produto inalterado; nada da
  fronteira usada pelo 26 foi relaxado.
- **Validação:** vermelho reproduzido em `npm run test:full -- test/sandbox/sandbox-storage` (`true !== false`, 2/2 falhas nas
  duas passadas) → verde 2/2. `npm run test:full -- sandbox/sandbox-` (raiz privada nova em `~/.cache/sft/`): 212/212 nas duas passadas (14 arquivos; segunda em ordem aleatória). Numa passada mais ampla (`-- test/sandbox`), `sandbox/bash-credential` (não condicionado à raiz) falhou 1× sob carga e passou 10/10 isolado; não é deste ticket.
  `npm run test:ci`: PASS, 1304 testes (1294 pass, 0 fail, 10 skip), 261,7 s de 600 s. `$HOME/software-factory-test` não foi tocado; `gondolin.test` segue `skip: true`.
- Não existe mapa da feature `software-factory-mvp`; a síntese fica nesta resposta.
