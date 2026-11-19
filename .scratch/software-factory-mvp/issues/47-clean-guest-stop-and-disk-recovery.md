# 47: Parada limpa do guest e retomada de disco preservado inconsistente

**What to build:** no piloto 35 (2026-11-19) três ambientes ficaram inutilizáveis depois de uma parada da VM no meio de trabalho do Gradle:
#126 (09:45 UTC) e, depois do reinício das 12:00, #124 e #125 juntos. O boot seguinte recusou com `START_PRESERVED_DISK_CHECK_REQUIRED`:
`checkDiskFilesystem` (`src/sandbox/filesystem.ts:51`) converte o `root.qcow2` numa cópia raw privada e roda `e2fsck -f -n`, que acusou
"block bitmap does not match checksum" em vários grupos. O ext4 do guest **não tem journal** (`dumpe2fs`: features sem `has_journal`, estado
"not clean"), então uma parada abrupta deixa inconsistência real; reaplicar journal não muda nada (testado numa cópia). As paradas vieram do fim
do orçamento do Builder (ticket 48) e do encerramento da Execução, com o Gradle e o Docker escrevendo no disco. Não existe retry nem reparo: o
Trabalho só volta por `cancel` + `new`, e um ciclo novo perde o ambiente (JDK, caches, imagens). No #124 isso deixou um commit com gate verde
(`d195d34`) preso sem publicação.

**Blocked by:** —

**Type:** task

**Status:** needs-triage

## Acceptance criteria

- [ ] Parada da VM, em qualquer caminho (fim de Execução, orçamento, cancelamento, pausa administrativa), pede antes ao guest `sync` e desligamento
  limpo, espera até `shutdownGraceSeconds` e só então força; o resultado (limpo/forçado) fica registrado no boot.
- [ ] Decisão registrada sobre o filesystem do guest: assets com ext4 journalado (nova versão dos assets, manifesto e pins) ou justificativa
  para manter sem journal.
- [ ] Disco preservado que falha na checagem tem um caminho explícito do operador (`factory` com decisão registrada): reparo `e2fsck -p` sobre o
  disco depois de cessação confirmada, ou descarte do disco com novo disco no mesmo ambiente preservando `/workspace` e `/artifacts`. Nada
  automático e nada silencioso.
- [ ] O boot recusado nessa condição deixa o Trabalho retomável depois da decisão (sem `cancel` + `new`), com a recovery cobrada normalmente.
- [ ] Prova real: build Gradle interrompido pelo fim do orçamento seguido de boot da recovery no mesmo ambiente.

## Comments

- Evidência: `pl1-pilot-evidence/findings.md` itens 10 e 14; ambiente `pl1/environments/env-d29afd15…` (snapshot de checagem preservado).
- Relacionados: [48](48-builder-budget-continuation.md), [50](50-operator-retry-of-blocked-start-and-preparation.md).
