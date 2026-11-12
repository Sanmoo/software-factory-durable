# Gate completo: ownership do flock no Btrfs

Na conferência de TODOS os arquivos .test do checkout pragmático, a subsuíte
Sandbox/config/protocol/typecheck104casos passou103/1VMskip e os17testes negativos
de arquitetura passaram. Os demais testes de Controle/CLI não estavam cobertos
por essa subsuíte; não chamá-la retroativamente de toda a suíte do repositório.

A rodada adicional Controle/CLI19casos resultou9pass/8fail/2timeouts: controlador
retornava3 antes de atender, inclusive onde config incompleta deveria retornar2.
Sem VM ou credenciais; processos recém-criados dos próprios testes/fixtures.
Não presumir regressão das novas métricas: a falha ocorre na prova de flock.

## Repro mínimo real

Um arquivo lock novo/privado em fixture sob o root autorizado, executado com
`flock --exclusive --nonblock --no-fork <lock> <Node24> <probe-readonly>`.
O próprio PID3281538 tinha WRITEFLOCK do inode31355784, mas:

- stat.dev55 (Btrfs por subvolume);
- /proc/locks device00:1d, isto é29, no MESMO inode/PID.

A implementação antiga reconstruía o device da linha de /proc/locks e comparava
com st_dev, rejeitando um lock válido. Outra amostra no-fork, PID3283304/inode
31355831, mostrou fd3 com stat.dev55 e fdinfo contendo o lock WRITE do próprio
PID, ino31355831/device00:1d. Probes terminaram e removeram APENAS suas fixtures
novas; não tocaram locks, serviços ou VMMs existentes.

## Correção: mesma interface, prova pelo descriptor herdado

verifyControllerLock continua exigindo flock kernel exclusivo/no-fork do PRÓPRIO
processo no arquivo canônico estável, regular, único, privado e UIDpróprio.
Agora identifica descriptors em /proc/self/fd, compara stat do descriptor com
lstat do arquivo pelo MESMO namespace (dev+ino), lê fdinfo desse descriptor e
exige ino correspondente e linha FLOCK/ADVISORY/WRITE/PIDatual/range0EOF.
Reconfere descriptor e pathname antes de aceitar. FD fechado/reutilizado, leitura
indisponível ou mismatch não são prova. Não abrir/fechar/duplicar o descriptor do
lock; não perder a exclusão, trocar por PID sozinho ou criar token/serviço novo.

Comparar identidade completa do arquivo e do descriptor substitui a comparação
incompatível de dispositivos; não é simplesmente remover validação de device.
No-fork, exclusão real, não herança para filhos, falta de takeover e autoridade
única do Controle permanecem. /proc/fdinfo indisponível continua failclosed.

## RED/GREEN e ambiente do teste

Depois da correção,18/19casos adicionais passaram. O restante revelou somente
que o TMPDIR longo usado para fixtures Sandbox fazia o teste de aliases acrescentar
/installation e ultrapassar o limite103bytes do socket. Não relaxado o limite:
TMPDIR curto /home/sanmoo/software-factory-test, ainda Btrfs/no mesmo root permitido,
e FACTORY_SANDBOX_TEST_ROOT mantém product-local-clYJQT. Com isso19/19passaram.

Regressão adicional na interface de processo já usada pelo teste de ownership:
owner iniciado sob lock SHARED do arquivo correto ou WRITE do arquivo errado
retorna3 ANTES de abrir SQLite. Arquivos são privados600 para não confundir
recusa de permissão com recusa do tipo/identidade do lock. Suite adicional agora
20pass; aliases/reinício/SIGKILL de child PRÓPRIO/limite real de file-size/ACK
perdido/FDnãoherdado/módulos sem efeitos permanecem passando. Nenhum desses
processos é um owner Gondolin real ou autorização de sinal de recursos antigos.

Strictcompile/build e arquitetura/ESLint75módulos344dependências passaram.
Uma revisão independente8ae5f119 sem achados, OK com notas de escopo; não
reexecutou comandos nem autorizou recursos. Gate agregado de TODOS23arquivos
.test (sem drivers manuais):141casos140pass/1VMskip/0fail, conferido em blocos
104(103pass1skip),20Controle/CLIpass e17arquiteturapass para respeitar limite60s
por comando. Foram capturados resultados finais/exit0 dos blocos, sem inferir
verde de saída longa truncada. LSP2checks sem achados mas inconclusivos push-only,
não certificado clean. Não instalar util-linux/kernel ou reabrir experimento de imagem.
Esta correção de pré-requisito não altera o lock de lifecycle da Sandbox, nem
pretende provar o smoke guest/FUSE que ainda requer novo orçamento específico.
