# Ticket03 — inputs Alpine e candidato nativo, ainda bloqueado

Autorização desta etapa: consultar/baixar inputs somente dos repositórios oficiais
da Alpine e preparar novos assets pelo builder nativo. **Nenhuma VM autorizada ou
iniciada nesta etapa**, nenhum serviço, sudo, instalação no host ou execução de
hook/binário guest no host. Nenhum novo acesso GitHub/modelo do produto.
A única revisão independente foi read-only, conforme o fluxo já aprovado.

Diretório novo exclusivo: `/home/sanmoo/software-factory-test/assets29`.
Branch: `implement/software-factory-mvp-03-pragmatic`; destino preservado:
`integration/software-factory-mvp` em `b591ec7`, sem integração parcial.

## Inputs e aquisição

Fontes primárias consultadas em 2026-11-11:

- [Diretório oficial de releases x86_64 v3.23](https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86_64/).
- [Metadados oficiais linux-virt v3.23](https://pkgs.alpinelinux.org/package/v3.23/main/x86_64/linux-virt):
  versão corrente observada `6.18.60-r0`, não prova de compatibilidade.
- [ISO alpine-virt3.23.7](https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86_64/alpine-virt-3.23.7-x86_64.iso)
  e [SHA-512 oficial](https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86_64/alpine-virt-3.23.7-x86_64.iso.sha512).
- [SHA-512 do minirootfs3.23.7](https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/x86_64/alpine-minirootfs-3.23.7-x86_64.tar.gz.sha512).

A ISO tem71303168B e passou no SHA-512 publicado:
`8d482c9a5689dfbec50957c83449c03f2e0d3efffe717ff8b61acba83dacc2d70c11ec59f5e772eb807c0cb259d9a333a0196c5803814587391b496e9ccf1f16`.
O minirootfs foi copiado do cache antigo para cache novo e passou no SHA-512
também obtido da origem oficial. Isso confere bytes contra checksum obtido por
HTTPS; não foi feita verificação PGP independente.

O APK antigo `linux-virt-6.18.58-r0.apk` retornou404; não foi substituído por60.
A mesma ISO oficial fornece `boot/vmlinuz-virt` e `boot/modloop-virt`, ambos58.
O kernel extraído tem SHA-256
`456e0691f095285a82533cc6335280e4b4991d630c5292ddf15e6320e71971c9`,
idêntico ao kernel da base preservada que anteriormente executou comandos.
Não foi reutilizado o initramfs de boot da ISO: o SDK gera seu próprio initramfs
com seus helpers/protocolo e os módulos correspondentes desse modloop.

## Composição nativa

Receita em `src/sandbox/guest-profile/alpine-docker-vfs.json`, hook guest em
`alpine-docker-vfs.sh` e configuração em `docker-daemon.json`:

- Usa `buildAssets` do SDK0.14 instalado nesta worktree, sem fork, OCI/container,
  `postBuild.commands`, chroot ou scripts de pacotes executados no host.
- Exclui `linux-virt` da lista de instalação para impedir seleção implícita60.
  `postBuild.copy` entrega kernel/módulos58, antes do sync/staging nativo. O aviso
  genérico do SDK sobre ausência do pacote é esperado; a cópia explícita fornece
  os arquivos e a build concluiu. Não é um pin `=versão` fictício.
- O `7z` disponível no host extraiu o modloop. A primeira composição preservada
  (`assets`, pin `af7286813ea5a42925342e1b4695ad99f62571a9407128c618e3520e8da28c42`)
  carregou um link `vmlinuz` que o extrator havia absolutizado para o diretório
  do host. Inspeção o recusou. Sem alterar ISO/extração/v1, criou-se `cohort/`
  contendo os mesmos arquivos regulares e omitindo somente esse link dispensável:
  o SDK já separa o kernel e remove `/boot`. Buildv2 em diretórios novos.
- Quatro helpers são cópias do cache preservado; seus SHA-256 foram conferidos
  contra o manifesto de helpers0.14. Os dois artefatos krun foram copiados dos
  assets preservados apenas porque o builder os inclui; não foram executados e
  não fazem parte de uma prova QEMU/KVM.
- Hook monta cgroup2, exige controllers legíveis, inicia um dockerd e aguarda
  driver `vfs` por até10s antes do exec sandboxd. Configura cgroupfs, socket Unix
  guest com grupo root, snapshotter containerd desativado e rede Docker desativada
  nesta fatia. São configuração/intenção, não prova de startup/controladores.
- Pacotes userland vêm dos índices v3.23 e cache copiado; não se alega snapshot
  imutável completo, assinatura verificada de cada APK ou constraints respeitadas
  pelo resolver do SDK.

Scripts pontuais em `build/` e `build-v2/` preservam a chamada da API nativa, logs e
receitas efetivas. Só o novo cache foi renovado; comparação byte a byte do cache
antigo com sua cópia anterior à build não encontrou diferenças. Wrapper pontual
no processo de build aceita somente `https://dl-cdn.alpinelinux.org/alpine/v3.23/`,
recusa redirects e registra URLs. Build1: dois APKINDEX, Git e zlib; build2: zero
fetches. Nenhum launcher/admission/controller de runtime foi adicionado.

## Verificação do artefato v2 e bloqueador real

`assets-v2/manifest.json` SHA-256:
`72060acb31ed03a0659181d55a17032c22c915ffcd48d7fe28fbf3a6031ba142`.

Buildv2 concluiu em aproximadamente8.8s. Inspeção read-only do ext4 empacotado e
do cpio verificou906 arquivos regulares de módulos/metadados contra a origem da
ISO e staging, sem o link do host. Há apenas a versão58 no staging de rootfs e
initramfs; os cinco `.ko` de boot (`virtio_blk`, `ext4`, `jbd2`, `mbcache`, `crc16`)
são byte a byte iguais à origem e contêm vermagic58. O hook e JSON extraídos do
ext4 são iguais aos inputs. `e2fsck -fn` no raw novo retornou0. São verificações
estáticas, não prova completa de ABI ou execução.

A facade pública `Sandbox.validate` passou nos quatro checks de integridade dos
assets com esse pin; corretamente manteve release, KVM funcional, supervisão,
Docker e durabilidade como não qualificados. O template ext4 tem197376 blocos de
4096B: isso **não prova filesystem utilizável de40GiB** após conversão/resize do
disco virtual; o crescimento efetivo continua pendente.

A revisão independente `a6af28fe` encontrou P1, reproduzido no ext4 final:

- `lib/apk/db/installed` não registra Docker/Git, embora os arquivos existam.
- Banco registra zlib `1.3.2-r1`, mas `libz.so.1` aponta para `libz.so.1.4`.
- SDK `dist/src/alpine/packages.js` só extrai APKs; `tar.js` descarta metadados.

Portanto `validation-v2/result.json` registra
**`BLOCKED_APK_DATABASE_NOT_COHERENT`, `accepted:false`**. Build/hash/e2fsck verde
não compensam esse bloqueador. Não se fabricou banco APK nem se executaram
scripts para ocultá-lo. O achado não demonstra a causa do timeout r3.

## Próximo trabalho e limites de autorização

É necessária uma transação APK real na preparação, sem reimplementar seu banco,
mantendo o SDK nativo na montagem final. Para avaliar essa opção, foram baixados
somente de Alpine, **não executados**, `apk-tools-static-3.0.9-r0.apk` (SHA-256
`ea77b2533566e70c9566c03748199b79348010c3199ba02d97e0634cf0fa9ef7`) e
`apk-tools-doc-3.0.9-r0.apk` (SHA-256
`9f1baac957144a030441d1bd0dd5080ce03f112c56158f8331103d5eb4ea3b98`).
Manpages extraídos em `tool-inputs/`: `--root` seleciona outro filesystem;
`--scripts` desativado impede scripts; `--usermode` tem limites explícitos e não deve
ser equiparado sem prova à instalação root do guest. `--force-no-chroot` é
explicitamente perigoso para o host e não é um fallback aprovado.

Usar nova ferramenta baixada num namespace de usuário rootless é um próximo
caminho a avaliar, sujeito à decisão do operador; nada disso foi executado.
A disponibilidade de `bwrap`/`unshare` e o limite de user namespaces foram apenas
consultados, não provam que o fluxo funcione. Não usar sudo/privileged/container
como recuperação automática. Uma VM permanece fora desta autorização.

Gates locais: typecheck/build/arquitetura/ESLint e diff-check passaram;54 casos,
53pass/1VMskip/0fail, incluindo três guards estáticos de receita/hook. Nenhum
hook foi executado. Revisão única concluída, sem cadeia de revisões. Evidências
v1/v2 e falhas de inspeção anteriores permanecem. `lc03`, `p3`, `q3`, `r3`, failed
units e UNKNOWN/noRetry históricos não foram limpos ou liberados. Ticket03
continua incompleto, sem integração, push ou limpeza de worktree.

Continuação com nova autorização de execução da ferramenta:
[transação APK rootless e candidato corrigido, ainda sem runtime](03-apk-rootless-image.md).
O registro de falha de assets29 permanece; a correção produziu outro artefato.
