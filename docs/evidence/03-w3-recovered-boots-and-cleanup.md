# 03 — W3: promoção autorizada, dois boots reais e cleanup próprio

## Resultado limitado

Após o [reparo somente em cópia](03-w3-copy-repair.md), o operador autorizou
explicitamente promoção controlada, até dois novos boots nos ambientes W3,
cleanup seletivo após gates e preservação dos originais/snapshots. Executado
2026-11-12, fonte **6c2b9980e702ca3c8192b7195075a9e4663d8e76**, checkout limpo.

**Cenário autorizado passou:** promoção manual, B2/A2 operacionais simultâneos,
A2 parado/verificado/removido mantendo B2 ativo e com mesma identidade; B2 depois
parado/verificado/removido. Exatamente2novas chamadas start e2boots KVM operacionais,
zero nova falha injetada, zero retry/variante. Isso NÃO é aceite integral automático
do ticket03/MVP; a matriz de critérios permanece separada.

## Promoção explícita: não foi recuperação automática

Ambientes e WorkIDs sintéticos de W3 mantidos, sem reprepare/reclone. Ambos
cessados por correlação independente antes da manutenção. Arquivos de cleanup
não existiam. Locks lifecycle exclusivos de A/B adquiridos em ordem estável;
identidade/WorkId, dados e checks verificados antes dos moves. Intenção durável
precedeu arquivo original sair do local operacional.

A cópia reparada40GiB foi revalidada com e2fsck-f-n0 e cinco hashes, convertida
em qcow2 standalone sem backing/externaldata, qemucheck0 e roundtrip raw com
fsck-f-n0/geometria40GiB/mesmas cinco amostras. Sem novo reparo, mount ou imagem.

- Original A foi ARQUIVADO, não corrigido: `w3/promotion-1/original-A.qcow2`,
  SHA d1bbabe2f94578da34fb39a8bb37e5333bc0927f8e12e7a9436a872161532b81.
  Mesmo inode/dados/mtime/UID/mode/nlink; rename pode alterar ctime, não foi
  falsamente declarado ctime idêntico.
- B original pré-B2 também preservado por cópia exclusiva em
  `w3/promotion-1/original-B-before-B2.qcow2`, SHA
  d10255868f7d343a15427e52040feb9c76749884a9bb35019f32dfed6155d97d.
- Novo arquivo operacional de A, inode31347875, SHA antes do boot
  e0960ce377ee624d6117cbb4904c485d6565a84eb387bc63a201cbd92318b82e.
  Substituição explícita do backing por manutenção autorizada: **não é o mesmo
  inode do disco A1**, nem alegação de recovery automático da Sandbox.
- Candidato raw reparado e snapshots antigos mantidos. Nenhum asset de template
  foi alterado; pin4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1.

Operação sob locks e syncs de arquivo/diretórios; nenhuma tentativa automática de
rollback/reparo se um move falhasse. Não foi criada API/framework de recovery.
A recuperação manual preserva a recusa segura anterior de A1 com fsck4.

## Dois boots e estado persistido

Mesmo perfil Arch7.1.9/x86_64/QEMU11.1.2/KVM/Alpine/Docker-vfs,2048MiB/2CPU/40GiB
por VM, max2simultâneas, startup30s/grace30s/serialnull, sem rede/pulls/modelo/GH,
credenciais, agent ou CLI SDK externos. VM só criada pelo adapter público start.

| Campo | B2 (primeiro) | A2 (recuperado) |
|---|---|---|
| Ambiente | env-eeedbc1931c6bb51ae4941c298fe8a94447be0a9efdd2d44b162afa85a9dd42e | env-3d16f0a88fcfe40efcc3e2405912436f57fa8478a218b933859c372bbc3ab109 |
| Boot | boot-af254021-5ec6-453d-88b2-3a8519a284fe | boot-019df5d7-98dc-4690-9ea1-7f2a02d4b68c |
| InvocationID | 2ceb87d7e7b3493085ec9367b4aa41ec | 86592713518c45e1865a107935f8ed84 |
| Owner MainPID | 3242972 | 3243111 |
| VMM PID/ticks | 3243020/105792777 | 3243170/105793792 |
| Active observado |18:41:09.802Z|18:41:19.904Z|

HostBoot37407e0a-d96d-4763-8347-581eb1dafd6b, nsCG4026531835/mnt4026531832.
Units/cgroups/runtimes e identidades VMM distintas; argv real KVM/kernel/initrd/
disco próprio, não version/help. Fonte exige guest Alpine e Docker info.Driver=vfs
antes de operacional; somente a VM não prova containers/TLS/Testcontainers.

A2 stop público success/guestFinalizationobserved/terminationunconfirmed. Cessação
independente pela identidade privada + manager + namespaces + full-rootcgroup2/
magic/controllers e grupo próprio ausente. Após parar: qcowcheck0, e2fsck-f-n0,
40GiB reais e originais de inspeção estáveis. Cinco hashes de engine-id/config
Docker/world/repos/bancoAPK iguais aos da cópia pré-boot (ver relatório anterior).
SHA do qcow2 após A2:4bce008935ac040137299aa1d3281b4b4fdafb59dad1618cad39fc96b218d2bf.
Não afirmar integridade de todos os dados nem ausência de escritas perdidas no crash.

