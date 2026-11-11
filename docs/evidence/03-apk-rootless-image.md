# Ticket03 — correção do empacotamento APK em build rootless

Escopo autorizado: APK oficial como ferramenta adicional em namespace de usuário
rootless/diretório novo, scripts/hooks desativados, SDK nativo na montagem dos
assets. Sem sudo, instalação no sistema host, VM, serviço, fork do SDK ou alteração
de recursos anteriores. Diretório exclusivo: `/home/sanmoo/software-factory-test/assets30`.

## Resultado limitado

Candidato final: `assets30/assets-final`.
Manifesto SHA-256:
`960b256c7c9f22a97428edf986ad6ff83affd5253e4fb6ba0c1579a0768c5d80`.

O bloqueador de registro APK do [candidato anterior](03-alpine-native-candidate.md)
foi corrigido com uma transação **real** do gerenciador, não fabricando registros.
O artefato tem74 pacotes registrados. Docker/engine `29.5.2-r0`, Git/templates
`2.52.1-r0`, Python bytecode `3.12.16-r0` e zlib `1.4-r0` estão no banco; o link
ativo de zlib aponta para1.4 e o arquivo obsoleto1.3.2 não reaparece na imagem.

`validation/result.json`: `PACKAGING_CHECKS_PASSED_RUNTIME_UNQUALIFIED`,
**`runtimeAccepted:false`**. Não houve VM, daemon/container Docker, teste TLS ou
prova de persistência nesta etapa. A causa exata do timeout r3 permanece desconhecida.

## Ferramenta, confinamento e transação

- APK estático3.0.9 do input Alpine anteriormente baixado. Seu executável foi
  extraído para `tools/`, sem instalar no host. A assinatura RSA/SHA-256 destacada
  do binário foi validada por OpenSSL com a chave Alpine do minirootfs3.23.7,
  cujo SHA-512 oficial foi novamente conferido. Resultado: `Verified OK`.
- `bwrap` existente criou namespaces de usuário, PID, IPC, UTS, mount e rede.
  UID0 é mapeado ao usuário host, **não root no host**. Ambiente vazio; APK tem
  acesso somente ao seu executável, repositórios/config read-only, rootfs novo e
  `/proc`/`dev`/tmp privados. Sem rede no processo APK, sem home/credenciais host.
- Repositórios locais receberam índices assinados originais e APKs do cache
  copiado; não se usou `--allow-untrusted`. O gerenciador verificou e resolveu
  dependências, incluindo instalações condicionais omitidas pelo SDK.
