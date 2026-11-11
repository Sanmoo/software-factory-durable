# 03 — u3: encerrar as variantes após boot operacional com initramfs publicado

## Decisão e limite antes do ensaio

O operador autorizou preparar a variante e UMA VM, perguntando quando encerrar
as tentativas. Foi comunicado e aplicado o corte: **último ensaio discriminante
desta abordagem**. Se falhasse/inconclusivo, parar boots/trocas de imagem e
reavaliar integração/consumo do SDK; se passasse, congelar a composição e parar
as variantes. Marcador novo isolado não justificaria outro boot. Este ensaio
consumiu a autorização; nenhum retry/reboot/fallback/aumento de timeout.

## Composição explícita; não imagem antiga sem Docker

Fonte executada: `8a78de50a34314725f3304975b7c608343894e2c`, após strict
compile/build, arquitetura/ESLint (65 módulos/274 dependências), 63 casos locais
(62pass/1VMskip/0fail, ~9.56s) e diff-check. LSP do driver sem achados retornados,
mas inconclusivo push-only, não certificado clean. Nenhuma alteração funcional
no adapter neste incremento: somente parâmetros/história/regra de saída do
qualificador já revisado; não reiniciada a revisão de observabilidade 9a6d7806.

`/home/sanmoo/software-factory-test/assets32/assemble-variant.mjs` conferiu os
quatro checks públicos de ambos os inputs, copiou arquivos regulares sem alias
para diretório novo e usou `writeAssetManifest` do SDK para checksums/buildId.
Não executou SDK VM, builder OCI, guest script ou download. Manifest config
preserva a receita predecessora; `assets32/provenance.json` declara a seleção
do archive, não finge um novo build nativo completo. JSON de receita sozinho
não reproduz essa composição.

- Rootfs/kernel/sidecars: `assets30/assets-final`, pin
  `960b256c7c9f22a97428edf986ad6ff83affd5253e4fb6ba0c1579a0768c5d80`.
- Somente initramfs: `ticket03/assets`, pin preservado
  `7b56e7234722541172922626b0d136b5924ae847ce39dcbd09cbe3079e091340`.
- Variante: `assets32/assets`, pin
  **`4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1`**.
- Kernel58 SHA256: `456e0691f095285a82533cc6335280e4b4991d630c5292ddf15e6320e71971c9`.
- Rootfs Docker-vfs SHA256: `6fb903a7bbdc4ec419e183897e0d5fcff7d5b79db1804e1d877f181cb3db15de`.
- Initramfs selecionado SHA256: `dd007247957ea2d89163083ab9a2df63921445bae0fafe45ef9f03c84d4f6bfd`.

Assertions comprovaram kernel/rootfs/krunSidecars byte-idênticos ao candidato
novo; somente checksum de asset `initramfs` mudou. Rootfs antigo sem Docker
NÃO foi usado. Kernel58 de ambos coincide; init/BusyBox/musl e cinco módulos
ELF críticos, descomprimindo os gzip antigos, foram comparados antes em t3.
Isso não equivale a identidade de archives/metadados ou prova completa de ABI.

## Ensaio real, uma vez

Root novo: `/home/sanmoo/software-factory-test/u3`. KVM/2048MiB/2vCPU/40GiB
virtual, startup timeout30000ms, mesmas opções básicas microvm/CPUhost,
net desativada, sem agentes/credenciais. Preflight quatro assets/storage ok,
8141750272B memória disponível, 594889441280B filesystem disponível,
socket106B, sem QEMU listado (não libera reserva histórica UNKNOWN).

- Environment `env-ce5ab9c9e49ad2825d1cc8171808ea16c22a9b3232b2819426434269dba9711e`.
- Boot `boot-686f4828-deca-4eb0-b764-cdec3bbdf206`.
- Invocation registrada `0cf94bf4b75a4fb383263035f685de6c`.
- VMM real PID2382151/ticks94844976, argv próprio kernel/initrd/disco,
  `-accel kvm -m 2048M -smp 2`; não testemunha `qemu --version`.
- `prepare` success; `start` success após comando real de perfil Alpine/Docker
  vfs e sync, com `operational.json`/VMM correlacionado.
