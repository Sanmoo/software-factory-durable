# 55: Parada "clean" do guest perde escritas de metadados do disco raiz

**What to build:** diagnóstico e correção do defeito que encerrou o piloto 2. Depois de uma parada registrada como
`clean`/`GUEST_ROOT_READ_ONLY` (`src/sandbox/guest-shutdown.ts`), o boot seguinte recusa com
`START_PRESERVED_DISK_CHECK_REQUIRED`. O `e2fsck -f -n` (só leitura) das cópias que a checagem guardou mostra, nos três ambientes, o mesmo
dano: as entradas `data` e `workspace` da raiz apontam para inodes livres (2068993 e 2183937, os mesmos em todos), os checksums de
bitmap de bloco não batem e o superblock está "clean", mas com a última escrita igual à hora do mount. Aconteceu também num disco novo
(`replace-disk`, a partir da base íntegra) que rodou só 3 minutos. O disco base `base-559a324f…` passa no `e2fsck`. Ou seja, as escritas
de metadados que o guest faz durante o boot não chegam ao `root.qcow2`, mesmo com a parada marcada como limpa. A carga e a duração não
fazem diferença.

**Hipóteses a separar (com reprodução controlada, sem modelo nem GitHub):**
1. O VMM é fechado (SIGKILL ou close do Gondolin) antes de o qemu gravar os caches de metadados do qcow2: o drive usa o cache padrão
   (writeback, sem `cache=`), e as alocações de clusters novos ficam na memória do qemu.
2. O caminho de emergência do script (sysrq `s`/`u`) faz o remount read-only sem esperar as escritas em andamento e mesmo assim sai 0.
3. O `sync`/`remount,ro` do guest não gera FLUSH no virtio-blk, ou o guest grava num cache que o qemu não persiste.
4. A própria checagem (`checkDiskFilesystem`: `qemu-img convert` → raw, replay do journal) lê uma imagem diferente da que o guest escreveu.
   Pesam contra essa hipótese o superblock antigo e as passagens limpas às 03:33 e 03:35 UTC (que precisam ser revistas).

**Blocked by:** —

**Type:** research

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Reprodução determinística: boot de um ambiente a partir da base, escrita conhecida no root (arquivo, diretório, `sync`), parada pelo
  caminho real do adapter, e `e2fsck -f -n` + leitura do arquivo no `root.qcow2` resultante. A falha aparece sem modelo.
- [ ] Causa identificada entre as hipóteses, com evidência (por exemplo: dano com SIGKILL do qemu e ausência com quit/flush; ou registro do caminho
  de emergência).
- [ ] Correção: a parada só é registrada `clean` quando o disco do host está provadamente consistente (flush do VMM confirmado, ou
  `cache=` que dispense o flush), e a checagem registra o motivo da recusa (hoje `catch { return false }`).
- [ ] Teste de regressão que falha antes da correção. Repetir a reprodução real 5 vezes, com e sem carga de Docker/Gradle, todas limpas.
- [ ] Revisar se as passagens limpas do piloto 2 (continuação do #124 às 03:33, boots depois do reinício das 03:35) leram mesmo um disco íntegro.

## Comments

- Evidência: `/home/sanmoo/software-factory-test/pl2-pilot-evidence/findings.md` (itens 8 e 12), cópias guardadas em `pl2/environments/env-*/filesystem-check-*/snapshot.ext4`,
  teste de `e2fsck -p` em `/home/sanmoo/software-factory-test/pl2-pilot-evidence/fsck-trial`, base conferida em `/home/sanmoo/software-factory-test/pl2-pilot-evidence/base-check`.
- Relacionado: [47](47-clean-guest-stop-and-disk-recovery.md) (critério de parada limpa falhou na prova real), [54](54-pilot-2.md).
