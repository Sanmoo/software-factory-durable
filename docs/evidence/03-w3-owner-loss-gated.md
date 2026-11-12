# 03 — w3: owner-loss real confirmado; terceiro boot bloqueado por filesystem

## Resultado e autorização

Em2026-11-12, o operador respondeu **autorizo** ao escopo fechado do
[plano](03-remaining-qualification-plan.md): até3boots A1/B1/A2condicional em2novos
ambientes,1SIGKILL só no ownerA1, remoção apenas novosA/B após gates/evidência.
Executado fonte **719176a903bf2b30acb58a7f5f5fce307da4b067**, worktree limpo antes
da execução. Diretório novo exclusivo `/home/sanmoo/software-factory-test/w3`.

**Resultado global do cenário: não aceito.** Dois boots KVM reais operacionais,
uma falha específica do ownerA1; filesystem de A apresentou erro estrutural.
A2 NÃO foi chamado. Nenhuma remoção ou reparo executado; ambos ambientes parados
com cessação correlacionada e recursos/evidências preservados. A concessão não
vira autorização de outro boot ou reaproveitamento do terceiro após a falha.
Ticket03 permanece aberto, integração em b591ec7 intacta, sem push.

## Perfil/preflight sem variante

Arch Linux x86_64, kernel7.1.9-arch1-2, QEMU11.1.2, systemd262. Pin fixo
4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1,
assets32/assets sem alterações. Cada VM2048MiB/2CPU/40GiBvirtual, startup30s,
grace30s, KVM, microvm/CPUhost, serialnull, console/debug desligados, tmpfsnone.
Sem instalação/download/modelo/GitHub/credenciais, hostmount, backend alternativo,
flags livres ou harness antigo. SDK VM permaneceu interno ao adapter.

Preflight: memória disponível9185198080B, retido31416766464B no root de teste,
filesystem disponível592896245760B. Depois de preparar A/B:32674881536B retidos.
Valores são observações/admissão, não quotas ou reservas fortes; UNKNOWN/noRetry
antigos intactos. Doctor offline não foi promovido a certificado de release.

## Identidades reais

| Campo | A1 | B1 |
|---|---|---|
| Ambiente | env-3d16f0a88fcfe40efcc3e2405912436f57fa8478a218b933859c372bbc3ab109 | env-eeedbc1931c6bb51ae4941c298fe8a94447be0a9efdd2d44b162afa85a9dd42e |
| Boot | boot-ab96f297-7f80-4975-8d2e-5bb29170263c | boot-30111c18-8572-4f39-90f6-d54db53c4339 |
| InvocationID | 511afb53a8734d43b97ce1afc656e6a2 | 04b4c7b8a5484aa6ae356484503ce398 |
| Owner MainPID | 3171237 | 3171413 |
| VMM PID/startticks | 3171310/104899364 | 3171459/104900345 |
| Operacional observado | 16:12:15.692Z | 16:12:25.484Z |

HostBoot37407e0a-d96d-4763-8347-581eb1dafd6b, cgroupns4026531835/mntns4026531832.
Cada unit `factory-sandbox-<boot>.service` sob cgroup esperado
`/user.slice/user-1000.slice/user@1000.service/app.slice/<unit>`.
Witnesses verificaram kernel/initrd reais, KVM/2048M/2CPU, disco próprio, argv
não-version/help, PID+startticks e cgroup. Discos, units, VMMs e sockets por boot
distintos. As duas observações públicas foram active simultaneamente.

## Falha e isolamento de término

16:12:25.613Z: intenção exclusiva após validar ambiente/boot/InvocationID, owner
exe/cmdline exatos, PID+startticks104899124, namespaces/cgroup e duas leituras
estáveis do manager. Uma última correlação precedeu o efeito:

`systemctl --user kill --kill-whom=main --signal=SIGKILL <unit exata de A1>`

Somente ownerA1, não VMM/B/operador/prefixo global. Exit0 de envio não foi usado
como prova. Às16:12:25.977Z, manager A carregado/failed, MESMO InvocationID,
ExecMainCode2/ExecMainStatus9/Resultsignal/MainPID0. Hierarquia cgroup2 full-root,
magic/controllers/namespaces/HostBoot/identidade privada correlacionados e grupo
próprio ausente; observe stopped/cessationConfirmedtrue.

Stop público SEM handle SDK anterior reconheceu cessação já ocorrida: success,
guestFinalizationunavailable/terminationunconfirmed. Isso prova reconhecimento
host sem owner, não nova atuação de stop nem tentativa graciosa pelo owner morto.
B às16:12:26.022Z permaneceu active, mesmos VMM PID/ticks, InvocationID e cgroup.
Prova real de isolamento desse término, não de todos os acessos/data paths/roles.

