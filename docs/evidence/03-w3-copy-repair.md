# 03 — w3: uma recuperação em cópia descartável, sem boot ou promoção

## Concessão e resultado limitado

Após [W3 bloqueado por fsck4](03-w3-owner-loss-gated.md), o operador respondeu
**autorizo** a uma única tentativa de reparo em cópia esparsa descartável de A,
seguida de verificação read-only. Não autorizou boot, troca do disco operacional,
reparo do original/snapshot preservado, mudança de imagem ou cleanup.

Executado2026-11-12T17:45:52–17:45:59Z, checkout limpo em
b208c2e8e5a8e7046a05b7b3f20da015e91b77fc. Uma cópia nova exclusiva e uma execução
reparadora. **A cópia passou a verificação estrutural; A operacional continua
com o original inalterado e bloqueado.** Ticket03 não está resolvido.

## Alvo e proteção

Alvo único: `/home/sanmoo/software-factory-test/w3/recovery-copy-1/candidate.ext4`.
Origem qcow2 do ambiente A
`env-3d16f0a88fcfe40efcc3e2405912436f57fa8478a218b933859c372bbc3ab109`.
Cópia raw standalone por qemu-imgconvert com sparse4k, diretório novo700,
arquivo600/UIDpróprio/nlink1/inode distinto dos originais. Capacidade42949672960B,
alocação inicial625881088B. Nenhum mount, sudo, install, download, SDKVM, modelo,
GitHub, sinal ou serviço criado/alterado. Nenhuma variante de imagem.

Intenção exclusiva/durável antes do efeito registra alvo/comando e limite1.
Antes/depois conferidos:

- SHA256 e dev/ino/size/mtimeNs/ctimeNs/UID/mode/nlink dos qcow2 operacionais A/B.
- Identidade/metadados equivalentes dos snapshots raw preservados A1/B1; **não**
  foi calculado hash integral dos raw40GiB. Não alegar prova criptográfica disso.
- Asset pin4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1
  revalidado, quatro checks de integridade OK antes/depois, sem boot.
- Cessação independente dos próprios A1/B1 antes/depois: HostBoot/namespaces/
  cgroup2 full-root/controllers/identidade privada/manager e grupos próprios
  ausentes correlacionados. Defaults de unit auto-GC de B não são causa/exit.

SHA de A preservado:
`d1bbabe2f94578da34fb39a8bb37e5333bc0927f8e12e7a9436a872161532b81`.
SHA de B preservado:
`d10255868f7d343a15427e52040feb9c76749884a9bb35019f32dfed6155d97d`.
Não houve promoção/rename/substituição do disco operacional ou alteração do current.

## Antes → reparo único → depois

1. Baseline na CÓPIA: `e2fsck -f -n` retornou4, mesmos bitmapdiff `+557611` e
   contadores divergentes observados em A; estado notclean, sem has_journal.
2. Uma execução `e2fsck -f -y <candidate.ext4>`: exit1, indicando correções,
   não falha de execução. Respostas yes foram limitadas exclusivamente à cópia
   nova. Log completo de metadata registrou:
   - inclusão de557611 no bitmap;
   - freeblocks do grupo17:32720→32719;
   - freeblocks total10188089→10187998;
   - freeinodes2293283→2293228.
3. `e2fsck -f -n` posterior: exit0, cinco passes sem divergências relatadas nesse
   comando; headerclean, geometria10485760*4096=40GiB, metadados da cópia estáveis
   durante a verificação read-only. Features permanecem SEM journal.

O resumo de arquivos passou5597→5652 em consequência da correção de contadores;
isso NÃO é prova de que55 arquivos foram recuperados, criados ou tiveram conteúdo
restaurado. Não houve replay de VM, regeneração de template ou política nova de
reparo automático no produto.

## Amostras de conteúdo

Hash antes/depois na cópia permaneceu igual em CINCO arquivos legíveis:

| Arquivo | SHA256 |
|---|---|
| /var/lib/docker/engine-id (trim canônico) | d6da51d26434cca5917fc93a891cfa94a667d59c6fbacc2279d8ef53d9f1aa9d |
| /etc/docker/daemon.json | 7751e34eafe3a036bffcd189e7194b6320ac73dd64d9ba0b4c15ec709976c4db |
| /etc/apk/world | 595a7f978380e5a9a1a088f93bb23d67cb3862ecf7b2754a3a4ac1792b0321c2 |
| /etc/apk/repositories | 680df3aa52f6778e1529e3e64b2b4ded9de96f8fed8d647b8bee06db919e6392 |
| /lib/apk/db/installed | c3542186879d1cc51b112370fcec5d866bb637eb06cc245a12e4adb74e5388fc |

`/etc/os-release` ficou unavailable nas duas leituras debugfs. Não afirmar que
esse conteúdo foi verificado, que está ausente ou que o reparo o perdeu. Nenhum
rawengine-ID, chave ou corpo desses arquivos foi persistido no relatório.

Amostras iguais + fsck0 NÃO garantem preservação de todos os arquivos, escritas
que nunca chegaram ao disco, funcionamento do guest/Docker/APK, persistência
entre boots ou tolerância futura a crash. Não há teste de boot da cópia.

## Evidência, validação e disposição

Em w3: `repair-copy-once.mjs`, `recovery-copy-1-intent.json`, baseline, repair,
verified e result; candidato mantido em recovery-copy-1. Registros exclusivos/
duráveis; resultados antigos do W3 não foram reescritos. Source b208c2e para o
produto; script de operação retido como artefato, não uma API/framework de recovery.

Esta etapa não mudou código de produto/testes. Baseline anterior103casos102pass/
1VMskip, strictcompile/build/arquitetura/ESLint72módulos323dependências permanece
referência, não foi reexecutado como suposta prova do reparo. Gates pertinentes
agora são os comandos nativos reais, conferência de preservação e diff-check docs.
Uma revisão independente0b929733 conferiu script/JSONs/relato sem executar efeitos;
sem achados, OK apenas neste incremento de evidência. Não autoriza boot/promoção.

Retido após a cópia34554753024B, filesystem disponível591169032192B. Histórico,
UNKNOWN/noRetry e todos os originais/snapshots/runtimes anteriores mantidos.
Nenhuma remoção, novo boot ou liberação presumida de recurso. A/B continuam
cessados e a cópia **não promovida**. Continuação física/promoção requer novo
escopo explícito; o terceiro boot bloqueado de W3 não é orçamento reutilizável.
