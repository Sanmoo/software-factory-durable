# 03 — v3: dois boots públicos, finalização observada e estado Docker persistido

## Escopo autorizado e consumido

O operador autorizou até DOIS boots sequenciais do mesmo ambiente novo, com o
segundo condicionado a todos os gates do primeiro. Executados exatamente dois,
nenhum simultâneo. Nenhum retry/terceiro boot/imagem alternativa/timeout maior,
agente, credencial, rede/pull, chamada GitHub/modelo, sudo/hostinstall ou cleanup.
Encerrada a autorização. Recursos e histórico UNKNOWN/noRetry preservados.

Fonte executada `cb5ec0aa7408fb23d17730105a9f55628c1045d6`, após gates locais
78casos77pass/1VMskip, strict compile/build/arquitetura/ESLint67módulos289deps.
Driver primeiro boot: qualify-public-lifecycle.ts compilado. Follow-up público
único e coletores arquivados em `/home/sanmoo/software-factory-test/v3/`;
nenhum SDK VM invocado fora do adapter nem novo seam de teste no produto.

Imagem congelada `assets32/assets`, manifestSHA256
`4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1`.
Kernel58/initramfs publicado/rootfs Alpine-Docker-vfs APK74 sem alteração.
prepare cresce/verifica CÓPIA por ambiente, não template. Ambos VMMs KVM/microvm,
2048M/2CPU/mesmo qcow2 standalone40GiB, SDK startup30s/grace30s. Witnesses reais
incluem kernel/initrd/disco próprio, não qemu-version. Serial `null` em ambos,
confirmando execução sem console/debug temporário.

## Preflight

`v3-preflight-cb5ec0a.json`: quatro checks de assets, storage/filesystem-tools/
KVM-access/host-platform ok; socket106B; memória disponível8266870784B;
filesystem594008252416B livre; root29534625792B retidos. Root novo ausente,
template sem /var/lib/docker/engine-id (debugfs read-only, erro específico
File-not-found). Inventory sem QEMU não foi usado para liberar reservas antigas.

## Primeiro boot e gate antes do segundo

Environment único:
`env-676b31e682299bb62c6e8058d1be87ea12fa7c258b53de6b5da392e74a33589e`.

| Evidência | Primeiro | Segundo |
| --- | --- | --- |
| BootRef | boot-77f0149e-cb5b-4e48-b61f-5f7f45655165 | boot-ff4464e7-d284-4660-85f7-94e13bceb1b8 |
| VMM PID/startTicks | 2967463 / 102394749 | 2971334 / 102441203 |
| Invocation registrada | 457d7c49c7f74136978d53512da1ada4 | 68582a4814d74879a716fe6c1395981b |
| Start/perfil Alpine-Docker-vfs | success | success |
| Antes de stop | active / cessationfalse | active / cessationfalse |
| Stop | success / cessationtrue | success / cessationtrue |
| Guest finalization | observed | observed |
| Termination | unconfirmed | unconfirmed |
| Depois de stop | stopped / cessationtrue | stopped / cessationtrue |
| qcow-check / read-only e2fsck | 0 / 0 | 0 / 0 |
| Ext4 real e virtual | 42949672960B / 42949672960B | 42949672960B / 42949672960B |

O segundo start reutilizou o MESMO EnvironmentRef, configuração/pin/disco; não
executou prepare outra vez nem recriou template. Passou pelo novo check de disco
preservado e publicou BootRef/VMM novos distintos. Segunda intenção exclusiva
impede rerun do follow-up. O primeiro gate estava completo antes dessa intenção,
com dados de filesystem/manager já persistidos. Ao terminar o segundo não houve
outro boot; segundo result declara thirdBootForbiddentrue.

## Cessação independente e falha do coletor corrigida sem boot

`manager-final-first.json` (09:18:25.932Z) e `manager-final-second.json`
(09:22:46.558Z), em2026-11-12: hostBoot37407e0a-d96d-4763-8347-581eb1dafd6b,
NSCg4026531835/mount4026531832 iguais aos privados do boot; full-root mount de
cgroup2/magic/controllers revalidados, cgroup exato próprio ausente, nova
observe pública stopped/cessationtrue. Evidence operational e guest-synced
correlacionadas ao boot. As units de sucesso foram coletadas: show not-found,
CIDvazio/Main0/CGempty. Não há novo CID pós-stop para comparar; defaults de
Resultsuccess/ExecMainStatus0 não são exitstatus/consumo reais. Cessação não
vem só de PID/unit ausente, close/receipt/sync ou inventory.

A primeira execução do coletor read-only falhou antes de consultar o manager:
seu ambiente nativo reduzido omitira DBUS_SESSION_BUS_ADDRESS/XDG_RUNTIME_DIR.
Repro read-only mostrou status1 sem contexto e0 com endereços explícitos do user
manager. Preservados script tentativa1 e inspection-first-attempt1.json; corrigido
SOMENTE o contexto do coletor e repetidas leituras. Não foi retry de VM nem
mudança do produto. Nenhum segundo boot até completar a verificação independente.

## Persistência observada, sem conteúdo sensível

Snapshots privados `evidence-first/snapshot.ext4` e `evidence-second/snapshot.ext4`:
qcow standalone/check, e2fsck-fn e dumpe2fs independentes, sem hostmount/reparo.
SHA256 e dev/ino/size/mtimeNs/ctimeNs/UID/mode/nlink do original não mudaram
DURANTE cada inspeção. Entre boots o conteúdo muda naturalmente; os checks não
exigem arquivos-contêiner bit-idênticos entre execuções.

Template sem identificador do daemon. Depois de cada boot, leitura somente de
`/var/lib/docker/engine-id`, forma/tamanho validados, guardou somente SHA256:
`7e861e582229b2e0e99ab6c60b0c9c2bc9904d933a85f388201001a5cddab2ac`.
Igual entre boots distintos, sem seed no template. Nenhum key.json, chave,
credencial, identificador bruto ou console guest capturado. Isso comprova
persistência desse estado criado pelo Docker no disco reutilizado, não todos
os arquivos/pacotes/caches de um trabalho, workspace, containers ou ferramentas.

## Resultado e limites

**Qualificada esta fatia:** preparo público com filesystem real40GiB, start
operacional, parada de ambiente ativo, finalização guest observada, cessação
independente, novo boot público do disco preservado e estado Docker persistido.

**NÃO é aceite completo03/release/MVP:** termination segueunconfirmed; finalização
observada+filesystemcheck não certificam shutdown gracioso completo. Sem prova de
consumo quantitativo, perda de owner, dois ambientes concorrentes/isolamento,
escapes VFS, projeções tools/roles ou remove. Não usar sucesso deste subconjunto
para marcar todos os critérios ou reabrir exploração de imagens.

Uso retido final31416725504B (~29.26GiB) sob orçamento80GiB, filesystem livre
593147396096B. Nenhuma reserva histórica UNKNOWN/noRetry liberada por scans;
discos/runtimes/snapshots/evidências preservados. Branch/worktree mantidas,
integração integration/software-factory-mvp b591ec7 intacta, sem push/merge/cleanup.
Próximo trabalho deve fechar os critérios ainda pendentes, não fazer terceiro boot.
