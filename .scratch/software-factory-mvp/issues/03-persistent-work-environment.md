# 03: Preparar, iniciar e parar um ambiente persistente por Trabalho

**What to build:** Uma integração autorizada prepara um ambiente próprio, inicia o guest, modifica dados e o desliga/reinicia sem perder disco ou workspace. O controlador consegue conhecer a condição e confirmar cessação mesmo se o proprietário anterior morrer.

**Blocked by:** [01: Preparar a instalação local e o gate de desenvolvimento](01-local-setup-and-development-gate.md)

**Status:** resolved

## Acceptance criteria

- [x] Interface pública de Sandbox permite validar sem boot, preparar idempotentemente, iniciar com boot novo, observar, parar e remover recursos próprios; refs são opacas para Controle e resultados distinguem sucesso, falha e indeterminação.
- [x] Perfil fixado usa Arch x86_64, QEMU/KVM e Alpine com assets íntegros; configuração aprovada é validada sem coerção e sem flags livres, scripts/mounts arbitrários ou fallback de aceleração.
- [x] Disco próprio persistente, rootDiskDeleteOnClose desabilitado e configuração de tmpfs aprovada preservam arquivos/pacotes/caches esperados entre boots, sem prometer preservar processos/RAM.
- [x] RealFSProvider expõe apenas workspace/artefatos próprios; testes de paths, symlinks e aliases negam escape para home, controlador, registros, cache Git ou outro Trabalho.
- [x] Systemd supervisiona adapter/workers/VMM/subprocessos por identidade; observação e parada host funcionam sem adapter anterior e não afetam outro ambiente.
- [x] Parada tenta cessação graciosa e depois término forçado próprio; pedido/exit code isolado não comprova cessação, e disco forçadamente parado é verificado antes de reuso.
- [x] Piso livre, espaço físico/virtual e configuração efetiva são observáveis; falta de espaço impede operações afetadas sem apagar recursos para abrir espaço nem matar ativo automaticamente.
- [x] Provas reais incluem ciclo persistente, falha do proprietário e isolamento entre ambientes; não usam dublê como prova de KVM, filesystem ou cessação.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 5.4, 7.1, 7.2, 7.3, 7.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-02, V-12, V-14 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Implementation checkpoint — BLOCKED

Desenvolvimento local autorizado; nenhum aceite acima está concluído. Após inspeção read-only,
QEMU/qemu-img não foram encontrados no PATH e nenhum perfil/asset de release foi fornecido.
Boot de VM, instalação, alteração de serviços e falha de proprietário não foram autorizados.
O supervisor aprovou um recorte parcial coerente apenas em `Sandbox.validate`, sem stubs de lifecycle.

Implementado diagnóstico de integridade com diretório explícito e SHA256 esperado do manifesto,
fornecidos pela composição confiável (não YAML); arquivos locais reais nos testes, sem boot,
download de imagem, descoberta de cache pessoal ou SDK irrestrito. Configuração válida não
é confundida com ambiente qualificado. Nenhuma prova de KVM, RealFSProvider/FUSE, systemd,
cessação ou persistência foi substituída por dublê.

[Evidência e lista completa das lacunas por critério](../../../docs/evidence/03-sandbox-validation-checkpoint.md).
Faltam o restante do lifecycle e todas as provas reais de V-02/V-12/V-14 pertinentes;
6 testes locais de validação e a suíte local verde não resolvem este ticket.
Status permanece não resolvido; preservar o checkpoint na branch local até autorização/pré-requisitos.

## Continuation checkpoint — PARTIAL (2026-11-05)

Autorização posterior e QEMU instalado permitiram continuar sem refazer o commit
anterior; rebase local sobre `b591ec7` preservou Controle/protocolo/CLI02. Implementado
`Sandbox.prepare` real, idempotente por Trabalho/configuração/pin, com identidade
registrada antes de efeitos, diretórios privados e cópia qcow2 standalone via
qemu-img. Sem stubs nem implementação pública de start/observe/stop/remove.

Prova real externa do SDK Gondolin0.14.0 em unit temporária systemd USER: dois boots
KVM distintos do asset upstream fixado preservam /root,/tmp e workspace RealFS;
teste opt-in do SDK + preparo público passou2/2. Isso NÃO comprova lifecycle público
completo, isolamento de paths ou cessação após morte do proprietário. Build nativo
rootless dos assets Alpine+git/gh/docker concluiu, mas seu boot real falhou no prazo
de60s para readiness; não foi declarado imagem homologada/Docker funcional.

Gate arquitetural/typecheck e suíte completa serial passam; `npm test` paralelo
falha no teste inalterado de readiness do ticket02 (linha43). Supervisor autorizou
commit parcial explícito; correção de pré-requisito pertence ao ticket04. Nenhuma
integração/resolução ou checkbox de aceite concluído. Zero VMs próprias vivas ao
checkpoint; assets/discos/logs identificados preservados somente no root autorizado.

