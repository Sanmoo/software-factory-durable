# Candidato local Alpine/Docker-vfs

Estes arquivos são inputs de composição do candidato local, não uma release
homologada nem um comando que inicia VM. Os caminhos em JSON apontam para inputs
próprios preservados; não descobrir/substituir automaticamente assets.

1. O APK oficial assinado prepara um rootfs novo em namespace de usuário
   rootless, com rede isolada, repositórios locais assinados e
   `--no-scripts --no-commit-hooks`. `apk-packages.txt` é a lista solicitada;
   o APK real resolve dependências/instalações condicionais e grava seu banco.
2. O instalador extrator do SDK fica desativado (`rootfsPackages: []`). Um payload
   de diferenças copia **bytes produzidos pelo APK**, incluindo banco/metadata,
   por `postBuild.copy`. Não há gerador alternativo de banco ou resolver próprio.
   O pequeno bootstrap derivado é declarado como derivado, não como tar oficial;
   exclui a biblioteca removida pelo APK, seu link antigo e diretórios cujo modo
   deve ser preservado. O original oficial permanece intacto em `inputs/`.
3. O SDK nativo monta kernel/initramfs/ext4 no namespace rootless uid0, para
   gravar ownership0 no guest sem root no host. Kernel/módulos58 vêm da mesma
   ISO verificada. Não executar o hook guest no host.
4. A extração/cópia de diretórios do SDK0.14 perde modos especiais. Em **nova
   cópia do raw**, o `debugfs` host finaliza somente os dois modos1777 declarados
   em `filesystem-modes.json`. O próprio `writeAssetManifest` do SDK recalcula
   checksums/buildId depois. JSON nativo sozinho não reproduz essa finalização.
5. Conferir o artefato empacotado: banco/versões/digests, `apk audit --system
   --check-permissions`, ownership/modos dos inodes raw, e2fsck e hashes/pin
   públicos. Não equiparar isso a boot/Docker/TLS/persistência em runtime.

Receitas, comandos, transformações e tentativas preservadas:
`/home/sanmoo/software-factory-test/assets30/`.
Evidência: `docs/evidence/03-apk-rootless-image.md` nesta worktree.
Nenhum build/teste desses arquivos autoriza ou inicia VM.
