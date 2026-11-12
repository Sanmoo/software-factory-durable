# Ticket03 — reconciliação técnica dos oito critérios

Fonte de produto1c99baf1df8d4acad02d2e2dc6c1444c4d382d69; evidência física
X3 após nova autorização explícita. Esta é uma matriz para avaliação do operador,
NÃO aceite humano, resolução automática, merge ou aceite de todo o MVP.
Ler os checkpoints antigos como cronologia, não como reescrita de falhas em passes.

## Escopo e gate

TODOS23arquivos.test conferidos em blocos:141casos140pass1VMskip0fail;
strict typecheck/build/arquitetura/ESLint75módulos344deps/diff verdes. VM test
unconditional skip não foi usado como prova real. Driver físico novo separadamente
autorizado X3: exit0,2bootsKVM, sem fault/retry/reparo/variante. Source rebuild
antes de executar passou; código de produto não mudou depois desse gate.
LSP push-only inconclusivo, não certificado clean.

| Critério03 | Implementação/evidência no nível pertinente | Limite que permanece explícito |
|---|---|---|
| 1. Público validate/prepare/start/observe/stop/remove, refs opacas, resultados distintos | Q5 em src/sandbox/index.ts. Testes públicos de validação/idempotência/recusas/indeterminação; V3 e W3 exercitaram boots e X3 atravessou o ciclo completo, dois boots, stop e remove reais com storage público. | Não é journal/dispatch do Controle nem ferramenta rawSDK para worker. |
| 2. Perfil Arch/x86_64/QEMU/KVM/Alpine/integração e config estrita | Config schema fechado, sem coerção/opções livres; hashes dos assets e pin4b6; ambos X3 têm VMM real KVM2048M2CPU/disk próprio, comando fixo real Alpine/Docker-vfs. | Composição de desenvolvimento exercitada; não release distribuída nem compatibilidade de qualquer host. Sem image-research/fallback/timeout tuning. |
| 3. Disco/tmpfs e dados/pacotes/cache persistentes | rootDiskDeleteOnClosefalse/tmpfs{}; prepare cresce ext4 REAL40GiB. X3 mesmo dev55/inode31366008 sem reprepare/reclone/reseed: seis paths root + workspace/artifacts escritos pelo GUEST, todos valores PRIMEIROBOOT preservados; cinco hashes de APK/config/engine-id iguais nos dois snapshots. | Amostras compactas representativas, não todo userdata, RAM/processos preservados ou perda zero em crash. Primeiro fsck-nexit0 teve counter warnings/Fixno: não chamar warning-free. W3 A2 foi recuperação MANUAL em outro inode e continua descrita assim. |
| 4. Apenas RealFS workspace/artifacts próprios, paths/symlinks/aliases sem escape | RealFSProvider/FsRpcService REAIS no entrypoint com VMdobrada: negativos lexicais/ancestor/forged inode parent em duas roots para quatro classes externas sintéticas (home/control/gitcache/otherWork), nativeFD write/reopen legítimo; correção limitada a metadata parentrealpath. X3 adiciona composição KERNEL/FUSE: guest write/rename/absolutealias/read ambos mounts em ambos boots e dados persistidos. | Não fingir que os negativos nativos eram VMs ou que smoke positivo repete todos negativos no kernel; não prova contra trusted-host comprometido. Registros do Controle permanecem fora das roots como demais dados host protegidos, não acessamos home/segredos reais. |
| 5. Supervisão por identidade, operação sem owner anterior e isolamento | Unit USER própria com owner/VM/subprocessos no mesmo grupo; private Boot/HostBoot/ns/full-rootCG2/controllers/managerCID/PIDticks correlacionados. W3 A1 ownerSIGKILL guardado levou à cessação independente; B1 permaneceu mesmo ativo. W3 B2 continuou mesmo ativo APÓS cleanup de A. X3 confirma novas identidades/cgroups/cessação por boot. | Stop A1 reconheceu já cessado, não fingir nova atuação contra VMM sobrevivente. SDK/model worker05 não foi implementado por03; não reabrir escopo como precondição circular. |
| 6. Tentativa graciosa/fallback próprio, cessação independente, disco forçado check antes do reuso | Adapter drena containers, valida daemon PID/exe/ticks/estado, TERM/wait/sync antes de close; systemd fallback group-bound próprio. Stop durável/retry barriers e correlação de cessação. X3 ambos guestFinalizationobserved; W3 check4 BLOQUEOU novo boot; regressão bitmap real confirma recusa antes do manager. Só autorização separada permitiu cópia/reparo/promoção W3. | terminationunconfirmed é honesto; sync/close/ACK/exit/defaultsGC isolados não são prova. Critério pede TENTAR gracioso, não teorema de toda parada graciosa. Nenhum autorepair de disco preservado. |
| 7. Piso/físico/virtual/config observáveis, admissão sem apagar/matar ativos | PUBLICobserve.storage com configuredVirtualBytes/minFreeBytes, QCowHeaderVirtual/allocated st_blocks, workspace/artifactlogical/allocated e FSavailable; testes nativos de alias/FIFO/race/limite/zero-vs-unknown. X3 active observa40Gvirtual,~630MBallocated,110Blogical por mount/8192Ballocated e4Gfloor; após remove retorna ABSENT explícito. Testes lowspace públicos recusam antes de intent/manager, reuso saudável idempotente/recuperação de espaço e disco alheio preservado. | Medidas pontuais, sem quota/reserva/CoW-exclusividade. consumo legado agregado/CPU/RAM continua unavailable. Não simulamos ENOSPC real em host com VMs ativas; prova de recusa é no seam externo de statfs com I/O nativo restante. Sem cleanup automático/stop de outro ambiente. |
| 8. Provas reais de persistência/perda de owner/isolamento | V3 nominal persistente, W3 simultâneo/fault/cessação/isolamento e cleanup, X3 complementa dados guest/FUSE/package state/storage público. Artefatos privados registram cada fonte e autorização, expectativas, resultados e recursos. | Doubles não substituem nenhuma dessas provas KVM/FS/cessação. W3 inicial acceptedfalse e reparo manual continuam preservados; piloto MVP não foi executado. |

