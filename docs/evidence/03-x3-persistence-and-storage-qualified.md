# 03 — X3: persistência guest/FUSE e storage público

## Escopo executado, não aceite humano

Nova autorização explícita do operador (`autorizo` à proposta final fechada),
2026-11-12. Fonte limpa **1c99baf1df8d4acad02d2e2dc6c1444c4d382d69**,
recompilada antes da execução sem alterar fontes. UM novo root exclusivo
`/home/sanmoo/software-factory-test/x3`, UM Work sintético
`public-persistence-mounts-x3`, exatamente DOIS boots sequenciais, uma VM ativa
por vez. Nenhum fault, retry, reparo, promoção, terceiro boot ou variação de imagem.

Perfil inalterado: Arch x86_64, QEMU/KVM/Alpine/Docker-vfs, 2048MiB/2CPU/40GiB
virtuais, startup30s/grace30s/exec10s, console none/debug false/stdio ignorado.
Assets32/assets com pin
`4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1`.
Preflight público: configuração/integridade válidas, nenhum check blocked,
headroom memória/espaço e root ausente conferidos. Prepare único pelo público.
Nenhum script caller/worker foi executado dentro do guest: somente o readiness
FIXO do produto. Driver privado chama o Q5 e usa leituras host independentes;
não importa SDK nem cria interface, flag ou filesystem alternativo.

Registros privados `x3/{execution-intent,preflight,prepare,start-intent-first,
start-intent-second,qualification-result}.json` e scripts `common.mjs` /
`qualify-once.mjs`, hashes registrados no intent. `node --check` passou, driver
rodou uma vez, exit0/37.8s, stdout/stderr privados exclusivos preservados. Limite
180s do comando físico permitiu finally; deadlines do SDK não foram alterados.

## Identidades e ordem real

Ambiente `env-21f9e8e53654a7105fb31be1a31d817d50c70e367bb094279a417a8fb1d889f8`.
Disco dev55/inode31366008 foi mantido nos dois boots, sem reprepare/reclone/reseed.

| | Primeiro | Segundo |
|---|---|---|
| Boot | `boot-0a33c502-b474-4b5f-a232-27632f4f5b3b` | `boot-106605d1-7c42-48de-a3a8-7aceb8b54438` |
| InvocationID | `06fcbc239c51446bb2530b54560c8d68` | `3367ef9d581c40dda814a09de40f688e` |
| Owner PID | 3317386 | 3317768 |
| VMM PID/ticks | 3317432 / 106461321 | 3317824 / 106462853 |
| Active observado UTC | 20:32:35.219 | 20:32:50.762 |
| Qcow SHA após stop | `361c009500e7de79fe15d3389cf5f4c5259aa02b9e7185cbd3bd653a7ea6e937` | `cc1f22de2f2924a051ddcceb6da336997b9f076347645d60b299e54d5d51024c` |

`active-first/second.json` correlacionam unit USER própria, CID, PID/ticks,
argv QEMU real (-kernel/-initrd/-accel kvm/-m2048M/-smp2/disco próprio), cgroup
exato e operational private; qemu --version/help não é witness de VMM. Observe
público active/cessationfalse em ambos. A amostra de persistência terminou às
20:32:41.182Z; os gates COMPLETOS foram registrados em first-gates-passed.json às
20:32:41.203Z, após observe/storage adicional. O segundo start-intent veio às
20:32:41.245Z. Não houve simultaneidade entre os boots.

Stop público nos dois: success, guestFinalization **observed**, termination
**unconfirmed**. `cessation-first/second.json` e `removed.json` fazem correlação
INDEPENDENTE: HostBoot37407e0a-d96d-4763-8347-581eb1dafd6b,
CGns4026531835/mntns4026531832, full-root cgroup2/magic/controllers, identidade
privada/CID próprio previamente ativo e cgroup exato realmente ausente. Units de
sucesso foram coletadas (not-found/defaults); defaults, PID ausente, ACK, sync e
close isolados NÃO provam cessação, exit/cause, consumo ou parada graciosa plena.

## Filesystem e oito dados realmente escritos pelo guest

Após cada cessação: qcow check0, cópia raw esparsa nova, e2fsck-f-n **exit0**, ext4
real **42949672960B**, SHA/metadados do qcow original estáveis durante inspeção e
cessação reconferida antes/depois. Nenhum hash integral dos raw40GiB foi feito.

**Não chamar ambos warning-free/absolutamente limpos:** o PRIMEIRO fsck-n retornou0
mas relatou free-block/free-inode counters diferentes com `Fix? no`; não houve
bitmapdiff ou exit4. O gate aprovado e do produto usa o exit0 mais geometria, não
uma alegação de ausência de todo aviso. Segundo fsck-n0 não reportou esses avisos.
Os stdout originais estão em `fsck-first/second.json`; preservados, não reescritos
como clean. Não atribuir causa, correção ou integridade universal apenas a esses
resultados. Nenhuma execução reparadora host ocorreu em X3.

O readiness fixo escreveu e não sobrescreveu `.factory-profile/storage-v1` em:

- `/root`, `/tmp`, `/var/tmp`, `/var/cache`, `/var/log`, `/var/cache/apk`;
- `/workspace` e `/artifacts`, pelos mounts FUSE reais do guest.

Cada valor é env|PRIMEIROBOOT,110bytes, sem newline; SHA comum
`fd07c0833f456d1160449a611cdb2bd84ea59b338ea1f9b94ca79d44983023d8`.
Se perdido/recriado no segundo boot, teria BOOT2 e falharia a comparação. Os seis
arquivos de root vieram de leituras debugfs nos snapshots read-only; os dois
backing files host foram escritos pelo GUEST e lidos por FD NOFOLLOW com identidade/
privacidade/tamanho rechecados. NÃO são fixtures hostseed. Nenhum host escreveu
esses stamps antes/depois dos boots.

