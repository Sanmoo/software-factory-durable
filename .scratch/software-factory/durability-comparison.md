# Durabilidade da Software Factory — matriz de evidências e lacunas

## Autoridade e estado

- Atualização: 2026-11-03 UTC. Artefato de apoio a [Escolher a estratégia mínima de durabilidade e recuperação](issues/02-durability-strategy.md), no [mapa](map.md). **Não é spec, resolução canônica ou aceite do MVP.** A resolução vive em Answer do ticket, não aqui.
- Requisitos: [PRD 0.0.1](prd.md). Premissas: Linux, uma máquina, single-tenant, vários Trabalhos concorrentes e preferência pela menor complexidade total. Não comparar apenas quantidade de serviços.
- Decisão encerrada após Q5/Q6: Pi Durable como base. Estratégia, armazenamento, limites e aprovações estão em [Answer do ticket](issues/02-durability-strategy.md#answer); este documento mantém a comparação e suas evidências, não outra cópia da resolução.
- Controlador próprio, Restate, DBOS, Mastra durable, LangGraph e Pi Durable foram comparados como candidatos individuais. Não pressupor que agentes precisam de motor externo nem que sua persistência basta para controlar o Trabalho. Linguagem e runtime de coding ainda não foram escolhidos.
- Este documento reutiliza a pesquisa inicial de runtimes, sem reabri-la. As três pesquisas complementares terminaram, foram revisadas e publicadas em branches próprias, sem merge/PR; [DB], [AC] e [LC] são referências imutáveis. A investigação documental e a decisão HITL desta estratégia foram concluídas; o restante do mapa permanece aberto. Não foram executados instalações, agentes/modelos dos candidatos, provas ou benchmarks.

## Como ler a evidência

- **D — documentado:** contrato ou implementação estática sustentados pelas fontes citadas; não significa prova empírica.
- **E — demonstrado no recorte:** teste já registrado, limitado à versão, ambiente e executor usados.
- **H — hipótese de composição:** análise do encaixe, ainda sem implementação ou validação. Não confundir com capacidade pronta.
- **? — desconhecido:** esta investigação ainda não estabeleceu o fato; não significa inexistência ou impossibilidade.

As fontes são resumidas em cada célula. As citações finais identificam relatórios e fontes primárias; o relatório de runtimes existe somente em sua branch de pesquisa, não foi integrado.

## Régua comum

Avaliar **a composição mínima completa**, não o marketing de cada ferramenta. O controle persistente do Trabalho precisa preservar identidade única, elegibilidade conhecida, admissão/ordem/categoria, reserva/Slot, pergunta/resposta, limites e fase confirmada. Sessão, checkpoints, artefatos e estado Git são referências/contextos distintos, não fontes concorrentes de autorização.

| Corte / requisito | Resultado a explicar na comparação |
| --- | --- |
| Admissão concorrente e reinício | Um Trabalho por ticket; ordem/categoria persistidas; reserva antes de iniciar, sem exceder Slots nem duplicar escritores. RF-01/03/04; CA-03. |
| Pergunta/espera/resposta | Persistir pergunta e resultado observável da publicação; espera não ocupa Slot; resposta autorizada e correlacionada volta à categoria/ordem correta. RF-03/10; CA-05/06. |
| Crash durante builder | Identificar execução sobrevivente antes de substituto; recuperar contexto disponível, sem prometer mesma instrução ou raciocínio interno. RF-04; RNF-01. |
| Push aplicado antes de confirmação | Descobrir ref/commit e alteração humana concorrente antes de repetir; preservar lease. CA-06/09. |
| PR/pergunta publicados sem confirmação | Descobrir artefato próprio, não recriar; identidade ambígua vira bloqueio visível. CA-06. |
| Cancelamento e retries | Pedido persistido não é interrupção confirmada; efeito já enviado pode terminar; separar retomada operacional de reparo e obedecer limites do produto. RF-12/13; CA-07. |
| Atualização com espera pendente | Parada controlada, backup/migração e reconciliação; preservar correlação/contexto e explicitar incompatibilidade, sem exigir manter o builder vivo. Q2 aprovada. |

Publicação direta pelo builder via GitHub App e prontidão verificada pelo controlador já foram decididas em [Definir a fronteira mínima entre controlador e builder](issues/01-control-authority.md). Nenhum candidato pode importar silenciosamente outro desenho de autoridade. Lock/lease de estado não prova exclusividade de processos, worktree ou escrita remota.

## Matriz principal — o que já sabemos

| Candidato individual | Primitivas e recuperação sustentadas | Composição mínima a comparar — H, não desenho aprovado | Lacuna que pode mudar a escolha |
| --- | --- | --- | --- |
| Controlador próprio transacional | **D** SQLite serializa escritas e permite transações locais conjuntas de estado/intenções; WAL/NORMAL resiste a crash de processo, mas pode perder commits em falha de host; WAL/FULL acrescenta sincronização por commit. Backup e migração de schema documentados. [LC] | Controlador específico do domínio sobre um banco; transações curtas para admissão/fila/Slot/intenção, despacho e reconciliação próprios; coding runtime/supervisor. Sem DSL ou replay genérico. | Maior responsabilidade explícita por transições, retomadas e diagnóstico, mas sem evidência medida de esforço. Lock do banco não cerca builder. Binding/SQLite embarcado e configuração devem ser fixados e provados. [LC] |
| Restate | **D** journal, estado por chave, mensagens/esperas duráveis; efeito externo pode repetir entre sucesso e registro. **E** bateria anterior com executor simulado passou em reservas, mensagens duplicadas, pergunta, crash e upgrade patch. [R] [B] | Controlador de domínio sobre estado/mensagens do motor + serviço Restate persistente + runtime/supervisor. A bateria usou deduplicação permanente, contadores e reconciliação próprios, não semântica pronta da fábrica. | A evidência já permite comparação documental. Não demonstra builder real, GitHub nem Docker, nem migração arbitrária de schema. Desenho precisa contabilizar deployments e modelo de mensagens, não assumir que Q2 elimina compatibilidade de journal. [R] [B] |
| DBOS | **D** checkpoints/passos e transações de datasource que unem alteração de aplicação ao checkpoint; filas com prioridade/FIFO e concorrência. Núcleo pode recuperar localmente sem Conductor. Ownership protege checkpoints, não escritores externos. [DB] | SDK embutido + banco (TS PostgreSQL; Python pode SQLite) + domínio transacional, runtime/supervisor. Funções SQL de enqueue/send ou intenções com IDs estáveis podem ligar domínio e despacho; não presumir transação ambiente de startWorkflow. | Fila interna não preserva automaticamente ordem original após retomada nem seleção de inelegíveis; waits PENDING podem ocupar concorrência da fila. Suspensão estacionada TS é Enterprise no snapshot, não implica proibição de espera core. Fixar release/APIs e composição. [DB] |
| Mastra durable | **D** workflows/state/snapshots, HITL e recovery configurável. **Código estático:** CAS de status e writes/claims delimitados por run em adapters compatíveis; não há transação host multi-run universal estabelecida. Durable agent in-process não exige motor externo. [AC §1; A] | **H:** workflow gestor serializado no host concentra fila/Slots/perguntas/intenção; agentes mantêm contexto, não autoridade concorrente. Alternativa de tabelas host pode usar o mesmo banco, não outro serviço obrigatório. | Recovery automático precisa respeitar o gestor antes de iniciar agents; CAS de status não é CAS de revisão. Compatibilidade geral de workflows pendentes em upgrades não foi estabelecida; beta/versão publicada e adaptação de coding entram no custo. [AC] |
| LangGraph | **D** state/checkpoints/interrupts Python e JS, sem serviço gerenciado obrigatório. Saver não é mutex de invokes nem transação global entre threads. **Código JS:** há barreira sync por superstep no SHA lido, divergindo dos docs congelados. [AC §2] | **H:** thread gestor global invocado serialmente pelo host guarda controle; builders externos e eventos não precisam prender nós longos. Checkpointer local pode ser a única persistência, sem segundo banco obrigatório. | Primeiro checkpoint/admissão antes do primeiro efeito precisa confirmação; não extrapolar Python ou descrição móvel para JS. Host fornece despacho, reabertura e exclusividade; nós/schema/ordem de interrupts têm restrições de migração. Coding harness é integração. [AC] |
| Pi Durable | **D** documentos Session, commits de docs/entradas/tasks e submit(tx) podem unir controle do host e admissão. Uma admissão por commit, leituras de tabela antes das escritas; wake/resume e migração de docs/tasks documentados. Um owner por storage; experimental. [AC §3] | **H:** um Harness/storage com docs Session de domínio e tasks de controle, conversas por Trabalho no mesmo domínio transacional; sem motor/banco extra obrigatório. FIFO/reparos e Slots são regras próprias sobre essas primitivas. | Resume/submit/wait podem iniciar scheduler: reconciliar e barrar spawn antes. Registry/coding tools/skills não são os do coding-agent. Helper Node usa WAL/NORMAL sem flag synchronous; mudar isso exige adapter/configuração verificada. Owner externo e migrações continuam próprios. [AC] |

**Nenhum candidato tem conformidade ponta a ponta demonstrada para CA-01–12.** Não transformar as lacunas comuns em empate artificial: o código que cada primitiva elimina e a dificuldade da integração podem ser diferentes.

## Dependências, licença e evolução — inventário, não pontuação

| Candidato | O que já está documentado | Ônus/limite a incluir na avaliação |
| --- | --- | --- |
| Próprio | SQLite autocontido/domínio público; binding e biblioteca embarcada não escolhidos. Verificar correção WAL-reset (3.51.3+ ou backport) e defaults reais. [LC] | Transições, retries, despacho, migrações, inspeção e reconciliação mantidos pela fábrica. FULL/NORMAL e backup consistente importam também quando SQLite vem embutido em outro candidato. Menos serviços não prova menor complexidade. |
| Restate | Servidor self-hosted e deployment da aplicação; BSL 1.1 do servidor v1.7.13, SDK TS v1.17.3 MIT. [R] | Licença/versão e cenário desta adoção ainda precisam confirmação; aprovação empresarial antiga era de outro esforço e recorte. Journal/versionamento, retenção e backup não desaparecem com nó único. |
| DBOS | SDKs core MIT; TS Node/PostgreSQL; Python pode SQLite. Conductor/Enterprise opcionais e licença comercial distinta. Releases TS v5.4/Python 3.4.0 são distintos dos snapshots lidos. [DB] | Fonte identifica recv/sleep com suspend:true TS como Enterprise no snapshot; não atribuir isso à release nem dizer que toda espera exige licença paga. Replay/patching/versionamento e domínio dos Slots continuam no custo. |
| Mastra | Node + storage local é possível; Apache-2.0 com exceção `ee/`; durable agents beta. [A §6] | Configurar recovery/ownership corretamente, fixar versão publicada adequada — o snapshot anterior era alpha. Stores/cache/PubSub têm papéis distintos. |
| LangGraph | Python ou JS + checkpointer; MIT no recorte; sem serviço gerenciado obrigatório. [A §6; AC §2] | Coding harness e host de controle não vêm prontos; diferenças de SDK, serializer, locks e migrações entram no custo. A divergência docs/código sync é risco de integração/versionamento, não prova de incapacidade do JS. |
| Pi Durable | Node + storage local; MIT no recorte; experimental. [A §6; AC §3] | Registry/ambiente precisam ser reinstalados pelo host; docs/tasks têm migrações, sem promessa de upgrade arbitrário. Compartilhar monorepo com Pi coding-agent não entrega bridge de skills ou compatibilidade de sessão. |

A comparação final deve distinguir backup de estado, preservação de artefatos e compatibilidade de código. O PRD não exige HA, distribuição ou novo SLA de perda de energia; configurações que mudam a garantia precisam ficar explícitas, sem inventar requisito ou garantir o que não foi provado.

## Alternativas de referência, sem exclusão técnica

| Alternativa | Evidência reutilizável e posição nesta rodada |
| --- | --- |
| Temporal | **D** replay, Activities, Signals/Updates, esperas e versionamento; operação persistente self-hosted distinta de dev SQLite. MIT. Pesquisa anterior, sem bateria comparativa executada. [T] Referência de controle separado; não eliminado. |
| Hatchet | **D** tarefas comuns e duráveis, waits/eviction e Postgres; Lite não exige RabbitMQ universalmente. MIT do engine, sem presumir recursos comerciais. Perguntas de contadores/upgrade permanecem. [H] Referência de coordenação por tarefas; não eliminado. |
| Inngest | **D preliminar** self-host em binário único; default SQLite e Redis embutido em memória com snapshots periódicos. [I0] Não inferir crash recovery sem perda a partir de snapshot. Consulta inicial, não avaliação equivalente aos candidatos principais. |
| Fila pronta + controlador (ex.: BullMQ) | **D preliminar** perda de lock pode reprocessar job; isso não prova morte do escritor antigo. [Q0] Categoria alternativa, sem vantagem identificada que justifique outra pesquisa agora; não afirmar incapacidade. |

Se a comparação principal revelar vantagem decisiva de uma referência ou falha de todos os candidatos, aprofundar essa alternativa antes de excluir/escolher. Não expandir para catálogo de ferramentas sem uma pergunta discriminante.

## Lacunas documentais versus provas futuras

Três pesquisas documentais independentes foram concluídas e verificadas: DBOS [DB], autoridade de controle nas três plataformas de agentes [AC] e base própria transacional [LC]. O supervisor leu integralmente os relatórios, verificou metadados/links/escopo, confrontou fontes primárias por amostragem e confirmou publicação por SHA remoto. Nas 64 URLs únicas mantidas, 63 fontes públicas retornaram HTTP 200; o relatório privado de baseline retornou 404 sem autenticação HTTP e foi verificado pelo objeto Git imutável, hash de conteúdo idêntico à cópia lida e branch remota por SSH. Isso não equivale a revisão semântica exaustiva nem teste de runtime.

## Síntese comparativa e decisão

As três plataformas de agentes podem participar do controle do Trabalho, não somente do transcript. A hipótese de segundo banco/motor obrigatório foi retirada: Mastra e LangGraph podem concentrar controle em gestor serializado; Pi Durable documenta a união mais direta de estado do host e admissão/tasks no mesmo commit. Essa vantagem específica não prova menor complexidade total: Pi Durable ainda exige integração de coding/skills e sua API é experimental. Mastra já fornece HITL/agents/workflows, com fronteiras de estado por run que o gestor precisa respeitar. LangGraph expõe o grafo/estado, mas deixa ingresso, despacho e exclusividade com o host.

DBOS oferece replay e transações de aplicação com checkpoints sem servidor de workflow obrigatório, ao custo do banco e da disciplina de versões; suas filas ainda precisam adaptar Slots/ordem do PRD. Restate oferece primitivas separadas do harness e evidência experimental prévia parcial, ao custo de serviço/deployments e código de domínio. O controlador próprio oferece controle transacional explícito sem novo modelo de replay, mas deixa a recuperação do coordenador quase toda com a fábrica. Não há benchmark/estimativa que torne um deles vencedor por contagem de componentes.

A comparação foi discutida com o operador; Q2–Q6 foram confirmadas. A [resolução canônica](issues/02-durability-strategy.md#answer) escolhe Pi Durable e registra armazenamento, recuperação/retry, evolução, riscos e encaminhamentos. O runtime de coding não foi escolhido automaticamente, e as provas do MVP continuam pendentes. Alternativas não selecionadas não foram declaradas impossíveis.

Ficam para validação posterior, não para esta pesquisa: injetar crash com builder real sobrevivente; perda de confirmação após push/PR/pergunta reais; interrupção e credenciais da App; espera/resposta e concorrência com processos; restauração e upgrade; testes Docker concorrentes. Pesquisa pode especificar o mecanismo e os limites, não substituir essas provas ou autorizar executá-las.

## Fontes e rastreabilidade

- **[A]** [Relatório de runtimes, commit 0cb8c80ad7b708f31a9fc905f58a62d7a1a0299b](https://github.com/Sanmoo/pkm/blob/0cb8c80ad7b708f31a9fc905f58a62d7a1a0299b/.scratch/software-factory/research/agent-runtimes.md), consulta 2026-11-03. Lido integralmente nesta rodada; suas fontes por SHA fundamentam as células, não preferências de esforços antigos. Snapshot Pi/Durable 1.5.0, Mastra core 1.82.0-alpha.1, LangGraph Python 1.2.19: não alegar que sejam versões estáveis publicadas.
- **[D1]** [Pi Durable README no SHA consultado](https://github.com/earendil-works/pi/blob/9c9ce8547e5a88cbe834a53e9a6d83a789d08e47/packages/durable/README.md).
- **[M2–M4/M7/M12]** Fontes imutáveis detalhadas em [A]: suspend/resume, snapshots, durable agents/ownership, askUserTool e workflow runners. [Durable agents no SHA consultado](https://github.com/mastra-ai/mastra/blob/cf6711962037b4900ebc479a1f1c805252c4248d/docs/src/content/en/docs/harness/durable-agents.mdx).
- **[L1–L3]** Fontes imutáveis detalhadas em [A]: checkpointers, interrupts e graph API/migrações. [Checkpointers no SHA consultado](https://github.com/langchain-ai/docs/blob/825cfcff35ee56a2e30b5c8006210b7763c14af8/src/oss/langgraph/checkpointers.mdx).
- **[R]** [Pesquisa Restate anterior](https://github.com/Sanmoo/pkm/blob/1da4f5fac781bfdbd0b761ea9731e248429a55eb/.scratch/agent-orchestration/research/restate.md), 2026-10-10, servidor v1.7.13/SDK TS v1.17.3; documentação, não prova de integração. Referência histórica local, não nova escolha aprovada.
- **[B]** [Bateria Restate anterior](https://github.com/Sanmoo/pkm/blob/1da4f5fac781bfdbd0b761ea9731e248429a55eb/.scratch/agent-orchestration/results/30-engine-battery-restate-2026-10-11.md), 2026-10-11: executor simulado, sem Pi/modelo/GitHub/Docker; upgrade patch, não migração arbitrária. Código/resultados possuem SHAs próprios no relatório.
- **[T]** [Pesquisa Temporal anterior](https://github.com/Sanmoo/pkm/blob/1da4f5fac781bfdbd0b761ea9731e248429a55eb/.scratch/agent-orchestration/research/temporal.md), 2026-10-10, servidor v1.32.1, sem PoC.
- **[H]** [Pesquisa Hatchet anterior](https://github.com/Sanmoo/pkm/blob/1da4f5fac781bfdbd0b761ea9731e248429a55eb/.scratch/agent-orchestration/research/hatchet.md), 2026-10-10, engine v0.110.5, sem PoC.
- **[DB]** [DBOS como controle durável, commit b61cd35a7e95dac95c543ab510c255524e30c54d](https://github.com/Sanmoo/pkm/blob/b61cd35a7e95dac95c543ab510c255524e30c54d/.scratch/software-factory/research/dbos-control.md), consulta 2026-11-03; versões, SHAs, licença, fronteiras SQL/filas/recovery e limitações release/snapshot no relatório. Publicação conferida por SSH.
- **[AC]** [Autoridade durável nas plataformas de agentes, commit 8bad2459743f16d4724bcb730af7a648ab45ec2f](https://github.com/Sanmoo/pkm/blob/8bad2459743f16d4724bcb730af7a648ab45ec2f/.scratch/software-factory/research/agent-control-durability.md), consulta 2026-11-03; complemento estreito de [A], inclui snapshot JS 2f7b082df1fdf18122e41dead7cce7cda3c7fb6a. Publicação conferida por SSH.
- **[LC]** [Base transacional própria, commit 1d60fd540f4d68a66a47f340c4b4f5b32f29e8b8](https://github.com/Sanmoo/pkm/blob/1d60fd540f4d68a66a47f340c4b4f5b32f29e8b8/.scratch/software-factory/research/local-controller-persistence.md), consulta 2026-11-03; fontes SQLite, sincronização, ownership externo e inventário de código próprio. Publicação conferida por SSH.
- **[I0]** [Inngest — self-hosting](https://www.inngest.com/docs/self-hosting), consulta preliminar 2026-11-03; docs móveis, não garante corte de crash desta fábrica.
- **[Q0]** [BullMQ — stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs), consulta preliminar 2026-11-03; docs móveis, não prova de exclusividade externa.