## Fontes de evidência

- [Ciclo V3](03-v3-two-boots-qualified-subset.md).
- [Owner-loss W3 bloqueado por FS4](03-w3-owner-loss-gated.md),
  [uma cópia reparada](03-w3-copy-repair.md),
  [promoção manual/boots/cleanup seletivo](03-w3-recovered-boots-and-cleanup.md).
- [Confinamento nativo/RPC](03-workspace-confinement-local.md),
  [remoção local e partial retry](03-remove-local.md),
  [admissão de espaço](03-storage-admission-local.md).
- [Storage público/smoke local](03-storage-observation-and-guest-smoke-local.md),
  [pré-requisito Btrfs do gate completo](03-btrfs-controller-lock-gate.md).
- [X3 físico com dados guest, storage público e remoção](03-x3-persistence-and-storage-qualified.md).

A revisão63e43389 identificou os dois gaps AC3/7 após W3. Código local44/45 teve
review43e70826 sem achados; pré-requisito47 teve review8ae5f119 sem achados.
Revisão independente única X3 **1001f438**: OK com notas, sem lacuna técnica P1
concreta identificada no recorte dos oito critérios. P2 documental de timestamp
corrigido diretamente: gates completos primeiro às20:32:41.203Z, distinto da
amostragem .182Z; start-intent2 às.245Z. JSON originais conferidos, sem nova VM,
testes ou reviewchain. O revisor não recertificou todo código anterior nem concedeu
aceite humano/merge; não inferir fechamento de ticket de acceptedSubset.
Artefato review-x3-persistence-and-ac03-reconciliation.md em outputs/
1001f438-674a-4605-8ac6-b7f82b15f487 da sessão.

## V-02 / V-12 / V-14 sem extrapolar

- **V-02 /03:** perfil fixo/integridade/KVM/Alpine/Docker-vfs, nativeRealFS/FUSE,
  paths/cache/pacotes/Docker state/workspace persistentes sem reclone e owner-loss
  isolado demonstrados no recorte acima. Roles/modelos/ferramentas/read-only de
  revisores/handoff05 e Gitlocks/Testcontainers/Ryuk/CA-TLS/API/Compose/build06
  CONTINUAM pendentes nos tickets dependentes; não declarar V-02 integral verde.
- **V-12 /03:** owner loss, reconciliação independente do escopo e gate físico
  antes de substituto; indefinição falha fechado. Não houve todos os cortes de
  commit/ACK/reserva/scheduler/worker/modelo/push/PR/pergunta/GitHub. Não declarar
  reconciliação global ou ausência de efeitos duplicados do futuro MVP.
- **V-14 /03:** mecanismo seguro de publicremove com Work encerrado/cancelled e
  evidência preservada afirmados pelo host confiável; todos boots cessados,
  alvos próprios removidos/history retido, retry partial local e isolamento real
  W3. Workcancelled X3 é sintético, não cancelamento do domínio nem entrega/merge
  confirmado. Retenção30dias, varredura/elegibilidade e gates do agregado são dos
  tickets posteriores; nenhum recurso histórico foi liberado/excluído.

## Decisão pendente do operador

Os dois gaps técnicos nomeados após W3 agora têm implementação e prova na fronteira
real pertinente, com revisão técnica independente concluída e P2 documental
corrigido. Submeter a matriz e os limites, incluindo counter warnings, à avaliação
do operador; sem marcar automaticamente os checkboxes como aceite humano.
O ticket diz que merge/avaliação humana não são delegados. Destino local registrado
integration/software-factory-mvp continua b591ec7; branch/worktree03 e evidências
permanecem preservados. Nenhum push, integração ou nova autorização de VM inferida.
