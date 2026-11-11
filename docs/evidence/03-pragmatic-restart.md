# Ticket03 — retomada com validação local normal

## Estado

Incremento parcial, não aceite do ticket03 ou do MVP.

Destino de integração preservado: branch `integration/software-factory-mvp`,
checkout `.worktrees/software-factory-mvp`, em `b591ec7`.
A retomada está em `implement/software-factory-mvp-03-pragmatic`, no checkout
`.worktrees/software-factory-mvp-03-pragmatic`.

Foram reaproveitados somente os incrementos de validação e preparo:

- `7abfc63` → `b57d98c`: integridade dos assets explicitamente fixados;
- `60cd813` → `d3fec60`: preparo idempotente de disco próprio.

Não foram importados os testes perigosos de lifecycle nem o controlador
experimental. A branch03 antiga, seus estágios e arquivos permanecem preservados.
O probe de VM reaproveitado está explicitamente desabilitado, inclusive quando
variáveis de ambiente de teste estiverem presentes.

## Inspeção da interrupção

A inspeção somente de leitura não encontrou processos correspondentes aos nomes
conhecidos H/O/lançador/TypeScript. Os quatro arquivos `compiler.*` esperados pelo
antigo harness e seu diretório de emissão estavam ausentes. Isso não é uma prova
de cessação de todos os serviços/VMs do host; nenhum recurso existente foi parado
ou removido.

O typecheck normal da branch03 antiga terminou com TS18047 em
`test/sandbox/test-controller-core-candidate.ts:132`. Esse erro da infraestrutura
experimental não foi reparado nem ocultado como sucesso.

## Validação local

Ferramentas locais usam timeout de 60 segundos, conforme a nova aprovação do
operador. Isso não autoriza encerrar VMs ou serviços persistentes.

As dependências desta retomada foram instaladas do cache com
`npm ci --offline --ignore-scripts --no-audit --no-fund`. A tentativa inicial de
reusar dependências por symlinks fez o gate arquitetural enxergar caminhos fora
do checkout; foi corrigida a instalação, sem enfraquecer a regra arquitetural.
Não houve download, script de instalação ou uso de credenciais pessoais.