- `before-stop`: **active**, cessationConfirmedfalse.
- `stop`: success, cessationConfirmedtrue, **terminationunconfirmed /
  guestFinalizationunavailable**.
- `after-stop`: stopped, cessationConfirmedtrue.
- `result.json`: **acceptedtrue**, operationalBoottrue, activeBeforeStoptrue,
  qualifyingVmmWitnesstrue; restartAttemptedfalse/resourcesRemovedfalse.

Aqui `acceptedtrue` é exclusivamente o predicado desse qualificador nominal,
não aceite do ticket03, release/imagem completa, containers/builds, rede/TLS,
restart/persistência, crescimento real do filesystem ou parada graciosa.
Timestamps dos próprios registros: started12:16:26.448Z,
operational12:16:32.395Z, beforeStop12:16:32.668Z, afterStop12:16:33.036Z
em2026-11-11. Intervalos de escrita host, não relógios internos do guest.

## Observação e cessação

407callbacks/0oversized; somente códigos:
`console-text-observed`, `acpi-text`, `kernel-init-attempt-text`,
`initramfs-network-failed-text`, `root-init-text`, `sandboxfs-launch-text`,
`pre-sandboxd-hook-text`. Nenhuma mensagem bruta. Marcador de rede não é teste
de rede/TLS; net foi desativada. Texto pre-sandboxd precede o hook Docker, não
prova exec/readiness; neste caso a evidência operacional separada existe.

`u3/manager-final.json`, 12:21:47.048Z: mesmo hostBoot registrado,
NSCg4026531835/mount4026531832, hierarquia full-root/controller-v2 revalidada
pela nova observação pública, cgroup exato próprio ausente, MainPID0/CGempty,
observe stopped/cessationtrue. A unit de sucesso já foi coletada pelo manager:
LoadStatenot-found/InvocationIDvazio. **Não há novo CID pós-stop a comparar**, e
ExecMainStatus0/Resultsuccess desse show não provam exit status real ou consumo.
Cessação correlaciona evidência própria anterior, host/NS/hierarquia/cgroup e
observe, não apenas PID ausente/unit ausente/receipt. Nenhum reset-failed,
remoção de disco/runtime ou liberação de histórico UNKNOWN/noRetry. Uso retido
observado28909113344B, sob orçamento80GiB; filesystem livre594261966848B.

## Reavaliação aplicada: agora parar a exploração de imagem

1. **Congelar esta composição como referência nominal uma vez qualificada.**
   Não continuar regenerando initramfs/trocando flags/kernel/timeout. Não mudar
   de hypervisor/SDK como reação especulativa: o mesmo adapter/SDK/hardware
   executou o rootfs novo com o archive selecionado.
2. **O delta initramfs é relevante, mas causa interna ainda desconhecida.**
   O archive nativo falhou e o publicado passou nesta observação; ainda não se
   sabe qual entrada/metadata/construção explica isso, nem há repetibilidade
   demonstrada. Isso autoriza a decisão de composição, não uma acusação causal
   completa ao SDK/kernel ou um reparo comprovado no gerador de initramfs.
3. **Mudar o trabalho de exploração para fechamento de critérios conhecidos.**
   Próximos gaps são finalização/parada graciosa, filesystem preservado e seu
   crescimento, restart/persistência, isolamento/owner-loss/tools/remove.
   Não usar `acceptedtrue` deste driver para marcar ticket03 concluído.
4. **Diagnóstico não vira produção.** Remover ativação de console/debug ou
   resolver buffering interno do SDK antes de workers/integração. Própria
   allowlist limitada não limita heap serial do SDK. A referência deste ensaio
   inclui observabilidade temporária; não é uma release apta a workloads.
5. **Nenhum outro boot nesta autorização.** Uma futura qualificação deve ter
   mudança/critério de aceite e orçamento fechados, não outra variação de imagem
   motivada por curiosidade. Se a referência deixar de reproduzir ao fechar um
   critério, reavaliar antes de abrir uma nova série de tentativas.

Integração `integration/software-factory-mvp` permanece b591ec7, somente01/02
integrados. Branch/worktree e todos os recursos/evidências preservados, sem
push/merge/cleanup. Ver também [t3 negativo](03-t3-diagnostic-failed.md) e
[empacotamento APK](03-apk-rootless-image.md).
