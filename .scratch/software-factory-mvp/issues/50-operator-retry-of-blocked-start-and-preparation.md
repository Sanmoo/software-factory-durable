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

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Falta de memória/disco no boot é transitória: volta à fila com espera e sem cobrar recovery quando nada iniciou.
- [ ] Para as demais recusas de boot/preparo, `factory resume <work>` (ou forma equivalente) aceita a decisão explícita do operador depois de
  cessação confirmada, registrada e auditável, e o Trabalho volta pela recovery normal. Este é o mecanismo genérico; o ticket 47 o usa para
  `START_PRESERVED_DISK_CHECK_REQUIRED`.
- [ ] Mudança de recursos do guest (memória, vCPU) na configuração não invalida ambientes preparados; só o que muda a identidade do disco ou do
  perfil (tamanho de disco, perfil, assets) exige ambiente novo, com mensagem que diga isso antes de aplicar.
- [ ] `doctor` avisa, antes do reinício, quando a nova configuração vai invalidar ambientes de Trabalhos abertos.
- [ ] Conflito de seed em `/artifacts` mostra o arquivo divergente e oferece recriar a seed com decisão do operador.

## Comments

- Evidência: `pl1-pilot-evidence/findings.md` itens 1, 5 e 6.
- Relacionados: [41](41-explicit-unblock-of-blocked-recovery.md), [47](47-clean-guest-stop-and-disk-recovery.md).
- 2026-11-19 triagem (operador, decisões registradas): primeiro da fila junto com o 51; dono do mecanismo genérico de retomada por decisão do operador (antes previsto também no 47); prova real no [54](54-pilot-2.md).
