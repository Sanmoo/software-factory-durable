# Runtimes de agentes para o MVP da Software Factory — investigação documental

## 1. Pergunta, autoridade e resultado

**Consulta:** 2026-11-03 UTC. **Natureza:** pesquisa de documentação e leitura estática de fontes primárias públicas; não é benchmark, prova de recuperação nem escolha arquitetural.

- Autoridade de requisitos: [PRD 0.0.1](../prd.md), em especial RF-05–07, RF-10, RF-12–13, RNF-01, RNF-03 e RNF-05; RF-03–04 e RNF-02 delimitam slots, escritores e isolamento.
- Demanda: [Investigar runtimes de agentes contra o contrato do PRD](../issues/03-agent-runtime-research.md), no [mapa Wayfinder](../map.md). O supervisor mantém o claim e resolve o ticket; este relatório não altera mapa ou tickets.
- Integração de destino registrada pelo mapa: `main`, checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`. Esta pesquisa **não é integrada**: continua na branch `research/software-factory-agent-runtimes`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/sf-research-agent-runtimes`, base `767a391433620cfae21ba2901905a9c434bb5045`.

### Síntese factual

1. **Pi SDK/coding-agent e Pi Durable não são o mesmo contrato de persistência.** O primeiro oferece um coding agent embutível, recursos/skills, sessões JSONL v3 e RPC. Durable é um harness de conversas e tarefas com commits atômicos, políticas de replay e storage próprio, explicitamente experimental. Não há nesta evidência um importador que torne as duas sessões ou APIs de extensão intercambiáveis. [P1][P2][P5][D1]
2. **Mastra não é apenas memória de chat:** há workflows com `suspend/resume`, `.parallel()`, snapshots e um `askUserTool` nativo. Durable agents acrescentam recuperação e ownership, mas a recuperação automática está desligada por padrão, o replay pode repetir ferramentas/subagentes e o cancelamento é cooperativo. A API durable é beta. [M2][M3][M4][M5][M6][M7]
3. **LangGraph é runtime/orquestração em grafo, não coding agent pronto.** Checkpointers persistentes e `interrupt/Command(resume=...)` permitem pausa e retomada; no recorte Python consultado, `durability="sync"` aguarda checkpoints antes de avançar. O nó interrompido reinicia do começo e efeitos externos precisam de idempotência/reconciliação. [L1][L2][L3]
4. **Eve é framework/harness de agentes com Workflow SDK por baixo**, não um nome genérico para um motor neutro que controla Pi. Há caminho self-hosted Node + world local e sandbox Docker; não há Vercel obrigatório para a base. Porém, no world local/Postgres, mudar a versão de Eve torna sessões anteriores irretomáveis pelo novo runtime; preservação de conversa e substituição precisam ser tratadas. [E1][E2][E3][E4]
5. **Nenhuma fonte comprova o MVP completo.** Slot, FIFO/reparos, autorização GitHub, um único escritor por worktree, cancelamento de todos os processos/containers e descoberta de efeitos após crash continuam contratos da fábrica. Um checkpoint ou um prompt de “somente leitura” não implementa essas garantias. Esta conclusão é uma análise de cobertura contra o PRD, não afirmação de impossibilidade dos candidatos.

## 2. Método, identidade e versões

A skill `research` foi lida e aplicada nesta sessão já delegada, sem subdelegação: investigar fontes primárias e registrar achados em um Markdown. Sem ferramenta web na allowlist, o supervisor autorizou HTTPS público somente leitura via `urllib`/`curl` (o `web_enable` do pai não estende a allowlist desta sessão). Foram lidos metadados GitHub, árvores e arquivos raw; nenhum código obtido foi executado. Não houve instalações, modelos, agentes, serviços, provas, credenciais reais ou mudanças de configuração/host.

As versões abaixo são **as declaradas nos manifests dos SHAs consultados**, não a promessa de que sejam o último release estável publicado no npm/PyPI. As documentações vinculadas por SHA são o recorte reprodutível da pesquisa; não atribuo capacidades de `main` a versões antigas instaladas.

| Identidade canônica e camada | Snapshot consultado / data do commit UTC | Versão e requisitos documentados |
| --- | --- | --- |
| Pi: `earendil-works/pi`; SDK `pi-coding-agent`, loop `pi-agent-core`, acesso a modelos `pi-ai` | `9c9ce8547e5a88cbe834a53e9a6d83a789d08e47`, 2026-11-02 23:53:07 | Pacotes `@earendil-works/*` em **1.5.0**, Node `>=22.19.0`. A consulta ao antigo `badlogic/pi-mono` retornou o mesmo SHA; não são dois candidatos independentes. [P0][P8][S1] |
| Pi Durable: `packages/durable` no mesmo monorepo | Mesmo SHA de Pi | `@earendil-works/pi-durable` **1.5.0**, Node `>=22.19.0`; **experimental**, API pode mudar sem aviso entre releases. [D0][D1] |
| Mastra: `mastra-ai/mastra`; framework TS, agentes e workflows | `cf6711962037b4900ebc479a1f1c805252c4248d`, 2026-11-03 01:02:08 | `@mastra/core` **1.82.0-alpha.1**, Node `>=22.13.0`; durable agents documentados desde 1.45.0, ainda beta. [M0][M4][S2] |
| LangGraph: `langchain-ai/langgraph`; runtime em grafo, recorte **Python** | `3c916d750575b22c464790e9774494d810ccd322`, 2026-11-03 01:03:26 | `langgraph` **1.2.19**, Python `>=3.10`; checkpointer SQLite/Postgres são pacotes separados. Não extrapolar esse número para LangGraph JS. [L0][L1][S3] |
| Documentação LangChain/LangGraph | `langchain-ai/docs` em `825cfcff35ee56a2e30b5c8006210b7763c14af8`, 2026-11-03 00:35:40 | Fonte Markdown oficial; páginas condicionam trechos por Python/JS. Documentação e biblioteca não compartilham número de versão. [S4][L1] |
| Eve identificado como **`eve.dev` / `vercel/eve`**, não homônimos | `55193f2fc3ffc1ffe550202893c6b9614c579a42`, 2026-11-02 23:02:00 | Pacote `eve` **1.0.0-rc.2**, Node `>=24`; manifesto raiz `eve-monorepo` 0.0.0 não é a versão do runtime. [E0][E1][S5] |

