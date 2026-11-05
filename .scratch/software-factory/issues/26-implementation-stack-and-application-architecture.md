# Definir a stack de implementação e a arquitetura interna da aplicação

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: retomada HITL em `wayfinder/software-factory-spec`, na worktree
  `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-spec`;
  integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`;
  sessão Pi `01a1a902-6d66-75a8-bc33-e0684d870873`. Contexto histórico da reivindicação;
  resolução e handoff registrados abaixo, sem implementação ou provas.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 23, 24

## Question

Qual é a stack concreta de implementação e como organizar internamente a aplicação para construir os contratos já aprovados,
sem deixar decisões arquiteturais relevantes implícitas para a sessão que receber a spec?

A revisão humana do rascunho identificou que a stack principal e a arquitetura de execução estão explícitas,
mas linguagem/tooling e organização interna do código ainda permitem interpretações distintas.
Resolver com o operador, usando grilling, domain-modeling e codebase-design:

- Linguagem e conjunto mínimo de ferramentas de dependências, build, empacotamento, typecheck e testes.
  Node já foi escolhido; TypeScript é uma possibilidade, não decisão aprovada por inferência dos SDKs.
  Escolher bibliotecas/frameworks adicionais somente quando necessários ao desenho, sem inventariar cada dependência antecipadamente.
- Módulos principais, responsabilidades e interfaces pequenas, incluindo onde ficam regras de controle,
  persistência Pi Durable e integrações externas. Explicitar direção de dependências sem impor formalismo arquitetural por preferência.
- Composição da aplicação: onde configuração/perfil e implementações se conectam aos entrypoints e processos já aprovados
  de CLI, controlador, workers e adapter. Não introduzir serviços/processos ou mecanismos de controle novos implicitamente.
- Interfaces de teste: como exercitar regras e fluxos com tempo/respostas controlados e como conectá-los às integrações reais
  exigidas pelo plano de aceite, sem duplicar a autoridade de domínio ou confundir dublê com prova da composição real.
- Regras arquiteturais executáveis no quality gate da própria Factory, conforme requisito adicional do operador:
  matriz explícita de dependências/comunicações permitidas, interfaces públicas, detecção de violações e limites
  da análise estática versus contratos de comunicação em runtime, sem transformar o gate local em bateria cara.

A resolução deve definir escolhas e justificativas suficientes para uma seção enxuta de stack/organização interna na spec,
com interfaces, direção de dependências e exemplos de fluxo/teste quando ajudarem a eliminar ambiguidade.
Não precisa desenhar cada classe/arquivo, fixar versões/hashes reservados à release nem decompor tickets de implementação.

Preservar PRD, tecnologias, topologia, contratos de estado/protocolo/sandbox, permissões e limites já aprovados.
Se o encaixe revelar necessidade de alterá-los, explicitar o impacto e obter decisão própria, sem reabertura silenciosa.
Não implementar, instalar pacotes, executar modelos/provas ou declarar homologação.

## Comments

- 2026-11-04 — Decisão surgida na revisão humana do rascunho **Spec técnica — Software Factory MVP**,
  preservado na branch/worktree de consolidação indicada no Claim context; o operador confirmou a falta desses detalhes
  e o encaminhamento por ticket próprio antes de retomar
  [Consolidar a spec técnica implementável do MVP](25-consolidate-technical-spec.md).
  Isso não é aprovação de linguagem, tooling ou arquitetura interna.
- Retomada na sessão indicada no Claim context: lidos os contratos de durabilidade/runtime, a revisão cruzada,
  o plano de aceite e as seções pertinentes do rascunho; skills grilling, domain-modeling e codebase-design consultadas.
  Rodada HITL inicial proposta, **ainda sem aprovação**:
  - Q1 — TypeScript estrito/ESM sobre Node já escolhido; npm com lockfile e `npm ci`, `tsc` para typecheck/build,
    `node:test`/`node:assert` sobre JavaScript compilado, sem bundler/transpiler de execução/framework web ou de DI por padrão.
    Distribuição mantém a release autocontida já aprovada, sem exigir npm/TypeScript no host do operador;
    versões/integridades continuam obrigações de release. Dependências específicas necessárias, inclusive YAML,
    não são substituídas por parsers próprios nem consideradas proibidas por essa proposta mínima.
  - Q2 — Um pacote de aplicação com módulos internos por responsabilidade: controle (regras, orquestração e persistência
    Pi Durable encapsulada), GitHub, sandbox, workers/agentes, protocolo local e registros/evidências.
    Entrypoints conectam implementações/configuração; módulos não significam serviços/processos extras.
    Regras de controle não importam implementações concretas de GitHub/Gondolin/Pi SDK; workers e CLI não escrevem estado
    operacional. Interfaces somente onde há variação real ou contrato necessário, sem framework arquitetural,
    repositório CRUD genérico, modelo persistido paralelo ou segunda autoridade.
  Com essas escolhas confirmadas ou corrigidas pelo operador, detalhar interfaces, composição dos entrypoints e testes
  em rodada posterior. Não foi resolvida decisão nem alterada a spec nesta retomada.
- O operador aprovou explicitamente Q1 e Q2 com “de acordo com as recomendações”. Ficam confirmados a stack/tooling
  propostos e o pacote único com módulos por responsabilidade, nos limites acima. A confirmação não se estende
  às interfaces/composição/testes ainda por discutir nem resolve o ticket inteiro; a consolidação continua bloqueada.
- O operador solicitou “vamos detalhar a interface publica de cada modulo”. Preparado o asset
  [Interfaces públicas dos módulos — proposta](../module-public-interfaces.md), com operações, entradas/resultados,
  ordenação, falhas e projeções por processo/papel. Q3–Q8 cobrem Controle, GitHub, Sandbox, Workers/agentes,
  Protocolo local e Registros/evidências e **aguardam confirmação individual**; não foram aprovadas por Q1/Q2.
  O asset não é implementação, não altera a spec e não reabre os contratos anteriores por inferência.
  Composição final dos entrypoints e exemplos de fluxo/teste serão conferidos após essas interfaces.
- O operador orientou separar code repository e issue tracker para permitir futuros serviços. A diretriz refina Q2 e
  substitui o agrupamento inicial GitHub, sem aprovar as demais interfaces ou ampliar o suporte do MVP.
  O asset foi revisado: Q4A propõe `IssueTracker` para Tickets/dependências/comentários da issue e Q4B propõe
  `CodeRepository` para hospedagem remota/PR/checks/comentários do PR; Git local/workspace continuam no fluxo sandbox/Builder.
  GitHub é a única implementação inicial; adapters podem compartilhar infraestrutura privada do fornecedor, não decisões de controle.
  Nomes, operações e interface mínima do emissor de credenciais ainda exigem discussão; nenhuma autenticação universal ou plugin registry foi aprovado.
  A satisfação de dependências próprias pela entrega/merge continua no Controle, e cada Ticket segue vinculado a um único repositório.
- O operador confirmou a Q4 revisada com “de acordo”: `IssueTracker` trata Tickets/dependências/comentários da issue;
  `CodeRepository` trata hospedagem remota/PRs/checks/feedback e comentários do PR; Git local/checkout/workspace permanecem na sandbox/Builder.
  Fica aprovado esse recorte e sua nomenclatura, com apenas GitHub no MVP e sem registry/framework de fornecedores.
  Não foi inferida aprovação das operações detalhadas Q4A/Q4B, das demais interfaces Q3/Q5–Q8 ou do emissor de credenciais.
  Próxima rodada apresenta as operações dos dois módulos; mutações recebem explicitamente a correlação do efeito já persistido pelo Controle,
  sem transformar o identificador em autorização/idempotência externa ou impor esse caminho à publicação direta do Builder.
- O operador aprovou explicitamente as operações Q4A e Q4B com “de acordo”, após sua apresentação detalhada:
  sete operações de `IssueTracker`, nove de `CodeRepository`, contexto explícito de efeito nas mutações e distinção
  entre sucesso conhecido, falha conhecida e resultado indeterminado. As definições estão no asset de interfaces.
  A aprovação não cobre Q3/Q5–Q8, a interface do emissor de credenciais ou a composição/testes ainda por discutir;
  não autoriza implementação/provas nem encerra este ticket ou a consolidação. Retomar as interfaces restantes na próxima rodada.
- O operador aprovou Q3 e Q5–Q8 com “de acordo”: operações públicas de Controle, Sandbox, Workers/agentes,
  Protocolo local e Registros/evidências, nos contratos apresentados. Todas as interfaces de aplicação propostas até aqui estão aprovadas,
  incluindo a separação tracker/code repository; o asset passa a distinguir essas aprovações da composição ainda pendente.
  Restam composição/direção de dependências, interface mínima de credenciais e exemplos de fluxo/teste.
  A confirmação não autoriza preencher esses pontos por inferência nem encerrar o ticket/consolidação ou implementar a fábrica.
- Preparadas Q9–Q11 no [asset de interfaces e composição](../module-public-interfaces.md), **ainda pendentes**:
  Q9 propõe bootstrap explícito/direção de dependências e release, preservando os quatro entrypoints/processos já aprovados;
  Q10 propõe a projeção estreita `BuilderCredentials.issue/revoke`, com emissor GitHub App privado e entrega transitória;
  Q11 propõe regras/fluxos com tempo e respostas controlados, Pi Durable/SQLite real temporário, fronteiras reais nos níveis fiéis
  e suíte local padrão sem efeitos externos. Incluídos exemplos de resposta/retomada e dependência própria/merge.
  O encaixe de supervisão host compartilha código privado, não cria novo serviço/supervisor ou transfere autoridade de Controle.
  Nenhuma dessas propostas foi considerada aprovada pela confirmação das interfaces Q3–Q8.
- O operador confirmou Q9–Q11 com “tudo de acordo com as recomendações”, aprovando composição/direção de dependências,
  projeção de credenciais e desenho dos testes. Na mesma mensagem, levantou o risco de o quality gate completo levar vários minutos
  e reduzir a velocidade de desenvolvimento, pedindo uma proposta de tratamento. A aprovação dos pontos anteriores permanece;
  a política de cadência/custo dos gates fica aberta nesta decisão, sem encerrar ticket ou consolidação.
- Q12 foi proposta no asset, **ainda sem aprovação**: feedback focado durante edição, gate local completo antes de integrar,
  integrações reais selecionadas por risco e cobertura integral de aceite/release sem execução monolítica a cada edição.
  Reaproveitar build/evidência apenas sob entradas/contexto correspondentes, medir duração por etapa e calibrar orçamento após baseline;
  sem engine próprio de seleção/cache nem redução dos requisitos. Distinguir desenvolvimento da fábrica de gates dos repos processados;
  o alcance da preocupação deve ser confirmado. Agrupar correções antes de nova revisão não dispensa pareceres atuais/checks obrigatórios.
- O operador esclareceu: “não estava falando de testes que os builders executam” e “estava falando dos testes da própria factory,
  do desenvolvimento da própria factory”. O alcance fica confirmado exclusivamente para desenvolvimento/integração/release da Factory.
  Retirada do asset a hipótese de aplicar esta discussão ao fluxo dos Builders; não há alteração de seus contratos.
  Q12 continua proposta, com feedback focado em segundos/gate local em dezenas de segundos como diretriz a calibrar por baseline,
  não evidência de desempenho ou SLA. As aprovações Q1–Q11 permanecem válidas.
- O operador aprovou Q12 com “sim podemos”, confirmando cadências e acompanhamento do custo do gate da própria Factory.
  Acrescentou requisito: desenhar exatamente as dependências/comunicações permitidas entre módulos e detectar violações no quality gate.
  Esse requisito é confirmado, mas a matriz de arestas, o encaixe dos contratos compartilhados e as regras/ferramentas concretas
  de verificação ainda precisam de proposta/validação; não foram inferidos da aprovação de Q12. Ticket e consolidação permanecem abertos.
- Q13/Q14 propostas no asset, **ainda sem aprovação**: matriz positiva de dependências, entradas públicas e proibição de ciclos
  inclusive de tipos; base neutra mínima `contracts` e zonas técnicas privadas GitHub/host, sem novos serviços.
  Refinamento explícito de Q9 para evitar ciclos de contratos e impedir imports concretos de integrações pelo Controle.
  Gate estático com resolução TypeScript, aliases/deep imports/SDKs e fixtures de violações, mais testes locais de contrato
  para comunicação em runtime. Não foi escolhida/examinada ferramenta específica nem afirmado tempo de execução;
  a implementação deverá usar analisador existente que satisfaça os casos, sem parser/engine próprio.
- O operador está “de acordo com tudo por enquanto”, exceto a parte de comunicação em runtime, e pediu exemplos/justificativa.
  Registrar acordo provisório com Q13 e enforcement estático Q14, não aprovação do trecho excluído nem resolução do ticket.
  O esclarecimento distingue imports permitidos de mensagens concretas com origem/fase/Execução indevidas, exemplos já cobertos por
  [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md#transporte-identidades-e-versão).
  Proposta em esclarecimento: manter a nova etapa arquitetural estática e tratar esses casos como testes funcionais do protocolo já previstos,
  sem acrescentar monitoramento de chamadas, framework/gate de runtime ou bateria cara. A delimitação ainda não foi confirmada pelo operador.
- Após a explicação dos casos de origem/Execução indevidas, o operador confirmou com “de acordo” a separação final:
  gate arquitetural novo somente estático; validade de mensagens nos testes funcionais locais do protocolo já previstos,
  sem camada adicional de enforcement em runtime. A ressalva de Q14 fica resolvida e o acordo de Q13/Q14 torna-se final.
  Q1–Q14 estão aprovadas; somente esta decisão não-research é encerrada nesta sessão.

## Answer

### Decisão e asset aprovado

Adotar [Interfaces públicas e composição — Software Factory MVP](../module-public-interfaces.md) como desenho aprovado
para a stack, organização interna, contratos públicos, composição, credenciais e gates de desenvolvimento da própria Factory.
O asset contém as operações, entradas/resultados, invariantes de uso, matriz de arestas e critérios de verificação;
a resolução e a rastreabilidade das confirmações vivem neste ticket. Ele complementa os contratos anteriores, não os substitui silenciosamente.

### Escolhas e justificativas

- **Stack mínima:** TypeScript estrito/ESM sobre Node, npm com lockfile/`npm ci`, `tsc` e `node:test`/`node:assert` sobre código compilado.
  Sem bundler, framework web/DI ou transpiler de execução por padrão. Release autocontida inclui runtime/dependências/assets;
  não exige compilação TypeScript ou instalação npm por Trabalho. Bibliotecas necessárias não são reimplementadas para reduzir contagem de dependências.
- **Sete módulos de aplicação:** Controle, IssueTracker, CodeRepository, Sandbox, Workers/agentes, Protocolo local e Registros/evidências.
  Tracker e hospedagem remota são contratos separados, com apenas GitHub implementado no MVP; Git local/workspace ficam no fluxo Builder/sandbox.
  Essa separação permite evolução independente sem plugin registry, novos serviços ou adoção antecipada de outros fornecedores.
- **Composição explícita:** factories nos entrypoints e dependências injetadas, sem service locator.
  Pi Durable/SQLite ficam privados ao Controle, Pi coding-agent a Workers e Gondolin a Sandbox; nenhum segundo modelo persistido ou motor.
  `contracts` guarda somente identidades/contratos neutros realmente compartilhados para evitar ciclos de tipos;
  zonas privadas GitHub/host compartilham infraestrutura, não regras ou autoridade.
- **Credenciais:** projeção estreita `BuilderCredentials.issue/revoke`; emissor GitHub App e chave somente no controlador.
  Material de entrega transitório não entra em resultados duráveis, logs, recibos ou sessões. Renovação é nova emissão autorizada;
  o risco de valor perdido após crash e as fronteiras de ambiente/cessação permanecem os do contrato da App.
- **Testes fiéis:** regras determinísticas; fluxos com Controle/Pi Durable/SQLite reais temporários e dublês das integrações;
  sockets/arquivos locais reais e fronteiras/agentes/pilotos conforme a matriz de aceite. Exemplos no asset exercitam resposta/retomada
  e dependência própria/merge sem acoplar tracker a hospedagem de código.
- **Feedback sem pedágio integral por edição:** testes focados/watch durante edição, suíte local completa e evidência relevante antes de integrar,
  integrações por risco e cobertura integral de aceite/release. `npm test` continua local, sem modelos, credenciais reais, GitHub remoto ou VM.
  Compilar uma vez, evitar repetição sem nova evidência e acompanhar duração por etapa; segundos/dezenas de segundos são diretrizes a calibrar,
  não duração medida ou SLA. Não cortar requisito ou omitir prova relevante para cumprir orçamento.
- **Arquitetura verificável:** matriz positiva de dependências, entradas públicas, proibição de ciclos inclusive de tipos,
  deep imports/aliases/SDKs fora de seus donos e classificação obrigatória de fontes. Nova etapa estática local usa analisador existente,
  configuração versionada e fixtures positivas/negativas; sem parser/engine próprios ou bateria end-to-end para conferir imports.

### Delimitação final de runtime

O gate arquitetural novo verifica estrutura, não intercepta ou monitora comunicação em runtime.
Origem/papel/fase/Execução vigente e mensagens atrasadas são propriedades funcionais do protocolo já aprovado;
seus testes permanecem na suíte local existente, sem novo framework/gate ou necessidade de VM/modelo em cada caso.
O grafo de imports não oferece por si essa garantia nem substitui provas reais de isolamento, autoridade ou cessação.

### Limites e encaminhamento

Não resta pergunta de desenho identificada nesta decisão. Versões/hashes de release e seleção da devdependency que satisfaça os casos
estáticos são detalhes de implementação/validação futura, não permissões para relaxar os contratos ou alegar capacidade não examinada.
Nenhum código, checker, modelo, instalação, benchmark ou prova foi executado; não há homologação ou autorização de construção.

[Consolidar a spec técnica implementável do MVP](25-consolidate-technical-spec.md) fica sem bloqueadores de desenho conhecidos,
mas continua reivindicada e não resolvida: incorporar este Answer/asset, conferir a composição/cobertura RF/RNF/CA e submeter a spec completa
novamente ao operador em sessão posterior. O rascunho preexistente permanece na branch/worktree da consolidação, sem incorporação silenciosa.
Nenhum novo ticket ou névoa em escopo foi identificado; lacuna futura deve voltar ao mapa. O mapa permanece aberto.
