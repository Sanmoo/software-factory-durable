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
