# 50: Retry explícito pelo operador de boot e preparo recusados, e mudança de configuração sem perder ambientes

**What to build:** no piloto 35 várias recusas classificadas como "não transitórias" deixaram Trabalhos em `RECOVERY_BLOCKED` sem nenhum
comando de retomada (`factory resume` responde `NOTHING_TO_RESUME`; `--override-blocked-recovery` só vale para pedidos ilegíveis do ticket 41):

- `START_INSUFFICIENT_MEMORY_FOR_BOOT` (#124, 01:13 UTC, três guests de 3072 MiB subindo juntos): a falta de memória passa quando outro guest
  termina, mas o Trabalho ficou retido até o operador cancelar.
- `PREPARE_ARTIFACT_SEED_VERSION_CONFLICT` (#126, 01:50): a cópia do pacote de skills em `/artifacts` do ambiente divergia do manifesto.
- `PREPARE_ENVIRONMENT_CONFIGURATION_MISMATCH` (#125, 08:36): o operador mudou `sandbox.memoryMiB` (3072 → 4096) e todos os ambientes já
  preparados ficaram inutilizáveis.
- `START_PRESERVED_DISK_CHECK_REQUIRED` (ticket 47).

A única saída foi `cancel` + `new`, que perde ambiente e trabalho não publicado; foram 6 ciclos novos em 3 Tickets.

**Blocked by:** —

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Falta de memória/disco no boot é transitória: volta à fila com espera e sem cobrar recovery quando nada iniciou.
  Evidência: `test/control/retry50-rules.test.ts` AC1; `test/control/retry50-flow.test.ts` AC1 (Slot e reserva liberados, espera 15 s, nada cobrado, depois inicia) e "after a restart" (hold antigo do piloto).
- [x] Para as demais recusas de boot/preparo, `factory resume <work>` (ou forma equivalente) aceita a decisão explícita do operador depois de
  cessação confirmada, registrada e auditável, e o Trabalho volta pela recovery normal. Este é o mecanismo genérico; o ticket 47 o usa para
  `START_PRESERVED_DISK_CHECK_REQUIRED`.
  Evidência: `retry50-rules` AC2; `retry50-flow` AC2 (recusas com motivo, dedup, auditoria em `show`/`history --execution`, uma recovery) e "after a restart"; CLI real `test/entrypoints/update-scope-cli.test.ts`.
- [x] Mudança de recursos do guest (memória, vCPU) na configuração não invalida ambientes preparados; só o que muda a identidade do disco ou do
  perfil (tamanho de disco, perfil, assets) exige ambiente novo, com mensagem que diga isso antes de aplicar.
  Evidência: `test/sandbox/sandbox-start.test.ts`, `configuration-compat.test.ts`, `sandbox-prepare.test.ts` (este só com `FACTORY_SANDBOX_TEST_ROOT`); mensagem no impedimento (`retry50-rules`) e no `doctor` (abaixo).
- [x] `doctor` avisa, antes do reinício, quando a nova configuração vai invalidar ambientes de Trabalhos abertos.
  Evidência: `test/sandbox/environment-identity.test.ts`.
- [x] Conflito de seed em `/artifacts` mostra o arquivo divergente e oferece recriar a seed com decisão do operador.
  Evidência: `test/sandbox/sandbox-checkout.test.ts` (arquivo divergente, recriação só da seed decidida, cópia antiga preservada); `retry50-flow` AC5.

## Comments

- Evidência: `pl1-pilot-evidence/findings.md` itens 1, 5 e 6.
- Relacionados: [41](41-explicit-unblock-of-blocked-recovery.md), [47](47-clean-guest-stop-and-disk-recovery.md).
- 2026-11-19 triagem (operador, decisões registradas): primeiro da fila junto com o 51; dono do mecanismo genérico de retomada por decisão do operador (antes previsto também no 47); prova real no [54](54-pilot-2.md).

## Answer

Resolvido em 2026-11-19 (branch `fix/50-operator-retry`, rebaseado sobre o 51 em `c64a112`). Prova real no [54](54-pilot-2.md).

**CLI.** `factory resume <work> --retry-blocked-start <code> [--remedy recreate-artifact-seed] --request-id <id>`. `--request-id` é
obrigatório; exclusivo com `--override-blocked-recovery` (41) e `--new-review-round` (51); `--remedy` só com o retry. O código tem a forma
`(PREPARE|START)_...` (`blockedStartCodePattern`, contracts) e o Control exige que seja exatamente o que bloqueou.

**Comportamento.**
- Recusa definitiva devolvida pelo Sandbox (toda falha de `start`; recusas de preparo conhecidas: mismatch de configuração, conflito/deriva de seed,
  falta de disco, assets inválidos, cleanup pendente...) é assentada na hora pela reconciliação comum (`reconcileExecution`, trigger
  `start-refused`) com cessação confirmada: Slot e reserva liberados sem esperar reinício. Resultado `indeterminate` mantém o hold de antes.
- `START_INSUFFICIENT_MEMORY_FOR_BOOT`, `START_INSUFFICIENT_STORAGE_FOR_BOOT`, `PREPARE_INSUFFICIENT_STORAGE_FOR_PREPARATION`: transitórios;
  mesma posição na fila atrás de `bootDeferral` (15/60/300 s, motivo `BOOT_CAPACITY_WAIT`), sem `pendingRecovery` nem cobrança; zera no próximo
  boot operacional.
- Demais `START_*`/`PREPARE_*`: `RECOVERY_BLOCKED` com `execution.blockedStart` (código, detalhe do Sandbox, cessação) e próximo passo com o
  comando. O aceite é um commit deduplicado (`retryBlockedStartDecision`), grava a decisão (`blockedStart.retry`, evento
  `blocked-start-retried`, visível em `show`/`history --execution`) e abre UMA recovery pelo caminho do 26 (uma recovery já pendente é mantida).
- Conflito de seed: o Sandbox devolve `detail` com o arquivo divergente (`<seed>/<arquivo>`); `--remedy recreate-artifact-seed` registra
  `work.startRemedy`, consumido pelo próximo preparo (`Sandbox.prepare({ recreateSeeds })`): a cópia divergente é renomeada para
  `<seed>.divergent-<stamp>` (nunca apagada) e a seed é reescrita; evento `start-remedy-applied`.
- Identidade do ambiente = perfil, `diskGiB` e pin de assets (`environmentIdentityChanges`). `memoryMiB`, `vcpus`, `minFreeSpaceGiB`,
  `minFreeMemoryMiB` e `shutdownGraceSeconds` são do boot (`identity.json`) e não invalidam ambiente. O mismatch nomeia os campos alterados e o
  impedimento diz que só ambiente novo resolve (ou restaurar a configuração).
- `doctor`: check `environment-identity` lista, por Work, os ambientes retidos (sem cleanup pedido) que a configuração invalidaria
  (status `unverified` com WARNING); offline não se sabe quais Works estão abertos, então todos os retidos contam.

**Para o 47.** Acrescentar o(s) remédio(s) em `startRetryRemedies` (contracts) e o mapeamento em `startRetryRemedyCodes`
(`src/control/rules/recovery.ts`), p. ex. `'repair-disk' | 'replace-disk'` → `['START_PRESERVED_DISK_CHECK_REQUIRED']`; aplicar
`work.startRemedy` no `ports.sandbox.start` em `dispatch.ts` como o seed é aplicado no prepare (e limpar no commit de fase). Sem remédio, o
retry simples já serve para esse código.

**Limites.** Provas em regras, fluxos S (Control + Pi Durable/SQLite reais; Sandbox/Builder/GitHub dublês), Sandbox com arquivos reais e CLI
real; sem VM, memória real do host ou disco real. Recusas de preparo desconhecidas continuam exigindo a reconciliação do boot.
