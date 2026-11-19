# 47: Parada limpa do guest e retomada de disco preservado inconsistente

**What to build:** no piloto 35 (2026-11-19) três ambientes ficaram inutilizáveis depois de uma parada da VM no meio de trabalho do Gradle:
#126 (09:45 UTC) e, depois do reinício das 12:00, #124 e #125 juntos. O boot seguinte recusou com `START_PRESERVED_DISK_CHECK_REQUIRED`:
`checkDiskFilesystem` (`src/sandbox/filesystem.ts:51`) converte o `root.qcow2` numa cópia raw privada e roda `e2fsck -f -n`, que acusou
"block bitmap does not match checksum" em vários grupos. O ext4 do guest **não tem journal** (`dumpe2fs`: features sem `has_journal`, estado
"not clean"), então uma parada abrupta deixa inconsistência real; reaplicar journal não muda nada (testado numa cópia). As paradas vieram do fim
do orçamento do Builder (ticket 48) e do encerramento da Execução, com o Gradle e o Docker escrevendo no disco. Não existe retry nem reparo: o
Trabalho só volta por `cancel` + `new`, e um ciclo novo perde o ambiente (JDK, caches, imagens). No #124 isso deixou um commit com gate verde
(`d195d34`) preso sem publicação.

**Blocked by:** 50

**Type:** task

**Status:** resolved

## Acceptance criteria

- [x] Parada da VM, em qualquer caminho (fim de Execução, orçamento, cancelamento, pausa administrativa), pede antes ao guest `sync` e desligamento
  limpo, espera até `shutdownGraceSeconds` e só então força; o resultado (limpo/forçado) fica registrado no boot.
  Evidência: `test/sandbox/guest-shutdown.test.ts`, `sandbox-adapter-diagnostics.test.ts` (modos `shutdown-*`: registro `guest-stop.json`),
  `sandbox-stop.test.ts` (`guestShutdown`), `retry50-flow.test.ts` ("every boot records how the previous boot ... was stopped").
- [x] Guest com ext4 journalado: nova versão dos assets, manifesto e pins. Se o builder de imagem do Gondolin não permitir journal, a
  justificativa fica registrada no ticket e valem só a parada limpa e o reparo.
  Código e teste prontos (`deriveJournaledGuestAssets`, `test/sandbox/guest-journal.test.ts`); **o build dos assets e a troca do pin na release
  ficam com o supervisor** (comando em `## Answer`).
- [x] Disco preservado que falha na checagem tem um caminho explícito do operador (`factory` com decisão registrada): reparo `e2fsck -p` sobre o
  disco depois de cessação confirmada, ou descarte do disco com novo disco no mesmo ambiente preservando `/workspace` e `/artifacts`. Nada
  automático e nada silencioso.
  Evidência: `test/sandbox/disk-remedy.test.ts` (só com `FACTORY_SANDBOX_TEST_ROOT`; rodado localmente, 6/6), `retry50-rules.test.ts`.
- [x] O boot recusado nessa condição é retomado pelo mecanismo de decisão do operador do ticket 50 (sem `cancel` + `new`).
  Evidência: `retry50-flow.test.ts` ("ticket 47: ... repair-disk/replace-disk decision through ONE recovery"), `update-scope-cli.test.ts`.
- [x] Teste offline (fake de guest) cobre parada limpa, timeout que força a parada e registro do resultado no boot.

## Comments

- Evidência: `pl1-pilot-evidence/findings.md` itens 10 e 14; ambiente `pl1/environments/env-d29afd15…` (snapshot de checagem preservado).
- A prova real (Gradle interrompido e boot da recovery no mesmo ambiente) foi para o [54](54-pilot-2.md).
- Relacionados: [48](48-builder-budget-continuation.md), [50](50-operator-retry-of-blocked-start-and-preparation.md).
- 2026-11-19 triagem (operador, decisões registradas): ordem 50 → 47 → 48; as duas defesas (parada limpa e journal); o caminho genérico de retomada fica no 50; prova real no 54.

## Answer

Resolvido em 2026-11-19 (branch `fix/47-clean-stop-disk`, sobre `ffbe137`). Falta só o passo do supervisor: build dos assets journalados e
troca do pin (abaixo). Prova real (Gradle interrompido, boot da recovery no mesmo ambiente) no [54](54-pilot-2.md).

