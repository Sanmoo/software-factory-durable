# 03 — duas lacunas próprias: storage público e smoke fixo do guest (LOCAL)

A revisão63e43389 da qualificação [W3](03-w3-recovered-boots-and-cleanup.md)
identificou duas lacunas de fechamento03: persistência compacta de writablepaths/
workspace no guest, e uso físico/workspace observável no produto. Não exigiu
antecipar modelo/roles05 ou suítesGit/Testcontainers/Ryuk/TLS06.

## Interface existente: Sandbox.observe → storage

Somente o resultado público ganha projeção adicional, sem método/flag/testseam.
Refs continuam opacas, sem path/PID/unit/cgroup/QEMU para Controle. Valores byte
são strings decimais; cada amostra tem status observed/unavailable/absent.

- configuredVirtualBytes e minFreeBytes: configuração própria validada.
- disk.virtualBytes: header qcow2 observado, NÃO comprimento do arquivo qcow2.
- disk.allocatedBytes: st_blocks*512 do arquivo próprio; não reserva, quota ou
  bytes exclusivamente possuídos/reclamáveis em filesystemCoW/reflink.
- workspace/artifacts.logicalBytes: tamanhos de arquivos regulares por inode
  único; hardlinks não duplicam contagem. allocatedBytes inclui alocação dos
  inodes de diretórios e symlinks, mas NUNCA dados do alvo de symlink.
- filesystem.availableBytes: observação do filesystem próprio. Não libera
  reservas nem presume que arquivos mantidos em archives não consumam espaço.

Agregado/processos continuam consumptionunavailable; isso não suprime as amostras
independentes de storage. Sem monitor/framework, reserva, quota ou telemetriaCPU/RAM.
Medições são pontuais, não snapshot atômico ou prova de integridade/cessação.

O caminho INTERNO de start/stop/remove não percorre árvores para decidir efeitos:
observação de lifecycle continua separada. Falha de métricas não muda condição ou
cessationConfirmed. ausente só é relatado após removed já validado e ENOENT do
ALVO, não desaparecimento de descendente ou de /proc.

Treewalk abre raiz/filhos diretórios NOFOLLOW e enumera por FD pinado em
/proc/self/fd; leaf lstat não segue symlinks. Troca guest de diretório por symlink
não redireciona ancestrais da varredura. Rejeita mounts/UID/dev inesperados;
verifica identidade da raiz e mudanças de diretórios. Limites32níveis/10000entradas/
250ms retornam unavailable, não total parcial apresentado como completo.

### RED/GREEN

Teste pela interface pública, assets/ext4/qcow2 novos reais1GiB, sem VM. RED no
campo storage ausente. GREEN: virtual1GiB, piso4GiB, alocação física, workspace
128bytes únicos com hardlink e symlink para arquivo externo65536bytes não seguido,
comparação com du nativo independente, artifacts vazio medido explicitamente,
freebytes, alias de raiz unavailable, FIFOdisk sem hang, profundidade excedida e
race externa lstat→open substituindo diretório por symlink (nenhum FD externo
aberto). Durante calibração, du incluía alocação do inode do symlink: corrigida
contagem do PRÓPRIO inode, não seguindo alvo. Não foi relaxado isolamento.

Testes anteriores agora comparam lifecycle separadamente do campo aditivo e
verificam unavailable/absent explícitos; não foram enfraquecidos os predicados de
cessação/hostmismatch. W3 A/B JÁREMOVIDOS foram observados novamente pela interface
pública, sem actuação: removed/cestrue e três recursos absent, piso4/virtual
configurado40GiB/freefilesystem, sem números zero substituindo dados desconhecidos.
Registro novo w3/public-storage-removed-local.json declara delta não commitado;
não altera resultado anterior nem é uma nova VM/remoção.

## Mesmo perfil: readiness operacional de storage, sem hook de teste