## Gate de filesystem e parada de B

A passou qemu-imgcheck do container. Snapshot próprio read-only, depois
`e2fsck -f -n`: **exit4**, diferenças de bitmap `+557611`, freeblock/freeinode
counts divergentes, aviso de erros remanescentes; nenhuma correção aceita.
O gate do QUALIFICADOR interrompeu A2 ANTES de chamar Sandbox.start. Não alegar
que uma chamada real startA2 retornou código: essa chamada não foi feita.

Finally parou só B pelo contrato público: success/guestFinalizationobserved,
terminationunconfirmed, observe stopped/cessationtrue. Coleta independente de B
confirmou identidade privada + host/ns/full-rootCG2 e grupo próprio ausente.
Unit de B auto-GC/notfound: defaults Exit0/counters/CIDvazio NÃO provam sucesso
ou causa; a cessação foi correlacionada separadamente.

Follow-up read-only confirmou:

- A: features NÃO incluem has_journal, estado notclean. Geometria10485760*4096=
  42949672960B. Mesmo fsck4 reproduzido no snapshot, sem mudar dados/metadados
  relevantes do snapshot ou original durante essa inspeção. SHA qcow2 de A:
  d1bbabe2f94578da34fb39a8bb37e5333bc0927f8e12e7a9436a872161532b81.
- B: qcowcheck0/e2fsck-f-n0/geometria40GiB, original SHA/metadados estáveis na
  inspeção. **Mesmo exit0 reportou divergências de contadores livres**; não
  chamar isso de ausência de qualquer aviso. Não houve diferença de bitmap nem
  aviso final de erros remanescentes como A. Hash do engine-id criado pelo daemon
  em B291a707003f3f72d5a85ffa0ed6cbd78feea457715c2e7d71dab9591efd56cf5,
  sem rawID/keys. Não há prova de persistência A1→A2 porque A2 não ocorreu.

A ausência de journal e a diferença estrutural após o corte são compatíveis com
inconsistência de alocação por interrupção abrupta; não estabelecem sozinhas causa
exclusiva, reparabilidade ou perda integral de dados. Não retomar experiências de
imagem nem reparar original. Decidir recuperação explicitamente antes de agir.

Um coletor read-only v1 excedeu60s do processo NOVO; incluía hash integral de raw
40GiB lógico, sem timing de etapa que prove causa exclusiva. Original preservado;
v2 substituiu esse custo por SHA qcow2 + estabilidade de metadados, sem aumentar
timeout nem repetir VM/falha. v2 concluiu; não há atestado de hash integral do raw
ou de igualdade lógica original/snapshot proveniente daquele v1 interrompido.

## Registros e regressão local

Em w3: scope/preflight/prepares/execution-intent, witnesses A1/B1/two-active,
owner-fault-intent/sent, A1-ownerless-stop/manager-final, B1-after-owner-loss,
fsck-A1, qualification-error/result, finally-stop/observe, diagnósticos e
post-failure-resources; scripts de execução/leitura e snapshots preservados.
Os arquivos JSON são exclusivos/duráveis. Scripts comuns e qualificador têm SHA
registrado no execution-intent. Nenhum JSON original de falha foi reescrito.

Nova variante de teste local usa APENAS fixture nova: debugfsfreeb em bloco
previamente marcado inuse, e2fsck-n confirma bitmapdiff/exit4. Sandbox.start público
recusa PRESERVED_DISK_CHECK_REQUIRED sem manager/current novo e sem mudar SHA do
disco. Manager dobrado, filesystem/disco REAIS; não é outro boot nem reparo de A.
Política do produto já conservadora, sem alteração da implementação neste passo.
Revisão independente única610f9906 sem achados, OK com notas de escopo; não é
aceite integral. Gates finais:103casos102pass/1VMskip/0fail (~22.91s), strict
compile/build/arquitetura/ESLint72módulos323dependências/diff-check. LSP sem
achados retornados mas um check inconclusivo push-only, não clean confirmado.

Retido final33928835072B, livre591399493632B; ambos w3 cessados. Dados, snapshots,
runtimes e failedunitA mantidos; u3/v3/UNKNOWN/históricos intocados. Nenhuma limpeza
foi usada para criar espaço. Falta qualificação de remoção real e dos subcasos
restantes de V-02/V-12/V-14; não marcar critérios integrais ou ticket resolvido.