**Parada limpa.** Todo caminho de parada (fim de Execução/orçamento `builder execution ended`, cancelamento, entrega, timeout, parada
administrativa, `reviewer retry limit` do 51, sobreviventes na reconciliação do boot) já passa por `Sandbox.stop` → `systemctl stop` da unit →
SIGTERM do adapter. O handler do adapter (`src/sandbox/adapter.ts`) agora roda, como exec SEPARADO (o Gondolin 0.14 não mata um exec em curso),
o script fixo `guestShutdownScript` (`src/sandbox/guest-shutdown.ts`): `docker stop` limitado dos containers; SIGTERM e depois SIGKILL em todo
processo do guest exceto PID 1 (sandboxd), os helpers do Gondolin (sandboxfs/ssh/ingress), threads do kernel e a própria ancestralidade (assim o
Gradle/dockerd/comando do worker que ainda escreve para); `sync`; `mount -o remount,ro /` (se um escritor segurar o root, sysrq `s`+`u`, remount
emergencial read-only); sai 0 só se `/proc/mounts` mostrar o ext4 root `ro` (o ext4 fica marcado limpo). Orçamento: 80% de
`shutdownGraceSeconds` (já existia na configuração, padrão 30 s; 30% para docker, 30% para esperar o SIGTERM); depois o VMM é fechado (a parte
"forçada", inofensiva com o root `ro`); a unit continua com `TimeoutStopSec=shutdownGraceSeconds` + SIGKILL. O resultado vai para
`<boot>/guest-stop.json` (`clean`/`GUEST_ROOT_READ_ONLY` ou `forced`/`GUEST_FINALIZATION_TIMEOUT|FAILED`; sem registro = `forced`/
`NO_GUEST_STOP_RECORD`, p. ex. crash ou boot nunca operacional). `Sandbox.stop` devolve `guestShutdown`; o próximo `Sandbox.start` devolve
`previousStop` e o Control grava `previous-boot-stop` (`<boot>:clean|forced:<motivo>`) no commit de boot (visível em `show`/`history --execution`).

**Journal.** O builder do Gondolin 0.14 NÃO permite journal: `createRootfsImage` (`dist/src/alpine/utils.js`) chama `mke2fs ... -O ^has_journal`
fixo, sem opção. Mas as variantes de assets do projeto já são derivadas no host (assets30→34: nova cópia do raw + manifesto recalculado), então a
versão journalada é derivada do pin atual por `deriveJournaledGuestAssets` (`src/sandbox/guest-journal.ts`, exportado pelo Sandbox): copia os
assets para um diretório NOVO, cresce a cópia do rootfs em `journalMiB` (128), `e2fsck -fn`, `resize2fs`, `tune2fs -O has_journal -J size=128`,
`e2fsck -fn` limpo, manifesto no formato Gondolin (buildId = `computeAssetBuildId`, conferido contra o manifesto publicado do assets34) e
`provenance.json` ao lado. O kernel58 já carrega `jbd2` (`modules.dep`: `ext4.ko` depende dele). A checagem do disco preservado passou a
reproduzir um journal pendente só na cópia privada (`e2fsck -E journal_only -p`) antes do `e2fsck -fn` (sem isso, um root journalado parado
abruptamente seria recusado à toa; teste "JOURNALED root" em `disk-remedy.test.ts`, que falha sem a mudança).

**Para o supervisor (sem rede, sem VM, ~1-2 min, só disco local):**
```
npm run build    # na checkout integrada
mkdir /home/sanmoo/software-factory-test/assets35
node --input-type=module -e "import { deriveJournaledGuestAssets } from '$PWD/dist/src/sandbox/index.js'; console.log(JSON.stringify(await deriveJournaledGuestAssets({ source: { directory: '/home/sanmoo/software-factory-test/assets34/assets', manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' }, output: '/home/sanmoo/software-factory-test/assets35/assets', journalMiB: 128 })))"
```
O JSON impresso traz o pin novo (`pin.manifestSha256`); usar `--guest-assets /home/sanmoo/software-factory-test/assets35/assets
--guest-manifest-sha256 <pin>` no `release-build` da próxima release. **Atenção:** o pin faz parte da identidade do ambiente (ticket 50):
ambientes já preparados (inclusive os do pl1) seguem no pin antigo e recusariam boot com a release nova (`GUEST_ASSET_PIN_MISMATCH`); trocar o pin
quando nenhum Trabalho aberto depender do seu ambiente, ou aceitar ambientes novos. Os antigos ficam cobertos pela parada limpa e pelos remédios.

