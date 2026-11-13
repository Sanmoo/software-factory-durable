# Interfaces públicas e composição — Software Factory MVP

Asset de [Definir a stack de implementação e a arquitetura interna da aplicação](issues/26-implementation-stack-and-application-architecture.md#answer).

**Estado: desenho aprovado e incorporado à [spec consolidada](spec.md), cuja composição completa também foi aprovada pelo operador.**
A resolução e a sequência de confirmações HITL estão no ticket. Q1–Q14 estão encerradas, com a delimitação final:
o novo gate arquitetural é estático; validade de mensagens permanece nos testes funcionais locais do protocolo já previstos,
sem monitoramento de chamadas, framework de enforcement em runtime ou bateria adicional cara.
A política de custo/cadência trata do desenvolvimento da própria Factory, não dos testes executados pelos Builders nos repositórios processados.
GitHub continua sendo a única implementação do MVP, sem registry/framework de fornecedores.
Não há implementação, instalação, benchmark ou prova de funcionamento neste documento.

## Sentido de interface pública

“Pública” significa utilizável por outro módulo da aplicação, não exposta à internet nem distribuída como SDK independente.
A interface inclui operações, dados, invariantes, ordenação, falhas e dependências necessárias ao uso correto.
Factories de composição constroem as implementações com configuração validada e dependências explícitas;
importar um módulo não abre SQLite, cria socket, inicia scheduler/VM/worker ou descobre perfil pessoal.

Os nomes abaixo descrevem contratos da fábrica, não APIs prontas de Pi Durable, Pi SDK ou Gondolin.
Os tipos mencionados reutilizam os registros/identidades dos contratos aprovados; não criam modelos persistidos paralelos.
Não se pretende fixar aqui cada classe, arquivo ou campo já definido nesses contratos.

### Convenções comuns

- IDs de Trabalho, Execução, invocação, rodada, efeito, pergunta, ambiente e boot mantêm os sentidos existentes.
  Uma string fornecida pelo agente não comprova identidade, papel, propriedade ou autorização.
- Uma observação externa traz origem, identidade, instante e completude/limitações. Leituras GitHub não formam snapshot remoto atômico.
  Erro, ausência comprovada, consulta incompleta e dado antigo não são o mesmo resultado.
- Operações com efeitos distinguem sucesso conhecido, falha conhecida e resultado indeterminado.
  Sucesso da chamada externa não confirma o commit posterior do controlador; transporte perdido não prova ausência do efeito.
- Erros operacionais esperados são resultados tipados, com código estável, alcance e próximo passo sem segredos.
  Exceção inesperada/falha de transporte permanece falha explícita; não vira vazio, sucesso ou repetição automática.
- As mutações de `IssueTracker`/`CodeRepository` expostas ao Controle recebem um contexto `effect` explícito
  com a identidade do efeito já persistido e as correlações/precondições pertinentes. O identificador não é autorização por posse nem idempotência externa.
  Nenhum adapter ganha autorização para repetir efeito ambíguo. Isso não se aplica à publicação Git/PR direta do Builder,
  que continua sem intenção específica prévia ou publicador adicional.
- Projeções por papel restringem as operações entregues a cada processo. Não são isolamento contra comprometimento do código host confiável;
  o confinamento efetivo de ferramentas/guest continua responsabilidade do adapter e dos mecanismos já aprovados.

## Q3 — Controle

**Chamadores:** ingressos locais/GitHub e tratamento das mensagens já vinculadas ao worker/adapter pelo host.
Implementação inclui regras, orquestração e persistência Pi Durable/SQLite; não expõe Session, transação ou acesso SQL.

| Operação pública | Entrada → saída | Contrato |
| --- | --- | --- |
| `accept(input)` | Comando/observação com origem verificada e correlações → recibo de aceitação, recusa ou indeterminação | Valida origem, fase, autorização e deduplicação; ingressos críticos só recebem confirmação durável depois do commit correspondente. Progresso pode ser apenas observacional, explicitamente distinto de confirmação durável. |
| `inspect(query)` | Consulta suportada → visão correlacionada | Status, filas, Trabalho, pedido, histórico e referências/leituras de evidência; paginação/filtros já aprovados, sem linguagem genérica de consulta. Não concede autorização nem consulta um banco paralelo. |
| `run(signal)` | Ciclo de vida do proprietário já exclusivo → resultado de parada limpa, falha ou parada incerta | Reconciliador, polling, tarefas/fases, despacho e retenção no proprietário existente. Começa com barreira fechada; parar solicita cessação e persiste contexto, sem cancelar Trabalhos implicitamente. |

`accept` não é um barramento de eventos nem cria fila persistente de ingressos: o recibo crítico e a transição ficam no mesmo commit.
Comando reconhecido/aceito não significa Execução iniciada ou efeito concluído. `inspect(request_id)` permite consultar esse resultado.
Resultados ambíguos não autorizam o chamador a inventar outro ID e reaplicar a mutação.

O entrypoint precisa adquirir o lock aprovado **antes** de abrir a implementação durável; a construção não substitui `flock`.
A barreira protege qualquer caminho Pi Durable capaz de alcançar efeito, mesmo antes/depois de entrar no loop de `run`.
Pi Durable e SQLite são detalhes privados deste módulo, não um módulo CRUD adicional.
Regras internas podem ser funções puras sobre os tipos canônicos, sem importar GitHub/Gondolin/Pi coding-agent concretos.

**Não exportar:** setters de estado/Slots/orçamento, acesso SQL, `spawnBuilder` que dispense admissão, `markReady` que dispense evidências,
reabertura genérica de task ou comando que ignore todos os impedimentos.

**Aprovado:** três operações externas, com o ciclo durável e seus efeitos encapsulados, sem motor/repositório paralelo.

## Q4 — Issue tracker e code repository separados

**Recorte aprovado pelo operador:** contratos distintos para tracker e repositório de código, permitindo futura troca independente de serviços.
Separação de responsabilidades agora, não implementação/configuração de outros fornecedores no MVP.
As superfícies abaixo substituem a proposta inicial de um único módulo GitHub;
suas operações detalhadas Q4A/Q4B foram confirmadas pelo operador.

**Vocabulário aprovado:** `IssueTracker` trata o pedido; `CodeRepository` trata sua hospedagem remota, PR e controles de entrega.
Git local, checkout, workspace e comandos Git no guest não são este segundo módulo e continuam no fluxo de sandbox/Builder.
`TicketRef` e `RepositoryRef` são identidades distintas, mesmo quando ambas se referem ao mesmo repositório GitHub.
Reutilizar suas identidades qualificadas/imóveis existentes, sem impor um esquema universal para serviços ainda não estudados.

### Q4A — IssueTracker

**Estado: operações aprovadas pelo operador.**

**Chamador:** controlador. O escopo do tracker identifica a origem configurada dos Tickets;
no MVP vem do repo/label GitHub já configurados, sem nova descoberta ou regra de entrada.

| Operação pública | Entrada → saída | Contrato |
| --- | --- | --- |
| `checkAccess(scope)` | Origem configurada → diagnóstico operacional | Identidade, leitura de Tickets/dependências/comentários e escrita autorizada de perguntas/marcos; não certifica capacidades invisíveis. |
| `listCandidates(scope)` | Origem e seletor configurados → observação de referências de Tickets | Paginação/limites encapsulados. Listagem parcial não comprova ausência de candidatos; resultado não admite Trabalho. |
| `readTicket(ticket)` | Ticket qualificado → situação e metadados de entrada | Estado, label, motivo de fechamento e identidade pertinentes; não ingere fontes documentais nem declara autorização persistente. |
| `readDependencyGraph(ticket)` | Ticket raiz → grafo nativo alcançável e completude | No adapter GitHub, `gh api` + REST, inclusive destinos/páginas/bloqueadores encerrados. Não aplica satisfação por ciclo próprio/merge. |
| `readInputs(ticket, cursor)` | Ticket e posição de leitura → comentários com autoria/continuação | Não interpreta prosa como autorização nem lê feedback de PR por conhecer o mesmo fornecedor. |
| `findQuestion(ticket, questionId)` | Destino e marcador estável → candidatos e evidências | Consulta incompleta não prova ausência; múltiplos candidatos não são escolhidos por conveniência. |
| `postComment(ticket, comment, effect)` | Pergunta/marco concreto autorizado e efeito correlacionado → resultado externo | Usa correlação estável prevista; não altera labels, assignees ou estado do Ticket. Não oferece endpoint arbitrário. |

### Q4B — CodeRepository

**Estado: operações aprovadas pelo operador.**

**Chamador:** controlador. A publicação Git/PR do Builder continua direta no guest com credencial reduzida;
este módulo não se torna publicador da implementação.

| Operação pública | Entrada → saída | Contrato |
| --- | --- | --- |
| `checkAccess(repo, base)` | Repo/base configurados → diagnóstico operacional | Identidade/escopo/capacidades de acompanhamento e controles permitidos; não certifica/monitora barreiras de merge ou segurança de CI. |
| `readPullRequest(pr)` | PR próprio conhecido → fatos atuais correlacionados | Head/base, estado/merge/conflito e dados necessários aos checks aplicáveis. Não decide prontidão. |
| `readInputs(pr, cursor)` | PR próprio e posição de leitura → comentários/reviews/feedback com autoria/continuação | Inclui comentários gerais e de revisão pertinentes; parsing/autorização de comandos ficam no Controle. |
| `findPublication(correlation)` | Repo/branch/identidades conhecidas → refs e candidatos ao PR próprio | Reconcilia publicação incerta sem adotar PR desconhecido ou recriar antes de descobrir. Consulta incompleta não prova ausência. |
| `findQuestion(pr, questionId)` | Destino e marcador estável → candidatos e evidências | Permite descobrir pergunta dirigida ao PR, sem depender de IssueTracker para comentários do PR. |
| `postComment(pr, comment, effect)` | Pergunta/marco concreto autorizado e efeito correlacionado → resultado externo | Mesmo contrato de correlação/ambiguidade, aplicado à superfície do PR. |
| `setDraft(pr, draft, effect)` | PR próprio, estado desejado autorizado e efeito → resultado externo | Conversão ready depende de decisão/evidências já verificadas pelo Controle; flag remota não substitui prontidão interna. |
| `reopenPullRequest(pr, effect)` | PR próprio fechado sem merge e efeito → resultado externo | Não renova autorização, escopo ou orçamento e não inicia Builder. |
| `cleanupBranch(selection, effect)` | Branch própria selecionada/autorizada e efeito → resultado externo | Preserva base/recursos desconhecidos e os controles de concorrência aprovados; sem merge, aprovação ou push mediado. |

### Implementação compartilhada e decisões que não mudam

Os adapters `GitHubIssues` e `GitHubCodeRepository` podem compartilhar código privado de transporte, autenticação,
paginação e normalização, sem importar a implementação um do outro. Código comum não vira contrato público `GitHub` do Controle.
A composição conecta as duas interfaces; não precisa de registry de plugins, serviços extras, testes de todas as combinações
ou configuração de outros fornecedores para entregar apenas GitHub.

Perguntas/marcos pertencem à interface da superfície que os hospeda: issue no tracker, PR no code repository.
Parsing, autorização e correlação de comandos permanecem únicos no Controle. O módulo tracker não consulta PR por conta própria,
e o módulo de código não lê dependências de Tickets por conta própria.
O Controle junta os fatos: uma dependência própria só é satisfeita pelo merge do ciclo correspondente.
Cada Ticket continua associado a exatamente um repositório no MVP; esta separação não concede trabalho multirrepositório.

Credenciais de GitHub App são infraestrutura específica do fornecedor, não métodos obrigatórios das duas interfaces de domínio.
O emissor compartilhado continua somente no controlador; emissão/redução/renovação/revogação por finalidade preservam o contrato aprovado,
inclusive tokens em memória, escopo mínimo e riscos de perda do valor após crash.
A composição e a projeção `BuilderCredentials` adiante concretizam a emissão/renovação para o Builder,
sem duplicar essa operação nos dois módulos ou inventar um protocolo universal de autenticação.

Retentativas de leitura respeitam rate limit; repetição de mutação ambígua depende da reconciliação do controlador.
Identidade de efeito/marcador serve à correlação, não cria idempotência externa automaticamente.
Não aplicar uma transação fictícia entre tracker, code repository e SQLite, mesmo quando os dois adapters usam GitHub.

**Aprovado:** recorte/nomes e operações detalhadas de Q4A/Q4B; composição e projeção de credenciais foram confirmadas separadamente em Q9/Q10.
Suporte real a outros serviços continua pós-MVP; o desenho não garante compatibilidade sem analisar suas capacidades e semântica.

## Q5 — Sandbox

**Chamadores:** controlador para ciclo de vida; worker recebe somente a projeção de ferramentas do seu papel/boot vigente.
Preservar a interface já aprovada em [contrato do adapter](issues/19-gondolin-adapter-contract.md#interface-referências-e-resultados).

| Operação pública | Entrada → saída | Contrato |
| --- | --- | --- |
| `validate(configuration)` | Configuração/perfil/pré-requisitos → diagnóstico | Sem boot; validação estática não prova Docker. |
| `prepare(work, configurationRef)` | Trabalho e configuração efetiva autorizados → `environment_ref` | Recursos próprios, repetição reconhecível, sem iniciar agente. |
| `start(environment, configurationRef)` | Ambiente preservado/configuração compatível → `boot_ref` operacional | Novo boot, não adoção de sobrevivente. |
| `executeTool(context, call)` | Boot/invocação/papel/operação → resultado/atividade/erro e referências de saída | Valida contexto vigente e acesso permitido; não expõe SDK Gondolin ou ferramenta host irrestrita. |
| `observe(environment, boot?)` | Referências próprias → condição, evidências e consumo disponível | Funciona para inventário/parada mesmo sem o proprietário Gondolin antigo vivo; indisponível não é zero. |
| `stop(environment, boot, reason)` | Recursos próprios → resultado de parada e evidências | Preserva disco/workspace; distingue pedido, cessação confirmada e parada graciosa. |
| `remove(environment, cleanup)` | Cleanup autorizado e cessação → resultados individuais | Remoção parcial/indeterminada permanece explícita; não apaga histórico ou recursos GitHub. |

Referências são opacas: Controle não lê unit/PID/path/QEMU/cgroup nem replica dimensionamento da configuração.
A execução das ferramentas passa pelo processo de adapter por Trabalho, dono da única instância Gondolin daquele ambiente;
workers não criam outra instância nem recebem o objeto irrestrito do SDK.
O transporte local concretiza essas chamadas, sem criar outro serviço global ou método concorrente de supervisão.

O papel é vinculado pelo host, não pelo modelo. Builder recebe o conjunto aprovado; Standards/Spec somente leitura `read` confinada.
Conexão perdida, cancelamento e geração/fase inválida impedem novas chamadas conforme o protocolo.
Uma chamada já enviada pode ter produzido efeito; timeout não a transforma em não executada.

**Componente fechado de cópia Bash (§12.2), não trigger automático:** `ToolProjection.executeTool`
aceita `{name:'bash', operation:'copy-output', reference, callId}` sem mudar o schema MODEL nativo.
O host confiável deve selecionar saída nativa truncada; `copyOutput: true` privado é explícito/default-deny,
fotografado antes do primeiro await e não concede WorkAdmission. Exige também `profileOrigin` exato
`factory-development-gondolin-0.14.0-stdin-capacity-v1`: o adapter o grava somente após a seleção SDK
verificada e o encaminha ao owner da MESMA VM pelo quinto argumento privado de `serveOwnerRegistration`.
O adapter não habilita a política por padrão; JSON, WorkerBootHost e Records não qualificam a VM.

Somente o último Bash concluído deste binding/contexto completo/fase/role/lifetime é elegível, em um slot.
Novo comando limpa o slot antes de efeitos; cópia exige callId diferente do original e gasta o slot
sincronamente antes do primeiro await. Spec/standards, refs read/raw/alheias/antigas e reabertura sem slot
não copiam. Chamador não fornece path/count/hash. Contexto/callId/bytes originais alimentam
`Records.projectText`; TODOS os bytes refiltrados atuais, inclusive tail, passam incrementalmente a stdin
AsyncIterableBuffer da VM qualificada com `stdinCapacity.maxChunkBytes:65536`; count/SHA256 são incrementais.
Não há segundo filtro/truncador, payload integral em memória ou montagem host de Records.

O helper SOURCE deriva do engine FD privado de Write; cria exclusivamente `/artifacts/factory-output-UUID.txt`
com parent/FD autorizados, NOFOLLOW/O_EXCL/NONBLOCK/CLOEXEC, sem truncate/mkdir/overwrite/repair/delete.
Exec guest usa `/usr/bin/env -i /usr/bin/python3`; stdin raw, writes parciais completos e receipt JSON pequeno
bytes/SHA256 após EOF. Buffer host de validação de receipt tem teto8192. Exit0 isolado não basta: exige
receipt estrito/count/hash e projeção completa. Intent e observação guest/metadata protegida são persistidos;
contexto/sinal e `assertCompleteAndCurrent()` são revalidados depois de TODOS os awaits imediatamente
antes do retorno local ReadResult text com pequeno JSON path/bytes/sha256 (nunca spill path host).
Incerteza revoga mutações sincronamente antes de aguardar evidência; sem sucesso/path grant/blind retry.
É ponto de publicação local, não transação sobre awaits futuros, snapshot/CAS, exclusão de writers,
membership contínua, hostile-root, physical FD cessation ou durabilidade. Bytes aceitos podem ser irreversíveis.
Testes usam Records FS real+VM receipt DOUBLE explicitamente qualificado e AST de SOURCE, nunca executado
no host; não provam kernel/native VM/backpressure. Trigger SDKWorker autoTruncation, Read Builder normal,
seleção reviewer/UI e reabertura modelSession ficam explicitamente para integração posterior.

**Aprovado:** usar esta interface sem redesenho, com projeções de ciclo de vida/ferramentas e implementação Gondolin privada.

## Q6 — Workers/agentes

**Chamador:** controlador. Implementação distribuída entre sua parte host de integração e os entrypoints dos workers Pi;
isso não significa novo serviço ou motor. Supervisão/grupos de processos continuam pelo adapter/systemd aprovado.

| Operação pública | Entrada → saída | Contrato |
| --- | --- | --- |
| `activate(invocation)` | Execução/invocação/papel/perfil/boot e referências de contexto → resultado de solicitação com identidade própria | Reserva/autorização precisam estar confirmadas antes. Solicitação/spawn não comprova entrada em atividade; recibo durável de início precede modelo/ferramenta. |
| `deliver(worker, directive)` | Destinatário vigente e diretiva permitida → resultado de entrega | Resultados reais de revisão à sessão parada no handoff ou atualização transitória de credencial. Entrega não comprova consumo/checkpoint pelo SDK. |
| `observe(worker)` | Identidade de invocação → recibos/resultados/contexto disponíveis e limitações | Permite descobrir resultados preservados sem rerodar. Não prova cessação física ou adota processo sobrevivente. |
| `interrupt(worker, reason)` | Worker vigente e motivo → pedido de interrupção e observações | Fecha novas chamadas e solicita abort; confirmação física continua pela supervisão/sandbox, não pelo retorno do SDK. |

`invocation` identifica Builder/Standards/Spec e modo inicial/continuação compatível/recuperação substituta.
Contém referências da sessão/perfil/pedido/rodada pertinentes; a primeira ativação do Builder recebe `/implement <link-ticket>`.
Não exige ingestão documental pelo controlador. Credencial é entregue em memória pelo caminho transitório, não gravada na invocação.

`deliver` não reativa uma Execução encerrada, muda o escopo em curso ou abre outra: resposta humana após espera passa por nova admissão/ativação.
No handoff interno, Builder fica sem turnos/ferramentas; somente após fim da atividade dos revisores recebe os resultados.
A interrupção solicitada pelo host não altera o resultado do Trabalho para cancelado sem decisão do Controle.

Eventos de progresso/pergunta/handoff/parecer/fim/uso seguem o protocolo existente, com referências aos resultados completos protegidos.
Ask user e parecer completo são preservados antes da notificação conforme seus contratos; streaming parcial não é resultado.
O módulo não oferece `reviewAllAndApprove` nem pode sintetizar parecer ou declarar prontidão com base em texto/exit code.

**Aprovado:** esta superfície de ativação/entrega/observação/interrupção, mantendo SDK, loader, sessões e retries internos privados.

## Q7 — Protocolo local

**Chamadores:** entrypoints e partes host dos módulos que se comunicam entre processos.
Não interpreta autorização de produto nem guarda estado de negócio.

| Operação pública | Entrada → saída | Contrato |
| --- | --- | --- |
| `listen(endpoint, handler, expectedPeers)` | Endpoint privado e vínculos esperados → servidor/conexões | Aceita frames completos válidos e vincula peer à invocação esperada; handshake autoafirmado não concede papel. |
| `connect(endpoint, invocation)` | Destino/identidade prevista pelo host → canal | Confere o único formato suportado pela release; incompatibilidade falha sem atuação, sem negociação multiversão. |

Um canal permite `send(envelope)` e `close()`; o handler recebe mensagens completas e fechamento/erro.
Serialização, framing/buffering, validação estrutural e limites ficam privados.
A aplicação distingue resposta correlacionada, progresso e confirmação durável pelo tipo/conteúdo da mensagem,
não por sucesso de `send`. Não há ACK durável fabricado pelo transporte ou replay automático de comandos.

Regras de autorização, fase, deduplicação durável e aceitação de evidência antiga permanecem no Controle.
EOF é um fato entregue ao responsável pela parada; timeout de uma solicitação ou silêncio não é EOF.
O módulo não cria heartbeat, broker, HTTP público, PKI, fila offline ou framework RPC.

**Aprovado:** transporte fino e concreto, reutilizado sem espalhar codecs/socket bruto entre módulos.

## Q8 — Registros/evidências

**Chamadores:** processos host confiáveis, com projeções/contextos próprios; leitura operacional e limpeza pelo controlador.
Não é banco de controle, cofre ou escritor alternativo de histórico/decisões.

| Operação pública | Entrada → saída | Contrato |
| --- | --- | --- |
| `registerSecret(value)` | Segredo conhecido neste processo → registro somente em memória | Antes de usar nos caminhos controlados; não persiste, não envia ao modelo nem recupera valores perdidos. Rotação registra o novo valor antes de expô-lo às ferramentas. |
| `record(context, event)` | Evento correlacionado → referência/resultado de gravação | Filtra antes dos destinos controlados; distingue evidência crítica e amostra auxiliar para que o chamador aplique a política de falha aprovada. Não confirma transição de domínio. |
| `openOutput(context)` | Chamada/ferramenta correlacionada → canal de saída filtrada | Recebe chunks, mantém estado entre fragmentos e finaliza captura com resumo/referência. Destinos SDK/exibição recebem somente saída filtrada; grande saída não é acumulada integralmente em memória. |
| `preserve(evidence)` | Evidência própria que precisa sobreviver ao cleanup → referência protegida | Não é coletor documental nem saneamento universal de arquivos arbitrários. Conserva contexto/resultados/fontes necessários, sem inventar conteúdo faltante. |
| `read(selection)` | Referências/filtros autorizados → página/trecho e estado da captura | Distingue íntegro, exibição truncada, captura parcial, removido/expirado/ausente e resultado desconhecido. Sem leitor operacional paralelo pela CLI. |
| `projectText({context, reference, expectedBytes, signal?})` | Captura textual completa já autorizada pelo host → `{chunks, state, assertCompleteAndCurrent()}` | Projeção técnica incremental pelo mesmo filtro e leitor paginado; segredos atuais desta instância, UTF-8 fatal contínuo, BOM persistido preservado. Não concede acesso nem materializa cópia guest. `state: complete` somente após consumir até EOF/finalização; erro/cancelamento/fechamento antecipado não são saída íntegra. |
| `remove(plan)` | Seleção concreta autorizada/revalidada pelo controlador → resultados individuais | Verifica recurso próprio/em uso; não decide elegibilidade de retenção, não apaga estado de domínio e não executa cleanup de VM/GitHub. |

O canal de saída permite fornecer chunks e finalizar a captura; pode reter a cauda necessária à filtragem de segredos fragmentados.
A integração entrega somente resultados já filtrados ao caminho que alimenta a persistência nativa Pi SDK.
Filtrar depois de o SDK persistir não cumpre a interface; exceção de filtragem não autoriza fallback bruto.
A capacidade dessa integração permanece a provar no perfil escolhido.

Sessões continuam no formato nativo do SDK, configuradas em local protegido e correlacionadas pelos registros;
não se cria formato substituto de sessão nem cópia integral duplicada por padrão.
A cópia de saída disponibilizada ao agente segue a interface de sandbox/área seletiva aprovada,
não montagem de `data/records` ou nova ferramenta de logs; ela não vira autoridade do resultado do comando.

`projectText` é somente o pré-requisito técnico da cópia seletiva (§12.2), não operação administrativa ou grant.
O host continua responsável por autorizar proprietário/contexto completo/fase/referência; a comparação do contexto gravado não autoriza uma fase.
`expectedBytes` é o total finito seguro da fonte completa, não tamanho da saída refiltrada. Chunks de bytes têm no máximo 65536 bytes
(e podem partir UTF-8); consumidor deve drenar o iterador, nunca interpretar fechamento antecipado como sucesso.
`state === 'complete'` é histórico: o iterador foi exaurido com EOF/finalização verificados; não prova revisão atual após conclusão.
`TextProjection.assertCompleteAndCurrent(): void` verifica sincronamente esse estado, a mesma revisão de segredos da mesma instância Records
capturada na construção da projeção e que o `signal` original não foi abortado. Falha usa somente `RecordsError` fechado
(`PROTECTED_CAPTURE_UNAVAILABLE`), sem motivos privados. Chamada antes de completar rejeita sem envenenar consumo válido;
registro novo ou abort depois de completar rejeita sem alterar o estado histórico `complete`; duplicata continua no-op.
O futuro proprietário deve chamar o guard depois de aguardar o resultado guest e antes de publicar a cópia. É um único ponto de validação,
não transação cobrindo awaits futuros, lease, autorização de fase/proprietário, grant ou publicação automática.
Não relê o filesystem: atual significa somente revisão do filtro e sinal, não snapshot imutável da fonte ou autorização do contexto.
O chamador conserva responsabilidade por contexto completo, permissão durante toda a vida e efeitos guest incertos;
não há proteção automática/recall de bytes já copiados. Uma nova projeção pode usar o filtro atualizado sem reparar cópias anteriores.
A projeção não cria arquivo adicional nem modifica captura/semântica de `read`; usa um decoder contínuo e o filtro existente incluindo sua cauda final.
Registro novo durante a projeção impede releases subsequentes e conclusão; duplicata não altera revisão. O fence é da mesma instância em memória,
não coordenação entre processos, recall de bytes já liberados, erasure retroativa ou prova de cessação física.
`AbortSignal` é verificado antes/depois das leituras e antes dos yields; consumidor fecha o iterador em `finally` se abandonar consumo.
Não mantém descritor aberto durante yield. Cancelamento não interrompe syscall em andamento; fechamento/retomada descarta a cauda.
Contagem/completude/contexto são revalidados por página e ao finalizar; não há snapshot imutável contra adulteração host de mesmo tamanho.
Nenhuma boundedness de transporte Gondolin, escrita guest, nova ferramenta ou novo grant de invocação é inferida desta API.

**Aprovado:** centralizar filtragem e operações de evidência, sem mover para cá autorização, orçamento, prontidão ou política de retenção.

## Q9 — Composição, dependências e distribuição

**Estado: aprovado pelo operador.**

Usar composição explícita por funções/constructors nos entrypoints, sem container de DI, service locator ou descoberta de plugins.
Os diretórios abaixo ilustram responsabilidades da futura aplicação, não novos serviços, packages publicáveis ou arquivos a criar neste PKM:

```text
src/
  contracts/
  control/
  issue-tracker/
  code-repository/
  sandbox/
  workers/
  protocol/
  records/
  platform/
    github/
    host/
  entrypoints/
```

Configuração/perfil são lidos e validados pelo bootstrap; cada processo recebe somente sua projeção necessária.
Configuração específica de sandbox é validada/interpretada pela implementação de sandbox.
Não criar ConfigService persistente, recarga automática, perfil pessoal herdado ou configuração paralela por módulo.
Tipos públicos específicos pertencem ao módulo que os define e são reutilizados pelos consumidores, sem duplicar modelo de domínio/estado.
Identidades e contratos neutros realmente compartilhados ficam em `contracts`, conforme refinamento aprovado em Q13.
Importações de tipos não devem carregar implementações ou causar efeitos de abertura.

| Entrypoint interno | Composição e limite |
| --- | --- |
| CLI | Parseia/valida argumentos, monta ingresso identificado e conversa com o Controle pelo protocolo. Setup/diagnóstico offline respeitam o escopo aprovado; inspeção/mutação operacional não abre SQLite. |
| Controlador | Launcher único para primeiro plano/serviço adquire o mesmo `flock` antes do storage. Bootstrap conecta as interfaces aprovadas, a implementação durável privada e o emissor de credenciais; só depois conduz o ciclo `run`. A barreira já está fechada ao abrir Pi Durable. |
| Worker | Carrega perfil explícito, SDK, sessões e registros próprios; recebe ferramentas confinadas e canal vinculado à invocação. Não instancia Controle, abre SQLite operacional ou carrega chave da App. |
| Adapter por Trabalho | Possui a instância Gondolin/VM e atende operações autorizadas. Supervisão/inventário/parada continuam disponíveis por caminhos host próprios mesmo após perda do proprietário antigo. |

O Controlador depende dos contratos `IssueTracker`, `CodeRepository`, `Sandbox`, `Workers`, `Records` e da projeção de credenciais abaixo,
não das implementações GitHub/Gondolin/Pi coding-agent. Regras puras internas também não dependem de Pi Durable.
A implementação durável do próprio Controle depende diretamente de Pi Durable/SQLite: não inserir interface CRUD genérica ou outro modelo persistido.
Worker/adapter usam protocolo e registros, mas não importam a implementação do Controle para tomar decisões locais de fila/orçamento.

As implementações GitHub podem compartilhar infraestrutura privada. Da mesma forma, o encaixe host de Workers e Sandbox pode reutilizar
código privado de integração systemd, com a organização/identidade de recursos do boot preparada pelo adapter.
`Workers.activate` usa esse contexto de supervisão já correlacionado; não inventa outro agrupamento, interpreta flags Gondolin ou lança processo fora dele.
A descoberta de cessação permanece pela interface Sandbox. Isso não cria supervisor próprio ou altera a autoridade de ativação do Controle.
Não há módulo de aplicação adicional de supervisão nem serviço para compartilhar esse código.

Build usa `tsc` para JavaScript ESM e typecheck estrito, com configuração compatível com o Node fixado.
Preparação da release inclui JavaScript, dependências runtime do lockfile, Node privado, skills e assets/manifestos já exigidos.
Sem bundler ou compilação TypeScript/`npm install` pelo operador durante instalação/ativação.
Versões/integridades finais e dependências nativas compatíveis continuam obrigações da construção/validação da release, não valores escolhidos neste desenho.

## Q10 — Credenciais do Builder como dependência estreita

**Estado: aprovado pelo operador.**

Explicitar uma projeção de composição, não um serviço ou módulo de negócio adicional:

```typescript
interface BuilderCredentials {
  issue(context: BuilderCredentialContext): Promise<BuilderGrant>;
  revoke(grant: BuilderGrant): Promise<RevocationResult>;
}
```

- `context` identifica Trabalho, Execução ativa e repositório; a composição já vincula configuração/finalidade autorizadas.
  O modelo não solicita permissões arbitrárias. O adapter deriva/verifica a redução aprovada, inclusive configuração explícita de Workflows.
- `BuilderGrant` reúne material transitório de entrega, validade e metadados não secretos. Só os metadados podem entrar no estado durável.
  Não retornar o segredo de uma operação cujo resultado Pi Durable vá serializar, nem persistir payload de entrega em logs/sessões/recibos.
- No MVP, a implementação usa o emissor GitHub App privado compartilhado pelos adapters, somente no controlador, onde fica a chave.
  Adapters obtêm suas credenciais por finalidade internamente; não recebem token universal ou credencial do Builder por conveniência.
- Renovação é nova chamada `issue` após revalidar autorização da atividade existente, antes do vencimento; não exige método `renew`.
  Retirada da label impede novos disparos, mas não revoga por si a autorização de a Execução ativa concluir/publicar, conforme contrato vigente.
- O resultado transitório é entregue por `Workers.deliver` ao caminho host que fornece ambiente explícito às ferramentas autorizadas.
  Na inicialização, essa entrega integra o handshake host antes de liberar operações dependentes da credencial;
  ela não é incluída no registro durável de `invocation`. Registrar valores conhecidos para filtragem antes de usá-los;
  nunca acrescentar segredo ao prompt.
  Formato GitHub de ambiente/credential helper fica na implementação, não nas regras de controle.
- Novo comando recebe a concessão vigente; subprocesso já iniciado conserva ambiente anterior. Renovar não é prova de interrupção nem motivo de reinício.
- Ao encerrar/esperar externamente/cancelar, revogar concessões conhecidas quando possível. Material perdido após crash não é recuperado magicamente;
  observar/reconciliar e registrar o risco já aprovado, sem cofre ou prova fictícia de revogação/cessação.

Esta interface não é protocolo universal de autenticação, não garante adequação a provedores futuros e não põe `issueToken` nos contratos de tracker/código.
Não cria armazenamento persistente de segredos ou endpoint público de emissão.

## Q11 — Interfaces de teste e exemplos de fluxo

**Estado: aprovado pelo operador; não autoriza execução de provas.**

Testes chamam os mesmos contratos usados pela aplicação. Composição explícita permite trocar implementações externas,
não reimplementar Controle, armazenamento de domínio ou scheduler em um test double.

| Nível | Composição | Limite |
| --- | --- | --- |
| Regras internas | Funções determinísticas sobre os tipos canônicos, com entradas/tempo controlados quando pertinentes | Exercita cálculos, não SQLite, processos ou GitHub. É seam interna do módulo, não comando operacional para alterar relógio/estado. |
| Fluxos de controle | Controle real + Pi Durable/SQLite temporário + dublês de tracker, código, sandbox, workers e credenciais | Exercita transações/filas/limites/reconciliação lógica; não prova integração substituída. Sem fake de um segundo motor ou banco em memória como prova de persistência. |
| Protocolo/registros | Sockets Unix e filesystem temporários reais, entradas/fragmentação/segredos sintéticos e falhas controladas | Exercita framing, filtragem, paginação e perdas; persistência nativa SDK precisa de sua integração real, não só teste de logger. |
| Fronteiras e jornada | Adapters/componentes reais no perfil fixado, com agentes/modelos e pilotos nos níveis exigidos pelo plano de aceite | Não exige modelo em cada permutação e não converte simulação/documentação em homologação. |

Tempo de calendário e tempo monotônico são dependências distintas nos pontos que os usam.
Testes de duração viva controlam o relógio monotônico local, sem comparar origens entre processos.
Esperas/backoff persistidos do Pi Durable conservam seu contrato próprio; não substituir seu `now` por relógio monotônico.
Testes devem usar os controles de tempo suportados ou testar a decisão antes/depois do prazo, e integrar o disparo real separadamente quando necessário.

### Exemplo: resposta e retomada

1. Pela interface `accept`, apresentar resposta autorizada/correlacionada a uma Pergunta existente.
2. Confirmar resposta/impedimento/histórico e pendência de fila no mesmo armazenamento real, sem spawn direto pela aceitação.
3. Reapresentar a mesma entrada: resultado conhecido, sem duplicar resposta, cobrança ou posição.
4. Executar o ciclo de controle com fatos externos controlados: só solicitar `Workers.activate` após revalidar elegibilidade, capacidade e reserva durável.
5. Reabrir o mesmo storage com barreira fechada e observar preservação das decisões; crash/processos sobreviventes requerem também prova real do plano.

### Exemplo: dependência e merge sem acoplamento entre fornecedores

1. Tracker informa bloqueador próprio fechado/completed; registro local aponta ciclo cujo PR ainda não teve merge confirmado.
2. CodeRepository informa PR aberto: dependência continua não satisfeita.
3. CodeRepository confirma merge do ciclo correto: Controle pode liberar o dependente, respeitados os demais impedimentos.
4. Se houve novo ciclo do bloqueador, merge do anterior não satisfaz o novo. Nenhum adapter consulta a implementação do outro para decidir isso.

`npm test` executa a suíte local sem modelos, credenciais reais, GitHub remoto ou boot de VM.
Integrações externas/agentes/piloto são suites e comandos explicitamente separados, com pré-requisitos e autorizações próprios.
Teste selecionado sem requisito necessário não conta como aprovado; resultados ausentes/reprovados/inconclusivos mantêm os gates pendentes.
A matriz de aceite aprovada continua sendo a autoridade da cobertura/evidência; esses exemplos não a substituem ou ampliam o escopo.

## Q12 — Custo e cadência do quality gate da própria fábrica

**Estado: aprovado pelo operador; nenhum benchmark executado.**

**Escopo confirmado pelo operador:** testes e gates do desenvolvimento da própria Factory, não testes executados pelos Builders nos repositórios processados.
Risco: uma bateria completa de vários minutos pode se tornar pedágio de toda iteração e reduzir a velocidade.
Distinguir feedback de desenvolvimento, validação antes de integrar e provas de aceite/release,
em vez de tratar tudo como um comando obrigatório a cada edição. Não alterar os contratos dos trabalhos operados pela fábrica.

### Cadências para desenvolver a fábrica

| Momento | Validação | O que não demonstra |
| --- | --- | --- |
| Edição/depuração | Testes focados no comportamento alterado e feedback incremental de TypeScript, podendo usar watch | Não substitui o gate local completo nem integração real. |
| Antes de integrar uma alteração | Compilação/typecheck e suíte local completa de Q11; integrações reais necessárias à mudança também devem estar satisfeitas | Sucesso local não aprova fronteiras substituídas ou provas ausentes. Não é necessário repetir a bateria em cada commit intermediário. |
| Mudança de fronteira/risco | Grupos reais pertinentes, por exemplo persistência/recovery, SDK/sessão, protocolo, sandbox/Docker/TLS | Seleção não depende só de extensão/path e não permite omitir dependentes ou mudar contratos sem nova prova. |
| Marco de aceite/release | Cobertura integral rastreável da matriz aprovada no perfil correspondente, incluindo evidência real exigida | Cobertura integral não exige repetir cada permutação com modelos nem executar tudo de modo monolítico a cada edição. |

`npm test` conserva seu significado aprovado: suíte local completa, sem serviços externos/modelos/VM/credenciais reais.
Um comando focado ou watch durante edição não deve apresentar seu subconjunto como aprovação de `npm test` ou do gate de integração.
As integrações caras continuam explicitamente separadas; prova relevante ausente/reprovada/inconclusiva bloqueia a integração/alegação dependente,
não é ignorada para cumprir um orçamento de tempo. Testes reais de uma fronteira alterada não são adiados automaticamente até a release.

Documentar grupos por responsabilidade/risco e comandos correspondentes, com seleção conservadora quando o impacto for incerto.
Não construir engine próprio de test-impact analysis, registry de combinações, daemon de testes ou orquestrador de CI.
Usar recursos normais de seleção/watch do tooling e paralelismo apenas onde não houver dependência ou disputa de recursos que invalide o teste.

### Evitar custo sem evidência adicional

- Um mesmo passo `tsc` pode verificar tipos e emitir JavaScript; o gate não precisa rodar `tsc --noEmit` e recompilar o mesmo conjunto em seguida.
  Compilar uma vez e reutilizar o artefato correspondente entre etapas evita duplicação sem trocar o tooling aprovado.
- Explorar combinações nas regras determinísticas e reservar integrações para as propriedades reais que precisam demonstrar.
  Evitar repetir inicialização/processos/esperas reais em cada caso quando isso não for a propriedade sob teste;
  manter isolamento de estado e cortes reais de recovery onde exigidos.
  Isso aplica o princípio de evidência no menor nível fiel, não substitui SQLite real por fake como prova de persistência.
- Reaproveitar resultados apenas quando houver correspondência demonstrada das entradas/contexto relevantes:
  código, dependências, configuração, ferramenta/perfil e demais insumos da prova. Cache de build não prova estado atual de serviço externo.
  Mudança de contexto/entrada relevante exige revalidação; histórico verde não prova estado externo atual.
- Registrar duração por etapa e o caminho crítico, usando os resultados normais dos testes/build, sem novo serviço de métricas.
  Diretriz aprovada: feedback focado na ordem de segundos e gate local na ordem de dezenas de segundos, não vários minutos como custo normal de toda iteração.
  São objetivos de desenho, não durações demonstradas ou SLA. Calibrar o orçamento no ambiente de referência quando houver baseline.
  Se o gate crescer, identificar o gargalo antes de acrescentar framework, paralelismo indiscriminado ou cortar cobertura.

Essa política não promete duração fixa sem medição e não reduz cobertura de aceite do MVP.
Testes executados pelos Builders, revisão dos PRs produzidos e gates dos repositórios processados não fazem parte desta discussão.
Nenhuma medição, experimento, otimização de implementação ou execução externa foi autorizada por esta discussão.

## Q13 — Matriz explícita de dependências

**Estado: aprovado pelo operador.**

O operador exige desenhar as comunicações permitidas e detectar violações no gate. Usar lista positiva de arestas:
o que não estiver permitido é proibido. As relações abaixo são diretas, não concessão transitiva ao conteúdo de outro módulo.
Distinguir dependência de contrato (inclusive `import type`) de acesso à implementação; injeção de uma interface continua uma dependência arquitetural.

### Base neutra e zonas técnicas

Explicitar `contracts/` como base neutra, sem comportamento de controle ou efeitos: identidades/referências compartilhadas,
correlações e a projeção `BuilderCredentials` que precisa ser implementada pela infraestrutura sem fazê-la importar o Controle.
Cada módulo continua dono de seus DTOs/contratos específicos. Não mover todo o modelo para `shared`, criar estado global ou outra autoridade.
O ajuste evita ciclos de tipos, por exemplo Records precisar importar WorkId do Controle enquanto Controle depende de Records.
É organização de código, não novo serviço ou módulo de negócio; o refinamento está aprovado e refletido na árvore de Q9.

`platform/github/` agrupa somente infraestrutura privada do fornecedor (emissão/transporte), compartilhável pelos dois adapters;
`platform/host/` agrupa somente o encaixe de supervisão/lançamento host aprovado. Não viram diretórios genéricos de utilitários.
Seus contratos técnicos de composição têm entrada explícita; não podem importar regras de aplicação para tomar decisões.

| Origem | Dependências internas diretas permitidas |
| --- | --- |
| `contracts` | Nenhuma; somente definições neutras compartilhadas. |
| `protocol` | `contracts`. |
| `records` | `contracts`. |
| `platform/github` | `contracts`, `records`. |
| `platform/host` | `contracts`, `records`. |
| `issue-tracker` | `contracts`, `records`, `platform/github` na implementação GitHub. |
| `code-repository` | `contracts`, `records`, `platform/github` na implementação GitHub. |
| `sandbox` | `contracts`, `protocol`, `records`, `platform/host`. |
| `workers` | `contracts`, `protocol`, `records`, `platform/host`; somente tipos da projeção de ferramentas pública de `sandbox`. |
| `control` | `contracts`; somente contratos públicos de `issue-tracker`, `code-repository`, `sandbox`, `workers`, `records`, cujas implementações são injetadas. |

Proibir ciclos entre zonas, inclusive por `import type`; isso não proíbe tipos recursivos legítimos dentro de um contrato.
Controlador não importa factories concretas dessas integrações para construí-las internamente.
`IssueTracker` e `CodeRepository` não importam um ao outro. `contracts`, protocolo, registros e infraestrutura não importam Controle/Workers.
O protocolo fornece envelope/transporte; os payloads específicos e a aplicação de regras continuam nos donos dos contratos.

### Entrypoints são exceção de composição, não acesso irrestrito

| Entrypoint | Acesso permitido e proibições |
| --- | --- |
| Controlador | Factories/contratos públicos dos módulos e entradas técnicas de composição GitHub/host, além do bootstrap/configuração próprios. Único entrypoint que compõe a autoridade durável e o emissor. |
| Worker | Workers, Protocol, Records e contratos neutros; somente tipos da projeção de ferramentas Sandbox recebida por injeção. Sem implementação de Control, SQLite operacional ou emissor GitHub. |
| Adapter por Trabalho | Sandbox, Protocol, Records e contratos neutros. Não compõe Controle ou emissor de credenciais. |
| CLI | Protocol, tipos públicos de Control e projeções públicas de validação/diagnóstico sem atuação operacional, além de bootstrap/configuração próprios. Sem abrir banco operacional, instanciar agente ou iniciar VM para inspeção. |

Leitura/validação de YAML no bootstrap não concede permissão de acesso ao SQLite ou à chave para todos os entrypoints.
Projeções públicas de diagnóstico/validação não devem exportar métodos de start/remoção sob uma interface anunciada como apenas leitura.
Entrypoint não pode atravessar arquivos privados de módulo para contornar sua interface; a composição usa factories/projeções explicitamente exportadas.

### Restrições internas adicionais

- `control/rules` não importa a implementação durável, SDK externo ou módulos de I/O/tempo real; recebe os dados/tempo necessários.
- Pi Durable/SQLite só são usados pela implementação durável privada de Control, não por CLI, workers ou registros.
- Pi coding-agent SDK só é usado na implementação de Workers; Gondolin SDK, na implementação de Sandbox.
- GitHub/auth/REST são detalhes dos adapters GitHub/infraestrutura correspondente. Isso não altera Git/gh executado pelo Builder no guest.
- Imports externos e Node built-ins não recebem autorização indiscriminada por estarem fora do grafo interno;
  o checker precisa restringir os SDKs críticos acima e I/O na zona de regras puras.

## Q14 — Enforcement arquitetural no gate

**Estado: aprovado pelo operador; nova etapa restrita à estrutura estática.**

Adicionar uma etapa local de arquitetura antes das etapas caras do gate. Ela lê fontes/configuração e não inicia runtime, banco, VM ou modelo.
Usar analisador estático de dependências existente com resolução TypeScript e configuração versionada;
não escrever parser ou engine próprio de arquitetura. A implementação deve escolher/fixar uma devdependency que satisfaça os casos de verificação abaixo,
sem alegar suporte ou duração de uma ferramenta específica não examinada.

### Verificações exigidas

1. Classificar cada fonte autoral em uma zona; arquivo novo não classificado é falha, não exceção silenciosa.
2. Rejeitar aresta não permitida pela matriz, incluindo imports somente de tipos e reexports.
3. Permitir consumo externo somente pelas entradas públicas declaradas do módulo; rejeitar deep imports de implementações privadas.
4. Resolver os aliases/caminhos pelo mesmo contexto de TypeScript, sem permitir bypass por caminho relativo ou alias equivalente.
5. Rejeitar ciclos entre zonas, dependências dos SDKs fora de seus donos e I/O/relógio real nas regras puras.
6. Exigir imports/carregamentos estaticamente identificáveis no código da aplicação; dependência calculada/opaca não vira exceção automática.
   Carregamento interno dos SDKs/dependências vendorizadas não é analisado como se fosse código autoral.

Testes internos de um módulo podem acessar sua seam interna; isso não libera deep imports entre módulos.
Atribuir os testes à mesma propriedade de módulo ou à composição de integração, sem excluir todos os testes das regras.
Fixtures intencionalmente inválidas são verificadas em escopo separado e devem produzir a violação esperada, não passar na análise normal.
Incluir casos positivos e negativos: import público permitido, deep import, inversão de dependência, ciclo de tipos, alias de bypass,
SDK fora da zona e arquivo sem classificação. Isso demonstra que o gate realmente detecta violações e não apenas termina com exit zero.

A configuração é a expressão executável do grafo aprovado; a documentação deve corresponder a ela.
Nova aresta exige revisão da decisão e da configuração/testes, não simplesmente relaxar a regra para deixar o build verde.
Usar saída normal do analisador para indicar arquivo, dependência e regra violada, sem novo serviço ou plataforma de certificação.
A duração da etapa entra no acompanhamento de Q12; ela não pode impor execução de integrações caras para verificar imports.

### Separação: análise arquitetural e testes funcionais do protocolo

O novo gate arquitetural verifica estrutura estática: dependências, entradas públicas, ciclos, deep imports e localização dos SDKs.
Não monitora chamadas ou mensagens em runtime e não acrescenta framework, interceptador ou serviço de fiscalização.

A validade de uma mensagem concreta continua sendo propriedade funcional do protocolo já aprovado:
comando administrativo vindo de conexão de worker ou resultado antigo aplicado à Execução atual são erros de origem/identidade/fase,
mesmo quando o grafo de imports está correto. Os testes locais de Q11 verificam rejeição/estado preservado,
sem exigir VM ou modelo para cada caso. O bootstrap mantém as projeções explícitas de capacidade já aprovadas.
Esses casos não constituem outro gate arquitetural ou bateria adicional; a checagem de imports tampouco os substitui.
As verificações não substituem provas reais de isolamento/cessação nem protegem contra código host comprometido.

## Limites e handoff

Q1–Q14 foram confirmadas pelo operador, incluindo a delimitação final entre estrutura estática e comportamento funcional do protocolo.
Não resta decisão de desenho identificada nesta questão. Versões/hashes finais e escolha da devdependency que cumpra os casos de Q14
pertencem à implementação/validação da release, sem parser próprio, benchmark presumido ou garantia de ferramenta não examinada.
Este desenho foi incorporado à spec completa, aprovada pelo operador na
[resolução da consolidação](issues/25-consolidate-technical-spec.md#answer); o mapa de planejamento está encerrado.
Não foram implementados código/gates, executadas provas ou criados tickets de implementação.
Nova incompatibilidade ou lacuna descoberta posteriormente exige decisão explícita, nunca preenchimento da spec por suposição.
