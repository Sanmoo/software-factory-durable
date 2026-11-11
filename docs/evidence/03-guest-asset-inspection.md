# Ticket03 — inspeção local dos assets após o timeout de r3

Escopo: inspeção somente de leitura dos assets, cache e SDK0.14.0 já instalados.
Nenhuma nova VM, download, serviço, script guest executado no host ou alteração
nos assets originais. A tentativa r3 permanece reprovada; diagnóstico real e
cessação estão na [evidência da retomada](03-pragmatic-restart.md).

## Resultado observado

r3 preservou `vm-start / GUEST_READINESS_TIMEOUT`. O SDK não concluiu sua
prontidão, que inclui controle/VFS; o check posterior de Alpine/Docker-vfs não
foi alcançado. O timeout não identifica sozinho o componente culpado.

## 1. Não foi observada mistura grosseira de versões dentro de cada conjunto

Inspeção de headers do kernel, `debugfs` read-only no rootfs e listagem
`lz4 -dc | cpio -it` do initramfs:

| Conjunto preservado | Kernel | Módulos rootfs | Módulos initramfs |
| --- | --- | --- | --- |
| assets, pin `7b56e723...` | 6.18.58-0-virt | 6.18.58-0-virt | 6.18.58-0-virt |
| built-assets, pin `8ed20af2...` | 6.18.60-0-virt | 6.18.60-0-virt | 6.18.60-0-virt |

Isso confere rótulos/versionamento, não cada ABI, assinatura ou funcionamento do
loader. Os mesmos módulos virtio de transporte aparecem como built-in nos dois;
`virtio_blk`/`ext4` não constam como built-in em nenhum dos dois arquivos lidos.
Não é sustentada uma explicação simples de que só o kernel novo passou a exigir
esses módulos. Avisos ELF também aparecem no log histórico do conjunto base que
executou comandos; não devem ser promovidos isoladamente a causa do timeout.

## 2. A receita customizada acrescentou pacotes, não inicialização de Docker

A receita preservada `ticket03/build/build-assets.mjs` chama o builder nativo do
SDK com os defaults mais `git`, `github-cli`, `docker`; `build-config.json` não
tem `init` nem `postBuild`. O `/init` extraído dos dois rootfs é idêntico:

`7f13165f9551ebd640c664f6b0c18ef8b883d9259a9252cf6fbba395bc898ad8`.

Esse init termina em `exec /usr/bin/sandboxd`, sem hook de Docker/cgroup. Docker
binário existe na customizada e não na base, mas sua presença não comprova daemon
operacional/vfs. O ponto suportado pelo SDK para compor essa preparação é
`BuildConfig.init.rootfsInitExtra`: o builder injeta o script antes do exec de
sandboxd (`dist/src/build/alpine.js`). Isso evita inventar outro supervisor ou
executar comandos guest arbitrários no host.

Essa lacuna precisa ser tratada na composição antes de prometer o perfil Docker.
Não é demonstrada como causa do timeout atual, anterior ao check do adapter, nem
se presume ausência de todo mecanismo possível só por ausência desse hook.

## 3. Não se pode prometer pin de kernel apenas com `=versão` nessa API

Em `dist/src/alpine/packages.js`, `resolveAndDownload` normaliza dependências
removendo `<>=~`, depois seleciona o primeiro metadado por nome do APKINDEX. O
cache local só contém `x86_64-linux-virt-6.18.60-r0.apk`; o registro `linux-virt`
do índice preservado também é `6.18.60-r0`. Não há APK6.18.58 disponível nesse
cache para reconstrução nativa dessa coorte.

Portanto escrever `linux-virt=6.18.58-r0` na configuração não é prova de seleção
correta. O builder também pode tentar renovar índices após24h mesmo com outros
arquivos presentes: não foi executado contando com um suposto modo offline que
essa chamada não oferece. Uma build reprodutível precisa de fontes/snapshot e
versões efetivamente verificáveis, não só o texto da restrição.

## Material e limites

Extrações somente de leitura em
`/home/sanmoo/software-factory-test/guest29-inspection`:
`base-init`, `custom-init`, `base-modules.builtin`, `custom-modules.builtin`.
Os originais e os logs antigos não foram editados. A inspeção não reconstruiu
imagem nem gerou um candidato homologado.

A próxima correção deve manter o perfil aprovado: QEMU/KVM x86_64, Alpine,
Docker-vfs, versões/manifesto/checksums declarados e kernel/initramfs/módulos
coerentes. Não substituir runtime, aplicar acpi=off, misturar arquivos de versões
diferentes ou usar a base sem Docker como verde. Recomenda-se preparar um novo
conjunto com o builder nativo e o hook suportado, deixando os conjuntos antigos
intactos. Obter inputs oficiais ausentes no cache requer decisão de aquisição;
outra VM exige autorização própria. Não se recomenda repetir o mesmo ensaio
inalterado ou aumentar timeout como correção.