**Remédios (CLI).** `factory resume <work> --retry-blocked-start START_PRESERVED_DISK_CHECK_REQUIRED [--remedy repair-disk|replace-disk]
--request-id <id>` (mecanismo do 50: `startRetryRemedies` em contracts; `startRetryRemedyCodes`/`isDiskRemedy` em `src/control/rules/recovery.ts`;
o impedimento explica os dois). O remédio fica em `work.startRemedy`, NÃO é consumido pelo preparo, e `dispatch.ts` o passa a
`ports.sandbox.start({ diskRemedy })`; o commit de boot grava `start-remedy-applied` (`<request>:<remedy>:applied|not-needed:<detalhe>`) e limpa.
No Sandbox (`startEnvironment` + `src/sandbox/filesystem.ts`), só sob o lock do ambiente, depois da cessação confirmada do boot anterior e se a
checagem falhar DE NOVO (senão `not-needed`, nada muda), e com espaço para uma cópia inteira (2× disco + piso; senão a espera de capacidade do 50):
- `repair-disk`: `qemu-img convert` para raw em `disk-repair-<stamp>/`, `e2fsck -f -p` (saída em `e2fsck-p.log`), re-checagem completa
  `e2fsck -fn` + geometria, raw → qcow2, original renomeado `root.qcow2.damaged-<stamp>` (identidade do original conferida antes do rename).
  **Decisão `-p` e não `-y`:** `-p` só aplica os reparos que o próprio e2fsck classifica como seguros e recusa (exit 4) o que exigiria resposta
  humana; `-y` responde sim a tudo (pode limpar inodes/mover para lost+found em silêncio), o que o "nada silencioso" exclui. Exit > 2 → recusa
  com o motivo no impedimento (`repair-disk: e2fsck -p exit N ...; use --remedy replace-disk`), disco intocado. Prova com o disco real do piloto:
  cópia reflink do snapshot preservado de `env-d29afd15…` (btrfs, sem tocar o original) → `e2fsck -f -p` exit 1 (bitmaps/checksums, contagem do
  inode 2, entradas `data`/`workspace` do `/`, que são só pontos de montagem recriados pelo init) → `e2fsck -fn` exit 0. Cópia apagada depois.
- `replace-disk`: disco novo do template do pin (o mesmo `buildRootDisk` do preparo) em `disk-replace-<stamp>/`, o atual renomeado
  `root.qcow2.replaced-<stamp>` (também quando o disco sumiu). `/workspace` e `/artifacts` são diretórios do host do ambiente (montados via
  sandboxfs), não estão no root: ficam como estão. Perde-se o que só existia no root (JDK, caches, imagens Docker).

**Limites.** Sem VM: o script do guest só é analisado (`sh -n`) e o adapter roda com a VM dublada; assume `exec` concorrente no sandboxd e
`/proc/sysrq-trigger` no kernel virt (fallback; sem ele o resultado é `forced`, nunca falso `clean`). Discos `*.damaged-*`/`*.replaced-*` e
diretórios `disk-repair-*`/`disk-replace-*` não são apagados pelo cleanup do ambiente (como os snapshots `filesystem-check-*` hoje): candidato a
ticket de retenção. Prova real no 54.

**Para o 48.** O fim de orçamento já para pela parada limpa: a Execução termina e `dispatch.ts` chama `stopOwnBoot('builder execution ended')` →
`ports.sandbox.stop` → adapter. O 48 só precisa continuar usando `stopOwnBoot`/`ports.sandbox.stop` (nunca fechar a VM por outro caminho) e pode
ler `stop.guestShutdown` (`clean`/`forced`) se quiser registrá-lo na continuação.
