# Spec técnica — Software Factory MVP

**Estado: spec consolidada e aprovada pelo operador; mapa de planejamento encerrado.**

Incorpora a resolução de
[Definir a stack de implementação e a arquitetura interna da aplicação](issues/26-implementation-stack-and-application-architecture.md#answer)
e o desenho de [Interfaces públicas e composição — Software Factory MVP](module-public-interfaces.md).
A composição completa foi aprovada explicitamente pelo operador; registro em
[Consolidar a spec técnica implementável do MVP](issues/25-consolidate-technical-spec.md#answer).
Nenhuma prova de funcionamento foi executada; aprovação documental não equivale ao aceite do MVP.

Asset de [Consolidar a spec técnica implementável do MVP](issues/25-consolidate-technical-spec.md).
Composição documental do [PRD — Software Factory MVP](prd.md)
e das decisões aprovadas em [Especificar tecnicamente o MVP da Software Factory](map.md), disponíveis na base documental `238526c7`.
A [Matriz de aceite e sequência de validação incremental](acceptance-and-incremental-plan.md) é o plano aprovado de provas futuras.

**Navegação**

- [Autoridade, destino e limites](#1-autoridade-destino-e-limites)
- [Arquitetura e responsabilidades](#2-arquitetura-e-responsabilidades)
  - [Stack e organização interna](#22-stack-e-organização-interna)
  - [Interfaces públicas dos módulos](#23-interfaces-públicas-dos-módulos)
  - [Composição e direção de dependências](#24-composição-e-direção-de-dependências)
- [Persistência, registros e invariantes](#3-persistência-registros-e-invariantes)
- [Admissão, filas, dependências e limites](#4-admissão-filas-dependências-e-limites)
- [Protocolo, exclusividade e recuperação](#5-protocolo-exclusividade-e-recuperação)
- [Runtime, pedido preservado e skills](#6-runtime-pedido-preservado-e-skills)
- [Interface de sandbox e perfil Gondolin](#7-interface-de-sandbox-e-perfil-gondolin)
- [GitHub App, permissões e segredos](#8-github-app-permissões-e-segredos)
- [Publicação, checks e prontidão](#9-publicação-checks-e-prontidão)
- [Manutenção e concorrência humana](#10-manutenção-e-concorrência-humana)
- [Instalação, configuração e CLI](#11-instalação-configuração-e-cli)
- [Observabilidade, retenção e encerramentos](#12-observabilidade-retenção-e-encerramentos)
- [Validação e rastreabilidade](#13-validação-e-rastreabilidade)
  - [Gates do desenvolvimento da própria Factory](#134-gates-do-desenvolvimento-da-própria-factory)
- [Obrigações de release e riscos remanescentes](#14-obrigações-de-release-e-riscos-remanescentes)
- [Condição de fechamento e handoff](#15-condição-de-fechamento-e-handoff)

## 1. Autoridade, destino e limites

Esta spec organiza componentes, contratos, estados, operação e validação para posterior decomposição da construção.
Não implementa a fábrica, não executa provas, não aprova uma release e não cria tickets de implementação.
O PRD é a autoridade de produto; os Answers dos tickets vinculados são os registros canônicos das decisões e justificativas.
Este documento os compõe, não cria uma autoridade que os altere. Contradição ou lacuna de desenho exige decisão no mapa e retorno ao operador.

### 1.1 Escopo suportado pelo desenho

- Instalação local single-tenant, uma máquina, vários repositórios GitHub explicitamente autorizados e confiáveis.
- Um Ticket pertence a um repositório. Vários Trabalhos podem executar no mesmo repositório com recursos independentes.
- GitHub Issues, relações nativas de dependência, PRs, polling e CLI local; implementação/revisões por agentes e merge humano.
- Perfil inicial: Arch Linux x86_64 de referência, Node, Gondolin QEMU/KVM, guest Alpine e Docker `vfs` por Trabalho.
  O suporte efetivo será à combinação fixada e validada de cada release, não a qualquer versão rolling desses componentes.
- Plataforma não adversarial: isolamento mínimo, poderes limitados e riscos residuais explícitos, sem promessa de conter código hostil.

Ficam fora: SaaS/HA/distribuição, outros trackers, Projects/regras booleanas de entrada, webhooks/UI web,
trabalho coordenado multirrepositório por Builder, adoção de PR desconhecido, merge automático, deploy/acesso direto a produção,
administração de repositórios, escrita na base, roteamento/fallback silencioso de modelos e backup/restauração integrado.
Outras sandboxes, inclusive Docker para hosts sem nested KVM, e macOS são esforços posteriores, não fallbacks do MVP.
A fábrica não certifica/monitora as barreiras GitHub de base/merge nem audita exaustivamente CI; o time operador responde por elas.

### 1.2 Vocabulário

Usar os conceitos da seção 3 do PRD, sem criar glossário global para este projeto dentro do PKM:

| Conceito | Significado operacional |
| --- | --- |
| Ticket | Pedido e referência de especificação em exatamente um repositório. |
| Trabalho | Unidade lógica persistente vinculada ao Ticket e ao ciclo de entrega. |
| Execução | Uma ativação de Builder para implementar, continuar, reparar ou recuperar um Trabalho. |
| Builder | Agente que implementa, valida, publica e trata os achados. |
| Revisores | Workers Standards e Spec, paralelos, sem escrita na worktree revisada. |
| Slot | Capacidade ocupada pela Execução, inclusive comandos/revisões internas, não por esperas externas. |
| Reparo | Execução motivada por gatilho autorizado de manutenção. |
| Bloqueio | Condição explícita que impede avanço, com motivo e ação necessária. |
| Pronto para revisão humana | Preparação verificada pelo controlador; não aprovação humana nem entrega. |
| Entregue | Merge do PR próprio confirmado no GitHub, mesmo que cleanup ainda falhe. |

Uma **correção** é a identidade técnica persistente que agrupa motivos, ativações, FIFO e cobrança de manutenção.
Não é sinônimo de Execução nem novo conceito de produto. Reserva, início, pedido de interrupção e cessação são fatos distintos.

## 2. Arquitetura e responsabilidades

Fontes: [Definir a fronteira mínima entre controlador e builder](issues/01-control-authority.md#answer),
[Escolher a estratégia mínima de durabilidade e recuperação](issues/02-durability-strategy.md#answer),
[Escolher o runtime de agentes e seus pontos de integração](issues/06-agent-runtime-choice.md#answer),
[Revisar a composição da arquitetura e suas fronteiras](issues/23-architecture-cross-review.md#answer) e
[Definir a stack de implementação e a arquitetura interna da aplicação](issues/26-implementation-stack-and-application-architecture.md#answer).

```text
CLI local / polling GitHub / comentários autorizados
                         |
             Controlador proprietário
              Pi Durable + SQLite
             /          |          \
     GitHub App    workers Pi     interface sandbox
    consultas,      via SDK       adapter Gondolin
 perguntas, ready,     |          / systemd / QEMU
 cleanup próprio       +----------+
                                   |
                        VM e disco por Trabalho
                     workspace host via RealFSProvider
                     Git / ferramentas / Docker guest
                                   |
                       Builder publica direto no GitHub
                              humano faz merge
```

| Componente | Responsabilidade e fronteira |
| --- | --- |
| Controlador | Única autoridade de autorização, domínio persistido, filas, Slots, limites, disparos, perguntas, prontidão, reconciliação e cleanup. |
| Pi Durable/SQLite | Documentos Session/tarefas e commits de controle; não executa o ciclo inteiro do Builder como operação cegamente repetível. |
| Worker Builder | Processo Node host confiável com Pi SDK; ferramentas do repositório executam no guest. Interpreta pedido, implementa, valida e publica diretamente. |
| Workers Standards/Spec | Sessões/modelos independentes, somente `read` confinado no perfil inicial; devolvem pareceres reais e correlacionados. |
| Adapter Gondolin | Configuração e ciclo de sandbox, ferramentas confinadas, disco/workspace, rede, supervisão e evidência de cessação. Não decide fila/orçamento. |
| GitHub App/cliente | Identidade técnica e operações autorizadas; `gh api` é cliente, não motor de workflow. Chave emissora só no controlador. |
| CLI | Comandos ao proprietário via socket privado; não abre banco operacional nem reconstrói autoridade de logs. |
| Registros/sessões | Contexto e evidência referenciados pela autoridade; não segundo banco de controle. |
| Humano/time operador | Autorizações concretas, resolução de bloqueios, barreiras GitHub e CI, avaliação e merge. |

Não acrescentar motor externo, broker, segundo banco de controle, event sourcing, publicador/gateway de push,
coletor documental, serviço de credenciais/logs/billing, supervisor próprio ou plataforma genérica de subagentes.
A preferência por simplicidade compara código próprio, dependências, instalação, operação e recuperação; menos serviços não prova menor custo.

### 2.1 Fronteira de autoridade externa

Builder implementa, testa, commita, prepara rebase e faz push/cria ou atualiza o próprio PR draft via Git/API.
`/pr` redige a descrição, não publica por si só. Controlador verifica identidade/artefatos/evidências e converte prontidão,
publica perguntas/marcos e confirma merge/cleanup. Nenhum agente realiza merge ou aprovação humana em nome do operador.
O fluxo padrão não altera labels, assignees, Projects ou status personalizados do Ticket.

O token pode permitir operações além da divisão acima, inclusive ready e mutações em outras branches/PRs desprotegidas do mesmo repo.
A flag GitHub não substitui a prontidão interna. `Contents: write` não separa push de merge;
o time deve manter regras sem bypass para a App, sem exigir certificação ou monitoramento dessas barreiras pela fábrica.
Push pode acionar CI/deploy já configurado no repositório: isso não concede ao agente comando de deploy nem acesso direto a produção.

### 2.2 Stack e organização interna

Um pacote de aplicação em **TypeScript estrito/ESM sobre Node**, com npm, lockfile e `npm ci` para desenvolvimento/construção.
`tsc` verifica tipos e emite JavaScript ESM compatível com o Node fixado; testes usam `node:test`/`node:assert` sobre o código compilado.
Sem bundler, transpiler de execução, framework web/DI ou service locator por padrão. Usar bibliotecas necessárias, inclusive para YAML,
sem reimplementar dependências para reduzir sua contagem. Versões/integridades finais pertencem à release.

Distribuir JavaScript, dependências runtime do lockfile, Node privado, skills e assets na release autocontida da seção 11.
Operador não compila TypeScript nem executa `npm install` por instalação/Trabalho.
Módulos internos não são packages publicáveis, serviços ou processos adicionais:

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

São sete módulos de aplicação: Controle, IssueTracker, CodeRepository, Sandbox, Workers/agentes, Protocolo e Registros/evidências.
`contracts` é base neutra mínima; `platform/github` e `platform/host` são zonas técnicas privadas, não módulos de negócio extras.
Tipos específicos pertencem ao seu módulo; identidades/correlações compartilhadas e a projeção `BuilderCredentials` ficam em `contracts`.
Não criar modelo persistido paralelo, estado global em `shared`, repositório CRUD genérico ou segundo scheduler/motor.

### 2.3 Interfaces públicas dos módulos

“Pública” significa utilizável por outro módulo, não API de internet ou SDK independente.
Os [contratos detalhados aprovados](module-public-interfaces.md) especificam entradas/resultados, ordenação, falhas e projeções por papel;
as operações abaixo são contratos da Factory, não nomes de APIs alegadas dos SDKs.
Factories recebem dependências/configuração explícitas. Importar um módulo não abre banco/socket, inicia VM/worker/scheduler ou descobre perfil pessoal.

Convenções comuns:

- IDs e referências preservam os sentidos da seção 3; identidade/papel autoafirmados pelo modelo não concedem poderes.
- Observações incluem origem, identidade, instante e completude/limitações. Erro, ausência comprovada, parcial e antigo são distintos.
  Leituras remotas não formam snapshot atômico.
- Efeitos distinguem sucesso conhecido, falha conhecida e indeterminado. Chamada externa bem-sucedida não confirma commit posterior;
  transporte perdido não prova ausência do efeito. Falhas esperadas têm código/alcance/próximo passo sem segredos; não viram vazio ou verde.
- Mutações de tracker/code repository feitas pelo Controle recebem `effect` com identidade já persistida e correlações/precondições pertinentes.
  Isso não é autorização por posse, idempotência externa ou permissão de repetir ambiguidade; não se aplica à publicação direta pelo Builder.
- Projeções limitam capacidades entregues a cada processo, sem prometer contenção de código host comprometido.

#### Controle

Inclui regras, orquestração e persistência Pi Durable/SQLite privadas; não exporta Session, SQL, setters de estado ou atalhos de despacho/prontidão.

| Operação | Entrada → resultado e limite |
| --- | --- |
| `accept(input)` | Comando/observação de origem verificada e correlações → aceitação, recusa ou indeterminação; valida fase/autorização/deduplicação. Ingresso crítico só recebe confirmação durável após o commit. |
| `inspect(query)` | Consulta suportada → visão correlacionada de status, filas, Trabalho, pedido, histórico e evidência, com paginação/filtros; sem banco paralelo ou autorização implícita. |
| `run(signal)` | Ciclo de vida do proprietário exclusivo → parada limpa, falha ou parada incerta; polling/reconciliação/despacho/retenção com barreira inicialmente fechada. Parar não cancela Trabalhos. |

Aceitar comando não comprova início/efeito. Recibo e transição ficam no mesmo commit, sem barramento/fila persistente de ingressos.
`inspect(request_id)` consulta resultado ambíguo, sem reaplicar com ID novo. Lock antecede abertura durável; barreira protege atuação até fora do loop `run`.

#### IssueTracker e CodeRepository

`TicketRef` e `RepositoryRef` são identidades distintas, mesmo no mesmo repositório GitHub.
IssueTracker trata pedido/dependências/comentários da issue; CodeRepository trata hospedagem remota/PR/checks/feedback do PR.
Git local/checkout/workspace permanecem no fluxo Builder/sandbox. Somente GitHub é implementado no MVP, sem registry/framework de fornecedores.

| Interface/operação | Entrada → resultado e limite |
| --- | --- |
| `IssueTracker.checkAccess(scope)` | Origem configurada → diagnóstico de identidade/leitura/escrita autorizada de perguntas/marcos; sem certificar capacidades invisíveis. |
| `IssueTracker.listCandidates(scope)` | Origem/seletor → referências observadas com completude; listagem não admite Trabalho e parcial não prova ausência. |
| `IssueTracker.readTicket(ticket)` | Ticket qualificado → estado/label/motivo/identidade de entrada; sem ingestão documental ou autorização persistente. |
| `IssueTracker.readDependencyGraph(ticket)` | Raiz → grafo nativo alcançável/completude via `gh api` + REST; não decide satisfação por ciclo/merge. |
| `IssueTracker.readInputs(ticket, cursor)` | Ticket/posição → comentários com autoria/continuação; não interpreta prosa como autorização nem consulta PR. |
| `IssueTracker.findQuestion(ticket, questionId)` | Destino/marcador → candidatos/evidências; parcial não prova ausência e múltiplos não autorizam escolha arbitrária. |
| `IssueTracker.postComment(ticket, comment, effect)` | Pergunta/marco autorizado e efeito → resultado externo correlacionado; sem alterar triagem/estado do Ticket ou endpoint arbitrário. |
| `CodeRepository.checkAccess(repo, base)` | Repo/base → diagnóstico operacional, sem certificação/monitoramento de barreiras de merge ou CI. |
| `CodeRepository.readPullRequest(pr)` | PR próprio conhecido → head/base/estado/merge/conflito e fatos de checks; não decide prontidão. |
| `CodeRepository.readInputs(pr, cursor)` | PR/posição → comentários gerais/de revisão e feedback com autoria/continuação; parsing/autorização ficam no Controle. |
| `CodeRepository.findPublication(correlation)` | Repo/branch/identidades → refs/candidatos próprios; descobre publicação incerta, sem adotar PR desconhecido ou recriar antecipadamente. |
| `CodeRepository.findQuestion(pr, questionId)` | PR/marcador → candidatos/evidências, sem delegar comentários do PR ao tracker. |
| `CodeRepository.postComment(pr, comment, effect)` | Pergunta/marco autorizado e efeito → resultado externo com o mesmo contrato de correlação/ambiguidade. |
| `CodeRepository.setDraft(pr, draft, effect)` | PR próprio/estado autorizado/efeito → resultado externo; ready depende de evidências verificadas pelo Controle. |
| `CodeRepository.reopenPullRequest(pr, effect)` | PR próprio fechado sem merge/efeito → resultado externo; não renova autorização/escopo/orçamento nem inicia Builder. |
| `CodeRepository.cleanupBranch(selection, effect)` | Branch própria selecionada/autorizada/efeito → resultado externo, com proteção de base/recursos desconhecidos/concorrência; sem merge, aprovação ou push mediado. |

Adapters `GitHubIssues`/`GitHubCodeRepository` podem compartilhar transporte/autenticação/paginação privados em `platform/github`,
sem importar a implementação um do outro. Pergunta pertence à superfície que a hospeda; parsing e autorização são únicos no Controle.
Controle combina dependência do tracker, ciclo local e merge de CodeRepository; nenhum adapter decide isso consultando o outro.
Não presumir transação entre as duas interfaces e SQLite, mesmo com um fornecedor. Cada Ticket continua vinculado a exatamente um repo.

#### Sandbox e Workers/agentes

Sandbox preserva a [interface encapsulada da seção 7](#71-interface-encapsulada):
`validate(configuration)`, `prepare(work, configurationRef)`, `start(environment, configurationRef)`, `executeTool(context, call)`,
`observe(environment, boot?)`, `stop(environment, boot, reason)` e `remove(environment, cleanup)`.
Controle recebe ciclo de vida; worker recebe só ferramentas de seu papel/boot/invocação. Referências são opacas, não flags/units/PIDs para o Controle.
Ferramentas passam pelo adapter dono da única instância Gondolin daquele ambiente; workers não criam outra nem recebem SDK irrestrito.

Workers/agentes encapsula SDK, loader, sessões e integração host/entrypoints; não é um motor ou serviço adicional.

| Operação | Entrada → resultado e limite |
| --- | --- |
| `activate(invocation)` | Execução/invocação/papel/perfil/boot/contexto → solicitação identificada, após reserva/autorização; spawn não prova início. Recibo durável precede modelo/ferramenta. |
| `deliver(worker, directive)` | Destinatário vigente/diretiva → entrega de resultados reais de revisão ou credencial transitória; não prova consumo/checkpoint, não reabre Execução nem altera escopo. |
| `observe(worker)` | Invocação → recibos/resultados/contexto e limitações; recupera resultado preservado sem rerodar, mas não prova cessação ou adota sobrevivente. |
| `interrupt(worker, reason)` | Worker vigente/motivo → pedido/observações; fecha novas chamadas e solicita abort, sem confundir retorno SDK com cessação ou cancelamento decidido. |

Invocação distingue início, continuação compatível e recuperação substituta, com referências de sessão/perfil/pedido/rodada, nunca segredo durável.
Resposta após espera exige nova admissão/ativação, não `deliver` para ressuscitar Execução encerrada.
No handoff, Builder permanece sem turnos/ferramentas até cessar atividade dos revisores; só então recebe resultados/falhas efetivos.
Progresso/pergunta/handoff/parecer/fim/uso seguem a seção 5; conteúdo completo protegido precede notificação crítica, streaming não é resultado.
Não exportar operação que sintetize parecer, faça todos os reviews/aprove ou deduza prontidão de texto/exit code.

#### Protocolo local e Registros/evidências

| Interface/operação | Entrada → resultado e limite |
| --- | --- |
| `Protocol.listen(endpoint, handler, expectedPeers)` | Endpoint/vínculos privados → servidor/conexões que entregam frames completos e fechamento/erro; handshake autoafirmado não concede papel. |
| `Protocol.connect(endpoint, invocation)` | Destino/identidade prevista → canal do formato único da release; incompatível falha sem atuar. Canal oferece `send(envelope)`/`close()`, não ACK durável/replay automático. |
| `Records.registerSecret(value)` | Segredo conhecido → registro só em memória neste processo, antes do uso; não recupera valor perdido nem envia ao modelo. |
| `Records.record(context, event)` | Evento correlacionado → referência/resultado filtrados, distinguindo evidência crítica e amostra auxiliar; não confirma transição de domínio. |
| `Records.openOutput(context)` | Chamada/ferramenta → canal de chunks/finalização com saída filtrada/resumo/referência, antes de SDK/exibição/arquivo, sem acumular íntegra em memória. |
| `Records.preserve(evidence)` | Evidência própria necessária após cleanup → referência protegida; sem coletor documental, conteúdo inventado ou saneamento universal. |
| `Records.read(selection)` | Referências/filtros autorizados → página/trecho/estado da captura, distinguindo íntegro/truncado/parcial/ausente/removido/expirado/desconhecido. |
| `Records.remove(plan)` | Plano autorizado/revalidado → resultados individuais de recursos próprios não em uso; sem decidir retenção, apagar domínio ou fazer cleanup de VM/GitHub. |

Protocolo encapsula framing/serialização/validação estrutural/limites, não autorização/fase/deduplicação durável ou fila de negócio.
EOF é comunicado à supervisão; silêncio/timeout não são EOF. Sem heartbeat/broker/HTTP público/PKI/fila offline/framework RPC.
Registros não são banco de controle, cofre ou autoridade de resultado. Filtragem antecede persistência nativa Pi SDK, inclusive chunks partidos;
falha não libera bruto. Sessões mantêm formato nativo protegido, sem substituto ou duplicação integral por padrão.
Saída acessível ao agente é cópia seletiva filtrada pela sandbox, nunca montagem de `data/records` ou nova ferramenta de logs.

### 2.4 Composição e direção de dependências

Bootstrap lê/valida configuração e injeta somente a projeção necessária a cada processo; sandbox interpreta sua configuração específica.
Sem ConfigService persistente, hot reload, descoberta de perfil pessoal ou configuração paralela por módulo.

| Entrypoint interno | Composição e limite |
| --- | --- |
| CLI | Argumentos → ingresso identificado pelo protocolo; usa tipos públicos de Control e projeções de validação/diagnóstico sem atuação. Não abre banco operacional, instancia agente ou inicia VM para inspeção. |
| Controlador | Launcher de primeiro plano/serviço adquire `flock` antes do storage. Factories públicas conectam módulos, configuração, durabilidade privada e emissor GitHub; barreira já fechada ao abrir Pi Durable, depois `run`. |
| Worker | Compõe Workers, Protocol, Records e contratos neutros; perfil/sessões próprios e projeção de ferramentas recebida. Sem Controle/SQLite operacional/chave emissora ou implementação Sandbox. |
| Adapter por Trabalho | Compõe Sandbox, Protocol, Records e contratos neutros; dono Gondolin/VM. Observação/parada host continuam disponíveis sem o proprietário antigo. Não compõe Controle/emissor. |

Composição usa exports públicos, nunca arquivos privados para contornar interfaces. Controlador é o único entrypoint que compõe autoridade durável/emissor.
A parte host de Workers/Sandbox pode compartilhar encaixe systemd privado em `platform/host`, com identidade/grupos preparados pelo adapter.
`Workers.activate` usa esse contexto correlacionado; não cria outro agrupamento/supervisor, interpreta Gondolin ou lança fora dele.
Cessação continua descoberta por Sandbox. Nenhum novo processo/serviço global resulta da organização interna.

Matriz positiva de dependências internas **diretas**, inclusive `import type` e interfaces injetadas; o que não está permitido é proibido:

| Origem | Destinos permitidos |
| --- | --- |
| `contracts` | Nenhum; definições neutras, sem controle/efeitos. |
| `protocol` | `contracts`. |
| `records` | `contracts`. |
| `platform/github` | `contracts`, `records`. |
| `platform/host` | `contracts`, `records`. |
| `issue-tracker` | `contracts`, `records`, `platform/github` na implementação GitHub. |
| `code-repository` | `contracts`, `records`, `platform/github` na implementação GitHub. |
| `sandbox` | `contracts`, `protocol`, `records`, `platform/host`. |
| `workers` | `contracts`, `protocol`, `records`, `platform/host`; somente tipos da projeção pública de ferramentas `sandbox`. |
| `control` | `contracts`; somente contratos públicos de `issue-tracker`, `code-repository`, `sandbox`, `workers`, `records`, com implementações injetadas. |

Entrypoints têm as exceções de composição da tabela anterior, não acesso transitivo irrestrito.
Proibir ciclos entre zonas, inclusive de tipos, deep imports e aliases que contornem a interface.
`control/rules` recebe dados/tempo e não importa persistência, SDK ou I/O/relógio real.
Pi Durable/SQLite só ficam na implementação durável privada de Control; Pi coding-agent só em Workers; Gondolin só em Sandbox.
GitHub/auth/REST ficam nos adapters/infraestrutura correspondentes, sem mudar Git/gh do Builder no guest.
Protocol, Records, contracts e infraestrutura não importam Controle/Workers para tomar decisões.
Regras arquiteturais executáveis e testes funcionais do protocolo são distintos, conforme [seção 13.4](#134-gates-do-desenvolvimento-da-própria-factory).

## 3. Persistência, registros e invariantes

Fontes: [Escolher a estratégia mínima de durabilidade e recuperação](issues/02-durability-strategy.md#answer) e
[Definir estados, filas, persistência e reconciliação dos efeitos](issues/08-state-and-effects-contract.md#answer).

### 3.1 Autoridade transacional

Pi Durable guarda o domínio em documentos Session/tarefas sob um único proprietário de escrita.
SQLite local usa **WAL e `synchronous=FULL` nos commits de controle**, em filesystem adequado.
Verificar SQLite efetivamente embarcado corrigido para WAL-reset: 3.51.3+ ou backport indicado pelas fontes oficiais do contrato.
Nome/versão de binding não prova isso. O helper Node examinado usa NORMAL; usar a fronteira pública de adapter/SqliteStorage e verificar FULL,
sem inventar flag ou aceitar NORMAL silenciosamente.

Leituras precedem escritas; quando usar `submit(tx, draft)`, fazer uma admissão por commit e tratar seu resultado como provisório até armazenamento.
Usar commits normais de Session/Conversation e tarefas próprias via `tx.createTask` para unir reserva/intenção de despacho.
Controle crítico não é progresso deferred. Várias concessões podem exigir commits sucessivos.

GitHub, spawn, filesystem do workspace/disco e memória do modelo ficam fora do commit.
FULL depende de OS/FS/hardware; não garante storage defeituoso, HA, RPO ou backup.
Falha de persistência nunca é anunciada como confirmação durável.

### 3.2 Esquema lógico

IDs internos são opacos e estáveis. Guardar identidades GitHub de repo/issue/PR/autores além de nomes, números e URLs de apresentação.
Título, URL ou número isolado não bastam como identidade. Este é esquema lógico do domínio, não tabelas paralelas de outra autoridade.

| Registro | Conteúdo mínimo |
| --- | --- |
| Instalação | Versão/identidade do estado, pausa, sequências FIFO, índice Ticket → ciclo vigente/anteriores e referências de configuração. |
| Trabalho | `work_id`, Ticket/repo/base/predecessor, resultado, autorização/impedimentos, admissão/categoria/posição, correção pendente, Execução vigente, branch/workspace/ambiente/PR, refs conhecidas, orçamento/consumos/reservas, spec/perfil/contexto, prontidão/cleanup. |
| Execução | `execution_id`, Trabalho/motivo/correção, fase, reserva de Slot/orçamento, início, duração/atividade, cessação/resultado, sessões/revisores/gates. |
| Pergunta | `question_id`, origem Trabalho/Execução, conteúdo/contexto/destino, publicação/comentário observado, situação e única resposta aceita com autoria/origem. |
| Efeito | `effect_id`, operação/alvo/correlações, intenção e refs esperadas quando aplicáveis, fase, observações/recibos, confirmação ou ambiguidade. |
| Histórico/resumo | Transição/comando, origem/autor/identidade do ingresso, antes/depois e motivo, referências de evidência e informação suficiente para explicar o Trabalho. |

Spec, sessões, logs, pareceres e arquivos de resultado são referências/evidências, não autoridade de autorização, fila, Slot ou limites.
A correção preserva sua identidade, motivos/contexto, posição de reparo e cobrança entre ativações.

### 3.3 Dimensões ortogonais

- **Resultado:** em aberto, cancelado, PR fechado sem merge ou entregue.
- **Autorização e impedimentos:** retirada de autorização, dependência, pergunta, configuração, limite, concorrência e ambiguidade podem coexistir.
- **Fila:** categoria normal/reparo, posição persistente e trabalho pendente; ordenado não significa executável agora.
- **Execução:** reserva, início/fase/atividade, interrupção e cessação separados.
- **Prontidão:** evidências atuais de conteúdo/spec/reviews/gates/checks/conflito, independente de PR existir/estar ready.
- **Cleanup:** recursos pendentes/removidos/falhos, independente de entrega.

A CLI apresenta essas dimensões sem esconder espera ou bloqueio em um único status: dependência, enfileirado, executando,
resposta, CI, revisão/merge humano, reparo pendente, bloqueado/suspenso, cancelado/fechado sem merge e entregue.

Invariantes:

1. No máximo um ciclo vigente por Ticket, inclusive bloqueado ou PR fechado sem merge; label persistente não inicia outro após entrega/cancelamento.
2. No máximo uma Execução escritora por Trabalho/workspace/branch, inclusive após crash; mensagens antigas não alteram reserva vigente.
3. Autorização de despacho, Slot e orçamento são confirmados antes do efeito de iniciar.
4. Reserva não prova spawn; pedido de parada não prova cessação; não liberar Slot/capacidade incertos.
5. Revisores compartilham Slot e relógio da Execução, com Builder inativo; esperas externas confirmadas não ocupam Slot.
6. Entrega exige merge confirmado; prontidão exige avaliação do controlador, não texto do modelo/flag isolada.
7. Cancelamento barra novas ações/publicações/renovações, sem negar efeitos já enviados.
8. Respostas, pushes, replay, polling, restart e configuração não zeram histórico/limites nem concedem poderes.
9. Resolver um impedimento não remove os demais; Trabalho temporariamente impedido não bloqueia a seleção dos independentes.

### 3.4 Fronteiras atômicas

| Transação | Confirmar conjuntamente |
| --- | --- |
| Admitir Trabalho | Ausência de ciclo vigente, observações/autorização válidas, Trabalho, índice e sequência de admissão. |
| Admitir Execução | Elegibilidade/dependências/impedimentos atuais, FIFO, capacidade, identidade/referência vigente, Slot/orçamento e tarefa/intenção de despacho. |
| Confirmar início | Evidência correspondente à Execução vigente, consumo único da reserva aplicável e fase. |
| Registrar pergunta | Pergunta, impedimento e intenção de publicar; cessação/liberação são posteriores. |
| Aceitar resposta/comando | Autenticação/correlação/deduplicação, resposta/transição, histórico e pendência de fila, sem spawn direto. |
| Interromper/cancelar | Pedido, proibições e intenção de interromper; confirmação física posterior. |
| Confirmar efeito/cessação | Observação correlacionada, resultado/fase, reservas liberáveis e histórico. |

Efeitos do controlador seguem intenção confirmada → chamada fora do commit → observação → confirmação durável.
Exceção aprovada: push/criação de PR diretos pelo Builder não exigem intenção específica, ACK ou ferramenta adicional antes da publicação;
a reconciliação continua obrigatória. Nenhum desses caminhos promete execução genericamente exatamente uma vez.

## 4. Admissão, filas, dependências e limites

Fontes: [Definir estados, filas, persistência e reconciliação dos efeitos](issues/08-state-and-effects-contract.md#answer) e
[Definir o escopo suportado e a validação das dependências nativas](issues/09-dependency-compatibility.md#answer).

### 4.1 Entrada e ciclos

Repo autorizado + issue aberta + label efetiva autorizam entrada sem segunda aprovação, respeitadas pausa e dependências.
Usar índice persistente antes de criar Trabalho. PR associado mas não reconhecido como próprio impede adoção/admissão automática e é reportado.
Retomadas/reparos preservam o Trabalho. Retirada observada da label ou fechamento da issue suspende novos disparos,
mas a Execução ativa pode concluir/publicar. Repor label/reabrir issue não remove a suspensão: retomada explícita e requisitos atuais são necessários.

Após entrega/cancelamento, `new` cria outro Trabalho com predecessor e recursos próprios.
Cancelamento anterior exige cessação/reconciliação, não cleanup prévio obrigatório.
PR ainda aberto do ciclo cancelado exige decisão do operador, sem adoção/fechamento/substituição silenciosos.
PR fechado sem merge mantém o ciclo vigente e contadores, sem retomada automática; continuar exige reabrir o mesmo PR e retomar explicitamente.
Abandonar esse ciclo exige cancelar e solicitar outro.

### 4.2 Dependências nativas

O adapter do controlador usa **`gh api` + REST** para dependências, sem fallback GraphQL/HTTP/outra identidade.
Executável com argumentos estruturados, sem shell/pipeline; host, GET e versão REST explícitos, saída JSON completa e status/headers relevantes.
A referência documental REST é `2026-03-10`; fixar/testar a versão suportada. `gh` tem configuração própria, token via ambiente e nenhum login pessoal,
alias, debug secreto ou cache temporal usado como aprovação atual. Exit code zero não basta sem validar payload/identidades/completude.
`--paginate`/`--slurp` não tornam saída parcial em sucesso se página posterior falhar.

Consultar exclusivamente `blocked_by` nativo e percorrer o grafo alcançável, inclusive bloqueadores encerrados.
`blocking` é inversa, não substituto; não interpretar prosa, `Depends on`, label ou duplicata como relação alternativa.
Visitar nós por identidade qualificada, uma vez por avaliação, distinguindo compartilhamento de nó e ciclo no caminho.
Completar páginas e leitura dos destinos; relação inválida, ciclo, inacessibilidade transitiva ou travessia incompleta impedem liberação.
Limites de API adiam a conclusão; contagens iguais não certificam ausência de arestas invisíveis nem snapshot remoto.

| Tipo de bloqueador | Satisfação |
| --- | --- |
| Ticket com registro próprio | Trabalho vigente ou, se ausente, último ciclo; exige merge confirmado do PR desse ciclo. |
| Próprio aberto/cancelado/PR fechado sem merge | Não satisfeito, mesmo com issue `closed + completed`. |
| Novo ciclo próprio após entrega anterior | Entrega anterior não satisfaz o ciclo novo. |
| Ticket sem Trabalho registrado | Externo: somente `state=closed` e `state_reason=completed`. |
| Externo aberto/reaberto, `not_planned`, `duplicate`, motivo ausente/desconhecido | Não comprova conclusão; não seguir duplicata para substituir o bloqueador. |

A memória mínima preservada após exclusão mantém classificação/resultado/merge de ciclos próprios; ausência de histórico completo não os torna externos.
Registrar origem, principal/escopo sem token, identidades, instante, completude e conclusão/motivos da avaliação.
Reavaliar antes da admissão elegível e de cada início/retomada/reparo, nunca usar consulta antiga para autorizar novo despacho.
Novo bloqueador/leitura inconclusiva durante atividade impede próxima ativação e retira prontidão, sem cancelar implicitamente a atual.

Repos executáveis e repos acessíveis só para dependências são distintos. Suporte local/cross-repo/cross-owner/visibilidade depende do GitHub e do acesso real;
não presumir suporte por owner nem certificar manualmente todos os pares. Combinar testes dos cenários declarados, pré-voo automático de acesso
sem criar issues/arestas em cada repo e leitura real em operação. Omissão silenciosa não detectável exige retorno ao operador, não aprovação do cenário.
Erro transitório/rate limit repete acompanhamento com espera; autorização/configuração/incompatibilidade exigem correção/revalidação.
Delimitar o escopo afetado: desconhecimento não autoriza declarar tickets dependentes seguros.

### 4.3 Seleção FIFO e capacidade

Fila normal conserva admissão original, inclusive após pergunta. Nova correção recebe sequência de reparo;
eventos consolidados/continuações preservam essa posição; uma correção posterior ao encerramento da anterior recebe nova sequência.
Reparos antes de normais, FIFO em cada categoria, sem preempção, mutex global por repo ou política extra de justiça.
Ignorar temporariamente impedidos sem perder ordem. Reservas incertas continuam ocupando capacidade até reconciliação.
Pausa global impede novos disparos, não acompanhamento/respostas/ativos; despausar não remove impedimentos individuais.
Revisores não consomem Slots extras; processos/chamadas de modelo podem exceder a concorrência de Builders.

### 4.4 Orçamentos e tempo

- Padrão por Trabalho: **três correções automáticas e três retomadas operacionais recuperáveis**, separados e configuráveis.
- Reservar atomicamente na admissão; consumir uma vez com início confirmado. Não início comprovado libera sem consumo; início incerto mantém reserva.
- Cobrar a correção, não cada edição/teste/push/evento. Pergunta e continuação preservam cobrança; recovery pode consumir retomada operacional.
- Recuperação transitória de modelo/transporte/worker passa por cessação/reconciliação e fila; esperas persistidas padrão **5/15/45 segundos**.
  Espera maior indicada pelo serviço prevalece. Eventos repetidos não antecipam espera nem renovam orçamento.
- Falha de autorização/configuração, timeout, propriedade incerta e esgotamento bloqueiam com ação necessária, sem repetição automática.
- Polling, consulta de reconciliação e publicação de pergunta recuperáveis não lançam Builder nem consomem retomada operacional.
  Não repetir POST ambíguo sob o nome de retry.
- Concessão adicional é explícita/auditável, não reinício do histórico nem consequência automática de mudar YAML.
- Parada administrativa durável **com cessação confirmada** permite continuação em nova Execução/fila sem cobrar recovery só pela parada.
  Preservar correção, posição, orçamento e impedimentos. Intenção administrativa não torna crash/parada incerta em parada limpa.

Timeout é opcional por repo e mede **cada Execução**, inclusive comandos/revisões, não soma acumulada de Trabalho/correção.
Sem configuração não há teto de 60 minutos ou outro corte implícito. Espera externa encerra atividade/relógio e a próxima Execução tem novo relógio,
sem contornar timeout já atingido ou zerar contadores. Duração e última atividade são visíveis e cancelamento continua disponível.
As regras de evidência temporal e cessação estão na seção seguinte.

## 5. Protocolo, exclusividade e recuperação

Fonte: [Definir o protocolo de execução e retomada entre controlador e worker](issues/15-controller-worker-protocol.md#answer).
Os nomes de mensagens/operações aqui são contratos da fábrica, não APIs prontas alegadas dos SDKs.

### 5.1 Canal e mensagens

`node:net`, socket Unix com pathname em diretório privado da instalação, JSON delimitado por linha.
Decoder acumula frames completos; leitura de socket não é uma mensagem. Validar versão/tipo/campos;
limites de frame/buffer são obrigações do perfil de release, com erro explícito, nunca truncamento aceito.
Sessões, diffs, fontes e pareceres grandes passam por referências próprias, não cópias integrais no canal.

Envelope: `protocol_version`, `controller_run_id`, `work_id`/`execution_id` quando aplicáveis,
`worker_id`/`role`, `message_id`/`reply_to`, `kind`/`payload`, `environment_ref`/`boot_ref` e `round_id`/`attempt_id` pertinentes.
Papel é atribuído pelo host, não declarado pelo modelo. Host vincula conexão ao worker/ambiente esperado;
handshake isolado não concede autoridade. Sem PKI/mTLS/HTTP público ou framework RPC adicional.

Mesmo ID/conteúdo retorna resultado registrado sem reaplicar; mesmo ID/conteúdo diferente é erro.
Conferir fase, operação e Execução vigente além da identidade. ACK de commit é distinto de recibo de transporte/progresso.
Abertura/Execução/boot antigos não modificam reservas nem disparam atividade. Reconciliador atual pode incorporar evidência antiga explicitamente.
Uma versão de protocolo por release, sem negociação multiversão; releases compatíveis podem compartilhar versão.

### 5.2 Lock e boot

Todos os lançamentos usam o mesmo arquivo estável do storage canônico, antes de abrir banco ou aceitar mutações:

```text
flock --exclusive --nonblock --no-fork <lock-do-storage> <controlador>
```

Não apagar/substituir lock, arbitrar por PID/socket ou criar lock por alias/release.
Segundo proprietário falha sem takeover. Workers/subprocessos não herdam o descritor; liberar lock não prova sua morte.

Boot:

1. Adquirir exclusividade e verificar compatibilidade de estado/registry/perfil; só então remover socket obsoleto próprio.
2. Abrir Pi Durable com barreira de despacho fechada por padrão e nova identidade de abertura.
3. Inventariar reservas, recursos/recibos/artefatos e processos próprios, inclusive cache em preparo, mesmo com adapter anterior morto.
4. **Encerrar sobreviventes, não adotá-los**; confirmar cessação, reconciliar efeitos, início/tempo/consumos/reservas.
5. Liberar apenas Trabalhos/capacidade comprovadamente reconciliados, respeitando pausa e demais impedimentos.

Incerteza limitada conserva bloqueio/reserva daquele Trabalho; os independentes podem avançar com capacidade comprovada.
Incerteza global de autoridade/capacidade mantém despacho fechado. Recursos desconhecidos não são ignorados para declarar capacidade livre.
`resume`/`submit`/waits do Pi Durable podem iniciar scheduler: toda fase que alcance spawn/comando/ferramenta consulta barreira e autorização atual.
Replay de task não autoriza novo spawn; abort/fim de task não prova morte de processo. Não encapsular o Builder como `replay: safe`.

### 5.3 Início e recibos

Confirmar antes do spawn a identidade/operação que permitirá descobrir recursos, Slot e orçamento.
Worker host grava **recibo durável de início antes de modelo/ferramenta**, fora do workspace editável pelo guest,
com Execução/invocação/abertura/boot/perfil/tempo. Arquivo temporário, sincronização e publicação atômica,
com validação de identidade/completude; falha impede atividade. Não criar journal/banco de workflow do worker.

Recibo completo conta como início mesmo se cair antes do modelo. Incorporar consumo uma vez.
Spawn/notificação perdidos exigem descoberta, não duplicata. Ausência do recibo só comprova não início quando storage íntegro e barreira prévia o sustentam,
junto da ausência/cessação confirmada de atividade; corrupção/observação parcial mantém reserva e bloqueio.
Recibo comprova início, não atividade atual; fim de processo não apaga início confirmado.

| Fluxo | Confirmação exigida |
| --- | --- |
| Preparar/iniciar ambiente | Operacional com referência de boot, falha conhecida ou indeterminado; não início automático do agente. |
| Ativar worker | Handshake identifica conexão; recibo persistido confirma entrada em atividade. |
| Progresso | Observação de fase/atividade/uso, sem liberar Slot ou confirmar sucesso. |
| `ask_user` | Pergunta/impedimento/intenção duráveis antes do ACK; publicação e cessação independentes. |
| Revisão | Rodada registrada; parecer completo correlacionado e incorporado uma vez; resultado não prova cessação do worker. |
| Fim/falha/interrupção | Evidências/contexto e decisão do controlador; Slot só após cessação. |
| Resposta/comando | Transição durável/autorizada, nunca spawn direto por ACK. |

### 5.4 Perda de canal e cessação

EOF/erro/fechamento confirmado faz worker/adapter negar novas chamadas e iniciar parada supervisionada.
Silêncio, comando longo ou timeout de solicitação não comprovam desconexão: sem heartbeat/watchdog que mate trabalho silencioso.
Cancelamento persiste primeiro a proibição; despacho local e worker impedem novas chamadas, acionam abort SDK e supervisão.
Requisição já enviada pode concluir, sem rollback automático.

Adapter observa invocação/grupos systemd próprios, workers, VMM e subprocessos capazes de continuar atuando,
não PID solto, `MainPID=0`, `close/abort`, token expirado/revogado ou exit code isolado.
O caminho host de observação/parada funciona mesmo sem proprietário Gondolin vivo.
Depois do prazo gracioso, término forçado próprio; cessação incerta mantém Slot/reserva/bloqueio.
VM terminada encerra guest, não requisições remotas já enviadas. Disco forçadamente parado é preservado e tem usabilidade verificada antes de novo boot.

### 5.5 Perguntas e retomada

Worker atribui identidade estável a `ask user` e preserva solicitação completa antes do envio.
Controlador confirma Pergunta/impedimento/intenção antes do ACK. Worker encerra ativação, sem Promise esperando humano;
cessação precede liberação do Slot e preserva disco/workspace/sessão.
ACK perdido recupera o mesmo registro ou solicitação íntegra com mesma identidade; conteúdo perdido bloqueia, não é inventado.

Publicar em issue/PR conforme contexto, com marcador estável e instrução `/factory answer <pergunta> <texto>`.
Descobrir comentário antes de republicar após incerteza; consulta incompleta não prova ausência.
Aceitar uma resposta: a primeira autorizada/correlacionada confirmada duravelmente, não promessa de ordem global por horário GitHub.
Duplicatas/posteriores não substituem; esclarecimento/correção exige nova Pergunta. Insuficiente pode gerar outra, não aprovação genérica.
Resposta pode chegar no boot; remove só seu impedimento e nunca reativa entregue/cancelado ou renova orçamento/autorização retirada.

Primeira chamada: `/implement <link-ticket>`. Sessão compatível: `continue` com resposta/feedback/motivo.
Substituta: instrução explícita de recuperação com Trabalho e artefatos; registrar motivo, não mandar `continue` sem contexto.
Retomar via fila/categoria/posição após revalidar requisitos; não repetir última ferramenta cegamente nem prometer mesma instrução/raciocínio interno.

### 5.6 Revisão e recuperação parcial

Worker host suspende turnos/ferramentas do Builder no handoff, não apenas aceita frase do modelo/`agent_end`.
Processo/sessão podem ficar ociosos; a Execução/Slot/relógio continuam. Controlador inicia Standards/Spec em paralelo na mesma VM.
Cada worker preserva parecer completo/durável antes da notificação, com identidade, conteúdo/contexto/status/cobertura e achados.
Streaming parcial não é parecer. Notificação perdida permite incorporar o resultado completo sem rerodar quando contexto corresponder.
Preservar parecer válido e recuperar só o falho se entrada inalterada, sob limites operacionais existentes.
Se a falha interrompe Execução, cessar e readmitir nova pela fila, sem adotar sobrevivente.
Builder só volta após encerrada a atividade dos revisores e recebe resultados/falhas efetivos na sessão preservada/substituta.
Entrega ao SDK antes de checkpoint perdido não comprova consumo; reconstruir continuação com evidências/efeitos observados.

### 5.7 Duração e timeout

Relógio monotônico local, por exemplo `performance.now()`, governa duração viva; calendário serve apresentação/auditoria.
Worker Builder mantém relógio desde recibo inclusive ocioso no handoff; timer de timeout independe de logs e sinaliza controlador/parada.
Não comparar origens monotônicas entre processos nem usar calendário pós-reboot como continuidade exata.
Sleeps/backoff persistidos do Pi Durable conservam seu próprio contrato de relógio; não trocar seu `now` por `performance.now()`.

Na recuperação distinguir duração comprovada, estimativa/limites e intervalo desconhecido:

- Timeout configurado e ultrapassagem provada: interromper/bloquear.
- Cessação antes do limite demonstrada: recuperação pode seguir as regras normais.
- Não é possível excluir ultrapassagem: bloquear retomada automática para intervenção.
- Sem timeout: imprecisão é lacuna de observabilidade, não motivo isolado de bloqueio/cancelamento.

Reinício não apaga duração anterior. Prazo de parada do adapter não é timeout da Execução.

## 6. Runtime, pedido preservado e skills

Fontes: [Escolher o runtime de agentes e seus pontos de integração](issues/06-agent-runtime-choice.md#answer),
[Definir a captura versionada da especificação e das instruções](issues/16-specification-snapshot-contract.md#answer) e
[Definir o pacote de skills e o contrato verificável de revisão e validação](issues/17-skills-and-review-contract.md#answer).

### 6.1 Perfil SDK independente

Pi coding-agent via SDK embutido no processo Node de cada worker; não CLI interativa/RPC como controle.
Builder/Standards/Spec têm provider/modelo explícito por papel, podendo coincidir, sem fallback silencioso.
Settings, resource loader, ferramentas, contexto, credenciais e sessões são fornecidos pela fábrica.
Não herdar settings, extensões, skills/templates, MCP, sessões ou credenciais pessoais; ler AGENTS não carrega executáveis do repo.
Recursos adicionais exigem inclusão explícita no perfil versionado.

Desabilitar retry de agente SDK (`retry.enabled: false`) e do provider (`retry.provider.maxRetries: 0`).
Controlador governa retomadas com limites persistentes; isso não proíbe investigar/corrigir/testar na mesma Execução ou compactar contexto.
`message_end` finaliza mensagem; `agent_end` pode anteceder continuação; `agent_settled` não certifica gates nem cessação de subprocessos.
Não converter sessões Pi Durable ↔ coding-agent, criar bridge de persistência ou outra autoridade de workflow.
SessionManager/JSONL v3 documentado é contexto, não checkpoint de Git/GitHub/processos.

Registrar perfil/runtime/formato de sessão, ferramentas/extensões, skills/instruções, spec/base e configuração efetiva por Execução.
Preferir sessão compatível; incompatível/perdida exige substituição registrada com contexto recuperável, ou bloqueio se insuficiente.
Node Linux é suporte inicial; Bun não integra o perfil.

### 6.2 Especificação e instruções

Builder recebe referência inequívoca de Ticket/repo/base e começa por `/implement <link-ticket>`.
Ele consulta/preserva pedido no início da primeira Execução, não na admissão da fila.
Ticket/documentos explicitamente referenciados são a especificação mínima; documentação auxiliar não vira requisito por ser consultada.
Controlador não percorre links, monta pacote, recebe ingestão nem certifica a captura.

Na área de artefatos própria, fora das alterações do PR:

```text
spec/<versão>/
  <cópias das fontes>
  sources.json
instructions/<versão>/
  <cópias das instruções>
  sources.json
```

Builder escreve cópias e por último registro completo: origem, caminho da cópia, data, hash, commit/revisão disponível.
Versões anteriores não são sobrescritas. Registro ausente/incompleto exige recuperação, não versão pronta.
Não prometer captura simultânea/atômica, descoberta exaustiva ou imutabilidade contra código hostil.
Várias Execuções podem usar a mesma versão; refs Git/perfil/spec são identidades distintas.

Fonte necessária inacessível/incompleta gera `ask user`, inclusive privada de outro repo; não ampliar token nem criar coletor/ferramenta cross-repo.
Fonte auxiliar pode ser substituída; cópia completa preservada continua útil se link desaparecer.
Documento necessário descoberto depois é registrado e avaliado como complemento ou mudança autorizável, nunca adotado silenciosamente.
Edição posterior de Ticket/link não é autorização nem gatilho isolado de reparo.
Resposta explícita/correlacionada pode autorizar mudança concreta de escopo sem segundo comando obrigatório;
a próxima Execução preserva nova versão antes de implementar, não qualquer edição futura do link.

Builder registra instruções aplicáveis, inclusive AGENTS por caminho; mais específicas prevalecem no seu escopo sob política da fábrica.
Conflito sem solução clara exige pergunta. Alterar instruções pelo próprio Builder não dispensa gates nem amplia poderes.
Spec lê pedido preservado; Standards lê instruções preservadas. Captura documental não é snapshot obrigatório da worktree.

### 6.3 Pacote e aprovações

Distribuir cópias adaptadas/versionadas de `implement`, `code-review`, `pr`, `tdd`, suas dependências/referências aplicáveis
(incluindo `codebase-design`) e preparação/diagnóstico Alpine. Manifesto simples registra origem/identidade/créditos/licenças.
Sem registry/instalador de skills ou sincronização com perfil pessoal.
SDK resolve explicitamente `/implement` e `/pr`; política/papel entram no contexto e auxiliares ficam legíveis em paths conhecidos.
Mencionar/carregar skill não prova execução nem pressupõe ferramenta nativa `Skill`.
Adaptar só integração de revisão ao controlador; não transportar delegação pessoal nem omitir Spec por falta de fonte.

Aprovações exigidas pelas skills, inclusive interfaces de teste de TDD, precisam de autorização concreta prévia ou `ask user`.
Label não as substitui; aprovação já registrada suficiente evita pergunta redundante.
Standards distingue padrão documentado de heurística; heurística não vira violação obrigatória.

### 6.4 Conteúdo, pareceres e gates

Handoff cobre alterações commitadas/staged/não staged, novos, removidos e metadados Git relevantes destinados ao PR,
com índice de arquivos/diff/referências da rodada e caminhos de fontes preservadas.
Revisor pode ler contexto além dos hunks. Dependências/artefatos gerados fora da proposta não viram automaticamente mudanças do PR.
Registrar identidade leve por hashes/presença/remoção/metadados, refs Git/base e versões de spec/instruções/perfil.
Não exigir commit candidato, worktree limpa, cópia/snapshot, VM auxiliar ou auditoria genérica de quiescência.
Handoff é cooperativo: não promete congelamento contra escritores externos; mudança observada/identidade incerta exige nova avaliação.

Cada parecer registra rodada/tentativa/papel/sessão/modelo/perfil, entrada/contexto examinados,
conclusão/falha/cancelamento, cobertura incremental/ampla com justificativa e achados identificáveis por regra/requisito/local.
Builder registra corrigido ou não acolhido com justificativa/evidência. Nem todo achado é veto;
discordância interna não exige arbitragem humana por si, mas dúvida de requisito/dispensa/autorização exige pergunta.
Não fabricar/omitir conclusão dos revisores nem tratar falha como zero achados.

Depois de corrigir conteúdo, reunir mudanças e pedir rodada dos dois, preferindo sessões compatíveis.
Ambos sempre emitem parecer atual justificado quando a proposta/contexto relevante muda; controlador não calcula equivalência semântica.
Duas exceções não exigem rodada por si:

- Justificativa de não acolhimento fora da proposta, sem mudar pedido/contexto.
- Commit contendo exatamente o conteúdo já revisado, com correspondência comprovada e vínculo ao commit, não só declaração do Builder.

Essas exceções não dispensam alterações efetivas, contexto mudado por rebase, concorrência desconhecida ou CI do SHA pertinente.
Falha parcial preserva outro parecer válido somente com mesma entrada/contexto; recovery usa limite existente, não orçamento paralelo.
Mero avanço da base sem impedimento efetivo não dispara revisão.

Gates: Builder identifica testes/typecheck/lint e demais comandos documentados, com fonte, comando/cwd,
resultado efetivo/status/log, conteúdo e Execução correlacionados. Sucesso/falha/não execução/dispensa são distintos.
Fonte faltante, impossibilidade ou falha não resolvida exigem `ask user`; dispensa concreta registrada não contorna check obrigatório GitHub.
Resultado real da ferramenta, não stdout declarado pelo agente, sustenta evidência.
Controlador verifica presença/correlação dos dois pareceres, tratamentos, gates e dispensas;
não interpreta semanticamente toda documentação nem certifica todas as fontes capturadas.

## 7. Interface de sandbox e perfil Gondolin

Fontes: [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](issues/07-isolation-choice.md#answer) e
[Definir o contrato e o perfil distribuível do adapter Gondolin](issues/19-gondolin-adapter-contract.md#answer).

### 7.1 Interface encapsulada

| Operação | Contrato |
| --- | --- |
| Validar | Configuração/perfil/pré-requisitos → diagnóstico sem boot; inspeção não prova Docker. |
| Preparar | Trabalho/configuração autorizados → referência persistente própria, sem duplicar em repetição nem iniciar Builder. |
| Iniciar | Referência/configuração compatível → referência de boot operacional; reusa disco/workspace, não adota sobrevivente. |
| Executar ferramenta | Boot/papel/operação autorizados → resultado/atividade/erro; nenhum SDK host irrestrito ou timeout tratado como ausência de efeito. |
| Observar | Identidade → condição, evidências e consumo disponível, inclusive sem proprietário antigo. |
| Parar | Referência própria → parada/cessação, preservando disco/workspace e distinguindo graciosa/forçada. |
| Remover | Cleanup autorizado + cessação → remoção ou resultado parcial/erro; não apaga histórico, PR ou branch remota. |

Referência persistente opaca identifica ambiente/disco/workspace/perfil; referência de boot muda por inicialização.
Controlador persiste/correlaciona, não interpreta PIDs/paths internos/units/QEMU/cgroups.
Observações: ativo, parado com cessação confirmada, removido ou indeterminado.
Resultados: sucesso conhecido, falha conhecida ou indeterminado; erro de parada não determina sozinho condição atual.
Não duplicar configuração/métodos, criar scheduler de recursos ou framework genérico de plugins.

### 7.2 Configuração aprovada

```yaml
schemaVersion: 1
profile: <identidade do perfil distribuído>
memoryMiB: 2048
vcpus: 2
diskGiB: 40
shutdownGraceSeconds: 30
minFreeSpaceGiB: 4
```

Adapter valida tipos/valores/perfil sem coerção silenciosa e registra configuração efetiva por ambiente/boot.
2048 MiB = 2 GiB = 2.147.483.648 bytes; disco virtual 40 GiB = 42.949.672.960 bytes;
piso livre 4 GiB = 4.294.967.296 bytes. Não são reserva física, consumo total medido ou suficiência demonstrada.
2 vCPUs não reservam núcleos físicos. 30 segundos é tentativa graciosa, não timeout da Execução.

Antes de preparar considerar cópias estimáveis e margem restante; antes de boot conferir piso novamente,
em ambos os filesystems se workspace/disco separados. Distinguir uso físico/virtual/espaço do workspace/livre.
Sem reserva total antecipada, resize automático, argumentos QEMU livres, scripts init/mounts arbitrários ou exclusão para abrir espaço.
Cruzamento do piso não mata ativo; reporta e impede novas operações afetadas. RAM/vCPUs/prazo podem mudar no próximo boot com registro,
sem alterar VM viva ou migrar perfil/disco silenciosamente.

### 7.3 Processos, filesystem e Git

Um processo host do adapter por Trabalho ativo possui uma instância Gondolin, separado dos workers Pi.
Systemd supervisiona grupos próprios identificáveis de adapter/workers/QEMU, sem supervisor próprio/global adicional.
Administração systemd não é ferramenta do agente. Falha de um proprietário não pode encerrar VMMs de outros Trabalhos.
Normalmente parar containers/daemon e sincronizar guest antes de fechar VM; depois do prazo forçar apenas recursos próprios.
Cessação confirmada e parada graciosa concluída são evidências distintas.

Workspace persistente host é exposto estritamente por RealFSProvider, sem home/checkout amplo, cache Git, SQLite,
chave, sessões/registros host, socket Docker host ou outros Trabalhos. Paths/symlinks/aliases FUSE não podem escapar.
Checkout/metadados próprios e artefatos operacionais ficam na área desse Trabalho, com artefatos fora da proposta de PR.
Workers host são confiáveis e não executam scripts/plugins do repo no host. Conta dedicada é recomendada, não obrigatória;
processos host da conta e administração estão na base de confiança, não isolados por nomes de diretório.

Manter cache bare local por repo, exclusivo da fábrica e nunca montado no guest.
Sequenciar fetch → clone local concluído → próximo preparo do mesmo repo, sem serviço/lock de cache adicional;
repos distintos e Builders preparados continuam paralelos. Cópia independente com `--no-hardlinks`, sem `--shared`, `--reference` ou alternates,
remoto apontando ao GitHub e worktree/branch próprias, sem metadados comuns graváveis entre Trabalhos.
Não executar hooks/scripts/plugins do repo no preparo host. Reparos/retomadas reutilizam checkout; cache pode ser reconstruído sem invalidar cópias,
mas falha de fetch não comprova base atualizada. Sem TTL/LRU/promessa de cache LFS/submódulos/dependências.
Após crash reconciliar processos próprios de preparo antes de mutar cache.

### 7.4 Guest, Docker e persistência

Assets prontos de release com Alpine, ferramentas básicas, Git/gh, certificados, Docker e utilitários de boot/disco.
Instalação/Trabalho não constroem imagem nem exigem Docker/Podman host só para produzi-la.
Runtimes/dependências do repo são instalados pelo Builder no guest, orientado pela skill Alpine: versões exigidas, `apk`, musl/compilação e diagnóstico.
Sem troca silenciosa de stack/versão/testes/imagem; glibc/musl e dependências nativas precisam compatibilidade demonstrada.

Disco próprio persistente, `rootDiskPath`/formato explícitos e `rootDiskDeleteOnClose: false`, não overlay temporário padrão.
Manter base/assets enquanto houver discos dependentes. `tmpfs: {}` preserva `/root`, `/tmp`, `/var/tmp`, `/var/cache`, `/var/log` no disco;
`/run` continua efêmero. Novo boot reusa pacotes/caches/Docker data/workspace, não RAM/processos nem o mesmo objeto SDK.
Docker daemon e data-root são do guest, driver **`vfs`**, distinto do VFS/FUSE Gondolin e sujeito a deep copy/custo de I/O/disco.
Não presumir que qcow2 elimina custo, que 40 GiB bastam ou alternar para overlay2/desligar Ryuk como fallback.

### 7.5 Ferramentas e rede

Builder tem leitura/pesquisa/edição/escrita/comandos explicitamente encaminhados ao guest; nenhum shell host ou plugin arbitrário do repo.
Revisores têm **somente `read` nativo Pi** (`path`, `offset`, `limit`, paginação/imagens), backend confinado do adapter:
substituir `access`/`readFile`/detecção pertinente, sem defaults/fallback host; mudar cwd não confina.
Sem shell, escrita, Docker, wrappers Git, busca/listagem próprios, consulta remota ou token GitHub neste perfil.
Índice/diff/paths preservados fornecidos no handoff tornam a leitura possível sem fingir que `read` lista ou calcula diff.
Fonte faltante/ilegível, truncamento não superado ou contexto insuficiente tornam revisão incompleta, não permitem ampliar ferramentas.

HTTP(S) público mediado sem lista manual de cada domínio; sem acesso geral a host/rede privada/outros Trabalhos ou portas públicas por padrão.
Exceções privadas são configuração autorizada de instalação/repo, não aprovação por Ticket nem fallback automático.
Separar TLS do guest/ferramentas, daemon Docker e runtimes/truststores/aplicações dentro dos containers.
Wrapper upstream de `docker run` não prova Testcontainers/Compose/API/build; pull não prova HTTPS interno ao container.
Adequação necessária é explícita, sem `--insecure`, TLS desligado, rede ampliada, testes reescritos ou Ryuk dispensado silenciosamente.

## 8. GitHub App, permissões e segredos

Fonte: [Definir o contrato de permissões e verificação da GitHub App](issues/11-github-app-contract.md#answer).

Uma App da fábrica, instalações por owner, repos selecionados pelo time. Não há token global entre instalações.
Time configura App/barreiras sem administração de escrita ou bypass que permita base/merge;
fábrica verifica identidade/instalação/repo/base/acesso/permissões operacionais, não certifica segurança do time.
Sem provas negativas, monitoramento de bypass ou auditoria por início/renovação. Leitura de regras para checks continua necessária à prontidão.

R = leitura; W = escrita incluindo leitura; — = não conceder. São tetos por finalidade, não token universal:

| Permissão | Controlador | Builder | Revisores no contrato geral |
| --- | --- | --- | --- |
| Metadata | R | R | R se token necessário |
| Contents | R; W só cleanup remoto próprio | W | R se necessário |
| Issues | W perguntas/marcos | R | R se necessário |
| Pull requests | W acompanhamento/prontidão | W publicar/atualizar PR | R se necessário |
| Checks / Commit statuses | R | R diagnóstico | — |
| Actions | R quando necessário a diagnóstico | R quando necessário a diagnóstico | — |
| Administration | R para leituras necessárias | — | — |
| Workflows | — | W só por configuração explícita do repo | — |

Perfil inicial de revisores escolhe **sem token**, com contexto capturado; opções gerais não autorizam consulta remota implícita.
Teto instalado é união dos usos configurados, mas cada token reduz explicitamente repo/permissões/finalidade e confere escopo devolvido.
Clone/fetch usa Contents R; cleanup de branch remota própria recebe token próprio com Contents W, sem ampliar acompanhamento por conveniência.
Builder só recebe token de seu repo. Dependências nativas podem usar outras instalações pelo controlador, não acesso documental do Builder.
Workflows exige permitir/proibir explicitamente por repo; ausência é configuração incompleta, sem proibição/permissão presumida.
Sem escrita em checks/statuses/Actions/administração/segredos/ambientes/deployments; Actions R não autoriza aprovar/disparar/reexecutar workflow.

Chave protegida e material emissor só no controlador, fora de Git/sessões/workspace/disco/mounts.
Token só em memória; metadados sem segredo persistem: instalação/repo/papel/finalidade/permissões/validade e correlações.
Comandos autorizados recebem `GH_TOKEN` em ambiente explícito separado de argv; Git HTTPS usa `gh auth git-credential` sem armazenar segredo.
Sem token em remoto/prompt/histórico, login persistente, store/cache secreto, cofre/broker ou PAT/perfil pessoal como fallback.
Não encaminhar ambiente inteiro do host nem devolver segredo ao modelo.

Renovar antes de `expires_at` enquanto autorizada atividade da Execução, mesmo se elegibilidade para nova ativação foi retirada.
Uma hora de token não é timeout. Novo comando recebe token atual; subprocesso existente conserva ambiente antigo.
Expiração exige reconciliar efeito antes de repetir comando, sem reiniciar Trabalho apenas para renovar.
Fim/espera externa/cancelamento retiram novas entregas/renovações e revogam tokens conhecidos quando possível;
handoff interno não exige rotação por rodada e não entrega ambiente secreto aos revisores.
Depois de crash valor perdido pode impedir revogação: registrar risco de cópia externa válida até expirar,
sem suspender instalação inteira ou afirmar cessação por expiração. Código que recebeu token pode copiá-lo; não prometer contenção adversarial.

### 8.1 Projeção de credenciais na composição

A interface estreita aprovada é dependência de composição, não serviço ou módulo de negócio adicional:

```typescript
interface BuilderCredentials {
  issue(context: BuilderCredentialContext): Promise<BuilderGrant>;
  revoke(grant: BuilderGrant): Promise<RevocationResult>;
}
```

Contexto identifica Trabalho/Execução ativa/repo, com configuração/finalidade autorizadas pela composição.
Emissor GitHub App privado, somente no controlador, deriva/verifica redução por repo/papel e escolha explícita de Workflows;
modelo não pede permissões arbitrárias. Adapters de tracker/código usam credenciais por finalidade internamente, sem token universal
ou métodos de autenticação adicionados aos seus contratos.

`BuilderGrant` contém entrega transitória, validade e metadados; **só metadados** podem entrar no estado durável.
Não retornar segredo em resultado serializável de task Pi Durable, payload persistido de invocação, recibo, log, sessão ou prompt.
Registrar valor conhecido para filtragem antes do uso. `Workers.deliver` o leva em memória ao caminho host de ambiente explícito das ferramentas;
no início, handshake host entrega antes de liberar operações dependentes. Formato GitHub/credential helper não vaza para regras do Controle.

Renovação é nova `issue` após revalidar autorização da atividade, não método `renew`, retomada ou novo Trabalho.
Novo comando recebe concessão vigente; subprocesso anterior conserva seu ambiente. `revoke` tenta retirar concessões conhecidas ao encerrar/esperar/cancelar,
sem alegar recuperação do segredo perdido após crash, revogação comprovada onde não há evidência ou cessação por expiração.
Esta projeção não é protocolo universal de autenticação, cofre ou endpoint público.

## 9. Publicação, checks e prontidão

Fontes: [Definir a avaliação de checks obrigatórios e prontidão do PR](issues/10-readiness-checks-contract.md#answer) e
[Definir o pacote de skills e o contrato verificável de revisão e validação](issues/17-skills-and-review-contract.md#answer).

### 9.1 Publicação e recuperação direta

Após implementação/reviews, controlador verifica resultado/localização/PR; se ausente solicita publicação ao Builder.
Builder usa `/pr`, push na branch própria e cria PR draft com associação inequívoca Trabalho/Ticket/repo/branch/base/PR.
Descrição curta: **Resumo** (mudança/razão/vínculo), **Validação** (síntese/limitações/dispensas), **Risco** relevante ao humano.
Sem transcrições, comandos extensos, rodadas ou pareceres integrais no PR; detalhes locais separados,
links só quando acessíveis remotamente, sem serviço novo de artefatos ou caminho local apresentado como link útil.
PR aberto não encerra Ticket; vínculo de fechamento por merge pode ser usado.

Não exigir `registrar_efeito`, wrapper Git/gh, parser de shell, diário especial ou ACK prévio por push/criação de PR.
Registros normais preservam OID esperado efetivamente usado antes da preparação, não só variável perdida.
Após cessação, consultar Git local/remoto e PR por identidades/correlação e evidência recuperável.
Branch com nome esperado não prova autoria; PR próprio encontrado é vinculado, não recriado.
Múltiplos candidatos, leitura incompleta, mudança humana desconhecida ou efeito ambíguo bloqueiam repetição insegura.
Ausência de ACK/primeira leitura vazia não prova ausência de efeito; a recuperação pode exigir intervenção humana.
Resultado perdido de comando exige inspeção, não replay arbitrário; leitura segura pode ser repetida.

### 9.2 Avaliador externo

`gh api`: REST para PR/regras/check-runs/statuses e GraphQL para draft/ready quando necessário, com versão explícita.
Ler identidade/head/base/estado/draft/merge/conflito do PR, proteção tradicional e rulesets ativos aplicáveis/herdados,
check-runs e statuses atuais com paginação/tentativas/origem/SHA, além de registros internos e impedimentos humanos pertinentes.
404/erro de acesso não comprova regra ausente. Rollup/merge box/resultados publicados não enumeram contextos obrigatórios nunca publicados.

Suportar required status checks tradicionais/rulesets, contexto/integração e strict/loose, acumulando requisitos.
Regra relevante não interpretável, por exemplo modalidade de workflow obrigatório ou merge queue não suportada,
é incompatibilidade/indeterminação, não dispensa nem interpretador universal.
Separar preparação da fábrica de exigências exclusivas do merge humano; review humano pendente não impede sozinho prontidão para recebê-lo.

Avaliação correlaciona Trabalho/Execução, PR/repo, head/base/merge de teste pertinente, instante/completude/requisitos,
origem/tentativa/SHA dos resultados, pareceres/gates e decisão/motivos:

1. Conferir ownership/estado; encerramentos/cancelamento não autorizam conversão proibida.
2. Capturar refs/requisitos completos e resultados atuais.
3. Correlacionar cada requisito ao SHA correto: head ou merge de teste atual conforme regra; correspondência incerta é indeterminada.
4. Verificar conteúdo/spec/instruções/reviews/gates, conflito triestado e todos os impedimentos.
5. Produzir motivos independentes; pronto só com todos os requisitos de preparação satisfeitos.
6. Antes da conversão reconsultar identidade/head/base/requisitos; mudanças invalidam avaliação externa e exigem recalcular,
   não lançar reviews só porque base avançou.
7. Confirmar intenção → converter fora do commit → observar/reconciliar → confirmar resultado/evidências.

Não existe snapshot atômico com GitHub/CI/regras nem prontidão permanente.

| Resultado pertinente | Ação |
| --- | --- |
| Check-run obrigatório concluído `success`, `skipped`, `neutral` | Satisfaz requisito GitHub correspondente, não prova gate local executado. |
| Commit status obrigatório `success` | Satisfaz status correspondente; não aplicar semântica de check-run a status. |
| Obrigatório ausente/queued/in progress/pending | Espera CI sem Slot; não falha de código nem verde. |
| Obrigatório atual `failure` | Reparo sujeito a autorização/consolidação/limites. |
| `cancelled`, `timed_out`, `stale`, `action_required`, erro/outra conclusão não satisfatória | Classificar evidência: defeito confirmado → reparo; causa operacional → bloqueio; causa incerta não lança Builder. |
| Aprovação workflow, permissão/configuração ou regra não interpretável | Bloqueio/ação humana, sem poderes extras. |
| Check opcional falho ou SHA antigo | Visível/histórico, sem reparo automático por si; gate local obrigatório permanece. |
| Consulta parcial/falha, origem/tentativa/requisito desconhecidos | Não pronto; recuperar leitura ou reportar impedimento. |

Requisito inclui contexto e integração, não só nome. Check-run/status homônimos exigidos precisam de ambos;
verde antigo não encobre rerun pendente/falho nem resultado de outra origem. Conjunto obrigatório vazio exige leitura completa/autorizada.

### 9.3 Draft e prontidão interna

Pronto requer dois pareceres atuais aplicáveis, tratamento dos achados, gates atendidos/dispensados legitimamente,
checks satisfeitos, ausência confirmada de conflito e nenhum impedimento de preparação, inclusive autorização/dependência/pergunta/limite/concorrência.

- Perda confirmada: retirar prontidão e converter draft com motivo.
- Falha transitória/cálculo desconhecido: retirar confirmação interna, preservar flag até evidência suficiente e reconsultar, sem oscilação por rede.
- Se fábrica colocou draft por suas condições, restaurar automaticamente após avaliação completa.
- Draft inesperado não atribuível à fábrica: respeitar e pedir autorização antes de reconverter.
- Ready sem evidências não certifica prontidão; conversão incerta exige descoberta antes de repetir.

Mero avanço da base apta não dispara Execução/revisão/rebase/draft. Aprovação humana, CI pendente e mergeability desconhecida
não são gatilhos genéricos de reparo. Polling não identifica intenção humana sem mudança observável.

## 10. Manutenção e concorrência humana

Fonte: [Definir o fluxo de manutenção e reconciliação autorizada do PR](issues/20-pr-maintenance-contract.md#answer).

Usar Trabalho/correção/Execução existentes, sem máquina de estados por evento, ACK de consumo de cada feedback,
fila extra ou histórico de cada polling/descarte. Preservar identidade/origem/versão/conteúdo relevante do pedido humano e tratamento,
contexto fornecido por Execução, motivos/referências atuais e evidências recuperáveis; não depender só de cursor temporal ou transcript.
Fornecido não prova consumido, tratamento declarado não prova CI/publicação.

Gatilhos: conflito confirmado, check obrigatório pertinente falho, strict que efetivamente exige atualizar a base para merge,
review humano autorizado `CHANGES_REQUESTED` e comando explícito autorizado.
Base avançando, atraso loose, `BLOCKED/BEHIND` isolado, comentário comum, check opcional/antigo, CI/review pendentes
ou mergeability desconhecida não são gatilhos por si.
Review humano de commit anterior não é descartado por push; aprovação posterior/dismissal pode retirar seu gatilho,
sem apagar pedidos independentes ou declarar satisfeita aprovação humana de merge.
Builder pode demonstrar já atendido/inaplicável; discordância real/incapacidade de atender pedido humano exige `ask user`,
não apenas não acolhimento permitido para achado interno.

Fluxo:

1. Reconsultar PR próprio/condições e consolidar motivos na correção pendente, preservando identidade/FIFO.
2. Antes de ativar revalidar requisitos, motivos, ownership e orçamento. Se todos desapareceram antes do início,
   retirar pendência sem cobrar; reserva/início incerto exigem reconciliação.
3. Fornecer todo feedback ainda relevante via `continue` ou recuperação contextualizada, sem recapturar spec ou reiniciar skill por conveniência.
4. Builder trata/registra, valida, obtém reviews aplicáveis e publica quando necessário.
5. Novo feedback durante atividade/reviews acumula para próxima ativação segura, sem injeção/interrupção por esse motivo ou escritor paralelo.
   Se incorporado antes do encerramento e ainda relevante, permanece na mesma correção/cobrança; reavaliar se já foi eliminado.
6. Encerrar correção após tratamentos, reviews/gates, publicação reconciliada quando necessária e cessação,
   sem feedback relevante pendente dessa correção. **Não esperar CI remoto para encerrar correção.**
7. Acompanhar mesmo PR. Nova falha pertinente do novo resultado pode criar outra correção/FIFO/cobrança;
   repetir evento antigo ou problema já declarado insolúvel não gasta novas tentativas: bloquear/perguntar.

Início confirmado conta mesmo se Builder concluir sem mudanças. Ordem de observação/commit decide se feedback entrou na correção aberta;
sem promessa de ordem global GitHub. Acumular feedback não adia cancelamento/merge/encerramentos ou bloqueio de escrita por concorrência.

### 10.1 Lease e divergência

Rebase por padrão salvo estratégia do AGENTS. Capturar OID remoto esperado **antes de preparar** atualização e preservar valor usado.
Somente branch do Trabalho com `--force-with-lease=<ref-do-trabalho>:<OID-esperado>` explícito;
nunca `--force`, reescrita da base, recaptura cega após lease falhar ou tracking ref como substituto da expectativa perdida.

Mudança remota não atribuível à fábrica impede próxima escrita. Preservar local/expectativa e apresentar Trabalho/repo/branch/PR,
ref conhecida/atual/resultado local, diferenças/autoria comprovável/incertezas e reconciliação proposta.
Padrão: preservar/incorporar mudanças humanas; descarte exige autorização específica.
Pergunta/resposta autoriza a divergência concreta; nova mudança requer nova avaliação/autorização, não lease renovado às cegas.
Reconciliação não renova escopo/orçamento. Se também muda pedido, obter autorização concreta e preservar nova versão na próxima Execução.
Troca de branch-alvo bloqueia continuação automática até restaurar ou autorizar base compatível e reavaliar comparação/instruções/reviews/checks.
Avanço da mesma base só gera manutenção pelos gatilhos efetivos acima.

## 11. Instalação, configuração e CLI

Fonte: [Definir a configuração, a CLI e o ciclo operacional da instalação](issues/21-installation-operations-contract.md#answer).

### 11.1 Distribuição e paths

Extrair release autocontida na raiz escolhida, executar `./factory setup`, configurar e iniciar `./factory run`.
Não são comandos já implementados neste PKM; são a interface que a futura fábrica deve oferecer.

| Path relativo à raiz canônica | Uso |
| --- | --- |
| `factory` | CLI/lançamento. |
| `releases/<versão>/` | Código/dependências/skills imutáveis selecionados explicitamente. |
| `assets/` | Assets versionados preservados enquanto houver discos dependentes. |
| `config.yaml` | Configuração com versão de schema e referências, sem valores secretos. |
| `credentials/` | Arquivos secretos privados da conta da instalação. |
| `data/` | Storage/estado e `records/<work_id>/{sessions,logs,evidence}/`. |
| `environments/` | Recursos persistentes próprios administrados pelo adapter. |
| `run/` | Socket/temporários; lock é estável e vinculado ao storage, não à release/socket descartável. |

Setup é repetível: subdiretórios/permissões próprios, exemplo inicial, verificação de pré-requisitos, repos inicialmente vazios.
Não sobrescreve dados/config/credenciais, inicia Ticket, instala pacote, usa sudo ou muda permissões recursivamente em conteúdo desconhecido.
Pré-requisitos administrativos explícitos incluem systemd dos ambientes, QEMU/ferramentas de disco, storage local e KVM funcional/nested quando necessário;
sem aceleração bloquear, sem TCG/krun/fallback. Conta dedicada recomendada; controlador em primeiro plano ou serviço systemd opcional com mesmo lock.
Setup só registra serviço por solicitação explícita; perfil host confiável não concede shell/admin host ao agente.
Paths incompatíveis/longos para socket e FS sem persistência/lock geram diagnóstico. Instalação não promete relocação livre por cópia.

### 11.2 Configuração declarativa

YAML versionado, validado integralmente antes da aplicação, sem recarga automática ou aplicação parcial.
Mudanças por reinício; comandos operacionais são persistidos, não edição cotidiana do estado/YAML.

| Nível | Conteúdo |
| --- | --- |
| Instalação | Operadores GitHub, provider/modelo de cada papel, concorrência/polling/retenção, referências secretas, configuração de sandbox. |
| Repo | Identidade explícita, base, label, escolha explícita de Workflows, limites de correção/recovery e timeout opcional. |
| GitHub App | App ID, installation IDs associados aos repos e referência da chave protegida. |
| Sandbox | Perfil/configuração/rede pela interface do adapter; sem campos paralelos/flags QEMU no controlador. |

Defaults: concorrência **1**, polling **60 s**, label **`ready-for-agent`** por repo se omitida,
limites **3/3**, espera **5/15/45 s**, timeout ausente e detalhes elegíveis **30 dias**.
Modelos/provider não têm default/herança/fallback; repo/base/operadores são explícitos.
Não descobrir/autorizar repos, criar overrides arbitrários por Trabalho ou herança multicamada.
Polling respeita headers/rate limit/backoff sem consultas sobrepostas descontroladas; falha não é ausência de evento/verde.

Nova ativação registra configuração efetiva e compatibilidade de sessão. Reduzir concorrência limita novos disparos sem matar ativos.
Alterar base/remover repo não migra/apaga Trabalhos; incompatibilidade bloqueia novos passos afetados.
Mudar limite não apaga esgotamento nem substitui concessão explícita; configuração não renova autorização/escopo.

### 11.3 Comandos e autenticação

`factory` abaixo abrevia `./factory` na instalação. Inspeção oferece saída humana e `--json`.

| Comando | Semântica |
| --- | --- |
| `setup`, `run`, `doctor` | Preparar, executar controlador e diagnosticar sem reparo automático. |
| `status`, `list`, `show <trabalho>` | Global/filas e detalhes/impedimentos/evidências. |
| `history <trabalho>`, `logs <trabalho>` | Histórico paginado e logs com filtros por Execução/papel. |
| `request <pedido>` | Resultado/andamento de ingresso identificado. |
| `pause`, `unpause` | Novos disparos; sem matar ativos/remover impedimentos. |
| `cancel <trabalho>` | Interrupção/encerramento com preservação e reconciliação. |
| `answer <pergunta> <texto>` | Resposta autorizada/correlacionada. |
| `resume <trabalho>` | Autorizar retomada/nova tentativa e renovação suspensa, revalidando requisitos; não reabrir PR/reviver cancelado ou entregue. |
| `repair <trabalho> --reason <texto>` | Correção dentro do escopo vigente. |
| `update-scope <trabalho> --reason <texto>` | Autorizar nova versão concreta do pedido. |
| `grant <trabalho> --corrections <n>` ou `--recoveries <n>` | Orçamento adicional com histórico. |
| `new <ticket>` | Novo ciclo explícito após entrega/cancelamento, com predecessor. |
| `reopen <trabalho>` | Reabrir PR próprio sem merge; não concede orçamento/escopo nem dispensa retomada. |
| `cleanup <trabalho>` | Seleção/plano/confirmação explícitos de recursos/logs/sessões. |
| `forget <trabalho>` | Excluir histórico elegível mantendo memória mínima de ciclo/resultado/merge. |

CLI local confia na conta administradora. Comentários exigem prefixo estrito `/factory`, operador GitHub autorizado e contexto do Ticket/PR próprio,
sem apontar outro Trabalho. `/factory answer <pergunta> <texto>` valida também correlação.
Prosa/bots/terceiros/fontes consultadas não concedem poderes. Globais, instalação/diagnóstico administrativo e exclusões destrutivas ficam locais.
Reconciliação excepcional usa Pergunta vinculada a referências concretas, não comando por caso nem autorização genérica.
Durante atividade, repair/update-scope ficam para próxima ativação segura; resume informa ativo sem lançar segundo Builder;
retornar aceito para depois/já atendido/recusado. Nenhum comando ignora todos os impedimentos ou lança agente diretamente.

CLI gera/apresenta identidade antes do envio mutável; automação pode fornecer `--request-id`.
ID/conteúdo iguais retornam conhecido; diferente com mesmo ID falha. Ingresso é persistido junto da transição, sem fila offline/diário paralelo.
ACK não prova efeito/cessação; conexão perdida exige `request` ou mesmo ID/conteúdo. Não localizado não prova ausência de ingresso equivalente.
Consultas lógicas/mutações exigem controlador; offline só diagnóstico de config/versões/paths/pré-requisitos/logs do processo ou serviço,
sem leitor operacional paralelo. Indisponibilidade não é lista vazia.
Doctor não instala, remove lock, mata processos, muda permissões desconhecidas ou GitHub;
consultas autenticadas exigem controlador e verificam acesso operacional, não barreiras de merge/CI.
Erros/códigos JSON estáveis distinguem sucesso, entrada inválida, recusa, indisponibilidade e indeterminação, com motivo/alcance/próximo passo sem segredos.

### 11.4 Parada e atualização

Ctrl+C/parada normal fecha despacho e solicita cessação supervisionada, preservando contexto sem cancelar Trabalhos.
Só declarar limpa após cessação/persistência; crash/forçada/incerta requer boot reconciliador.
Reiniciar preserva pausa, suspensão, fila, contadores e perguntas. Continuação limpa segue seção 4, sem recovery indevido.

Atualização:

1. Pausar novos disparos e parar com confirmação.
2. Extrair/verificar nova release em diretório próprio, preservando anterior.
3. Validar configuração, backend/schema, docs/tasks/registry, protocolo, perfil/skills, sessão e ambientes antes de modificar estado.
4. Executar somente migração suportada e explicitamente solicitada, preservando IDs, índices/ciclos/FIFO, perguntas, reservas, limites e efeitos.
5. Iniciar pausada, reinstalar registry compatível, reconciliar/inspecionar e então despausar.

Formato/definição incompatível bloqueia; não apagar/ressubmeter task para contornar.
Migração interrompida precisa detecção e caminho próprio de conclusão/recuperação; nunca estado parcial aceito sem saída conhecida.
Não migrar disco/base ou remover assets dependentes implicitamente, nem prometer rolling update/rollback universal.
Release antiga só pode operar estado compatível. Sem comando/agendamento/expiração/certificação de backup/restauração;
proteção contra perda do storage é externa, sem desfazer GitHub ou dispensar reconciliação. Recovery após crash do estado persistido permanece obrigatório.

## 12. Observabilidade, retenção e encerramentos

Fonte: [Definir observabilidade, proteção de segredos e retenção dos artefatos](issues/22-observability-retention-contract.md#answer).

### 12.1 Evidência e apresentação

Histórico/resumos na autoridade, logs detalhados JSONL e sessões no formato nativo Pi:
`data/records/<work_id>/sessions/`, `logs/`, `evidence/` privados, não montados no guest.
Fontes/pareceres/resultados/recibos necessários sobrevivem ao cleanup na área protegida;
antes de remover ambiente preservar o que sustenta registros retidos, sem coletor documental ou nova autoridade.
Sessão pode atravessar Execuções; registros ligam papel/sessão/Execução sem duplicar uso.

Registros estruturados incluem versão, identidade/origem/papel/horário/tipo e IDs pertinentes de Trabalho/Execução/worker/sessão/
tentativa/rodada/pergunta/efeito/ambiente/boot. Globais não exigem todos os campos.
Ferramentas registram chamada/comando/argumentos filtrados/cwd, início/fim/falha/aborto/desconhecido e saída/status só quando observados.
Manter expectativa remota efetivamente usada em lease nos registros normais, sem parser/diário adicional.

CLI mostra globalmente pausa/Slots/filas/impedimentos/cleanup/consumo; por Trabalho Ticket/repo/branch/PR,
resultado/autorização/fase/espera/bloqueio/próximo passo, duração/última atividade, Execuções/tentativas,
perguntas/gates/reviews/efeitos/recursos e referências. Histórico/logs paginados por Execução/papel.
Observações externas têm instante/frescura; arquivo expirado/ausente/removido/incompleto é explicado, não lista vazia.
Silêncio não é travamento, atividade não é progresso útil, log/sessão não é autoridade e raciocínio interno não é exigido.

Uso/custo por Execução/papel, Trabalho e instalação inclui revisores/falhas/abortos quando mensuráveis,
sem somar novamente notificação ou total de sessão retomada. Completo/parcial/indisponível são distintos; zero só observado.
Estimativa SDK com modelo/provider/unidade/moeda disponível não é fatura; sem consulta a billing ou preços inventados.
Após exclusão, agregado remanescente não representa toda a vida da instalação.
RAM/CPU/I/O/disco do adapter são distintos de tokens/custo e de capacidade virtual/livre.

### 12.2 Saídas longas, segredos e falhas

Filtrar segredos conhecidos antes de sessão nativa SDK, arquivos, exibição/publicação controladas e streaming,
inclusive valores partidos entre chunks. Não registrar ambiente secreto/autenticação/chave/token em prompt/argv/recibo/sessão/log.
Falha de filtragem não libera bruto por outro caminho. Não prometer saneamento universal de arquivos arbitrários,
segredos transformados, token perdido após crash ou cópias externas. Conta confiável/admin host não são isolados por esses diretórios.

Saída grande segue para arquivo filtrado sem acumular tudo em memória; trecho marcado e referência paginável.
Se agente precisa ler, expor seletivamente cópia filtrada na área própria de artefatos via adapter,
fora da proposta, sem montar `data/records`, fallback host ou nova ferramenta de logs.
Cópia editável não certifica resultado/gate; evidência protegida permanece separada.
Distinguir exibição truncada com íntegra disponível, captura incompleta e resultado desconhecido.
Ausência/falha de disponibilização impede conclusões dependentes, sem ampliar ferramentas.

Perda auxiliar de progresso/uso gera lacuna. Impossibilidade de persistir controle/contexto/resultado necessário
barra passos dependentes e solicita parada supervisionada quando afetar atividade; pedido não prova cessação.
Storage indisponível impede alegar que o erro já foi persistido. Não repetir comando com efeitos nem inventar verde por perda de saída.
Não publicar logs/sessões automaticamente no GitHub, só marcos/perguntas relevantes filtrados.

### 12.3 Entrega, cancelamento e cleanup

Cancelamento persiste proibição de novas ações, solicita parada e preserva artefatos;
não apaga branch, fecha PR ou desfaz GitHub. Reconciliar efeitos já enviados.
PR fechado sem merge é não entregue, sem reabertura/substituição/retomada automáticas e sem comprovar morte de ativo.
Merge confirmado torna entregue mesmo durante cancelamento; manter histórico do pedido e impedir novas ações do Builder.

Cleanup automático exige merge e cessação confirmados, ownership individual e preservação prévia de evidência retida.
Remover apenas worktree/branch local/remota/temporários/ambiente próprios; nunca base, desconhecidos/outros Trabalhos ou Docker global.
Intenção/resultado por recurso, ausência confirmada como conclusão; falha/parcial/indeterminado permanecem visíveis/repetíveis só nos pendentes.
Falha não desfaz entrega, consulta falha não comprova recurso ausente e êxito de um não comprova todos removidos.

| Classe | Retenção |
| --- | --- |
| Não entregue, inclusive aberto/bloqueado/cancelado/PR fechado | Integral até limpeza explícita, sem expiração automática de logs/sessões. |
| Recursos de entregue | Cleanup após merge/cessação, sem esperar prazo de detalhes. |
| Logs/sessões de entregue | Elegíveis por padrão 30 dias após confirmação do merge, configuráveis. |
| Evidência necessária a pendência/efeito/cleanup | Protegida enquanto necessária, mesmo além do prazo. |
| Resumo/histórico/referências/revisões/decisões | Até exclusão explícita, independente da remoção do ambiente. |

Controlador varre no boot após reconciliação e diariamente, sem daemon extra.
Revalidar entrega/prazo/ownership/uso/recuperação antes de remover; não apagar em uso.
Fim da pendência depois do prazo torna elegível na próxima varredura, sem outros 30 dias.
Crescimento de não entregues é visível/aceito, sem apagar para abrir espaço.

### 12.4 Cleanup explícito e exclusão de histórico

Seleção explícita de recursos/logs/sessões, plano de perdas e confirmação (opção de automação não dispensa verificações).
Revalidar na execução: plano antigo não permite apagar recurso agora ativo/necessário.
Destruir ambiente/contexto de Trabalho aberto exige cancelar antes; cleanup não cancela implicitamente.
Preservar evidência pendente e avisar quando perder sessão/log inviabiliza retomada; não presumir recriação por resume.

`forget` é separado: Trabalho encerrado sem recursos/efeitos pendentes; PR fechado sem merge precisa cancelamento prévio para excluir histórico.
Preservar memória mínima: Ticket/repo/Trabalho, ordem/vínculo de ciclo, resultado e, se entregue, PR e fato de merge confirmado.
Sem conteúdo do pedido, logs ou pareceres nessa memória. Impede redisparo e mantém avaliação de dependência própria:
entregue comprovável, cancelado não satisfaz, novo ciclo passa a ser avaliado. Novo Trabalho segue explícito.
Exclusão não apaga toda referência ao Ticket, cópias anteriores ou efeitos GitHub; cópia externa pode fazer reaparecer dados excluídos.

## 13. Validação e rastreabilidade

Fonte canônica: [Definir a matriz de aceite e a sequência de validação incremental](issues/24-acceptance-and-incremental-plan.md#answer).
O [plano aprovado](acceptance-and-incremental-plan.md) contém catálogo V-01–V-17, subcasos/resultados, matrizes e gates completos;
estas tabelas orientam navegação na composição, não substituem obrigações do PRD/contratos ou dispensam subcasos.
**Todas as provas de funcionamento estão a demonstrar.**

### 13.1 Requisitos funcionais e não funcionais

| Requisito | Composição nesta spec | Cenários do plano |
| --- | --- | --- |
| RF-01 — Configuração/autorização | Entrada/ciclos, config e CLI nas seções 4/11; memória mínima na 12. | V-04, V-11, V-16 |
| RF-02 — Dependências | Grafo/satisfação/visibilidade na 4, memória após exclusão na 12. | V-05, V-14 |
| RF-03 — Filas/concorrência | Transações/Slots na 3, FIFO na 4, handoff/cessação na 5. | V-06, V-11, V-13 |
| RF-04 — Worktrees/autoria | Escritor único na 3/5, Git/isolamento na 7 e concorrência na 10. | V-02, V-06, V-10, V-12 |
| RF-05 — Especificação/instruções | Captura/pedido/continuação na 5/6. | V-07, V-08 |
| RF-06 — Skills/revisão | Perfil/pareceres/gates na 6, permissões na 7 e prontidão na 9. | V-08, V-09 |
| RF-07 — Validação | Gates na 6, Docker/TLS na 7 e saídas na 12. | V-02, V-08, V-15 |
| RF-08 — Publicação/prontidão | Autoridade na 2, recuperação na 5, publicação/checks na 9. | V-09, V-12, V-17 |
| RF-09 — Acompanhamento/reparos | Avaliador na 9, manutenção/lease na 10 e polling na 11. | V-09, V-10, V-15 |
| RF-10 — Perguntas/comandos | Pergunta/retomada na 5 e CLI/autorização na 11. | V-11, V-12, V-17 |
| RF-11 — Retirada/encerramentos | Ciclos/suspensão na 4, resultado/cessação na 5/12. | V-04, V-13 |
| RF-12 — CLI/cancelamento | Interrupção na 5, operação na 11, reconciliação/recursos na 12. | V-11, V-13, V-15 |
| RF-13 — Limites/recovery | Reservas/retries na 3/4/6, tempo/boot na 5. | V-01, V-12, V-13 |
| RF-14 — Cleanup/retenção | Recursos/segredos na 7/8, retenção/exclusão na 12. | V-03, V-14, V-15 |
| RNF-01 — Durabilidade | Autoridade/commits na 3, contexto/boot na 5/6, upgrade na 11. | V-01, V-07, V-12, V-16 |
| RNF-02 — Isolamento/credenciais | Sandbox na 7, App na 8 e filtragem na 12. | V-02, V-03, V-06 |
| RNF-03 — Observabilidade | Inspeção na 11, correlação/lacunas/consumo na 12. | V-11, V-15 |
| RNF-04 — Polling | Dependências na 4, checks na 9, manutenção na 10, backoff na 11. | V-05, V-09, V-10, V-15 |
| RNF-05 — Controle previsível | Autoridade na 2/3, fila/limites na 4, perfil/pedido na 6 e comandos na 11. | V-01, V-07, V-08, V-11, V-13 |

### 13.2 Critérios de aceite

| Critério | Evidência observável exigida | Cenários do plano |
| --- | --- | --- |
| CA-01 — Jornada | Ticket autorizado → implementação → dois reviews → draft → pronto → merge humano → cleanup próprio. | V-07, V-08, V-09, V-14, V-17 |
| CA-02 — Dependência | Pendência/inacessível/não conclusiva bloqueiam; satisfação válida libera, inclusive memória de ciclos após exclusão. | V-05, V-14 |
| CA-03 — Concorrência três | Três Builders reais, dois no mesmo repo, Git/discos/VMs próprios, sem escritor duplicado e capacidade registrada. | V-02, V-06, V-12 |
| CA-04 — Prioridade | Conflito/check obrigatório atual → reparo antes de novos trabalhos, sem preempção/duplicação. | V-06, V-09, V-10 |
| CA-05 — Pergunta | Cessação libera Slot; resposta autorizada/correlacionada volta à fila; terceiro não desbloqueia. | V-06, V-11, V-12, V-17 |
| CA-06 — Crash | Cortes de execução/push/PR/pergunta/recibos recuperam efeitos sem PR/pergunta/escritor/consumo duplicados. | V-01, V-07, V-12 |
| CA-07 — Interrupção/cleanup | Cancelamento/limites/falha parcial explícitos e operáveis, preservando não entregue e entrega confirmada. | V-13, V-14, V-15 |
| CA-08 — Docker | Suites reais dos pilotos com containers simultâneos, sem colisão, bypass de testes/Ryuk ou limpeza alheia. | V-02, V-06, V-17 |
| CA-09 — Lease | Política de rebase do repo, OID anterior preservado, lease falho sem sobrescrita/renovação cega. | V-10, V-12 |
| CA-10 — Encerramentos | Polling/retirada/fechamento/limpeza/exclusão não duplicam Trabalho, redisparam ou provam entrega indevida. | V-04, V-11, V-14 |
| CA-11 — Tempo | Sem corte global; timeout configurado bloqueia; espera não usa Slot/tempo ativo; incerteza não vira zero. | V-06, V-13, V-15 |
| CA-12 — Evidência ausente | Revisor indisponível, spec incompleta, gate não executado e resultado desconhecido não são verdes; CLI explica causa/histórico/ação. | V-07, V-08, V-09, V-15 |

### 13.3 Níveis, sequência e reprovação

D = documentação; S = simulação automatizada; I = integração real; A = agentes reais; P = piloto real.
Usar o menor nível fiel: S prova regra, não integração; I prova fronteira real, não skill/utilidade;
A prova execução de skills/reviews/contexto, não aceite humano; P usa tickets reais/avaliação, não substitui bateria adversa.
O plano registra combinações obrigatórias por cenário. Segredos de teste são sintéticos.

| Incremento conceitual | Gate |
| --- | --- |
| Fronteiras frágeis | Pi Durable/SQLite FULL, SDK/persistência/filtragem, KVM/FUSE/Docker/TLS e cessação reais, sem bypass. |
| Controle determinístico, em paralelo | Regras/adversidades automatizadas, depois integradas às fronteiras reais. |
| Uma jornada completa | Cadeia correlacionada com pergunta, dois reviews, PR/merge/cleanup, sem aceitar MVP por caso feliz. |
| Concorrência/adversidades | Três Builders, Docker simultâneo, dependências, reparos/lease, crash/limites sem duplicação ou sobrescrita. |
| Operação da release | Setup/config/CLI, upgrade com pergunta pendente/migração interrompida, retenção/exclusão verificáveis. |
| Piloto útil | Menor conjunto suficiente por cobertura, tickets reais, evidências obrigatórias e qualidade/utilidade avaliadas pelo operador. |

Crash, isolamento, filtragem, observabilidade e evidência começam no primeiro incremento e reaparecem integrados, não só no final.
Não escolher agora nomes/quota de pilotos ou acessar recursos reais. Obter autorização própria de host/conta/storage/preparo,
GitHub/App/operadores/recursos descartáveis/falhas/cleanup, modelos/custos e merge humano.
Testar cenários de dependências declarados sem certificação manual de todos os pares de uso;
adequação de musl/portas/volumes/testes é explícita, nunca bypass/fallback.

Cada prova registra cenário/RF/RNF/CA, expectativa/observado/lacunas/aprovado-reprovado-inconclusivo,
release/manifesto/configuração/host/modelos, comandos/gates/injeção de falha, correlações/evidências acessíveis e autorização/avaliação pertinente.
Métrica boa não dispensa requisito. Ausente/inconclusivo bloqueia gate dependente/conformidade, não testes independentes sem relação.
Correção compatível revalida afetados; lacuna de desenho cria ticket/dependência e volta ao operador.

Medir tempos de elegibilidade/início/PR/prontidão/merge separados de espera, intervenções/perguntas/correções/recoveries,
resultados/motivos, Slots/filas/impacto da prioridade, uso/custo incluindo revisores, recuperações/duplicações/cleanup falho.
Sem taxa de sucesso, custo-alvo ou SLA arbitrários antes do piloto. Aceite do MVP exige todos os RF/RNF/CA e obrigações dos contratos,
na composição declarada, mais avaliação humana da qualidade/utilidade; aprovação desta spec não o substitui.

### 13.4 Gates do desenvolvimento da própria Factory

Fonte: [Definir a stack de implementação e a arquitetura interna da aplicação](issues/26-implementation-stack-and-application-architecture.md#answer)
e [desenho aprovado de testes/gates](module-public-interfaces.md#q11--interfaces-de-teste-e-exemplos-de-fluxo).
Esta seção trata da construção da **Factory**, não altera testes/gates que os Builders executam nos repos processados.
A matriz de aceite continua sendo a autoridade de cobertura; sucesso local não homologa fronteiras substituídas.

| Nível de teste | Composição e propriedade demonstrada |
| --- | --- |
| Regras | Funções determinísticas/tipos canônicos com dados e tempo controlados; não prova SQLite, processo ou serviço. |
| Fluxos | Controle real + Pi Durable/SQLite temporário + dublês das integrações/credenciais; testa transações/filas/limites/reconciliação lógica, sem outro motor ou fake como prova de persistência. |
| Protocolo/registros | Sockets Unix/filesystem temporários reais, fragmentação/falhas/segredos sintéticos; persistência nativa SDK ainda exige integração real. |
| Fronteiras/jornada | Componentes reais do perfil fixado, agentes/modelos e pilotos conforme o plano; não exige modelo em cada permutação nem equipara simulação a integração. |

Testes usam os mesmos contratos da aplicação, sem Controle/scheduler/domínio paralelo no dublê.
Calendário e monotônico são dependências distintas; não comparar origens entre processos nem trocar o relógio próprio de waits Pi Durable.
Usar controles suportados/decisões antes-depois de prazo e provar disparo real no nível pertinente, sem comando operacional de alterar relógio/estado.

Exemplos de fluxo com persistência real temporária:

1. Resposta correlacionada via `accept` confirma resposta/impedimento/histórico/fila sem spawn; repetir ingresso não duplica cobrança/posição.
   `run` só chama `Workers.activate` após revalidar fatos e reservar duravelmente. Reabrir storage mantém decisões com barreira fechada;
   processos sobreviventes/crash exigem ainda as provas reais correspondentes.
2. Tracker observa bloqueador próprio fechado/completed; CodeRepository ainda informa PR aberto, então Controle não libera dependente.
   Merge do ciclo correto pode liberar sob os demais requisitos; merge anterior não satisfaz novo ciclo. Adapters não se consultam entre si.

`npm test` significa **suíte local completa**, sem modelo, credenciais reais, GitHub remoto ou boot de VM.
Integrações/agentes/pilotos têm grupos/comandos separados, pré-requisitos e autorização próprios.

| Momento | Gate exigido |
| --- | --- |
| Edição/depuração | Testes focados e feedback incremental TypeScript/watch; subconjunto não se apresenta como aprovação da suíte inteira. |
| Antes de integrar | Arquitetura estática, compilação/typecheck e suíte local completa; evidência real pertinente à mudança também satisfeita, não bateria integral por commit intermediário. |
| Mudança de fronteira/risco | Grupos reais afetados, por exemplo persistência/recovery, SDK/sessão, protocolo, sandbox/Docker/TLS; seleção conservadora quando impacto incerto, não só por path/extensão. |
| Aceite/release | Cobertura integral rastreável no perfil correspondente, sem exigir execução monolítica a cada edição ou todos os casos com modelo. |

Compilar uma vez quando o mesmo `tsc` já verifica/emite; reaproveitar artefatos/resultados somente com entradas/contexto relevantes correspondentes.
Cache de build/verde histórico não prova estado externo atual. Ausente/reprovado/inconclusivo bloqueia a alegação/gate dependente;
não adiar automaticamente prova de fronteira alterada até release nem cortar requisito para caber no orçamento.
Documentar grupos/comandos por responsabilidade/risco; usar seleção/watch normais e paralelismo só sem dependência/disputa que invalide o teste.
Sem engine próprio de impacto/cache, daemon de testes, registry de combinações ou orquestrador de CI.

Medir duração por etapa/caminho crítico pela saída normal do tooling. Diretriz: feedback focado na ordem de segundos e gate local em dezenas de segundos,
a calibrar por baseline, não benchmark executado ou SLA. Crescimento exige localizar gargalo antes de framework/paralelismo indiscriminado/corte de cobertura.

#### Gate arquitetural estático

Etapa local antes das caras, sem iniciar runtime/banco/VM/modelo, usando analisador de dependências existente com resolução TypeScript
na mesma configuração/aliases. Escolher/fixar devdependency que satisfaça os casos; não escrever parser/engine próprio ou presumir ferramenta não examinada.
Configuração versionada deve expressar a matriz/entradas públicas da seção 2.4 e verificar:

- Toda fonte autoral classificada por zona; arquivo novo não classificado falha.
- Arestas/imports de tipos/reexports permitidos; ausência de ciclos inclusive de tipos e acesso externo só por entradas públicas.
- Deep imports/aliases/caminhos equivalentes sem bypass; SDKs só nos donos e I/O/relógio real fora das regras puras.
- Carregamentos/imports autorais estaticamente identificáveis; dependência calculada/opaca não ganha exceção automática.
  Não tratar carregamento interno de SDK/dependência vendorizada como fonte autoral.

Testes internos podem acessar seam do próprio módulo; testes de integração são composição, não exclusão geral dos testes da análise.
Fixtures inválidas ficam em escopo separado e precisam falhar pelo motivo esperado. Cobrir import público permitido, deep import,
inversão, ciclo de tipos, alias de bypass, SDK fora da zona e fonte não classificada. Exit zero sozinho não prova detecção de violações.
Erro informa arquivo/dependência/regra pelo analisador; nova aresta exige revisão da decisão/configuração/testes, não relaxamento para build verde.

O gate novo é **somente estático**, sem interceptador, monitoramento de chamadas/mensagens ou enforcement adicional em runtime.
Origem/papel/fase/Execução vigentes e rejeição de mensagem atrasada/administrativa de worker são testes funcionais locais do protocolo já previsto,
com estado preservado, não outra bateria arquitetural cara. Grafo de imports não substitui esses testes, isolamento/cessação reais
ou proteção contra host comprometido.

## 14. Obrigações de release e riscos remanescentes

Referências documentais iniciais, não combinações publicadas/homologadas:

- Pi coding-agent 1.5.0, snapshot `9c9ce8547e5a88cbe834a53e9a6d83a789d08e47`, manifesto Node >=22.19.0;
  Pi Durable pesquisado nesse snapshot. Não é faixa de autoatualização nem prova de compatibilidade.
- Gondolin 0.14.0, snapshot `6b381a9fd1c353e80cc9b4cf35474b6909703a16`.
- `gh` 2.98.0 e REST `2026-03-10` são referências do contrato de dependências, não evidência de serviço autenticado.

Cada release fixa artefato/integridade e dependências, Node exato, Pi/Durable/SDK, SQLite real/binding,
Gondolin/QEMU/helpers, kernel/initramfs/base Alpine/pacotes, manifesto/checksums/buildId de assets,
perfil/skills/ferramentas/protocolo/formatos/limites de canal e host kernel/systemd/configuração usados nas provas.
A construção fixa também TypeScript/npm, configuração ESM/typecheck, lockfile/dependências runtime e devdependency/configuração do checker arquitetural,
com testes positivos/negativos e correspondência entre grafo documentado e executável; não exigir esses instrumentos de desenvolvimento no host operador.
Preservar créditos/licenças aplicáveis; pesquisas distinguem MIT dos núcleos das condições de outras dependências/alternativas.
Números/hashes finais e capacidade medida pertencem à construção/validação, não devem ser inventados para encerrar planejamento.
Escolha de versão compatível não autoriza alterar backend/base/papéis/mecanismos silenciosamente.

Riscos aceitos/limites que a implementação deve tornar visíveis:

- Pi Durable experimental e integração SDK/FULL/scheduler ainda exigem demonstração; transcript não prova durabilidade.
- Visibilidade/completude remota e corridas GitHub não são snapshot atômico; omissão silenciosa pode exigir retorno ao produto.
- Alpine/musl, FUSE/Git/binds, TLS por camada, Docker `vfs`, capacidade e custo real podem inviabilizar piloto/perfil sem correção ou nova decisão.
- Host confiável/conta usada/administração e hardware/storage são premissas; isolamento não garante contenção hostil/DoS/exfiltração legitimamente concedida.
- Token copiado/perdido pode seguir válido até expirar; filtragem conhecida não cobre todos os arquivos, transformações ou cópias externas.
- Barreiras App/CI são do time; alteração insegura pode passar despercebida. Não reintroduzir certificação como gate indireto.
- Reparos prioritários podem alongar fila normal; sem timeout, Execução pode ocupar Slot indefinidamente. Observabilidade/cancelamento são controles previstos.
- Não entregues preservados consomem espaço; falta de recurso bloqueia preparo, não autoriza apagar trabalho.
- Backup externo não é certificado, não reverte GitHub nem apaga cópias anteriores; migração não promete rollback universal.

## 15. Condição de fechamento e handoff

Todos os pré-requisitos de desenho conhecidos estão resolvidos, incluindo stack/interfaces/composição e gates internos incorporados nesta spec.
O operador aprovou a composição completa; a resolução da consolidação registra a confirmação e as validações documentais,
com cobertura RF-01–14/RNF-01–05/CA-01–12, referências/dependências conferidas e ausência de névoa/decisão pendente identificada.
O destino documental foi alcançado e o mapa está encerrado; isso não afirma provas executadas nem autoriza construção/piloto.

O próximo esforço pode decompor construção e validar pelos gates do plano, mediante autorização própria.
Isso é handoff, não continuação automática desta cartografia nem tickets de implementação criados por esta spec.
Lacuna ou incompatibilidade de desenho descoberta posteriormente exige decisão explícita com impacto/rastreabilidade,
não preenchimento da spec por suposição ou mudança silenciosa das decisões aprovadas.


### Adendo aprovado — HTTPS privado de autenticação App (2026-11-05)

Proveniência: aprovação explícita do operador na continuação do ticket MVP 04,
registrada em `/tmp/software-factory-mvp-test-authorization.md` e na instrução
“NEW OPERATOR DESIGN APPROVAL” desta sessão (checkpoint inicial `d54b95f`).
Exceção estreita ao transporte gh: somente o controlador usa HTTPS nativo Node
para **GET /app**, **GET /app/installations/{configured-id}** e
**POST /app/installations/{configured-id}/access_tokens**. A instalação é a
configurada, não um parâmetro arbitrário fornecido pelo modelo. Endpoint fixo
`https://api.github.com:443`, TLS validado, REST `2026-03-10`, JWT Bearer somente
em memória. Sem redirects, proxy, descoberta de auth/ambiente, fallback ou
interface genérica de rede para agentes. Limites de 15s e 2 MiB, validação de
status/headers/completude/payload, erros sanitizados e distinção tipada de emissão
rejeitada conhecida versus resultado desconhecido; POST incerto nunca é repetido
automaticamente. Chave/JWT/token são protegidos e registrados para filtragem
antes do uso. **Todas as demais operações conservam gh api com installation
tokens reduzidos**, inclusive leituras dos adapters distintos Tracker e
CodeRepository. Não é substituição global de transporte nem serviço emissor
novo. Workflows permanece explicitamente proibido no ensaio autorizado.
Fixture da fronteira HTTPS não comprova GitHub real; evidência real e lacunas
ficam em `docs/evidence/04-github-app-access-diagnostics.md`.