**Rastreabilidade:** metadados de commits [S1]–[S5] explicam SHAs/datas; fontes abaixo apontam para conteúdo imutável. Endpoints de metadados com `/main` são apenas o registro de descoberta, não evidência congelada de funcionalidades.

**Limite de descoberta:** a URL oficial `.../langgraph/durable-execution.md` resolveu, nesta consulta, para a página *Persistence*. Por isso as afirmações sobre durabilidade vêm de `checkpointers.mdx`, `interrupts.mdx` e `graph-api.mdx` no snapshot dos docs, não de um título antigo tomado como documento vigente. [L1][L2][L3]

### Histórico local: o que foi e não foi reaproveitado

A [pesquisa anterior de Pi Durable](https://github.com/Sanmoo/pkm/blob/0cb8c80ad7b708f31a9fc905f58a62d7a1a0299b/.scratch/agent-orchestration/issues/12-pi-durable-compatibility.md) identificava a fonte canônica, versão 1.1.0 e snapshot de outubro. A [comparação anterior de opções](https://github.com/Sanmoo/pkm/blob/0cb8c80ad7b708f31a9fc905f58a62d7a1a0299b/.scratch/agentic-factory-options/research/comparison.md) ajudou a localizar Eve e Mastra. **São pistas de navegação, não fontes primárias de capacidade nem autoridade de produto.** Os SHAs atuais foram obtidos novamente e o conteúdo relevante foi relido. Preferências antigas por self-host integral, preservar Pi ou shortlist de produtos não foram importadas. Restate com executor simulado e testes Docker de outros esforços não comprovam estes runtimes; nenhum resultado experimental foi usado como requisito ou como teste aprovado deste PRD.

## 3. Achados por candidato

### 3.1 Pi SDK / coding-agent

**Fronteira real.** `createAgentSession()` embute uma sessão de agente no processo Node/Bun; `cwd`, `resourceLoader`, ferramentas, modelo, settings e armazenamento podem ser fornecidos explicitamente. Sem overrides, a fábrica do SDK descobre recursos, configurações e credenciais locais — comportamento inadequado para assumir automaticamente o perfil isolado da fábrica. RPC é alternativa de subprocesso independente de linguagem, não um serviço de workflow persistente. [P1][P5]

**Perguntar e parar.** Extensões registram ferramentas e interceptam chamadas; `abort()` espera a sessão ficar idle e `dispose()` aborta trabalho ativo. Isso fornece pontos de integração para `ask user`, mas uma UI/dialog ou uma Promise aguardando resposta não prova RF-10. A fábrica precisaria persistir a pergunta e seu resultado de publicação, encerrar/devolver a ativação do builder e reabrir a sessão ou iniciar outra com contexto depois da resposta autorizada. Não encontrei nas fontes consultadas uma fila remota durável de perguntas GitHub já pronta. [P1][P4][P5]

**Sessões e substituição.** `SessionManager` é autoridade do contexto finalizado; mudar apenas `agent.state.messages` não substitui o contexto persistido. O SDK expõe runtime para abrir/trocar/forkar/importar JSONL, e assinaturas de eventos devem ser religadas após troca. O formato é árvore JSONL com `id/parentId`, versão corrente v3 e migração de v1/v2; suporta conversa/compaction, não checkpoint transacional de Git, subprocessos e operações GitHub. Preservar `cwd` importa na retomada. [P1][P2][P3]

**Revisores, modelos e skills.** É possível construir sessões independentes e fornecer conjuntos distintos de ferramentas/modelos. O carregador aceita recursos controlados pelo host. Pi implementa Agent Skills e `/skill:nome` força a inclusão das instruções, mas a descoberta automática pode não carregar uma skill relevante. Versionar `implement`, `code-review` e `/pr` e executar os gates/reviews obrigatórios não decorre de anunciar essas skills no prompt. O mecanismo real de ferramentas deve retirar escrita e shell irrestrito dos revisores, além da fronteira de filesystem decidida em RNF-02. [P1][P4][P6][P7]

**Cancelamento e observabilidade.** O backend local de shell consultado chama `killProcessTree` em abort/timeout e acompanha PID de filho detached; há interface substituível `BashOperations`. Isso é evidência mais forte que “o agente recebeu instrução de parar”, mas não prova matar containers Docker, processos desassociados ou uma operação remota já enviada. Sessões expõem uso/custo via `/session`; JSON/RPC expõem eventos, e **JSON mode pode sair com código zero apesar de resposta do assistente falha/abortada**: o consumidor precisa interpretar os eventos. [P3][P5][P9]

**Adaptação mínima identificada:** host/adaptador com perfil explícito e versionado, `ask user` persistente, supervisão do processo, correlação de eventos, revisão paralela obrigatória, recuperação por contexto e estado do Trabalho fora do transcript. Isso é estimativa qualitativa de integração, não desenho aprovado.

### 3.2 Pi Durable

**O que adiciona.** Harness sobre `pi-ai` e Chord, com conversas, entradas imutáveis, documentos JSON e tarefas duráveis. Commit pode gravar entradas, documentos e criação de tarefas atomicamente; `requestId` deduplica submissões internas. Reabrir storage e `resume()` retomam tarefas. MemoryStorage não persiste; há SQLite, JSONL, IndexedDB e Cloudflare DO. [D1]

**Limites concretos do storage.** SQLite padrão usa WAL e `synchronous=NORMAL`: documenta sobreviver a crash de processo, mas não garante últimos commits em falta de energia/host. JSONL admite `fsync:true`, mantém histórico em memória e tem custo crescente. **Um processo por storage, sem locking entre processos**: a fábrica não pode tratar o SQLite interno como fencing dos builders na worktree. [D1]

**Replay não é exactly-once.** A intenção de tool call é persistida antes de `execute`. Interrupção por crash só reexecuta ferramenta declarada `replay:"safe"`; as outras retornam erro `interrupted` com saída persistida. Mesmo safe precisa deduplicar efeitos externos. Resultado estruturado para programas não é, por si só, um arquivo/Git checkpoint; o transcript guarda os canais indicados pela API. Repetir criação de PR ou publicação de pergunta exige descoberta/deduplicação na integração GitHub. [D1]

**Espera e retomada.** Tarefa em `waiting` não executa código; `sleepUntil()` salva checkpoint e termina a fase, e o host pode receber `onWake`. Isso comprova uma primitiva de espera durável, **não uma ferramenta GitHub `ask user` pronta** nem liberação automática de Slot. Uma integração pode representar a pergunta no estado persistido e terminar o run (`control.terminate`) ou construir tarefas de espera e posterior submissão. A forma concreta, o fechamento do processo builder e o contrato de autorização permanecem decisões abertas. Um `wait()` em memória não substitui esse protocolo. [D1]

**Subagentes e cancelamento.** Exemplos oficiais mostram conversa filha task-owned, deduplicação por owner e submissão, escolha de modelo por conversa e ferramentas selecionadas. Abortar o owner alcança o trabalho owned; background é fronteira: não mantém o pai busy e sobrevive ao abort padrão, requerendo abort com `{background:true}` quando aplicável. O ambiente recebe contexto cancelável e `cleanup`, mas implementação de filesystem/exec e contenção não são impostas por instrução. Em particular, `modelTools:[read]` pode ocultar bash do modelo sem impedir que outra ferramenta chame bash; para revisor read-only, importa o conjunto executável e o ambiente, não só o conjunto anunciado. [D1]

**Compatibilidade e uso.** Modelos/ferramentas/extensões são guardados por nomes; registry e settings são do host e não ficam congelados no storage. Após restart é preciso reinstalar definições; definições ausentes/incompatíveis podem bloquear tarefas. Reset/handoff/compaction preservam entradas antigas, e `pi.usage` agrega por provider/model e ferramenta, incluindo tentativas falhas/abortadas. Não encontrei garantia de conversão automática das sessões JSONL v3 do coding-agent, carregamento nativo das mesmas skills ou equivalência das APIs de extensão. São superfícies diferentes, embora compartilhem monorepo e acesso a modelos. [D1][P1][P2][P6]

**Adaptação mínima identificada:** extensão/ferramenta de pergunta, bridge de skills/instruções versionadas, host com registry/configuração reproduzíveis, supervisão exclusiva do storage e dos escritores externos, gateway de eventos e reconciliação de efeitos. A durabilidade interna pode reduzir código de retomada de conversas/tarefas, sem absorver automaticamente o controlador da fábrica.

### 3.3 Mastra

**Camadas distintas.** Agentes definem instruções, modelo e ferramentas; `createTool` valida schemas e recebe contexto com `abortSignal`. Workflows encadeiam etapas e `.parallel()` executa ramos concorrentes e reúne resultados. Durable agents envolvem o loop do agente em workflow e PubSub, com variantes in-process, evented e Inngest; a documentação não exige Inngest para a variante in-process. [M1][M4][M5][M8]

**Pergunta nativa e suspensão.** `askUserTool` usa `suspend()` do runtime, emite `tool-call-suspended` e permite `agent.resumeStream(answer,{runId})`; fora de execução de agente, retorna string de fallback com a pergunta, não uma pausa durável. Workflows têm `suspendData`, schemas de resposta e `createRun({runId}).resume()`. Snapshot salva estados/resultados de etapas no storage configurado, inclusive para processos/deployments posteriores. Isso é uma primitiva mais pronta de HITL do que apenas uma ferramenta customizada que espera Promise, mas ainda não publica perguntas em issue/PR nem autentica `/factory answer`. [M2][M3][M7]

**Recuperação: cuidado com defaults.** Durable agent é beta. Para a variante in-process, `recovery.durableAgents:'off'` é padrão: grava pending/paused/suspended, mas não os checkpoints running de cada etapa, salvo fronteiras alcançadas durante shutdown. `'auto'` habilita os running checkpoints e recuperação no boot; policy customizada pode modificar isso. Cache de eventos in-memory não sobrevive restart e replay de stream não é arquivo de auditoria permanente (cleanup padrão após o fim é 30 segundos). Storage de run, memória, replay cache e PubSub são responsabilidades distintas; não exigir Redis apenas para justificar durabilidade se replay de chunks não for necessário. [M4]

**Ownership tem escopo.** A documentação atual descreve claims renovados a cada 5 s, TTL padrão de 15 s e fencing de writes em adapters compatíveis, incluindo libSQL/Turso/Postgres. Sem suporte no store, usa lease PubSub com garantias diferentes; o padrão EventEmitter só cobre um processo. Mesmo com fencing de estado, recuperar pode iniciar a mesma tool antes da invocação velha detectar perda de ownership. O texto manda tornar ferramentas idempotentes/deduplicar efeitos e explica que subdelegação repetida pode repetir todo o subagente. **Isso não é fencing de worktree/processo/Docker.** [M4]

**Cancelamento não é término.** `Run.cancel()` sinaliza abort, evita etapas seguintes e tenta atualizar status; a Promise não espera etapas ativas pararem. Código que não observa `abortSignal` pode terminar e produzir efeitos. O cancelamento de workflows aninhados, inclusive suspensos, é documentado nos engines default/evented, mas isso não certifica subprocessos arbitrários do builder. [M6][M8]

**Skills, modelos, uso e contexto.** Há skills diretamente no agente (inline com `createSkill`, paths com `SKILL.md` ou resolução dinâmica), sem Workspace obrigatório; Workspace também permite descoberta compartilhada de diretórios de skills. Ferramentas e modelos são configuráveis por agente. Métricas automáticas vêm de spans concluídos; tokens dependem do provider e custo pode vir de custo reportado ou registry de preços. Snapshot/memória são formatos próprios de Mastra, não contrato de import/export de sessão Pi ou LangGraph; compatibilidade de upgrades do perfil completo da fábrica não foi comprovada. Os dois agentes revisores podem ser etapas paralelas com ferramentas distintas, mas o produto ainda deve impor snapshot revisado, read-only, falha explícita e invalidação após mudanças. [M1][M3][M5][M8][M9][M10]

**Adaptação mínima identificada:** storage persistente e policy de recuperação escolhidos conscientemente, `askUserTool` ligado a perguntas/autorização remotas, binding Trabalho↔run/thread, ferramentas de código/Git/validação, bridge das skills, supervisão externa e agregação dos revisores. Mais funcionalidades internas não eliminam o custo de configurar corretamente persistência, ownership e eventos.

### 3.4 LangGraph (Python)

**Camada.** Grafo de estado com nós/arestas, execução paralela, subgrafos, checkpoints e políticas de retry/timeout. Um coding builder com shell/Git/skills é código integrado ao grafo ou outro harness chamado por um nó; a biblioteca não entrega por si o ciclo issue→PR do PRD. LangChain pode fornecer modelos/ferramentas, mas é camada distinta. [L0][L1][L3][L4]

**Pausa sem chamada ativa.** `interrupt(payload JSON)` suspende execução, devolve payload ao chamador e grava estado através do checkpointer; nova invocação com mesmo `thread_id` e `Command(resume=...)` responde. A documentação mostra inclusive interrupção dentro de ferramenta. Isso permite encerrar a invocação e só executar novamente após resposta, sem um builder aguardando stdin; **a decisão de liberar Slot, finalizar processo/container e recolocar na fila é externa**. `InMemorySaver` não sobrevive restart; SQLite/Postgres são opções persistentes separadas, e os docs posicionam SQLite para experimentação/workflows locais e Postgres para produção. Isso não torna Postgres requisito do PRD. [L1][L2]

**Replay e fronteiras.** O nó que chamou interrupt reinicia desde o início; chamadas anteriores ao interrupt precisam ser idempotentes. Ordem de interrupts/tasks importa; não capturar indiscriminadamente a exceção especial de interrupt. Checkpoints são por super-step, com pending writes dos nós concluídos para não refazê-los quando outro nó da mesma etapa falha. Python `sync` persiste antes de avançar; `async` admite janela de perda em crash, `exit` não recupera progresso intermediário. **O trecho JS atual descreve semântica diferente de `sync`**, portanto esta conclusão de barreira síncrona é restrita a Python, não promessa multi-SDK. Nenhum modo transforma commit Git/push/PR em transação com o checkpointer. [L1][L2][L3]

**Paralelismo e restrições.** Fan-out/fan-in pode representar Standards e Spec; `max_concurrency` é limite de tarefas da chamada, não slots persistentes de builders da fábrica. Nós e suas ferramentas são código da aplicação: retirar shell/escrita e usar filesystem read-only é integração, não propriedade do grafo. Timeouts por nó são suportados para async; execução Python síncrona não é seguramente cancelável in-process. Matar uma task não comprova recolher subprocessos/containers, nem desfazer pedidos remotos. [L4][L7]

**Compatibilidade e observação.** Há `get_state`, histórico, replay, serializers e stores. Docs de migração permitem adicionar/remover chaves, mas renomear perde estado; mudar tipos incompatíveis ou remover/renomear nó pendente pode quebrar retomada. Alteração tecnicamente carregável ainda pode mudar comportamento: perfil/versão semântica da fábrica precisa ser registrado. LangChain expõe callbacks de uso de modelos; skills podem ser progressive disclosure por ferramentas/prompts, não executor obrigatório de `implement`/`code-review`/`/pr`. Nenhum desses contratos é uma sessão universal portável para outro runtime. [L1][L3][L5][L6]

**Adaptação mínima identificada:** construir o coding harness ou adaptá-lo a nós, checkpointer persistente e schemas de estado, ferramentas/perfis de modelos por papel, perguntas remotas, versões/migrações, cancelamento de processos e toda a operação do Trabalho. Um nó que apenas mantém Pi vivo esperando resposta não herda automaticamente suspensão granular dentro do Pi.

### 3.5 Eve: enquadramento, não homologação de fábrica

**Identidade e composição.** É `vercel/eve`, framework/harness com ferramentas, canais, subagentes e sandbox; cada sessão executa como workflow no **Workflow SDK**. Nitro hospeda HTTP/entrypoints; o world guarda estado/filas e o sandbox executa shell/files. Logo, Eve não é sinônimo nem de seu world nem de seu backend de isolamento, e não há evidência de ser controlador neutro pronto para Pi. O template Foreman e produtos Mastra Factory não foram usados para atribuir capacidades à base. [E0][E1][E2]

**Operação local existe.** `eve start` usa por padrão world local em `.eve/.workflow-data`, um processo com disco persistente. Postgres/Graphile Worker é alternativa para réplicas; Vercel Workflow é outra. Self-host requer processo Node, auth de rotas e proxy dos dois prefixos de runtime/workflow; providers podem ser chamados diretamente por AI SDK, sem AI Gateway obrigatório. Sandbox Docker pode ser selecionada explicitamente; o build também a escolhe quando encontra Docker. [E2][E3][E4]

**HITL e tarefas.** `ask_question` é opt-in, usa `ctx.ask()` e pergunta ou approval emite `interaction.opened`/`turn.paused`, retomando por `interactionId`. A espera sobrevive restart, mas o contrato padrão pode interpretar follow-up/mensagem que combina com opção como resposta; não equivale ao comando remoto estritamente autorizado do PRD. Approval omitida é `never()` (sem aprovação exigida), `auto()` chama outro modelo e não é a autorização humana da fábrica. Declared subagents têm modelo/tools próprios e não herdam o perfil do root; o built-in `agent` cria cópia que compartilha sandbox e ferramentas. Para dois revisores read-only, a cópia padrão não é evidência de isolamento: precisa de especialistas/perfis/ambientes restritos e coordenação obrigatória. [E5][E6]

**Cancelamento e duração.** Cancelar pai alcança filhos, mas shutdown de filho é best effort, e filho remoto inacessível pode continuar. Ferramentas devem respeitar `ctx.abortSignal`; cancelamento e approval não garantem exactly-once. `sessionTimeoutMs` é **idle de sessão**, 30 dias por padrão e desabilitável; não expira durante turno aberto, inclusive esperando pessoa. Não deve ser confundido com tempo ativo de Execução do PRD. Contadores de reparos/retomadas e prazo ativo opcional da fábrica ainda precisam ser impostos externamente. [E5][E6][E7]

**Compatibilidade é a principal ressalva documental.** Rebuild na mesma versão retoma no world local/Postgres; mudança da versão Eve deixa sessão *stranded*. Conversa armazenada pode alimentar sessão substituta, mas não é a continuação do mesmo workflow. Vercel tem roteamento por deployment e handoff de sessões elegíveis, propriedade que não deve ser atribuída ao self-host local. Checkpoint batching aumenta a unidade reexecutável para vários ciclos modelo/tools. Atualizar pacote sem plano de preservação/substituição pode violar RNF-01. [E1][E3]

**Auditoria, skills e GitHub.** Há API HTTP de sessão e stream NDJSON reconectável por cursor, skills com `SKILL.md` e contadores `inputTokens/cacheReadTokens/cacheWriteTokens/outputTokens`; `costUsd` vem do AI Gateway, exclui ferramentas/infra e pode faltar. Retenção padrão pode pedir exclusão dos payloads ao encerrar sessões privadas/sem audiência conhecida: não satisfaz automaticamente 30 dias e preservação de trabalhos abertos do PRD. Canal GitHub documentado é App/webhooks e invocação por comentário, não polling/label de admissão do MVP; usá-lo exige adaptação ou canal próprio, não importar webhooks como requisito. [E7][E8][E9][E10]

**Adaptação mínima identificada:** protocolo de admissão/polling/perguntas autorizado, controle de Slot e limites do Trabalho, perfis read-only e contexto dos revisores, persistência/retention e plano de substituição em upgrade, supervisão e isolamento dos testes Docker. O Docker sandbox do próprio agente não comprova Docker de integração dentro do worker nem concorrência sem colisões.

## 4. Matriz por requisito

**Legenda:** **P** = primitiva documentada útil; **A** = adaptação/integração ainda necessária; **L** = limitação explícita. Nenhuma célula representa aceite ponta a ponta. “Não demonstrado” significa lacuna desta leitura, não prova de inexistência.

| Requisito / obrigação do PRD | Pi SDK | Pi Durable | Mastra | LangGraph Python | Eve |
| --- | --- | --- | --- | --- | --- |
| RF-05: ticket, referências e versão de escopo por Execução | **P/A** ResourceLoader/contexto; captura/versionamento do ticket externos. [P1] | **P/A** entradas/docs; registry/settings não congelados. [D1] | **P/A** inputs/snapshots; versão de escopo externa. [M3] | **P/A** state/checkpoints; captura autorizada externa. [L1][L3] | **P/A** instruções/state/história; snapshot da spec externo. [E1][E6] |
| RF-06: skills próprias versionadas, sem globais | **P/A** loader e `/skill`; fixar pacote/perfil. [P1][P6] | **A** bridge de skills; registry por nome não embute código. [D1] | **P/A** skills no agente ou Workspace; fixar conteúdo e integração. [M9] | **A** skills por tools/prompts; carregar/executar protocolo próprio. [L6] | **P/A** skills por diretório; fixar build/perfil. [E9] |
| RF-06: Standards e Spec paralelos, ambos obrigatórios | **P/A** duas sessões e agregador próprios. [P1] | **P/A** child tasks/conversas e política de agregação. [D1] | **P/A** `.parallel()` + agentes distintos. [M5][M8] | **P/A** fan-out/fan-in + nós/agentes próprios. [L4] | **P/A** declared subagents/tasks; impor duas conclusões. [E6] |
| RF-04/RNF-02: revisores sem escrita, todos os arquivos no review | **A** allowlist real + filesystem; capturar diff integral. [P1][P4] | **A** `tools`/ExecutionEnv; `modelTools` sozinho insuficiente. [D1] | **A** toolsets restritos/ambiente e snapshot revisado. [M8] | **A** restrição nos nós/tools e ambiente. [L3][L4] | **A/L** cópia root compartilha sandbox; especialistas/ambiente restritos. [E6] |
| RF-07: gates/testes/Docker e resultados verificáveis | **P/A** bash executa; registrar status/artefatos reais. [P9] | **P/A** ferramentas/ambiente; prova Docker externa. [D1] | **P/A** ferramentas programáveis; prova Docker externa. [M8] | **P/A** nós programáveis; prova Docker externa. [L3] | **P/A** Docker sandbox não comprova testes que criam containers. [E4] |
| RF-10: ferramenta `ask user` e payload | **P/A** ferramenta customizada; remote bridge. [P4] | **P/A** `defineTool`, docs/tasks; remote bridge. [D1] | **P** `askUserTool` + suspensão; **A** GitHub/CLI. [M7] | **P** `interrupt` inclusive em tool; **A** interface de pergunta. [L2] | **P** `ask_question`/`ctx.ask`; **A** interface autorizada. [E5] |
| RF-03/RF-10/CA-05: espera sem builder/processo/slot ativo | **A** persistir, finalizar ativação, reabrir com contexto. [P1][P2] | **P/A** waiting/sleep não executam fase; fechamento de builder/Slot externo. [D1] | **P/A** snapshot/suspend encerra caminho ativo; Slot/processo externos. [M2][M3] | **P/A** interrupt devolve ao host; Slot/processo externos. [L2] | **P/A** turno parked durável; Slot/processo externos. [E1][E5] |
| RF-10: publicar uma pergunta, correlacionar e autorizar resposta | **A** estado/publicação/operadores GitHub. | **P/A** requestId interno não deduplica comentário remoto. [D1] | **A** runId/resume não autentica comentário. [M7] | **A** thread_id/Command não autentica comentário. [L2] | **P/A** interactionId; regras de resposta padrão não equivalem à allowlist/comando. [E5] |
| RNF-01: retomar sessão ou substituí-la com contexto | **P/A** JSONL/SessionManager; recuperação de Trabalho externa. [P1][P2] | **P/A** reopen/resume/handoff; arquivos/Git externos. [D1] | **P/A** snapshots, recovery configurado; memória/cache separados. [M3][M4] | **P/A** checkpointer persistente/reinvocação; estado e efeitos externos. [L1][L2] | **P/L/A** mesma versão retoma; versão nova exige substituição fora Vercel. [E1][E3] |
| Exportação e compatibilidade de sessões | **P/L** JSONL v3 + import; não formato universal. [P1][P2] | **P/L** storage/entradas próprios, API experimental; conversão não demonstrada. [D1] | **P/L** snapshots/memória próprios; conversão entre runtimes não demonstrada. [M3][M4] | **P/L** estado/histórico/serializer; migração exige disciplina. [L1][L3] | **P/L** stream/história; stream exportado não torna workflow retomável em outra versão. [E1][E8] |
| RF-12/CA-07: cancelar builder e subprocessos | **P/A** abort + killProcessTree no backend consultado; reconciliar externos. [P1][P9] | **P/A** abort owned, background explícito e env cancelável; processos externos. [D1] | **P/L/A** cancel retorna sem aguardar fim; signal cooperativo. [M6] | **P/L/A** cancel async; sync não é seguramente cancelável in-process. [L7] | **P/L/A** cancel/delegação best effort; supervisor externo. [E5][E6] |
| RF-13/CA-11: limites, sem teto fixo, espera fora do relógio | **A** contadores/regras da fábrica; não confundir timeout de tool. [P9] | **P/A** retry/maxTurns/restartLimit internos não são tentativas do Trabalho. [D1] | **P/A** retries/recovery internos não são limite de reparos. [M3][M4] | **P/A** retry/timeout por nó não é prazo ativo do Trabalho. [L7] | **P/A** idle/usage limits não são relógio ativo/reparos. [E7] |
| RNF-03: logs/uso/custo incluindo revisores | **P/A** eventos/sessão; agregar/indicar indisponibilidade. [P3][P5] | **P/A** `pi.usage`, graph/watch; agregar Trabalho. [D1] | **P/A** spans/tokens/custo condicionais; retenção própria. [M4][M10] | **P/A** state/stream + callbacks LangChain; custos/retention próprios. [L1][L5] | **P/A** NDJSON/usage; custo condicional e retenção a configurar. [E7][E8] |
| RNF-05: modelo por papel, sem fallback silencioso | **P/A** modelo por sessão; fixar e validar seleção efetiva. [P1][P7] | **P/A** modelo por conversa; proibir herança/alteração não autorizada. [D1] | **P/A** modelo por agente; fixar provider/gateway/policy. [M1][M8] | **P/A** modelo por nó/agente; fixar wrappers/provider. [L5] | **P/A** modelo por especialista; evitar defaults/dinâmica não autorizados. [E6][E7] |
| RNF-01/CA-06: crash após push/PR/pergunta, sem efeito/escritor duplicado | **A** transcript não prova reconciliação. [P2] | **A/L** replay seguro exige integração; sem locking cross-process. [D1] | **P/A/L** claims/fencing do store, não dos efeitos; replay pode sobrepor tools. [M4] | **A/L** checkpoints não atomizam efeito remoto. [L1][L2] | **A/L** checkpoint e approval não dão exactly-once externo. [E1][E5] |

As células **A** sem fonte própria representam obrigações do [PRD](../prd.md) não demonstradas pelas capacidades documentadas, não APIs alegadamente existentes.

## 5. Integração comum que a seleção de runtime não resolve

Esta lista é **análise de lacunas contra o PRD**, não proposta de concentrar poderes no controlador. A fronteira controlador–builder continua aberta no mapa. Seja qual for o proprietário futuro de cada operação, sua garantia precisará ser verificável.

1. **Identidade e autorização:** mapear Ticket→Trabalho→Execução→sessão/run/thread, snapshot do pedido/referências e perfil efetivo (runtime, provider/modelo, instruções, skills, tools). Revalidar elegibilidade/dependências antes de retomar. Não carregar globais do operador por acidente. RF-01–05/RNF-05.
2. **Pergunta remota:** identidade estável, intenção persistida, publicação issue/PR reconciliável após crash, allowlist e resposta correlacionada, suficiente e não reaplicada; só então fila normal/reparo preservando ordem. Suspender também significa encerrar a ativação do builder, e não só bloquear uma tool. RF-03/RF-10/CA-05–06.
3. **Ownership e cancelamento:** reconciliar PIDs/ambientes antes de substituto, impedir dois escritores inclusive quando engine perde lease; bloquear novos efeitos após cancelamento, descobrir resultado de operação já enviada e preservar artefatos. Sinal cooperativo e fencing de banco não cercam filesystem/Git/Docker. RF-04/RF-12/RNF-01.
4. **Revisão efetiva:** duas execuções paralelas com objetivos distintos, spec disponível, sem escrita real na worktree; incluir arquivos tracked/untracked e mudanças não commitadas, guardar conclusão/falha/tratamento, invalidar se o conteúdo relevante mudar. Ferramenta omitida do prompt não é proibição se shell ou tool indireta permite escrita. RF-06/CA-12.
5. **Modelos e skills:** configuração independente por builder/Standards/Spec; registrar seleção resolvida e reportar falha em vez de trocar silenciosamente. Retry no mesmo modelo não é fallback entre modelos. Gateway/provider pode introduzir roteamento fora do runtime; a evidência consultada não audita todos esses backends. Skills versionadas e verificadas no perfil da fábrica, sem assumir que sua prosa executa os gates. RNF-05/RF-06.
6. **Operação do produto:** categorias/FIFO/slots persistentes, polling GitHub, reparos e retomadas com contadores separados, prazo ativo opcional que exclui esperas, CLI observável, retenção e cleanup conservador. Concurrency de tarefas/subagentes ou limite de tokens não é concorrência de builders. RF-03/RF-08–14/RNF-03–04.
7. **Isolamento e Docker:** perfil de filesystem/processo/rede/credenciais, recursos Docker por trabalho, proteção de branch-base/merge e testes simultâneos nos pilotos. Nenhuma sessão persistida nem sandbox com “Docker” no nome prova CA-08; backend e autoridade ainda serão decididos. RNF-02/RF-07.

## 6. Licença e custo operacional comparável

Não foi medido custo, latência, throughput ou quantidade de código. As comparações abaixo são inventário qualitativo de componentes documentados. Licença OSS não elimina consumo pago de modelos, disco, backup, manutenção ou operação; as licenças dos providers, ferramentas e backends adicionais precisam de revisão própria.

| Opção | Licença do recorte consultado | Componentes/ônus mínimos plausíveis, sem decisão de adoção |
| --- | --- | --- |
| Pi SDK | MIT no monorepo e manifests. [P0][P10] | Processo Node compatível, provider de modelos e arquivos de sessão/recursos; host controla persistência do Trabalho, supervisão, perguntas e revisores. Sem serviço de workflow obrigatório demonstrado no SDK. [P1][P5] |
| Pi Durable | MIT, API experimental. [D0][P10] | Harness + `pi-ai`/Chord, storage persistente local possível, host/registry/ExecutionEnv; um proprietário por storage, backup e proteção contra mudança de API. JSONL tem custo de memória proporcional ao histórico. [D1] |
| Mastra | Apache-2.0 fora de `ee/` e ressalvas de terceiros; `ee/` tem licença própria, não presumir licença Apache para tudo. [M0][M11] | Node, framework e storage persistente (local é possível); policy explícita de recovery e observabilidade. PubSub/cache persistente só se necessários aos contratos escolhidos. Inngest/Temporal são opções de runners e adicionam dependências; Temporal está experimental na documentação, não é pré-requisito. [M4][M12] |
| LangGraph Python | MIT; licença do SDK OSS, não avaliação contratual de toda oferta gerenciada. [L0][L8] | Python + checkpointer e coding harness/ferramentas próprios; SQLite local ou outro adapter, manutenção de schema/migrações e integração de execução. Não pressupor LangSmith/Agent Server para usar a biblioteca. [L0][L1][L3] |
| Eve | Apache-2.0 no pacote/base. [E0][E11] | Node >=24, build/server Nitro, world persistente e auth/proxy; Docker quando selecionado, modelo via gateway ou provider direto. Local world dispensa Postgres/Vercel, mas upgrades de versão exigem estratégia de substituição/preservação de sessões. [E1][E2][E3][E4] |

## 7. Composições mínimas plausíveis e fatos que ainda faltam

**Não há vencedor nem ranking aprovado.** As composições são hipóteses de integração compatíveis com a evidência, não arquitetura escolhida. O critério futuro deve ser complexidade total (código, instalação, operação, recuperação), conforme o mapa, não apenas número de processos.

| Composição a considerar no ticket decisório | O que a evidência permite esperar | O que não se pode assumir |
| --- | --- | --- |
| Pi SDK como builder/revisores + controle persistente da fábrica | Coding tools, skills e sessão reutilizável com host controlado. [P1][P6] | Durabilidade end-to-end pelo transcript; pausa remota pronta. |
| Pi Durable como harness + controle de Trabalho integrado ou externo a definir | Menos código próprio para tarefas/conversas persistidas, ownership interno e uso. [D1] | Compatibilidade direta com coding-agent, fencing de processos ou carregamento automático das skills existentes. |
| Mastra agentes + workflows locais persistidos | HITL e paralelismo prontos como primitivas, opção de recovery/fencing configurada. [M2][M4][M5][M7] | Recovery habilitado por default, side effects exactly-once ou kill de subprocessos por `cancel()`. |
| LangGraph + coding harness explícito + checkpointer persistente | Fluxo tipado/controlável com checkpoints, interrupts e fan-in. [L1][L2][L3][L4] | Harness de coding incluído ou granularidade interna de um agente externo obtida apenas por envolvê-lo num nó. |
| Eve base self-hosted + integração das políticas da fábrica | Harness, perguntas/subagentes e world local sem Vercel obrigatório. [E1][E2][E5][E6] | Canal GitHub webhook equivalente ao polling do MVP ou continuidade de workflow entre versões self-hosted. |

### Lacunas para decisão e validação posterior

- **Compatibilidade real das skills da fábrica:** não foi lido/executado um pacote definitivo `implement` + `code-review` + `/pr` neste escopo; é preciso definir formato, distribuição congelada, dependências e evidência de execução, não escolher runtime só porque reconhece `SKILL.md`.
- **Suspensão integral:** comprovar que pergunta elimina builder/processos ativos e libera Slot, preserva contexto/artefatos e ordem de fila, e que resposta não autorizada não retoma. Primitivas documentadas não completam CA-05/CA-11.
- **Crash recovery:** observar crashes durante ferramenta e logo após push, PR e pergunta; descobrir efeito ocorrido antes do checkpoint, sem novo escritor nem publicação duplicada. Documentação de retry/checkpoint não completa CA-06.
- **Cancelamento:** verificar árvore de processos, filhos detached, operações em andamento e containers de integração; efeito remoto já enviado deve ficar visível. Verificar também revisão indisponível e tool que ignora abort; não declarar êxito baseado em status da engine. CA-07/CA-12.
- **Revisão paralela:** demonstrar ambas sem escrita e sobre o mesmo conteúdo integral, incluindo untracked, e revisão invalidada após mudança. Estado/métricas dos revisores deve entrar no Trabalho. CA-01/CA-03/CA-12.
- **Configuração e upgrades:** pin de runtime/modelo/tools/skills e credenciais restritas; importar/substituir contexto em versões suportadas, incluindo sessões stranded de Eve e registry ausente de Pi Durable. Nenhum caminho universal de migração entre candidatos foi comprovado.
- **Custo/uso:** diferenciar desconhecido de zero; custos reportados por gateway não incluem necessariamente todas as tentativas, ferramentas, revisores e infraestrutura. Precificação/qualidade de modelo e benchmark estão fora desta pesquisa.
- **Abrangência:** suporte de GitHub, isolamento Linux/Docker e estratégia de durabilidade geral pertencem às investigações/decisões adjacentes do mapa. Estas lacunas não autorizam instalar, testar ou construir agora; provas futuras exigem autorização própria.

## 8. Validação e limites da evidência

- Fontes por SHA, manifests e metadados foram lidos por HTTPS público. Código/documentação oficiais são evidência de API/intenção/implementação estática, **não evidência empírica de garantias sob crash**.
- Validador Python somente leitura: **52 definições de fontes, 303 ocorrências de citações e seis links inline/locais**, sem identificadores ausentes/duplicados ou arquivos locais inexistentes. Todos os **52 destinos HTTPS retornaram HTTP 200**; links GitHub `blob` foram conferidos pelo conteúdo raw do mesmo SHA (não teste de renderização da interface GitHub). `git diff --check` e `git diff --no-index --check /dev/null .scratch/software-factory/research/agent-runtimes.md` passaram. São gates documentais, não testes de runtime.
- Nenhum agente/modelo/protótipo/candidato foi instalado ou executado, nenhum teste dos projetos foi rodado. Sem validação de Docker, containers, ferramentas GitHub, contas ou credenciais.
- O relatório é o único arquivo desta tarefa. Mapa/ticket continuam sob autoridade do supervisor, sem follow-ups gravados fora do escopo autorizado.

## 9. Fontes primárias consultadas

Todos os arquivos de código/documentação a seguir foram consultados em **2026-11-03 UTC**. As referências curtas usadas nas afirmações resolvem para arquivos imutáveis; os cinco endpoints iniciais são os metadados de descoberta.

### Metadados de descoberta

[S1]: https://api.github.com/repos/earendil-works/pi/commits/main
[S2]: https://api.github.com/repos/mastra-ai/mastra/commits/main
[S3]: https://api.github.com/repos/langchain-ai/langgraph/commits/main
[S4]: https://api.github.com/repos/langchain-ai/docs/commits/main
[S5]: https://api.github.com/repos/vercel/eve/commits/main

- [S1 — commit Pi][S1]; [S2 — commit Mastra][S2]; [S3 — commit LangGraph][S3]; [S4 — commit docs LangChain][S4]; [S5 — commit Eve][S5].

### Pi e Pi Durable

[P0]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/package.json
[P1]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/docs/sdk.md
[P2]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/docs/session-format.md
[P3]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/docs/sessions.md
[P4]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/docs/extensions.md
[P5]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/docs/cli-integration.md
[P6]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/docs/skills.md
[P7]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/docs/models.md
[P8]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/agent/package.json
[P9]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/coding-agent/src/core/tools/bash.ts
[P10]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/LICENSE
[D0]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/durable/package.json
[D1]: https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/durable/README.md

- [P0 — manifesto coding-agent][P0]; [P1 — SDK][P1]; [P2 — formato de sessão][P2]; [P3 — sessões/contexto][P3]; [P4 — extensões][P4]; [P5 — CLI/RPC][P5]; [P6 — skills][P6]; [P7 — modelos][P7]; [P8 — manifesto agent-core][P8]; [P9 — implementação bash][P9]; [P10 — licença][P10].
- [D0 — manifesto Durable][D0]; [D1 — contrato completo Durable][D1], especialmente *Persist and Resume*, *Tools*, *Per-Conversation Agent*, *Settings*, *Environment*, *Abort and Subagents*, *Usage and Cost* e *Storage*.

### Mastra

[M0]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/packages/core/package.json
[M1]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/docs/agents/overview.mdx
[M2]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/docs/workflows/suspend-and-resume.mdx
[M3]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/docs/workflows/snapshots.mdx
[M4]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/docs/harness/durable-agents.mdx
[M5]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/reference/workflows/workflow-methods/parallel.mdx
[M6]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/reference/workflows/run-methods/cancel.mdx
[M7]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/reference/tools/ask-user-tool.mdx
[M8]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/docs/agents/tools.mdx
[M9]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/docs/skills.mdx
[M10]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/reference/observability/metrics/automatic-metrics.mdx
[M11]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/LICENSE.md
[M12]: https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/docs/deployment/workflow-runners.mdx

- [M0 — manifesto][M0]; [M1 — agentes][M1]; [M2 — suspend/resume][M2]; [M3 — snapshots][M3]; [M4 — durable agents e ownership][M4]; [M5 — paralelo][M5]; [M6 — cancel][M6]; [M7 — askUserTool][M7]; [M8 — ferramentas][M8]; [M9 — skills][M9]; [M10 — métricas/custo][M10]; [M11 — licença e exceções][M11]; [M12 — runners][M12].

### LangGraph e LangChain

[L0]: https://github.com/langchain-ai/langgraph/blob/3c916d750575b22c464790e9774494d810ccd322/libs/langgraph/pyproject.toml
[L1]: https://github.com/langchain-ai/docs/blob/825cfcff35ee56a2e30b5c8006210b7763c14af8/src/oss/langgraph/checkpointers.mdx
[L2]: https://github.com/langchain-ai/docs/blob/825cfcff35ee56a2e30b5c8006210b7763c14af8/src/oss/langgraph/interrupts.mdx
[L3]: https://github.com/langchain-ai/docs/blob/825cfcff35ee56a2e30b5c8006210b7763c14af8/src/oss/langgraph/graph-api.mdx
[L4]: https://github.com/langchain-ai/docs/blob/825cfcff35ee56a2e30b5c8006210b7763c14af8/src/oss/langgraph/use-graph-api.mdx
[L5]: https://github.com/langchain-ai/docs/blob/825cfcff35ee56a2e30b5c8006210b7763c14af8/src/oss/langchain/models.mdx
[L6]: https://github.com/langchain-ai/docs/blob/825cfcff35ee56a2e30b5c8006210b7763c14af8/src/oss/langchain/multi-agent/skills.mdx
[L7]: https://github.com/langchain-ai/docs/blob/825cfcff35ee56a2e30b5c8006210b7763c14af8/src/oss/langgraph/fault-tolerance.mdx
[L8]: https://github.com/langchain-ai/langgraph/blob/3c916d750575b22c464790e9774494d810ccd322/LICENSE

- [L0 — manifesto Python][L0]; [L1 — checkpoints/durability/serializers][L1]; [L2 — interrupts e regras de replay][L2]; [L3 — graph API/migrações][L3]; [L4 — execução/fan-out][L4]; [L5 — modelos/uso LangChain][L5]; [L6 — skills LangChain][L6]; [L7 — falhas/timeouts][L7]; [L8 — licença][L8].

### Eve

[E0]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/packages/eve/package.json
[E1]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/docs/concepts/execution-model-and-durability.mdx
[E2]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/docs/guides/deployment/self-hosting/index.md
[E3]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/docs/guides/deployment/workflow-worlds.md
[E4]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/docs/sandbox/docker.mdx
[E5]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/docs/tools/human-in-the-loop.md
[E6]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/docs/subagents/index.mdx
[E7]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/docs/agent-config.md
[E8]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/docs/concepts/sessions-runs-and-streaming.md
[E9]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/docs/skills.mdx
[E10]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/docs/channels/github/reference.mdx
[E11]: https://github.com/vercel/eve/blob/55193f2fc3ffc1ffe550202893c6b9614c579a42/LICENSE

- [E0 — manifesto][E0]; [E1 — modelo de execução/stranded][E1]; [E2 — self-host][E2]; [E3 — worlds][E3]; [E4 — Docker sandbox][E4]; [E5 — HITL][E5]; [E6 — subagentes][E6]; [E7 — config/limites/retention][E7]; [E8 — sessões/stream][E8]; [E9 — skills][E9]; [E10 — canal GitHub][E10]; [E11 — licença][E11].