O mesmo comando fixo faz, em AMBOS mounts e AMBOS boots, write exclusivo temporário,
rename, symlink ABSOLUTO guest, bounded read e remove só o probe. Operational só é
publicado após exit0 desse comando; isso liga o kernel/FUSE efetivo à fronteira
nativa/RPC já testada. Não repetimos artificialmente todas as negativas da fixture
nativa na VM nem afirmamos prova contra um trusted host comprometido.

`persistence-first/second.json` também mostram os MESMOS cinco hashes:

| Amostra | SHA256 |
|---|---|
| Docker engine-id (trim; bruto não gravado) | `7ef631eec7783adfb3a1492b68ef77eb887daacad9919354d7b561e24882aecf` |
| daemon.json | `7751e34eafe3a036bffcd189e7194b6320ac73dd64d9ba0b4c15ec709976c4db` |
| APK world | `595a7f978380e5a9a1a088f93bb23d67cb3862ecf7b2754a3a4ac1792b0321c2` |
| APK repositories | `680df3aa52f6778e1529e3e64b2b4ded9de96f8fed8d647b8bee06db919e6392` |
| APK installed DB | `c3542186879d1cc51b112370fcec5d866bb637eb06cc245a12e4adb74e5388fc` |

É persistência compacta dos writable paths/cache/estado de pacote e daemon, não
integridade de todo userdata, memória/processos preservados ou instalação APK
nova. Cache recebeu dado representativo real; nenhum pacote/pull/rede foi usado.

## Métricas PÚBLICAS, não somente JSON do qualificador

Os dois `alive` chamam o observe público e guardam sua projeção storage:

| Campo | Primeiro ativo | Segundo ativo |
|---|---|---|
| configurado virtual / header real | 42949672960 / 42949672960B | igual |
| allocatedBytes do qcow | 630001664B | 630067200B |
| workspace logical / allocated | 110 / 8192B | 110 / 8192B |
| artifacts logical / allocated | 110 / 8192B | 110 / 8192B |
| availableBytes do filesystem | 589767639040B | 588902961152B |
| piso configurado | 4294967296B | igual |

Todos esses status observed. A métrica agregada legada consumption continua
unavailable, não virou zero nem promessa de CPU/RAM. st_blocks é alocação por
arquivo, NÃO espaço exclusivo/reclaimable no CoW, quota, reserva ou teto contínuo.

## Remoção pública somente X3, após preservação

Depois de ambos cessados e todas as comparações passarem: cópias sincronizadas de
workspace/artifacts e regular files/symlinks dos DOIS runtimes em `x3/preserved`;
especiais como sockets só inventariados. Hash dos stamps arquivados conferido.
Snapshots/evidências/histórico ficam fora dos alvos. Work sintético declarado
cancelled, não é implementação de cancelamento do domínio.

`remove.json`: success dos quatro recursos. `removed.json`,20:32:58.098UTC:
root.qcow2/workspace/artifacts e runtimes dos dois boots realmente ausentes,
owner/ready/current/cleanup-request/removed/boot histories retidos. Observe público
removed/cessationtrue e storage.disk/workspace/artifacts **absent**, não zero.
Os dois próprios scopes rechecados com identidade+HostBoot/NS/fullRootCID+manager.

Retidos R37685022720B, filesystem livre588902961152B no final (observação pontual,
pequenos JSON posteriores crescem R). U3/V3/W3/UNKNOWN/noRetry, candidatos, archives,
snapshots, failed units e reservas históricos intocados. Não inferir liberação
por inventário ou apagar história. Só o orçamento X3 foi consumido:2starts/2op,
0fault/0retry/0repair/0newimage, acceptedSubsettrue, wholeTicket03Acceptedfalse,
integrationPerformedfalse. Nenhum GitHub/modelo/credencial, sudo/hostinstall/mount,
push ou integração. Operacionais X3 removidos; evidências X3 preservadas.

## Gate local e avaliação

Fontes de produto não mudaram neste incremento físico. Gate anterior exato da
fonte1c99baf: TODOS23arquivos.test/141casos140pass1VMskip0fail, strictcompile/build/
arch/ESLint75módulos344deps/diff. Rebuild anterior à execução passou. Não repetido
como prova de KVM; hardware acima é separado. LSP11inconclusivos push-only não é
certificado clean. Revisão independente única1001f438 do incremento X3/matriz:
OK com notas, nenhuma lacuna técnica P1 concreta identificada no recorte dos oito
critérios. Um P2 documental corrigido diretamente: horário dos gates completos
.203Z, separado da amostragem .182Z, antes do start-intent2 .245Z. Conferidos os
JSON originais; nenhuma nova execução ou reviewchain dos incrementos locais.
Artefato: outputs/1001f438-674a-4605-8ac6-b7f82b15f487/
review-x3-persistence-and-ac03-reconciliation.md, no diretório de subagent-artifacts
da sessão. Revisão read-only, sem reexecutar testes ou revalidar integralmente todo
código antigo; não concede aceite humano, merge ou novo orçamento físico.

Reconciliação técnica dos oito critérios em
[03-acceptance-reconciliation](03-acceptance-reconciliation.md). Nem o qualificador
nem o revisor são autoridade para aceite humano ou merge; nenhuma integração é
inferida do JSON acceptedSubset. Tickets05/06 e piloto MVP continuam fora da prova.