- Duas ausências foram corrigidas por downloads somente da origem oficial:
  [git-init-template](https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/git-init-template-2.52.1-r0.apk)
  e [python3-pycache-pyc0](https://dl-cdn.alpinelinux.org/alpine/v3.23/main/x86_64/python3-pycache-pyc0-3.12.16-r0.apk).
  Curl com HTTPS/sem redirects; nenhum GitHub/modelo do produto chamado.
- `apk add --upgrade` com a lista de `src/sandbox/guest-profile/apk-packages.txt`,
  `--no-scripts --no-commit-hooks`. A transação limpa terminou0:
  `OK: 473.5 MiB in 74 packages`. `apk fix --directory-permissions`, igualmente
  offline e sem scripts/hooks, aplicou os modos do banco. Não foi usado usermode
  de banco nem execução de comandos guest/SDK postBuild.commands no host.

Erros ordinários de setup foram corrigidos sem alargar permissões: sintaxe booleana
`--scripts=false` rejeitada pelo CLI (usou-se `--no-scripts`), layout de repositório
sem o subdiretório x86_64 e os dois APKs condicionais ausentes. Logsv1–v4 foram
preservados. A tentativa parcial foi mantida em `rootfs-partial-v3`; a transação
completa começou de um rootfs novo extraído do input verificado.

## Montagem e metadados do filesystem

O extrator SDK fica desativado (`rootfsPackages: []`, `initramfsPackages: []`).
O payload de diferenças contém3351 entradas de arquivo/link e diretórios novos,
com **bytes reais produzidos pelo APK**, incluindo instalado/world/scripts/triggers.
Não existe um segundo solver ou gerador de banco. Kernel/módulos58 e helpers0.14
continuam inputs read-only de assets29; o backend não mudou.

O SDK não substitui links existentes via postBuild.copy. Um bootstrap pequeno
**derivado**, não rotulado como tar oficial autenticado, remove somente a antiga
biblioteca zlib e seu link, além de quatro diretórios vazios recriados pelo payload.
Isso evita ressuscitar arquivo removido pelo APK e não torna o initramfs uma cópia
gigante do userland Docker. Original, derivações e transformações estão em `inputs/`.
O initramfs nativo não chama APK; BusyBox requer só a libc musl preservada.

A inspeção detectou limitações adicionais do SDK, corrigidas diretamente:

1. Fora do namespace, mke2fs herdava UID/GID1000 do host. O assembly nativo foi
   executado no namespace uid0, com runtime/ferramentas host read-only e somente
   assets30 writable. Inodes do ext4 passaram a UID/GID0, sem privilégio host.
2. O extrator ignora modos de diretório e a cópia perde bits especiais/umask.
   O APK define root0700, var/empty0555 e tmp/var/tmp1777. Os diretórios vazios
   foram entregues pelo payload; em **nova cópia** `assets-final` do raw, debugfs
   host finalizou unicamente `/tmp` e `/var/tmp` para mode041777, valores declarados
   em `filesystem-modes.json`. Não é modificação de disco de ambiente/VM.
   `writeAssetManifest` do próprio SDK recalculou checksums/buildId depois disso.

Tentativas/artefatos anteriores permanecem: `assets-failed-overlay`,
`assets-user-uid1000`, `assets-directory-mismatch`, `assets` (antes da finalização)
e respectivos workdirs/logs. Não foi mascarado um erro com exit0.

## Verificação real do artefato final

- Inspector manual `test/sandbox/inspect-guest-packages.ts`: RED exit1 sobre o
  banco extraído do antigo ext4 (Docker ausente); GREEN no root produzido pelo APK
  e no ext4 final extraído. Confere versões e digests Q1 do próprio banco para
  dockerd/Git/zlib, link ativo e ausência da biblioteca obsoleta.
- `apk audit --system --check-permissions` no filesystem extraído final, usando
  ferramenta assinada em namespace offline e alvo read-only: exit0, **stdout e
  stderr vazios**. Esse modo exclui configurações protegidas e arquivos novos não
  gerenciados pelo APK; não é auditoria universal de todos os arquivos.
- Extração debugfs feita no namespace preserva ownership. `rdump` mascara bits
  especiais de diretórios: a primeira extração exibiu777 apesar de o raw ter1777.
  Restauraram-se somente esses dois bits na extração, a partir dos modos conferidos
  **diretamente nos inodes raw**, antes do audit final. Logs de ambas as leituras
  permanecem; não se corrigiu o banco ou o raw para disfarçar falha de extração.
- E2fsck `-fn` no raw final: exit0, sem reparos. Banco extraído é byte a byte igual
  ao banco da transação real; configuração Docker/hook correspondem aos inputs.
- 906 arquivos regulares de módulos/metadados comparados com a mesma coorte da ISO;
  cinco `.ko` de boot idênticos, vermagic58. Kernel SHA-256 continua `456e0691...`.
- `Sandbox.validate` passou nos quatro checks de integridade com o novo pin e
  manteve runtime/release/KVM funcional/Docker/durabilidade não qualificados.

Compilação estrita, build, arquitetura/ESLint (63 módulos/270 dependências) e
55 casos locais:54pass/1VMskip/0fail, aproximadamente8.9s; diff-check passou. O probe
LSP dos dois TS não retornou achados, mas foi inconclusivo (servidor push-only);
a compilação estrita é a confirmação de tipos. Guards de receita não executam hook.

Scripts/hooks de pacote deliberadamente não executados: seus efeitos, Docker-vfs,
TLS, boot, crescimento do filesystem para usar o disco virtual40GiB, restart,
isolamento, owner loss e parada ativa/graciosa ainda exigem qualificação própria.
Iniciar outra VM requer nova autorização explícita, com diretório novo.
Uso físico retido observado:26356400128B, abaixo de80GiB; não é quota rígida nem
liberação das reservas UNKNOWN anteriores.

Destino `integration/software-factory-mvp` permanece em `b591ec7`; ticket03 não
aceito/integrado, sem push/cleanup. `lc03`, `p3`, `q3`, `r3`, assets29, caches/discos/
failed units e UNKNOWN/noRetry históricos permanecem preservados.
