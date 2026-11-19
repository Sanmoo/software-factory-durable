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

## Referência nominal congelada após u3

A receita nativa acima produziu um initramfs que não completou readiness em
s3/t3. Não continuar regenerando archives ou alterando timeout/flags a partir
desses resultados. O último ensaio discriminante autorizado, u3, passou boot
Alpine/Docker-vfs e parada de ambiente ativo com cessação confirmada, trocando
**somente o archive initramfs** pelo publicado da mesma coorte58.

Referência selecionada: `/home/sanmoo/software-factory-test/assets32/assets`, pin
`4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1`.
Kernel/rootfs novo com banco APK74/Docker-vfs são byte-idênticos aos de assets30;
NÃO é fallback para o rootfs antigo sem Docker. A seleção está declarada em
`assets32/provenance.json`/`assemble-variant.mjs`, não reproduzida pelo JSON nativo
sozinho. Não alterar esse fato para aparentar build completo ou release.

Congelar a composição, não abrir outra série de boots. A causa interna do delta
entre archives continua desconhecida. Um ensaio nominal não comprova parada
graciosa, restart/persistência/crescimento do filesystem, isolamento ou release;
console/debug temporários ainda exigem remoção ou buffering seguro antes de
workers/integração. Evidência e regra de saída:
`docs/evidence/03-u3-initramfs-comparison.md`.

Consolidação local posterior: `prepare` passa a crescer e verificar uma cópia do
ext4 por ambiente para sua capacidade configurada, sem alterar template/pin.
`start` verifica snapshot privado do disco preservado com e2fsck-fn e capacidade
real antes de nova intenção de boot; não monta/repara esse filesystem no host.
Requer e2fsck/resize2fs nativos disponíveis; doctor nunca instala ferramentas.
Discos históricos pequenos não são expandidos silenciosamente. Console/debug
operacionais foram desligados (none/false/null), sem flag de worker para reativar.
Essas mudanças locais ainda exigem qualificação de hardware própria; não alteram
retroativamente a prova u3. Ver `docs/evidence/03-filesystem-preparation-local.md`
e `docs/evidence/03-guest-finalization-local.md`.

Qualificação posterior v3, fontecb5ec0a: dois boots públicos sequenciais passaram
com esse MESMO pin, console desligado, cópia por ambiente com ext4 real40GiB,
finalização guest observada, cessação independente e estado Docker persistido.
Sem reprepare/recriação entre boots. Não equivale a parada graciosa completa,
containers/TLS/workspace/isolamento/owner-loss/remove ou release homologada.
`docs/evidence/03-v3-two-boots-qualified-subset.md` registra fatos e limites;
nenhum terceiro boot foi autorizado ou executado.

## Smoke operacional de storage (fonte posterior, ainda sem nova VM)

O adapter mantém o perfil/imagem acima e acrescenta um comando guest FIXO de
readiness, sem flag de teste ou script fornecido por caller/worker. Verifica
leitura/escrita dos paths persistentes aprovados e rename/symlink absoluto via
ambos mounts guest. stdout/stderr continuam ignore, mesmo deadline10s; nunca
executar o corpo no host (testes locais somente sh-n).

`.factory-profile/storage-v1` é uma área RESERVADA operacional em /root,/tmp,
/var/tmp,/var/cache,/var/log,/var/cache/apk,/workspace,/artifacts. O primeiro
conteúdo env|boot é criado com noclobber somente se ausente; boots seguintes
validam conteúdo limitado a160bytes sem sobrescrevê-lo. Uma recriação após perda
recebe OUTRO boot, portanto a inspeção externa de dois boots pode detectar reset
em vez de aceitar dado regenerado. Arquivos/symlinks inesperados falham o smoke;
não são reparados ou apagados silenciosamente. Probes temporários de rename/
alias têm nome do boot e são removidos, não a amostra persistente.

A raiz /workspace é a área própria do Trabalho, não o checkout Git: checkouts
ficam em filhos, mantendo esta área reservada fora do conteúdo de PR conforme
contrato. /artifacts continua separado. A amostra NÃO é autoridade de domínio,
recibo de início, integridade global, continuidade do modelo ou prova de cessação.
Não confiar nela para liberar Slot, executar ferramenta ou autorizar recovery.

Sem instalar APK ou mudar tmpfs/journal/assets. Permanecem pendentes provas de
execução/persistência pelo guest no perfil atual com novo orçamento específico;
comando esperado ou shellsyntax correto não são execução real de FUSE/Alpine.

## Journal do ext4 do guest (ticket 47)

O builder de imagem do Gondolin 0.14 formata o root com `mke2fs -O ^has_journal`
fixo (`createRootfsImage` em `dist/src/alpine/utils.js`, sem opção), e o piloto 35
mostrou o custo: parada abrupta durante Gradle/Docker deixa bitmaps/checksums
inconsistentes. Como nas variantes anteriores (finalização host de uma NOVA cópia
do raw + manifesto recalculado), a versão journalada é DERIVADA de um pin publicado
por `deriveJournaledGuestAssets` (`src/sandbox/guest-journal.ts`): copia os assets,
cresce a cópia do rootfs pelo tamanho do journal, `e2fsck -fn`, `resize2fs`,
`tune2fs -O has_journal -J size=<MiB>` (128 por padrão), `e2fsck -fn` limpo,
manifesto no formato Gondolin (buildId = `computeAssetBuildId`) e `provenance.json`
ao lado do diretório de saída. Fonte nunca alterada; saída sempre NOVA; sem VM ou
rede. O kernel58 já carrega `jbd2` (dependência de `ext4.ko`).

O novo pin muda a identidade do ambiente (ticket 50): ambientes já preparados
continuam no pin antigo (sem journal) e um Trabalho só usa o journal num ambiente
novo. Os já existentes ficam protegidos pela parada limpa e pelos remédios
`repair-disk`/`replace-disk`. A checagem do disco preservado reproduz o journal
pendente só na cópia privada (`e2fsck -E journal_only`) antes do `e2fsck -fn`.
