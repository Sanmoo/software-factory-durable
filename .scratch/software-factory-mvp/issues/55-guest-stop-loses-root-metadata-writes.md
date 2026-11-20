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

**Status:** resolved

## Acceptance criteria

- [x] Reprodução determinística: boot de um ambiente a partir da base, escrita conhecida no root (arquivo, diretório, `sync`), parada pelo
  caminho real do adapter, e `e2fsck -f -n` + leitura do arquivo no `root.qcow2` resultante. A falha aparece sem modelo.
- [x] Causa identificada entre as hipóteses, com evidência (por exemplo: dano com SIGKILL do qemu e ausência com quit/flush; ou registro do caminho
  de emergência).
- [x] Correção: a parada só é registrada `clean` quando o disco do host está provadamente consistente (flush do VMM confirmado, ou
  `cache=` que dispense o flush), e a checagem registra o motivo da recusa (hoje `catch { return false }`).
- [x] Teste de regressão que falha antes da correção. Repetir a reprodução real 5 vezes, com e sem carga de Docker/Gradle, todas limpas.
- [x] Revisar se as passagens limpas do piloto 2 (continuação do #124 às 03:33, boots depois do reinício das 03:35) leram mesmo um disco íntegro.

## Comments

- Evidência: `/home/sanmoo/software-factory-test/pl2-pilot-evidence/findings.md` (itens 8 e 12), cópias guardadas em `pl2/environments/env-*/filesystem-check-*/snapshot.ext4`,
  teste de `e2fsck -p` em `/home/sanmoo/software-factory-test/pl2-pilot-evidence/fsck-trial`, base conferida em `/home/sanmoo/software-factory-test/pl2-pilot-evidence/base-check`.
- Relacionado: [47](47-clean-guest-stop-and-disk-recovery.md) (critério de parada limpa falhou na prova real), [54](54-pilot-2.md).

## Answer

2026-11-20, branch `fix/55-guest-stop-disk` (commit `532402e`). **Nenhuma escrita do guest se perdeu: a CHECAGEM lia uma cópia truncada**
(hipótese 4). Os discos do piloto estão íntegros.

**Causa.** `checkDiskFilesystem` (`src/sandbox/filesystem.ts`) rodava `qemu-img convert` do disco inteiro (e o `e2fsck`) com o limite de
30 s das chamadas pequenas (`native`). Um `root.qcow2` de 13-17 GiB depois de Gradle/Docker leva 26-35 s sozinho e mais de 90 s com três
checagens juntas (o reinício do piloto). O `execFile` mata o convert no meio, o `catch { return false }` recusa, e o snapshot guardado fica
incompleto: o "dano" lido nele é só o fim que falta (as tabelas de inode dos flex groups 288/304, onde ficam `/data` e `/workspace`, estão em
~36/38 GiB).

**Evidência** (`docs/evidence/55-guest-stop-disk-check-2026-11-20.json`, só leitura sobre `pl2/`):
- Os quatro `filesystem-check-*/snapshot.ext4` do pl2 têm mtime = birth + 30,0 s. O de `env-9a1…` é idêntico à conversão completa nos
  primeiros 11,0 GiB e não tem nada depois; a conversão completa tem dados até 38,0 GiB.
- A conversão completa (`qemu-img convert -U`) dos três `root.qcow2` do pl2 passa no `e2fsck -f -n` (exit 0), com journal vazio (start 0).
- Antes da correção, três checagens simultâneas sobre cópias reflink dos três discos: as três recusadas aos 30,05 s. O snapshot guardado dá
  exit 4 com a mesma assinatura do piloto (`data` → 2068993, `workspace` → 2183937, ref count 23≠21, 39 checksums de bitmap). Depois da
  correção, as mesmas três passam (91-98 s).
- **O "disco novo" não era novo.** O controle registrou `pl2-124-replace-disk-1:replace-disk:not-needed` (a rechecagem das 05:35 terminou
  abaixo de 30 s). O boot das 05:35 rodou no disco antigo (mount count 5, 36 GB de lifetime writes), e a checagem seguinte, de novo
  concorrente, estourou. A falha depende de carga e tamanho, e não aparece com 3 min de uso num disco novo.

**Hipóteses 1-3 descartadas.** Na receita real (`test/sandbox/disk-stop55-qualification.ts`: base assets35, disco novo como no preparo,
opções de VM do adapter sem rede, escrita no root, parada e checagem pelo host), a parada do adapter (`stopGuestCleanly` + close do SDK =
SIGTERM no qemu) e a mesma parada seguida de **SIGKILL** do qemu dão disco consistente, journal vazio, marcador lido de volta, sha256 do
arquivo de 1 GiB igual e 5000 arquivos pequenos. O `sync` + remount `ro` do guest gera o FLUSH do virtio-blk, que leva o qemu a gravar os
caches do qcow2 antes de qualquer fim do VMM. Controle positivo (SIGKILL sem a parada do guest, com escritor ativo): journal pendente e
arquivo grande diferente. A receita detecta perda quando ela existe. O caminho sysrq (hip. 2) não foi exercitado (o remount normal sempre
funcionou), mas nenhum disco do piloto mostra perda.

**Passagens das 03:33/03:35 (00:33/00:35 locais).** Leram discos íntegros e passaram porque, no começo do piloto, os discos eram pequenos
(pouco além da base de ~1,5 GB de escritas) e o convert cabia nos 30 s. A falha surgiu quando o Gradle/Docker encheu os discos.

**Correção.** Passos de imagem inteira (`qemu-img check`/`convert`, `e2fsck`, `resize2fs`, também no preparo e no reparo) usam o limite
`image` de 30 min; o `qemu-img info` fica com 30 s. `checkDiskFilesystem` devolve `{ ok: true } | { ok: false, reason }`, com o passo, a
expiração (`timed out after 1800 s and was killed (its output is incomplete)`) ou o exit e os primeiros achados do e2fsck. Ela grava
`refusal.txt` ao lado do snapshot guardado, e `Sandbox.start` (detalhe do impedimento `PRESERVED_DISK_CHECK_REQUIRED`) e o preparo da base
levam esse motivo. A semântica não mudou: nunca repara, guarda o snapshot que falhou. A parada continua `clean` só com o root `ro`. A prova
mostra que isso já basta para o qcow2 do host, então `cache=` não mudou.

**Testes.** `test/sandbox/disk-check.test.ts` (fast, offline, `execFile` dublado com expiração): 5/5; falha antes da correção. Também
passaram `environment-base`, `sandbox-start(-diagnostics)`, `sandbox-stop`, `guest-shutdown`, `retry50-flow` e `fixed-timers` (61/61), e,
com `FACTORY_SANDBOX_TEST_ROOT` curto, `disk-remedy`, `sandbox-filesystem` e `environment-base-native` (14/14).
**Real (VM, uma por vez):** 6 execuções depois da correção, `adapter`/`adapter-sigkill` × `light`/`heavy` (1 GiB aleatório, 5000 arquivos,
escritor `fsync` ativo durante a parada). Todas passaram em `checkDiskFilesystem`, `e2fsck -f -n` e leitura. Mais o controle `sigkill`. Sem
Docker com contêiner (sem rede para imagens).

**Para o operador.** Os três ambientes do pl2 não precisam de `repair-disk`/`replace-disk`: com a release corrigida, um `--retry-blocked-start
START_PRESERVED_DISK_CHECK_REQUIRED` sem remédio deve passar. Os `filesystem-check-*` do pl2 são cópias truncadas e podem ser descartados pelo
operador (não apagados aqui).