B2 posterior: mesmo contrato de stop/cessação e checks0/40GiB; engine-id hash
291a707003f3f72d5a85ffa0ed6cbd78feea457715c2e7d71dab9591efd56cf5 igual a B1,
mesmo disco lógico/arquivo operacional sem reprepare. SHA pós-B2:
9533e95ff6329b45efff2e79ec13956f85598c2cdf97e89fdb8dc8ec193d3473.
Saídas e2fsck de ambos pós-boots não relataram as divergências vistas em A1/B1.
Ainda sem prova de tolerância futura a crash: filesystem continua sem journal.

## Cleanup pela API, mantendo o outro ambiente

Antes de cada remove: todos os boots daquele ambiente cessados; testWork declarado
cancelled pelo host confiável, sem cancelar ticket/Trabalho real. Workspace e
artifacts copiados/sincronizados fora dos alvos, hashes dos fixtures preservados.
Todos arquivos regulares/symlinks dos runtimes W3 arquivados; sockets/especiais
apenas inventariados, sem seguir links ou mounts. Snapshots raw e originais
arquivados fora de áreas removíveis. Arquivos dos fixtures são declaradamente
criados pelo HOST; não fingem ser escrita via FUSE no guest.

`Sandbox.remove` A retornou success: disk/workspace/artifacts/runtime removed.
Às18:41:29.893Z, observe removed/cessationtrue; ausência física de alvos/runtimes
A1+A2, históricos/owner/ready/current/cleanup-request/removed mantidos.
Às18:41:33.237Z, B2 CONTINUOU active: mesmo PID3243020/ticks105792777,
InvocationID2ceb87d7e7b3493085ec9367b4aa41ec e cgroup próprios.

Depois stop/checks/preservação de B2, remove B também success nos quatro recursos.
Às18:41:43.407Z, removed/cessationtrue, alvos/runtimesB1+B2 ausentes e histórico
mantido. Originais A/B arquivados tiveram SHA rechecado após ambas remoções.

Correlações independentes pós-cleanup de TODOS quatro boots confirmaram grupos
próprios ausentes, host/ns/full-rootCG2 e manager compatível. Unit A1 continua
failed com seu CID antigo/status9; não foi resetada. Units coletadas exibem
notfound/CID vazio/defaults: esses defaults NÃO são exit code/counters/causa ou
novo CID correlacionado; não substituem a prova independente de cessação.
`guestFinalizationobserved` não foi promovido a teorema de parada graciosa plena.

Somente recursos OPERACIONAIS A/B de W3 foram removidos, incluindo seus runtimes
anteriores A1/B1 explicitamente no escopo. U3/V3 e recursos anteriores/UNKNOWN/
noRetry intactos; nenhuma reserva histórica liberada por scan/PID/ACK/close.

## Artefatos e fronteiras de aceite

Em w3: promote-repaired-once.mjs, promotion-1-scope/intent/result; novo qualificador
qualify-after-recovery-once.mjs e post-recovery-execution-intent (hash dos scripts),
post-B2/A2-intent/start/active, post-two-active, post-A2/B2-stop/manager-final,
filesystem/fsck-post-A2/B2 e amostras, post-A/B-evidence-preserved/remove/removed,
post-B2-after-A-cleanup, post-recovery-result e stdout/stderr privados. Registros
novos exclusivos/duráveis, resultados negativos do primeiro W3 não reescritos.

Resultado final18:41:46.922Z: acceptedSubsettrue, newStartAttempts2,
confirmedOperationalBoots2, newFaultSignals0, wholeTicket03Acceptedfalse,
integrationPerformedfalse. Retido36432781312B, livre590060167168B. Runtimes e discos
operacionais removidos, evidência/históricos/cópia reparada/originais/snapshots
mantidos por intenção, não lixo automático. Nenhum quarto/terceiro boot adicional.

Sem código/teste de produto alterado nesta rodada; baseline103casos102pass/1VMskip
estrito/build/arch/ESLint72módulos323dependências é anterior e não foi repetido como
prova física. Gates reais agora são os checks e resultados acima + diff-check docs.

Faltam deliberadamente provas de tools/modelo/roles/handoff (ticket05), Docker
Testcontainers/Ryuk/TLS e Git/locks/renames via FUSE da suíte representativa(ticket06),
controle/reconciliação completa e pilotos. Não concluir esses tickets a partir de
start/Dockerinfo/FSRPC local ou cleanup. O aceite integral03 deve mapear seus OITO
critérios aos menores níveis fiéis, sem importar todos subcasos05/06 nem ignorar
uma fronteira que o próprio03 exige.

Revisão independente63e43389: sem achados no incremento43, OK com notas de escopo.
O mapeamento03 identificou DUAS lacunas reais ainda próprias do ticket: prova
compacta de persistência dos writablepaths/cache/workspace pelo guest através de
stop/start (não toda suíteGit/Docker06) e uso físico/disco/workspace observável
no PRODUTO (não apenas nos JSONs privados de qualificação). Não serão substituídas
por este resultado verde nem por consumptionunavailable constante. Source e
registros desta rodada continuam congelados; próximas mudanças locais tratam
essas lacunas e qualquer nova execução de VM exige novo orçamento específico.