Com Node 24.21.0, no checkout da retomada:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmitOnError
npm run check:architecture
```

Typecheck, compilação, dependency-cruiser e ESLint passaram.

Testes focados usam `TMPDIR` e `FACTORY_SANDBOX_TEST_ROOT` em
`/home/sanmoo/software-factory-test/product-local-clYJQT`:

- Sandbox.validate e Sandbox.prepare: 7/7; inclui qemu-img real em arquivos
  descartáveis próprios, sem boot de guest ou prova de isolamento de VM.
- Configuração/doctor, protocolo e garantia de typecheck estrito: 9/9.
- Reexecução conjunta final: 17 casos, 16 passaram, 1 prova de VM explicitamente
  ignorada, nenhuma falha; duração total dos testes de 6,87 segundos.

A sondagem LSP não apresentou erro de TypeScript. O analisador auxiliar apontou
cinco sugestões e um alerta de `JSON.parse` em `prepareEnvironment`; a exceção
já é convertida em resultado indeterminado pelo `try/catch` de `Sandbox.prepare`.
Isso foi registrado, sem anunciar uma análise auxiliar totalmente limpa nem
refatorar código apenas para silenciar o alerta.

Não foi executada a suíte antiga em quarentena, nem houve boot, sinalização de
VM, alteração de serviço, acesso GitHub ou chamada de modelo.

## Próximo recorte do produto

Implementar e validar o lifecycle pela interface pública da Sandbox: iniciar,
observar e parar um ambiente próprio, depois comprovar reinício preservando dados.
Essa prova e os critérios de isolamento/cessação ainda estão pendentes. Não
integrar o incremento parcial nem declarar o ticket resolvido por estes testes.

## Primeiro incremento: observação pela interface pública

`Sandbox.observe` foi acrescentado diretamente ao módulo do produto, sem runner
ou controlador adicional. Valida referências e metadados privados/versionados,
consulta somente a unit derivada do boot próprio e correlaciona invocação,
cgroup e início do processo. Não usa PID isolado como prova de cessação nem
converte métricas indisponíveis em zero. Metadados antigos/incompletos ou aliases
não são adotados.

TDD no seam público Q5: os quatro testes inicialmente falharam com operação
inexistente (TS2339 e TypeError); após implementação passaram em 0,14s.
Cobrem ambiente desconhecido, alias de diretório, host boot diferente e evidência
incompleta, preservando arquivos e resultado indeterminado. Typecheck,
compilação e arquitetura/lint passaram novamente.

A reexecução conjunta com o novo incremento teve 21 casos: 20 passaram, uma
prova de VM continuou ignorada e nenhuma falha, em 5,93 segundos.

A revisão independente apontou dois problemas concretos e ambos foram corrigidos:

- Metadados agora são abertos com `O_NONBLOCK` antes de verificar por fstat que
  são arquivos regulares. A regressão pública com FIFO sem escritor falhou antes
  por timeout do subprocesso local recém-criado (1,5s) e passou após a correção
  em 0,11s; nenhum processo de VM foi alvo desse timeout.
- Ausência de `cgroup.events` não basta: a observação exige cgroup v2, mount da
  hierarquia completa, fonte de controllers legível e namespaces de cgroup/mount
  iguais aos registrados. Grupo existente sem eventos legíveis é indeterminado;
  ausência do grupo só vale após revalidar a disponibilidade da hierarquia.
  Essa correção foi analisada como fonte; não é prova de cessação de VM real.

Após as correções: typecheck, compilação e arquitetura/lint passaram; 22 casos
focados, 21 passaram, 1 prova de VM ignorada e nenhuma falha, em 6,03s.

Os ramos que retornam ativo/parado têm implementação real de consulta ao
systemd e `/proc`/cgroup; ainda não foram qualificados com uma VM real neste
incremento. Os testes negativos não substituem essa prova. Nesse checkpoint,
`start`, `stop`, reinício persistente e demais critérios continuavam pendentes.

## Segundo incremento: fonte do primeiro boot supervisionado

Acrescentados `Sandbox.start` e o entrypoint do proprietário Gondolin por boot.
O caminho de primeiro boot valida propriedade/configuração/pin, diretórios e
arquivo de disco próprios, espaço livre, integridade dos assets, formato e
container qcow2. Não instala componentes, baixa imagem, migra disco ou usa TCG.

Um lock de recurso por ambiente impede dois starts concorrentes. Lock preexistente
não é removido nem adotado. Identidade/intenção do novo boot são fsynced antes do
pedido ao systemd; erro ambíguo mantém a referência para observação, sem retry
cego. A unit usa nome derivado do boot, sem restart automático, e executa um único
proprietário Node com ambiente explícito, não o ambiente inteiro do host.

O proprietário confirma MainPID/invocação/cgroup/host boot antes de importar o SDK.
Usa KVM, disco standalone preservado, `tmpfs: {}` e somente workspace/artefatos
próprios por RealFSProvider. Só publica operacional após readiness do SDK e
verificação guest de Alpine/Docker-vfs, correlacionando o VMM com seu grupo e início
no `/proc`. Rede permanece desabilitada neste recorte: nenhuma chamada remota é
necessária ou foi feita.

Existe tratamento de TERM/INT para tentar finalizar Docker/sincronizar antes de
`VM.close`; isso **não é** API pública de stop, prova de parada graciosa ou de
cessação. A responsabilidade da supervisão permanece no systemd. O código não
foi exercitado com VM ou serviço real neste incremento.

Limite intencional: boot anterior ativo/indeterminado bloqueia substituição; até
boot anterior com cessação confirmada retorna `PRESERVED_DISK_CHECK_REQUIRED`.
Verificação do filesystem preservado e reinício serão implementados no próximo
recorte, sem usar apenas `qemu-img check` como prova de integridade do ext4.

A primeira regressão pública falhou com TS2339 (`start` inexistente) antes da
implementação e passou depois. Os sete casos locais de recusa passaram em 0,14s:
configuração inválida, ambiente não preparado, disco/configuração incompatíveis,
pin diferente, boot anterior ambíguo, lock preexistente e alias de disco. São
testes negativos com metadados deliberadamente incompletos; não são provas de
start positivo, KVM, Docker, isolamento de VM ou parada.

Compilação/typecheck e arquitetura/lint passaram. Sondagem LSP ativa nos seis
arquivos não retornou erros: dois confirmados limpos e quatro inconclusivos no
protocolo do servidor; não substitui o typecheck.

A única revisão independente encontrou dois P2, corrigidos diretamente:

- Os sockets agora têm paths explícitos e curtos, calculados antes de publicar
  intenção; todos os endereços efetivos, incluindo o UUID de sessão SDK, devem
  caber em 107 bytes. Root incompatível retorna `SANDBOX_RUNTIME_PATH_TOO_LONG`
  sem criar runtime/boot ou chamar o manager. A regressão pública foi RED
  (retornava `GUEST_ASSETS_INVALID` sem esse preflight) e GREEN após a correção;
  ela não reproduz um boot, mas verifica a recusa antecipada e preservação.
- O runtime é `<root>/r/<UUID-do-boot-em-base64url>`, criado exclusivamente, com
  registro privado de ambiente/boot. `TMPDIR`, cache e registry SDK são privados
  desse runtime. Antes de importar o SDK, o adapter verifica diretórios, registro
  e ambiente efetivo; os sockets explícitos são os mesmos paths verificados.
  O GC implícito do SDK passa a alcançar somente o registry desse boot, nunca
  um diretório comum a outros Trabalhos. Isso é correção de composição analisada
  em fonte, não prova de isolamento entre VMs reais. Nenhum registry antigo foi
  varrido, adotado ou removido.

Validação final após correções: typecheck, compilação, arquitetura/ESLint
(54 módulos, 217 dependências) e `git diff --check` passaram. **30 casos: 29
passaram, uma prova de VM ignorada, nenhuma falha, 6,34s**. O teste focado de start
passa8/8. Nova sondagem LSP de start/adapter: nenhum erro retornado, ambos
inconclusivos por silêncio do servidor; typecheck é a confirmação de compilação.

A revisão recomendou corrigir os dois pontos antes do commit; não foi convertida
em aprovação operacional nem relançada como cadeia de revisões. Nesse checkpoint,
`stop`, reinício persistente e qualificação real continuavam pendentes. Não houve
integração nem resolução do ticket03.

## Terceiro incremento: parada pública e pedido durável

`Sandbox.stop({ environment, boot, reason })` valida propriedade privada, boot do
host, unit derivada, invocação, cgroup e namespaces antes de solicitar parada.
Não depende do objeto SDK anterior e não sinaliza por PID ou prefixo global.
O pedido de parada é registrado antes do efeito; a configuração de unit no
`start` define `KillMode=mixed`, `SendSIGKILL=yes` e o prazo de parada. A resposta positiva exige a
cessação observada separadamente pelo caminho de supervisor/cgroup existente,
não apenas sucesso de `systemctl --no-block stop`.

`guestFinalization: observed` significa somente marcador válido de finalização do
guest. `termination: forced` é usado para resultado de timeout/OOM do manager;
outros resultados permanecem `unconfirmed`. Não se declara parada graciosa a
partir de sync, exit code ou `VM.close()`.

A primeira regressão pública foi RED com TS2339 (`stop` inexistente). Após
implementação, seis casos de recusa passaram: ambiente desconhecido, motivo
inválido, referência de boot inválida e divergências de host/cgroup/namespace.

A única revisão independente do stop, `f9f96ecf`, apontou um P2 no retry: ler um
JSON existente não confirma que o primeiro publisher terminou seus fsyncs. A
correção exige uma barreira própria de arquivo e diretório também no `EEXIST`.
O arquivo permanece aberto no FD validado com NOFOLLOW/NONBLOCK; após as
sincronizações, são rechecados inode publicado e estabilidade. Qualquer erro
impede a solicitação e retorna indeterminado. A leitura normal de `observe`
continua sem essa opção de sincronização.

Três regressões no seam público demonstraram RED antes da correção: retry após
falha de sync do arquivo, retry após falha de sync do diretório e segunda chamada
com o primeiro publisher ainda bloqueado antes do sync. O log do dublê mostrava
`stop` sem ambas as barreiras. Após a correção, os três passaram, exigindo a ordem
`file-synced → directory-synced → stop`. Dois casos adicionais verificam que uma
nova falha de sync de pedido existente não permite atuação.

Esses cinco testes substituem **somente a fronteira externa do manager** por um
executável Node local e injetam falhas/bloqueio na fronteira filesystem. `PATH`
contém exclusivamente o diretório do dublê, sem fallback para `systemctl` real;
nenhum SDK, unit, VM ou serviço é iniciado/parado. Fsyncs que não foram injetados
executam nos arquivos locais reais. Sucesso/cessação sintéticos do dublê não são
provas de cessação de VM, correlação systemd real ou sobrevivência a perda de
energia. Nenhuma flag ou seam de teste foi adicionado à API do produto.

Validação final: typecheck, compilação, arquitetura/ESLint (56 módulos, 235
dependências) e `git diff --check` passaram. **41 casos: 40 passaram, uma prova de
VM ignorada, nenhuma falha, 7,46s**. Stop passa11/11, incluindo os cinco casos com
dublê descritos acima. Sondagem LSP dos quatro arquivos não retornou erros, mas
os quatro resultados foram inconclusivos por silêncio do servidor; o typecheck
estrito é a confirmação de compilação.

Reinício ainda está bloqueado até implementar/verificar o filesystem preservado.
Qualificação positiva de primeiro boot/parada, parada graciosa, ciclo persistente,
isolamento, recuperação, remoção e transporte de ferramentas continuam pendentes.
Este incremento não integra nem resolve o ticket03.

## Qualificação autorizada — correções antes do primeiro guest

O operador autorizou uma única VM própria, 2048 MiB/2 vCPU/40 GiB virtual sob
`/home/sanmoo/software-factory-test`, preservando discos/evidências e recursos
anteriores. Preflight somente de leitura: 8.228.511.744 bytes de uso físico no
root de testes, cerca de 604 GB disponíveis no filesystem e 8,57 GB de memória
available. Nenhum QEMU apareceu no inventário naquele momento; isso não libera
reservas UNKNOWN históricas nem prova cessação universal do host.

Os dois manifestos preservados e seus kernel/initramfs/rootfs passaram novamente
pela integridade pública. A imagem base de pin `7b56e723...` não tem
`/usr/bin/docker` (debugfs read-only); não foi usada como fallback. A imagem
customizada de pin `8ed20af2...` contém Docker, mas mantém o risco histórico de
readiness/kernel6.18.60. Não há novo boot bem-sucedido atribuído a essa imagem.

- `lc03`: prepare real passou, mas start retornou
  `SANDBOX_RUNTIME_PATH_TOO_LONG`. Root tem39 bytes; socket de sessão teria108,
  acima de107. Não houve publicação de boot/unit. Disco e três registros de fase
  ficaram preservados. O erro de escolha de path foi corrigido dentro da etapa,
  sem converter a recusa em sucesso.
- `p3`: root37 bytes/socket106; prepare passou e a nova unit
  `factory-sandbox-boot-6d5317d6-6220-4d92-9995-345c4ab01645.service` entrou no
  entrypoint e gravou `started.json`. Em cerca de2s o processo saiu1; start retornou
  `BOOT_ENDED_BEFORE_OPERATIONAL_CONFIRMATION`. Sem `operational.json` ou witness
  de VMM. Observe real confirmou cessação e stop retornou sucesso de ambiente
  **já parado**, `termination: unconfirmed`, finalização indisponível. Isso não é
  parada ativa nem boot operacional. `result.json` preserva `accepted:false`.
  A unit manteve a invocação `6b1a70570aa64496b586b6142dfc5765`, failed/exit-code,
  MainPID0/ControlGroup vazio; grupo exato ausente, hierarquia/namespaces
  disponíveis. Nenhum recurso anterior foi sinalizado ou removido.

O diagnóstico local descartou falha de import SDK, construção com autoStartfalse
(sem chamar start) e `qemu --version` no ambiente explícito. O repro mínimo depois
chamou `start()` **com autoStartfalse** e obteve `sandbox is stopped`,
`bootMessageSent:false`. A fonte SDK0.14 em `VM.ensureRunning`, core.js1245–1253,
lança nesse estado antes de `ensureBoot`. Construtor e server.start não iniciam
VMM; portanto esse caminho impede o guest antes da mensagem boot. A falha de p3
não é atribuída ao kernel e não constitui um boot de VM consumido como prova.

Corrigida a composição para `autoStart:true`, mantendo start explícito, SDK
privado, autoRestartfalse e gates anteriores à construção. Revisão independente
`d0efd3c7` confirmou a semântica e não encontrou bloqueadores no delta/driver;
não converteu isso em GO de asset nem evidência de VM. A regressão pública é o
driver manual `test/sandbox/qualify-public-lifecycle.ts`, não descoberto por
`node --test`, com root novo `q3`, uma chamada start, stop público em finally e
OID completo da fonte obrigatório. Não cria supervisor/launcher ou seam de teste
novo; somente chama Q5 e registra um witness read-only independente.

Após a correção: typecheck/build/arquitetura/ESLint57 módulos239 dependências e
41 casos (40 passaram, uma VM ignorada, nenhuma falha) em11,52s. LSP não retornou
erros nos dois arquivos, ambos inconclusivos por silêncio do servidor. A prova
de **primeiro boot efetivo** continua pendente até executar o driver corrigido,
sem rerodar roots consumidos e sem substituir assets.

## Resultado da tentativa autorizada com política corrigida — REPROVADO

Fonte executada: `d94ff1abae2577929caf4de4a05344047e07b635`, Node24.21.0,
root novo `/home/sanmoo/software-factory-test/q3`; mesmo asset/pin customizado,
2048 MiB/2 vCPU/40 GiB virtual, rede desabilitada. O driver foi chamado diretamente
com esse OID, sem timeout que pudesse matar a unit e sem novo launcher. Nenhuma
prova antiga em quarentena foi habilitada. Preflight imediatamente anterior:
6.281.764.864 bytes de memória available e nenhum QEMU listado.

Prepare público passou. Boot retornado:
`boot-67f15b41-d851-4cd2-abed-459704d6ecd0`, ambiente
`env-3c4c1c75273af3b220333a76f5bd5a34865976bae63a851b4650fa480aae4d67`.
A unit própria tem invocação `40574fe1785840d294571b102209fb33`, igual à registrada
em `started.json`, e executou de22:02:20 até22:02:53 (UTC-03), saindo1. **Start
falhou** com `BOOT_ENDED_BEFORE_OPERATIONAL_CONFIRMATION`; não publicou
`operational.json`, e `result.json` registra `operationalBoot:false` e
`accepted:false`. Não houve reboot ou substituição de assets.

Observe público antes do stop já retornava parado/cessação confirmada. Stop
público retornou sucesso de recurso **já parado**, `termination:unconfirmed` e
`guestFinalization:unavailable`; a observação posterior permaneceu parada.
Isso é confirmação real de cessação do escopo próprio após falha, **não** prova
de parada ativa, Docker operacional ou parada graciosa. O erro específico do
SDK não foi preservado pelo entrypoint atual; não atribuímos esta nova falha ao
kernel apenas por sua duração ou pela falha histórica do mesmo asset.

### Correção da evidência de witness

O coletor capturou `/usr/bin/qemu-system-x86_64 --version`, executado pelo check
de disponibilidade do SDK. **Esse processo não é um VMM/guest.** O arquivo
original `q3/vmm-witness.json` foi mantido intacto e `witness-assessment.json`
registra sua insuficiência. Não prova aceleração KVM, recursos efetivos da VM,
hello do guest ou sucesso de boot. A autorização não é reutilizada inferindo
que faltou uma VM só porque não houve witness válido.

O driver foi corrigido para excluir probes de versão/ajuda, exigir kernel/initrd,
flags KVM/2048M/2 vCPU/disco próprio e witness válido como requisito adicional de
aceite. Essa correção **não foi rerodada com VM** e não reescreve o resultado
original. O diagnóstico posterior usou apenas o SDK com spawn de VMM bloqueado;
argumentos calculados nesse dublê tampouco são prova de execução/aceleração.

### Estado preservado e limite da prova

`q3/manager-final.json` guarda consulta read-only de01:12:45Z: unit failed,
Result=exit-code, ExecMainStatus1, mesma invocação, MainPID0, ControlGroup vazio;
o grupo exato está ausente e a hierarquia completa está disponível. Namespaces
cgroup4026531835/mount4026531832 correspondem aos registrados. Observe público
nessa coleta confirma cessação. Não se usa apenas PID0/exit code/SDK.close como
prova. Os counters da unit (MemoryPeak216.477.696 bytes/CPUUsage33.649.521.000ns)
são do escopo, não medida qualificada da RAM guest nem demonstração de vCPUs.

Root de testes usa9.854.144.512 bytes físicos (abaixo80GiB). `lc03`, `p3`, `q3`,
seus discos/registros e as units failed ficam preservados. Não houve sinalização
ou cleanup de recursos anteriores, download de assets, GitHub ou modelo. Nenhum
QEMU apareceu na inspeção posterior; a afirmação de cessação é restrita ao grupo
próprio verificado, sem liberar UNKNOWN/capacidade de ensaios históricos.

Fica bloqueada a qualificação positiva: primeiro boot operacional e parada ativa
não foram demonstrados. Antes de outro boot, é necessário preservar um diagnóstico
seguro do erro de startup e obter autorização para nova tentativa. Ticket03 e
integração continuam pendentes.

Após corrigir apenas o coletor (sem rerodar a qualificação real), passaram
typecheck, build, `node --check` do driver sem executá-lo, arquitetura/ESLint
57 módulos239 dependências e `git diff --check`. Suíte local focada: 41 casos,
40 passaram, uma prova de VM ignorada, nenhuma falha, 9,12s. LSP não retornou erro
no driver, mas foi inconclusivo pelo protocolo do servidor. Essa rodada local
verde não altera o resultado real **reprovado** nem comprova KVM.

## Diagnóstico seguro de startup — fonte e regressões locais

Para não perder novamente o erro de uma futura inicialização, o adapter agora
publica `failure.json` privado e fechado por boot, depois dos gates de identidade
/supervisão. O conteúdo é somente versão/boot/fase/código literal permitido.
Fases cobrem runtime, assets, import SDK, construção, start, perfil guest e
publicação operacional. `vm_start_timeout` é convertido em
`GUEST_READINESS_TIMEOUT`; erro não reconhecido vira
`UNCLASSIFIED_STARTUP_FAILURE`. Nunca se grava mensagem arbitrária, stack, env,
stderr ou payload do guest. O estado operacional impede confundir erro de
shutdown posterior a boot aceito com falha de startup.

`Sandbox.start` pode anexar `{ failure: { phase, code } }` a resultado falhado ou
indeterminado, inclusive ao explicar um boot anterior preservado. Lê pelo mesmo
FD seguro/limite/schema estrito e exige o boot correlacionado. Evidência ausente,
inválida, de outro boot ou com campos extras é omitida. Diagnóstico não confirma
cessação, não transforma deadline em sucesso nem libera o disco sem verificação.
O primeiro teste público foi RED por DTO ausente e GREEN após implementação;
seis casos públicos com manager double validam consumidor/correlação/canários.

A única revisão independente desse incremento, `9849d1c1`, encontrou P2 de
ordenação: um stop concorrente podia fechar enquanto o catch principal ainda
escrevia o diagnóstico. A publicação foi movida para a rejeição compartilhada de
startup aguardada por ambos os caminhos; um único Promise de close também evita
a chamada duplicada. Erro ao gravar é tolerado para não impedir encerramento.
A ordem controlada é **tentativa de diagnóstico → close do adapter**; cleanup
interno do SDK, prazo forçado do systemd, crash e perda de energia continuam
independentes. Não se promete que a VM permaneça viva até o fsync nem que todo
crash deixe diagnóstico completo.

Duas regressões no entrypoint real, com fronteiras externas dubladas, foram RED:
`close → failure-begin → ... → close`. Após correção, são GREEN:
`failure-begin → failure-written → file-sync → directory-sync → close`, e, para
falha injetada, `failure-begin → failure-failed → close`. Dois casos adicionais
cobrem código/mensagem desconhecidos e falha de startup sem pedido de parada.
O canário privado não aparece no arquivo nem em stdout/stderr.

Esses quatro testes usam o CLI existente em subprocessos Node locais, mock do SDK
externo, manager fake com PATH exclusivo, mapeamento de `/proc/self/cgroup` apenas
no filesystem do processo de teste e atraso/falha na escrita por FileHandle.
Invocam somente o callback recém-registrado do adapter: nenhum sinal OS real ou
emit global. Há bloqueio adicional da fronteira spawn de VMM caso o mock falhe.
Nenhuma VM ou unit/service real é criada. A flag experimental de module-mocks
fica restrita aos filhos de teste, sem flag/método novo no produto.

Validação final: typecheck/build, arquitetura/ESLint61 módulos261 dependências,
`git diff --check` passaram. **51 casos: 50 passaram, uma VM em quarentena
ignorada, nenhuma falha, 11,56s**. LSP nos sete arquivos não retornou erro, mas
todos inconclusivos pelo protocolo push-only; typecheck estrito confirma a
compilação. Os quatro testes do produtor e seis do consumidor são locais com
dublês, não prova de diagnóstico numa VM real.

O `failure.json` do antigo q3 continua ausente; não foi fabricado nem preenchido
retroativamente. q3 segue **accepted:false**, causa real desconhecida. Não houve
outro boot, sinal real, GitHub/modelos, cleanup anterior ou integração. A fonte
agora melhora a captura numa futura prova, que exige nova autorização de VM;
não resolve o primeiro boot operacional, reinício persistente ou o ticket03.