[Evidência atual, inventário, hashes, comandos/resultados e os oito critérios ainda
incompletos](../../../docs/evidence/03-sandbox-validation-checkpoint.md#2026-11-05-continuation--partial-not-ticket-acceptance).
Próximo incremento: incorporar correção revisada do gate, diagnosticar boot da imagem
customizada e implementar adapter systemd persistido com start/observe/stop reais.

## Retomada simplificada — parcial

O operador aprovou voltar a comandos normais de validação local, com timeout
limitado aos processos recém-criados pelos próprios comandos. Os recursos e
registros anteriores são preservados, sem retomar o harness experimental.

A [retomada pragmática](../../../docs/evidence/03-pragmatic-restart.md) parte da
integração01/02 e reaproveita apenas validação de assets e preparo idempotente.
Typecheck, compilação, arquitetura/lint e16 testes focados passaram; a prova de
VM está explicitamente desabilitada. Lifecycle público, persistência entre boots,
isolamento e cessação ainda precisam de implementação/validação. Ticket não
resolvido e nenhum critério acima marcado como concluído.

Incremento seguinte: `Sandbox.observe` acrescentado ao módulo do produto, com
metadados privados/versionados, correlação de identidade e leitura do supervisor.
Cinco casos locais de recusa passaram; a revisão independente levou a correções
de FIFO e disponibilidade da hierarquia cgroup. A suíte focada atual passa21 casos
com uma prova de VM ignorada. Retornos ativo/parado ainda não qualificados com
VM real; início/parada/reinício persistente continuam pendentes nesse checkpoint.

Próximo incremento de fonte: `Sandbox.start` e proprietário Gondolin por boot sob
systemd implementados, com sucesso condicionado a readiness Alpine/Docker-vfs e
correlação VMM/supervisão. Uma revisão apontou paths Unix longos e GC de registry
compartilhado; corrigidos com runtime exclusivo por boot, sockets explícitos
limitados em bytes e recusa anterior à intenção. Testes locais passam29 casos,
com uma prova de VM ignorada; oito são recusas de start. Nenhuma VM/unit foi
iniciada/parada neste incremento; não é prova positiva de start. Reinício fica
explicitamente bloqueado até verificação do filesystem preservado. `stop`
público, reinício e provas reais continuavam pendentes nesse checkpoint, sem aceite
ou integração03. Detalhes na evidência da retomada pragmática.

Incremento de fonte seguinte: `Sandbox.stop` implementado com identidade privada,
invocação/cgroup/namespaces e pedido durável antes do efeito; só confirma cessação
pela observação existente. Uma revisão encontrou retry sem nova barreira de sync;
corrigido com fsync de arquivo seguro e diretório também no pedido já existente.
Três regressões foram RED e GREEN após a correção; dois casos adicionais impedem
atuação quando o novo sync falha. Esses cinco usam dublê externo do manager, sem
fallback para comando real, não uma prova de cessação de VM. Seis recusas anteriores
seguem passando. Rodada focada completa: 40 passaram, uma prova de VM ignorada,
nenhuma falha. Primeiro boot/parada reais, reinício/checagem de filesystem,
isolamento e demais critérios continuam pendentes; nenhum checkbox concluído.

O operador autorizou uma única VM própria para qualificar primeiro boot/parada.
Preflight de capacidade/integridade passou; `lc03` foi recusado antes de unit por
socket longo e preservado. `p3` criou unit, mas terminou antes de operacional;
observe real confirmou cessação e stop reconheceu ambiente já parado, não parada
ativa. Diagnóstico local encontrou erro na composição: SDK0.14 com
`autoStart:false` rejeita start antes de enviar boot (`sandbox is stopped`).
Corrigido para true, com start explícito/SDK privado/autoRestartfalse e guards
preservados. Uma revisão independente confirmou a correção sem qualificar asset.
Driver manual Q5 com root novo q3 está pronto para o primeiro boot efetivo;
nenhuma evidência negativa anterior foi apagada ou convertida em aceite.

Executada a tentativa autorizada corrigida em q3, fonte d94ff1a, mesmo pin
customizado: prepare passou; start falhou sem operacional, unit saiu1 após33s.
Observe confirmou cessação real do escopo próprio; stop reconheceu ambiente já
parado, não parada ativa/graciosa. O witness capturado era apenas `qemu --version`
e foi explicitamente desqualificado, preservando o original; filtro corrigido
sem rerodar VM. Resultado `accepted:false`, discos/units failed preservados.
Não há novo diagnóstico conclusivo de kernel: o erro específico do SDK não foi
preservado. É necessário diagnóstico seguro de startup antes de nova tentativa,
que exige outra autorização de VM. Nenhum critério de aceite ou integração03.

Diagnóstico de startup acrescentado na fonte: `failure.json` privado por boot,
fase/código em allowlist, projeção correlacionada no resultado público de start,
sem rawmessage/stack/env/stderr e sem relaxar cessação ou bloqueio de reuso. Uma
revisão encontrou publicação concorrente com close; corrigida na Promise de
startup compartilhada e fechamento único. Dois casos do entrypoint foram RED
antes da correção e GREEN depois, sem VM/sinais reais. Total novo: quatro testes
de produtor com fronteiras externas dubladas e seis de consumidor público.
Validação local: 50 passam/uma VM ignorada, typecheck/build/arquitetura/lint verdes.
Isso não preenche o diagnóstico perdido de q3, não muda `accepted:false` nem
comprova o produtor numa VM nesse checkpoint. Qualificação positiva/causa real
seguem pendentes.

Com nova autorização explícita, executada uma única tentativa em r3, fonte
dbbe0b2/diagnóstico fc0f69f, sem reusar q3. Prepare passou e foi capturado VMM
real com kernel/initrd, disco próprio e flags KVM/2048M/2vCPU. Start falhou em
`vm-start / GUEST_READINESS_TIMEOUT`, agora persistido e projetado no resultado
público. Não chegou ao check de Docker-vfs. Unit saiu1 após~32s; observe confirmou
cessação real do escopo próprio e stop reconheceu recurso já parado, não parada
ativa/graciosa. `accepted:false`, nenhum reboot/retry. Diagnóstico/cessação deste
caso comprovados; primeiro boot operacional/perfil não qualificados. Root r3 e
anteriores preservados; autorização consumida. Próximo: investigar guest/handshake
e composição dos assets, sem repetir VM sem nova autorização ou chamar timeout
sozinho de prova de defeito no kernel. Nenhum checkbox ou integração03 concluído.

[Inspeção local dos assets](../../../docs/evidence/03-guest-asset-inspection.md),
sem outro boot: rótulos de kernel/módulos rootfs/initramfs coincidem em cada
conjunto; isso não prova ABI nem causa do timeout. O init extraído da customizada
é idêntico ao da base e a receita não configura hook Docker/cgroup; só acrescenta
pacotes. O builder tem `rootfsInitExtra` para essa composição. Seu resolver também
remove restrições `=versão` e o cache só tem linux-virt6.18.60: não prometer pin58
apenas mudando uma string. Correção exige inputs/receita coerentes, sem misturar
assets ou repetir VM sem alteração fundamentada; investigação ainda não resolveu
o readiness.

Com autorização somente para fontes Alpine/build nativo, preparados inputs e
[candidatos experimentais](../../../docs/evidence/03-alpine-native-candidate.md)
em `assets29`, sem VM/hostinstall. Kernel e módulos58 vieram da mesma ISO oficial
3.23.7, checksum publicado conferido, kernel idêntico à base conhecida; hook
Docker-vfs/cgroup acrescentado via API nativa. Corrigido no staging um link de
boot absolutizado pelo extrator; v1 preservada. V2 pin `72060acb...` passou hashes,
comparação de906 arquivos regulares de módulos e e2fsck read-only; initrd tem
cinco `.ko`, sem alegar ABI completa/runtime ou filesystem40GiB.

**Bloqueador P1 da revisão única:** SDK extrai pacotes mas não atualiza o banco
APK. No ext4 final, Docker/Git não registrados e zlibDB1.3.2 difere de libz1.4.
`validation-v2/result.json`: `BLOCKED_APK_DATABASE_NOT_COHERENT`, `accepted:false`.
Gates locais:53pass/1VMskip, typecheck/build/arquitetura/lint; não qualificam imagem.
Próximo: transação APK real, não DB fabricado/forkSDK. APK estático oficial e docs
baixados como inputs, NÃO executados; avaliar ferramenta adicional rootless em
namespace exige decisão de execução fora do escopo de apenas aquisição/build
nativo. Nenhum avanço de aceite03, nova VM, integração, push ou limpeza.

Após autorização adicional, [empacotamento APK real corrigido](../../../docs/evidence/03-apk-rootless-image.md)
em `assets30`, sem VM/hostinstall/sudo. Ferramenta APK com assinatura validada,
namespace rootless/offline, scripts/hooks desativados; transação limpa74 pacotes,
inclusive duas dependências condicionais que faltavam no cache. SDK extrator
bypassado, assembly nativo mantido com payload/banco genuínos. Corrigidos ownership
raw paraUID/GID0 e modos de diretórios; finalização limitada aos dois tmp sticky
em nova cópia do raw, seguida de manifesto SDK recalculado. Originais/falhas retidos.

Final `assets30/assets-final`, pin `960b256c...`: banco/versões/digests reais de
Docker/Git/zlib conferidos, audit APK system+permissions sem achados (exclui configs
protegidas/arquivos Factory não gerenciados), e2fsck read-only0 e integrity pública
ok. Coorte58/906 arquivos/cinco módulos de boot verificados. P1 de registro APK
corrigido; isso não determina causa r3 nem prova Docker/boot/TLS/persistência/parada
ativa. `runtimeAccepted:false`. Nova VM exige autorização própria; ticket03
continua sem aceite, integração, push ou cleanup.

Com autorização própria, [tentativa única s3 com a imagem corrigida](../../../docs/evidence/03-s3-lifecycle-failed.md),
fonte `45e830c`, prepare passou e witness real KVM/2048M/2CPU/disco próprio foi
capturado. Novamente `vm-start/GUEST_READINESS_TIMEOUT`, sem operacional/check
Docker. Unit rodou32s e saiu1. Cessação correlacionada por invocation/hostBoot/NS,
cgroup exato ausente e observação pública; antes de stop já estava parado, não
parada ativa/graciosa. `activeBeforeStop:false`, `accepted:false`. Sem retry.

Comparação read-only do qcow2 com o template retornou0, avisando diferença de
capacidade e considerando tail de zeros: nenhuma diferença lógica persistida
detectada, não prova de que o guest nunca rodou. Diagnóstico não identifica
último estágio de kernel/init/control/VFS; console/debug atuais são desativados.
Próximo sinal necessário: marcadores de boot privados/limitados, sem conteúdo
bruto de guest. Não atribuir causa ao kernel/Docker nem trocar imagem/aumentar
timeout às cegas. Autorização consumida; nenhum outro VM/start autorizado. s3,
disco, failed unit e evidências preservados; ticket03 continua incompleto.

Nova autorização executada em [diagnóstico único t3](../../../docs/evidence/03-t3-diagnostic-failed.md),
fonte `c5c9377`, mesma imagem960b256c/timeout30/recursos. Observador privado
revisado (9a6d7806, sem P1/P2 no recorte temporário), 62pass/1VMskip/strictgates.
Marcadores reais: console-text-observed/acpi-text, callbacks100/oversized0; nada
bruto gravado. Sem marcador Rootinit/sandboxfs, mas ausência não prova ausência de
execução nem causa ACPI. VMM real KVM/2048M/2CPU capturado; novamente SDKtimeout,
sem operacional/check Docker. Cessação própria revalidada por CID/NS/CG e facade,
antes de stop já parado; `accepted:false`. Discos/failed units/evidências retidos.

Comparação apenas read-only com prova antiga: microvm/KVM/CPUhost/2CPU/2048M e
opções básicas coincidem, assim como kernel58, init de initramfs, BusyBox/musl e
cinco ELF de módulos após descompressão; archives completos/metadados diferem.
Não há fundamento observado para acpi=off. Próxima proposta é variar SOMENTE o
archive initramfs58 da prova antiga, mantendo kernel58 idêntico e rootfs Docker-vfs
novo, declarando variante/pin/proveniência e demais parâmetros fixos. Ainda não
montada/autorizada; não é fallback para rootfs sem Docker. Outra VM exige nova
decisão, autorização t3 consumida. Instrumentação temporária não é liberada para
workers/integração; ticket03 segue incompleto, sem push/merge/cleanup.

O operador autorizou a variante e UMA VM e pediu critério de saída. Foi fixado
**último ensaio discriminante**: negativo/inconclusivo encerra boots/variantes e
leva à reavaliação; positivo congela composição e encerra exploração de imagem.
[u3 passou a fatia nominal](../../../docs/evidence/03-u3-initramfs-comparison.md),
fonte8a78de5, pin4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1,
só checksum de asset initramfs mudou, kernel58/rootfs novo Docker-vfs idênticos.
Prepare/start success, comando real Alpine/Docker-vfs/sync, VMM KVM2048M2CPU,
antes de stop active, depois stopped/cessationtrue. `result.accepted:true` é
somente o predicado nominal desse driver, **não o aceite do ticket03**.
Stop ainda terminationunconfirmed/guestFinalizationunavailable: sem prova de
parada graciosa. Manager coletou unit de sucesso; show not-found/CIDvazio não
prova exit status/consumo. Nova observe correlacionou metadados prévios próprios,
host/NS/full-root/controller-v2 e cgroup exato ausente; recursos preservados.

Congelar referência assets32/assets com initramfs publicado58; parar variações
kernel/imagem/flags/timeout. Causa interna da diferença de archive desconhecida,
sem repetibilidade/release comprovada. Não há motivo observado para abandonar
agora SDK/KVM; próximo trabalho é fechar finalização graciosa,
filesystem/crescimento/restart/persistência/isolamento/owner-loss/tools/remove e
retirar debug temporário antes de workers. Nenhum novo boot nesta autorização;
qualificação futura precisa escopo/critério/orçamento fechados, não outra série
exploratória. Integração b591ec7 intocada, ticket03 incompleto, sem push/cleanup.

Continuação autônoma local: [finalização guest](../../../docs/evidence/03-guest-finalization-local.md)
em78643f5 substitui rc-service ausente no perfil pelo daemon direto, valida
PID/exe/starttime e drena containers sem pipeline que mascare erro. Reviewfb1b7c27
achou P1 de zombie em kill-0; corrigido diretamente por estado stat Z/X/identidade,
sem cadeia de revisão. Evidência de sync aguarda publicação antes de close;
timeout/nonzero/writefailure não fabricam graceful. Gates73casos72pass1VMskip.

[Filesystem e consolidação](../../../docs/evidence/03-filesystem-preparation-local.md):
medição mostrou823132160B(~785MiB) de ext4 no template, não40GiB úteis. prepare
agora cresce/verifica cópia por ambiente; pin/template4b6 intocados. Novo start
exige snapshot privado + full read-only e2fsck + geometria real, original
inalterado e cessação antes/depois; permite tentativa de novo boot só se válido.
Corrupção/tamanho errado/backing/cessação desconhecida bloqueiam sem reparar ou
substituir current. Console/debug temporários foram retirados (none/false/null),
sem flag de worker. Review32d0bfff sem P1/P2;78casos77pass1VMskip, strictgates.
Native helper tem30s por processo, não prazo global; storage livre não é reserva.

Nenhuma VM desta continuação, nem novo dado real de graceful/restart/persistência.
Próxima qualificação deve ser fixa/fechada: mesmo pin, ambiente novo, dois boots
sequenciais condicionados à finalização/FScheck do primeiro, estado Docker
persistido verificado sem credenciais/agentes/retry, sem reabrir variantes. Ainda
não autorizada. Projeção de ferramentas/isolamento/owner-loss/remove seguem
pendentes; ticket03 continua incompleto, integração/push/cleanup não realizados.

Nova autorização explícita e [qualificação v3 de dois boots](../../../docs/evidence/03-v3-two-boots-qualified-subset.md)
executadas fontecb5ec0a, MESMO pin4b6/2GiB2CPU/disco40GiB/timeout30, um ambiente
novo único e VMMs sequenciais distintos. Ambos start/perfil success, active antes
de stop, guestFinalizationobserved, after stopped/cessationtrue. Verificações
independentes após cada parada: ownhost/NS/full-root/controllers/CG/metadados,
qcowcheck0/e2fsck-fn0 e ext4REAL42949672960B, original inalterado durante inspeção.
Segundo boot só após todos os gates do primeiro, sem reprepare/recriar template.

Estado não secreto criado pelo Docker (engine-id ausente no template) teve mesmo
hash após os dois boots; identificador bruto/chaves/credenciais não capturados.
Isso qualifica persistência DESSE estado, não todos os arquivos/pacotes/caches ou
workspace. Terminationunconfirmed continua: sync/evidence não provam shutdown
gracioso completo. Finalização agora observada em hardware; sem promover outros
critérios. Fonte imutável, console serialnull real, sem agentes/pulls/rede/modelos.

Um erro de contexto DBus no coletor read-only foi diagnosticado/corrigido com
leituras; não houve retry de VM. Dois boots consumidos, nenhum terceiro/variante.
R31416725504B retidos<80GiB; históricosUNKNOWN/noRetry/discos/units/runtimes/snapshots
preservados, sem liberação por inventory. Ainda faltam remove/escapes RealFS,
owner-loss/isolamento entre ambientes e demais provas do contrato. Checkboxes
integrais continuam abertos; integração b591ec7 intocada, sem push/cleanup.

[Remoção local](../../../docs/evidence/03-remove-local.md) implementada no Q5:
cleanup host vinculado ao Work encerrado/evidência preservada, lock de lifecycle,
cessação de todos os boots antes de cada efeito, alvos próprios fixos e resultados
individuais/parciais. Root aliases/mounts/hardlinks compartilhados recusados,
links descendentes não seguidos. Histórico/identidades/evidências permanecem;
cleanup pendente impede start/prepare recriarem recursos. Observe removed exige
provas de cessação e ausência, não receipt isolado. Nenhum u3/v3/UNKNOWN removido.

Revisão ab431421 encontrou dois P1 de retry: perda de owner interno após rm parcial
e removed.json malformado por escrita interrompida. Corrigidos diretamente,
identidade de runtime guardada fora da subárvore e publicação atômica exclusiva
com recuperação estrita da janela link/unlink. RED2/GREEN2 + regressões de alias
recriado, hardlink-publication e final malformado recusado. Sem cadeia de revisão.
100casos99pass1VMskip, strictgates/arch71módulos318deps. Managerdoubles e dados novos
não provam cleanup real de VM; prepared-sem-boot/metadata insuficiente ainda
recusado conservadoramente. Prosseguir confinamento RealFS e depois qualificação
real de isolamento/owner-loss/cleanup com orçamento próprio; ticket ainda aberto.

[Confinamento local RealFS](../../../docs/evidence/03-workspace-confinement-local.md):
repro no entrypoint real usando RealFSProvider/FsRpcService REAIS e VMdobrada
mostrou lookup RPC malformado por inode de symlink expondo metadata de fixture
fora do workspace. Corrigido com validação do pai por realpath público antes de
lstat/readlink async/sync, preservando provider/FD/mutações/fila serial nativos.
Sem fork do SDK/engine ou nova flag/interface de worker. Ambos mounts privados
conferidos, quatro classes de destino externo por mount negadas, symlink interno
e FDread/write/reabertura legítimos preservados. Nenhum dado pessoal acessado.
Review53c769a3 sem achados;101casos100pass1VMskip strictgates/arch72módulos321deps.
Isso fecha o bug de fronteira testada, não substitui prova kernel/FUSE/hardware,
isolamento entre ambientes ou perda do owner. Imagem4b6 e históricos intocados.

[Admissão de storage](../../../docs/evidence/03-storage-admission-local.md): falta
conhecida de espaço antes deixava owner sem disco e impossibilitava retry mesmo
após espaço restaurado. Repro público RED corrigido movendo checks de capacidade/
espaço de novos ambientes antes do mkdir por Work; intenção continua durável
antes de todo efeito nativo, mkdirEXCL resolve corrida, existentes incompletos não
são adotados. Reuso idempotente saudável sob pressão e novo prepare do MESMO Work
após recuperar espaço passam, sem mudar disco de outro ambiente. Start baixo espaço
recusa antes do manager e preserva current/SHA. Review38a5ebc9 sem achados;
102casos101pass/1VMskip strictgates/arch72módulos323deps. Storage é admissão pontual,
não quota/reserva ou teste ENOSPC real com ativo. Qualificação física restante
precisa de concessão específica; orçamento v3 permanece consumido.

[W3 autorizado e executado parcialmente](../../../docs/evidence/03-w3-owner-loss-gated.md),
fonte719176a: A1/B1 reais KVM operacionais simultâneos, uma falha SIGKILL no ownerA1
exato com identidade/cgroup/namespaces/manager correlacionados. Cessação A sem
owner confirmada, stop público reconheceu já cessado, B manteve mesmos VMM/CID
ativos após o fault. Snapshot A apresentou bitmapdiff/contadores e e2fsck-n4;
gate do qualificador NÃO chamou A2 nem cleanup, sem reparo/retry/variante. B parado
pelo público no finally, guestfinalizationobserved e cessação independente. Ambos
originais/runtimes/snapshots/evidências mantidos. A não tem journal/notclean;
repetição read-only mantém fsck4 e fonte estável. B fsck0 mas contadores reportados,
logo não afirmar ausência de avisos. Não há persistência A1→A2 ou remoção real
qualificada. Terceiro boot condicional não pode ser reposto/reaproveitado após
falha sem nova decisão. Regressão com bitmap inconsistente em fixture NOVA real
confirma recusa pública antes do manager, sem mutar disco/current. Ticket continua
aberto, nenhum checkbox integral concluído nem integração; recuperação de A exige
decisão/autorização explícita, não reabre exploração da imagem.

[Uma cópia descartável reparada](../../../docs/evidence/03-w3-copy-repair.md), com
nova autorização explícita: qcow2A→raw esparso novo, baselinefsck4, uma execução
fsck-f-y somente na cópia corrigiu bitmap/contadores (exit1), seguida de fsck-f-n0
/headerclean/40GiB. Cinco hashes legíveis iguais antes/depois (engine-idDocker,
configDaemon, world/repos/bancoAPK); os-releaseunavailable não foi promovido a
verificado. SourceA/B SHA+metadados e snapshots raw metadados estáveis, pin4b6
revalidado, ambos cessados independentemente; não alegar hash integral dos raw.
Original permanece sem reparo, candidato não promovido, zero novos boots/cleanup.
Isso comprova reparo estrutural na cópia e amostras, não perda zero de todos os
dados, boot funcional ou recuperação automática. Ticket ainda aberto; promoção/
continuação física dependem de novo escopo, sem reaproveitar terceiroboot bloqueado.

[Promoção/boots/cleanup W3 autorizados e concluídos](../../../docs/evidence/03-w3-recovered-boots-and-cleanup.md):
fonte6c2b998, originalA arquivado com SHA/inode preservados (ctime pode mudar no
rename), Boriginalpré-B2 copiado/verificado; qcow2 standalone da cópia reparada
promovido sob locks/syncs, roundtripFS0/40GiB/cincohashes iguais. Exatos2novosboots
B2/A2 KVM operacionais, cincohashes A apósboot iguais e engine-id B1/B2igual.
A2parado/checks0/cessaçãoindep e remove público success quatrorecursos; B2 permaneceu
active mesmoVMM/CID apóscleanupA. Depois B2parado/checks0/removido pelo público.
Alvos/runtimes próprios W3 ausentes, owner/ready/current/boots/markers/histórico e
originais/snapshots/evidências preservados; U3/V3/UNKNOWN anteriores intocados.
Guestfinalizationobserved/terminationunconfirmed não são prova graciosa plena.
Review63e43389 sem achados no cenário; ainda duas lacunas de aceite03: persistência
compacta dos writablepaths/cache e workspace via guest/FUSE no perfil atual, e
consumo físico/disco/workspace observável pela interface do produto. Não importar
toda suíte05/06 nem declarar esses requisitos cumpridos por fixturehost ou JSON
privado. Orçamento43 consumido; nenhum boot/falha/cleanup extra implícito. Ticket
permanece aberto até fechar os dois gaps próprios, sem integração parcial.

[Correções locais dos gaps](../../../docs/evidence/03-storage-observation-and-guest-smoke-local.md):
observe público agora retorna storage físico/virtual/workspace/artifacts/freefloor
com statuses observed/unavailable/absent, sem caminhos/PIDs ou inferir cessação;
treewalk pinado por FD/NOFOLLOW contra races de guest, orçamento finito e medição
nativa em fixtures reais. Readiness guest fixo, sem hook/flag de teste, escreve
primeiro stamp em oito paths aprovados sem sobrescrevê-lo nos boots seguintes;
renames/alias absoluto pelos dois mounts têm smoke privado e stdout/stderrignore.
Área .factory-profile é operacional, fora do checkout/PR, não autoridade/recibo.
Ambos RED/GREEN na interface pública aprovada; review43e70826 sem achados. Execução
de shell/FUSE e stamps entre boots continuam PENDENTES de prova real nova, não
confundir sh-n/VMdobrada com KVM. [Plano fechado](../../../docs/evidence/03-final-persistence-qualification-plan.md)
pede um novo ambiente e até dois boots sequenciais, sem reprepare/reclone, imagem
nova, falha/reparo ou cleanup histórico; ainda não autorizado.

[Gate Btrfs de Controle](../../../docs/evidence/03-btrfs-controller-lock-gate.md):
conferência de todos testes anteriores encontrou st_dev virtual55 versus
/proc/locks device29 no mesmo FLOCK real, rejeitando owner legítimo. Corrigida
correlação por descriptor herdado/canonicaldev+ino/fdinfoWRITEFLOCKPIDatualrange0EOF
com rechecks, sem remover exclusão kernel ou criar autoridade por PID. Nova
recusa real de shared/unrelated lock antes de SQLite; review8ae5f119 sem achados.
Suíte completa23arquivos:141casos140pass/1VMskip0fail, strictbuild/typecheck/arch/
ESLint75módulos344deps; TMPDIR curto nos testes de socket sem relaxar103bytes.
Estas correções não iniciaram VMs, não mudaram imagem ou registros antigos e não
concluem ainda a prova física de persistência do perfil estendido.

Após nova autorização explícita, [X3 executado](../../../docs/evidence/03-x3-persistence-and-storage-qualified.md)
fonte limpa1c99baf: um ambiente novo, exatos2boots SEQUENCIAIS KVM do MESMO disco
(dev55/inode31366008), mesmo pin4b6/recursos/deadlines, sem reprepare/reclone/reseed.
O readiness FIXO escreveu110bytes em oito paths e fez write/rename/alias absoluto/
read nos DOIS mounts pelos guests reais nos DOIS boots. Após paradas/cessação
independente, seis stamps via snapshotroot + dois backing files host ESCRITOSPELO
GUEST mantiveram env|PRIMEIROBOOT (SHAfd07c083...), mais mesmos5hashes APK/daemon/
engine-id. Nenhum hostseed contado como prova. Nativeqco0/fsck-f-nexit0/40GiB após
cada parada, original estável nas inspeções. PRIMEIRO fsck0 continha counterwarnings
com Fixno, não chamar warning-free; segundo0 sem esses avisos. Sem reparo host ou
bitmapdiff/exit4 omitido. Guestfinalizationobserved/terminationunconfirmed nos dois,
sem fabricar teorema de graceful. HostBoot/NS/fullRootCG2/controllers/CID privado/
manager/grupo exato ausente comprovam cessação, não ACK/close/PID/defaults isolados.

Observe PÚBLICO efetivamente mediu40GiBvirtual/~630MBallocated, workspace/artifacts
110Blogical/8192Ballocated por mount,4GiBfloor/freebytes. Depois de preservar e
sincronizar dados/runtimes/evidências e revalidar todos boots cessados, publicremove
success quatrorecursos somenteX3; ausência física própria verificada/histórico
retido, storage.disk/workspace/artifactsABSENT nãozero. R37685022720B/free588902961152
no fim; históricosU3/V3/W3/UNKNOWN/noRetry e arquivos/snapshots/candidatos intocados.
OrçamentoX3consumido:2starts2op0fault0retry0repair0newimage. acceptedSubsettrue NÃO
aceitehumano/integration: ver [oito critérios no nível fiel](../../../docs/evidence/03-acceptance-reconciliation.md).
A revisão única deste incremento e avaliação do operador são separadas; não marcar
checkboxes ou resolução/merge automaticamente. Destino b591ec7 continua intacto,
fontes de produto iguais ao gate completo141casos140pass1VMskip/strictbuild/arch/
ESLint75módulos344deps. Sem novo modelo/GitHub/credenciais/rede/hostinstall/mount,
nenhum push/integração/limpeza de branch/worktree. MVP e tickets05/06 seguem pendentes.

Revisão independente única1001f438 concluída: OK com notas para X3/matriz, nenhuma
lacuna técnica P1 concreta identificada no recorte dos oito critérios. Achado P2
apenas documental corrigido diretamente: gates completos1 às20:32:41.203Z, não o
horário da amostragem.182Z; start-intent2 às.245Z confirma sequência. JSON originais
conferidos, sem rerun/VM/re-review. Pronto para AVALIAÇÃO HUMANA dos oito critérios
na matriz; não é resolução automática, aceite do MVP ou autorização de merge.
Aguardar decisão do operador antes de marcar aceite/resolver/integrar localmente.
Branch/worktree e evidências permanecem preservados; escopo físico X3 consumido.

## Answer

Ticket03 tecnicamente concluído no recorte dos oito critérios, conforme a
[matriz de reconciliação](../../../docs/evidence/03-acceptance-reconciliation.md),
a fonte de produto1c99baf e o tip revisado68d9dbb. Checkboxes registram conclusão
técnica, não um novo aceite humano do MVP. Gate local completo já registrado:
23arquivos/141casos/140pass/1VMskip/0fail, typecheck/build/arquitetura/ESLint
75módulos344deps. V3/W3/X3 fornecem as provas reais pertinentes; revisão única
1001f438 sem lacuna técnica P1 concreta nos oito critérios, P2 de timestamp
corrigido antes desta resolução. Nenhum teste ou VM foi repetido neste fechamento
documental.

## Comments

### Supersessão explícita do processo de integração local

Nesta retomada, o operador reafirmou **implement-spec para toda a spec**, com
merger separado e integração local por ticket concluído, **sem exigir outra
aprovação humana de merge local por ticket**. Essa direção SUPERA a espera do
último checkpoint acima e as referências históricas equivalentes a um hold local.
Destino registrado: `integration/software-factory-mvp`, checkout
`.worktrees/software-factory-mvp`, head original
`b591ec7218563b5c73d9c885a6f9f28826b56b89`; integração somente fast-forward do
branch `implement/software-factory-mvp-03-pragmatic`, após commit desta resolução
e verificação de branch/head/clean/ancestry pelo merger. Este registro não alega
que o merge já ocorreu; o resultado Git é registrado pelo merger separadamente.

Não altera a política canônica de merge humano de PRs do PRODUTO, não concede
aceite humano do MVP/piloto nem fecha05/06 ou V-02/V-12/V-14 integrais. Permanecem
os limites da matriz: primeiro fsck X3 exit0 com counter warnings/Fixno,
terminationunconfirmed apesar de guestFinalizationobserved, amostras compactas
(não perda zero), W3 inicial fsck4/acceptedfalse e recuperação MANUAL em inode
novo. Nenhum orçamento físico é renovado; registros e recursos históricos ficam
preservados, inclusive este worktree03 até o cleanup final da skill. Sem push,
PR, alteração da base/main ou remoção de worktrees. Não existe mapa/spec no
diretório MVP deste checkout; não foi inventado um para registrar a resolução.