O comando guest existente agora também testa os writablepaths aprovados e ambos
mounts FUSE. Implementação privada guest-storage.ts, referências env/boot fechadas
por regex antes de qualquer interpolação. Não recebe script/path/mount/flag de
caller ou modelo. Mesmos SDK/profile/assetpin4b6, tmpfsnone, journal inalterado,
console/debug desligados, deadline10s de exec, stdout/stderrIGNORE. Nenhum output
potencialmente volumoso volta a buffering default do SDK.

Em /root,/tmp,/var/tmp,/var/cache,/var/log,/var/cache/apk,/workspace,/artifacts:
área operacional reservada .factory-profile/storage-v1. Primeiro env|boot criado
com noclobber SOMENTE se ausente. Boots posteriores não sobrescrevem o valor;
validam arquivo regular/não symlink/conteúdo limitado160bytes/formato e ambiente.
Recriação após reset ganha bootNOVO: a inspeção independente após dois boots tem
como detectar perda, em vez de aceitar marcador regenerado como persistência.

Não há recibo/diário/autoridade de domínio novo. O dado smoke não autoriza chamadas,
Slots, recovery, integridade global ou cessação. Falha gera o diagnóstico guest-
profile já existente; não corrige/muta marcador existente silenciosamente. A raiz
/workspace é área do Trabalho, checkouts são filhos; .factory-profile fica fora
dos arquivos do PR, conforme separação operacional já requerida pelo contrato.

Nos dois mounts: subdiretório temporário exclusivo por boot, write→rename→symlink
absoluto guest→read, então remoção dos probes temporários. O stamp persistente não
é removido. Isso permite qualificar alias-routing pelo kernel/FUSE real quando
uma execução explícita for autorizada, conectando-o ao confinamento nativo/RPC
já testado. Nenhum corpo desse shell é executado no host.

### RED/GREEN e limite

No entrypoint real com VM externa dobrada, teste exigiu os paths/smoke e foi RED
com comando antigo; GREEN com novo comando. Teste verifica stdioignore, bound de
leitura, noclobber/identidade e alias/rename. /bin/sh-n no pai só analisa sintaxe;
não é execução de guest, FUSE real ou prova de persistência. Arquivos novos do
produto não modificam asset/kernel/initrd/template, não instalam APK/Git e não
constroem engine/toolprojection alternativa.

## Gates locais e próxima prova

Subsuíte104casos103pass/1VMskip/0fail, strict compile/build/arquitetura/ESLint
e diff-check. Revisão funcional única43e70826 das duas correções: sem achados,
OK local com limites de execução explícitos. LSP9checks sem achados mas todos
inconclusivos push-only, não certificado clean. Depois do último ajuste de
rawlength, a subsuíte foi reexecutada com sucesso, sem re-review chain.

A conferência de TODOS23arquivos.test também revelou e corrigiu um pré-requisito
[Btrfs/flock do Controle](03-btrfs-controller-lock-gate.md); não atribuir essa
falha às métricas nem omitir testes anteriores. Gate completo agregado apósfix:
141casos140pass/1VMskip/0fail em blocos104+20Controle/CLI+17arquitetura, arquitetura/
ESLint75módulos344dependências. TMPDIR curto R para caber o socket do teste de
aliases, FACTORY_SANDBOX_TEST_ROOT mantém product-local-clYJQT. Não relaxar limite
103 de socket para fazer teste passar. Nenhum driver manual/VM foi ativado.

NENHUMA nova VM/boot/falha/sinal/cleanup nesta implementação local. Orçamento43
foi consumido, antigos u3/v3/W3/UNKNOWN/cópias/archives preservados. Para fechar a
prova restante, pedir concessão separada de UM ambiente NOVO e até DOIS boots
sequenciais, segundo condicionado a firststop+ces+fschecks+stampsguest/host e
cinco amostras de package/config/cache; no segundo observar mesmos valores do
PRIMEIRO boot em todos os paths/mounts, sem reprepare/reclone/regeneração. Sem
imagem nova/fallback/reparo; falha interrompe. Remover apenas seu operacional após
evidências necessárias preservadas e cessação, não qualquer histórico anterior.
Ticket03 ainda não resolvido nem integrado antes dessa prova e reconciliação final.
