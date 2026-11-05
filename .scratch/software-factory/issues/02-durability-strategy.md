# Escolher a estratégia mínima de durabilidade e recuperação

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Pi `01a1a0f3-937b-72a8-8dc8-48e21281587a`; branch de registros `software-factory-durability`; integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 12, 13, 14

## Question

Qual estratégia oferece a menor complexidade total para filas e controle duráveis em uma instalação local single-tenant: controlador próprio com persistência transacional e reconciliação explícita, motor de workflow durável, ou composição justificada?

Comparar código e serviços próprios/de terceiros, instalação/operação, recuperação, migração de versões, licença e testes necessários. Não assumir Restate, Temporal, Pi Durable, Mastra, Eve ou LangGraph como requisito. Uma sessão persistida não demonstra workflow durável, e um motor não resolve sozinho efeitos GitHub ambíguos ou propriedade de processos.

A decisão deve explicar a recuperação nos cortes exigidos por CA-06, os limites de transação e retry, e quais responsabilidades permanecem na aplicação. Incluir uma comparação suficientemente concreta da opção própria com pelo menos uma alternativa durável plausível. Usar as provas locais com seus limites; se faltar fato decisivo, graduar uma pesquisa em vez de escolher por intuição. Não implementar nem executar provas neste ticket.

## References

- [Matriz de evidências e lacunas de durabilidade](../durability-comparison.md): comparação dos seis candidatos e evidências; a resolução e seus limites são registrados em Answer deste ticket.
- [Investigar DBOS como controle durável local da fábrica](12-dbos-control-research.md).
- [Verificar plataformas de agentes como autoridade durável do Trabalho](13-agent-control-durability-research.md).
- [Verificar a base transacional de um controlador próprio local](14-local-controller-persistence-research.md).
- [PRD — Software Factory MVP](../prd.md): RF-01, RF-03–04, RF-10, RF-12–13; RNF-01, RNF-04–05; CA-03, CA-05–07.

## Comments

- Criado na cartografia aprovada; não é ticket de implementação.
- Reivindicação registrada antes do trabalho; desenvolvimento documental na branch `software-factory-durability`, com destino original `main` no checkout indicado acima.
- A comparação inicial restrita a controlador próprio/Restate foi ampliada a pedido do operador. A preferência inicial por SQLite próprio foi retirada; as pesquisas complementares foram verificadas/publicadas antes da escolha.
- Aprovações HITL: Q2 “Sim” (atualização controlada); Q3 “sim, estou de acordo” (risco beta/experimental); Q4 “sim” (Pi Durable); Q5/Q6 “sim para ambas” (SQLite WAL/FULL e recuperação por fases reconciliáveis). Não houve escolha automática pela pesquisa.
- As aprovações parciais foram consolidadas em Answer; o mapa recebe somente síntese e link. Nenhum candidato foi implementado/testado nesta decisão.

## Answer

### Escolha e alcance

Adotar **Pi Durable como estratégia-base de durabilidade do MVP**, com controle do Trabalho em documentos Session/tarefas de uma única autoridade proprietária do storage, usando **SQLite local em WAL com synchronous=FULL para os commits de controle**.

Vários builders continuam concorrentes. Um proprietário de estado não é um Slot único, mutex por repositório nem promessa de que somente um processo exista na máquina. O mecanismo de exclusividade desse proprietário e a propriedade/interrupção dos workers devem ser concretizados nas decisões de isolamento e protocolo.

Não adotar um motor de workflow externo, broker ou segundo banco de controle por padrão. Isso não impõe um único arquivo para todos os artefatos/sessões nem proíbe contexto próprio do runtime: tais dados não podem virar autoridade concorrente de autorização, filas ou limites.

A escolha não seleciona automaticamente Pi coding-agent nem prova compatibilidade de suas sessões/extensões com Pi Durable. A decisão de runtime concretizará coding tools, skills, revisores, modelos e sessões. Se essa integração desfizer a simplicidade esperada, voltar ao operador com impacto explícito; não impor bridge complexa, segundo motor ou fallback silencioso.

### Justificativa e alternativas

A vantagem específica documentada de Pi Durable é poder unir estado do host, admissão e criação de tarefas no mesmo commit, além de oferecer espera/retomada e migração de docs/tasks. Isso reduz a necessidade de um protocolo adicional entre a autoridade de domínio e um motor separado. FIFO/reparos, Slots, autorização e reconciliação continuam regras da fábrica.

O operador aceita API beta/experimental se a composição for a mais simples, com versão fixada, limites/migração explícitos e provas antes do aceite. É uma escolha qualitativa de desenho, **não menor LOC/custo/operação medidos nem conformidade empírica**. Núcleo Pi/Durable é MIT no recorte pesquisado; dependências/binding/perfil efetivos ainda precisam fixação.

| Alternativa comparada | Trade-off que pesou nesta escolha |
| --- | --- |
| Controlador próprio + SQLite | Fronteira transacional direta, mas transições, despacho, retomadas do coordenador e diagnóstico quase todos próprios. Não basta ter menos serviços para ser mais simples. |
| Restate | Journal/mensagens/esperas fortes e bateria anterior favorável com executor simulado; adiciona serviço/deployments e modelo de evolução, sem eliminar estado de domínio ou reconciliação. Servidor BSL e SDK MIT são distintos; aprovação de outro esforço não foi importada. |
| DBOS | Biblioteca embutida com checkpoints/transações de aplicação; TS requer PostgreSQL e Python pode SQLite. Filas internas ainda precisam adaptação de Slots/ordem/elegibilidade e disciplina de versão; core/Enterprise foram distinguidos. |
| Mastra durable | HITL/agentes/workflows integrados; operações atômicas examinadas são por run/operação, exigindo organizar autoridade global e subordinar recovery à admissão. Beta não o eliminou; seu encaixe foi comparado. |
| LangGraph | State/checkpoints podem hospedar gestor, mas serialização de invokes, ingresso, despacho e coding harness são integração do host. Diferenças Python/JS foram preservadas, inclusive divergência docs/código sync; não foi descartado por suposta incapacidade. |

Temporal, Hatchet e Inngest permaneceram referências, sem exclusão por impossibilidade. A [matriz](../durability-comparison.md) indexa evidências e limites; os relatórios imutáveis e sua verificação estão nos Answers das pesquisas, sem incorporar suas branches.

### Limites de transação e persistência

- Persistir admissão/ordem/categoria, reserva de Execução/Slot, pergunta/resposta, contadores, intenção e confirmação na autoridade de controle. O schema, IDs e transições exatos pertencem à decisão de estados e efeitos.
- Usar commits confirmados para controle crítico, nunca progresso deferred como prova de admissão/reserva/pergunta/intenção/resultado.
- Respeitar os contratos Pi Durable: leituras de tabelas antes das escritas e uma admissão por commit; o resultado de submit dentro do callback é provisório até o commit armazenado. Várias concessões podem exigir commits sucessivos.
- SQLite deve estar em filesystem local apropriado, com versão efetivamente embarcada corrigida para WAL-reset (3.51.3+ ou backport indicado pelas fontes oficiais). Nome/versão do binding não bastam como evidência.
- O helper Node examinado configura WAL/NORMAL, sem flag synchronous. A implementação deverá usar a fronteira pública de adapter/SqliteStorage e **verificar FULL**, em vez de inventar opção do helper ou aceitar NORMAL silenciosamente. A integração concreta ainda precisa prova.
- FULL acrescenta sincronização por commit sob as premissas de OS/FS/hardware. Não substitui backup nem garante armazenamento defeituoso; nenhum SLA/RPO/HA novo foi imposto. Falha de persistência não pode ser anunciada como confirmação durável.
- GitHub, filesystem do worker, spawn e memória do agente ficam fora do commit. Uma intenção indica o que descobrir, não comprova sucesso ou fracasso do efeito externo.

### Recuperação e cortes CA-06

Usar **fases curtas reconciliáveis**: commit da reserva/intenção, efeito fora do commit, observação e novo commit de confirmação. Não encapsular o ciclo inteiro do builder como operação cegamente repetível.
Para push/criação de PR diretos pelo Builder, aplicar a revisão HITL de
[Definir o protocolo de execução e retomada entre controlador e worker — publicação direta sem ferramenta adicional de intenção](15-controller-worker-protocol.md#q7--publicação-direta-sem-ferramenta-adicional-de-intenção),
que substitui a exigência de intenção prévia específica por publicação; os demais controles transacionais permanecem.

Abrir estado/restabelecer registry não autoriza automaticamente executar builders. Como resume/submit/wait podem iniciar scheduler, o host deve impor barreira de reconciliação e condicionar cada despacho à autorização/reserva vigente. Não basta esperar que o scheduler seja iniciado explicitamente em um único ponto.

| Corte | Conduta aprovada no nível de estratégia |
| --- | --- |
| Reserva persistida, spawn ainda incerto | Descobrir execução identificável antes de lançar outra; reserva não prova processo existente, ausência de recibo não prova ausência de spawn. |
| Crash durante builder, processo pode sobreviver | Reconciliar propriedade/processos/artefatos e recuperar acompanhamento ou confirmar interrupção antes do substituto. Se não for possível determinar exclusividade, bloquear. |
| Push ocorreu antes da confirmação | Consultar branch/ref/commit e reconhecer alterações humanas; preservar o OID esperado do lease, sem renovação cega ou sobrescrita desconhecida. |
| PR criado sem confirmação | Descobrir PR próprio por identidade/correlação; registrar em vez de recriar. Múltiplos candidatos ou identidade ambígua bloqueiam. |
| Pergunta persistida, publicação incerta | Descobrir comentário/pergunta pelo identificador estável antes de republicar. Persistir publicação/resposta e confirmar suspensão sem Slot ocupado. |
| Pergunta já publicada, resposta chega durante recuperação | Autenticar/correlacionar e aplicar uma vez; retomada passa pela fila/categoria/ordem do Trabalho, não dispara agente diretamente nem reinicia limites. |
| Cancelamento durante efeito enviado | Pedido persistido não é interrupção confirmada. Impedir novos disparos/renovações, interromper por supervisão, reconciliar efeito que ainda pode terminar e preservar artefatos. |

A publicação permanece **direta pelo builder via GitHub App**, conforme a decisão de autoridade; esta estratégia não cria gateway/publicador mediado ou transação distribuída. Prontidão continua verificada pelo controlador, merge humano e riscos residuais da credencial permanecem os já aceitos.

### Retry, limites e contexto

Replay automático fica restrito a operações cuja repetição seja segura/idempotente ou reconciliada antes de agir. Marcar replay safe não cria idempotência GitHub nem encerra writer anterior. Timeout/erro de comunicação não comprovam ausência do efeito nem morte do processo; ambiguidade gera bloqueio explícito.

Contadores e autorizações do PRD são persistentes e prevalecem sobre defaults internos: padrão de até três correções automáticas e até três retomadas operacionais recuperáveis, configuráveis e separados, com espera progressiva para estas. Falha de autorização/configuração e timeout configurado não iniciam repetição automática; esgotamento bloqueia. Restart/reopen/replay nativos não concedem tentativas extras, não zeram histórico e não podem contornar fila/Slot. O detalhamento de classificação/consumo fica na decisão de estados e efeitos.

Retomar sessão compatível ou substituí-la com contexto recuperado, conforme RNF-01. Não prometer continuar mesma instrução, raciocínio interno ou reconstruir dados nunca persistidos. Espera por resposta/CI/merge não ocupa Slot nem relógio ativo; não criar timeout global de execução.

### Atualização e recuperação operacional

Atualização com parada controlada: pausar novos disparos, aguardar builders ou interrompê-los com confirmação, preservar trabalhos/esperas, validar compatibilidade e executar somente migração suportada e solicitada de formatos/estado e reinstalar registry compatível antes de reconciliar e retomar. Perguntas pendentes não impedem atualização; não exigir rolling update ou controladores antigos simultâneos.

Versionar separadamente backend/schema, docs/tasks e perfil do agente/skills. Usar migrações suportadas e bloquear incompatibilidades; não reabrir storage com definições diferentes assumindo equivalência. A revisão de escopo em [Definir a configuração, a CLI e o ciclo operacional da instalação](21-installation-operations-contract.md#atualização-e-limite-de-recuperação) retirou suporte integrado a backup/restauração. Proteção contra perda do storage é externa; cópias não são certificadas nem desfazem GitHub ou dispensam reconciliação. A migração suportada precisa detectar interrupção e ter caminho definido de recuperação, sem promessa de rollback universal. Recovery após crash a partir do estado persistido permanece obrigatório.

### Encaminhamentos e provas

- [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md): runtime/perfil/versão de suporte, coding tools/skills, ask user, revisores, contexto e integração com o controle aprovado. Não presumir compatibilidade coding-agent/Durable.
- [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md): estado protegido, proprietário único, evidência de processos sobreviventes, interrupção e recursos persistentes.
- [Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md): schema/IDs/transições, fronteiras atômicas concretas, elegibilidade, ordem/Slots, perguntas, limites, cleanup e migrações.
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md): mensagens/resultados/evidências e barreiras que conectam runtime, isolamento e estados sem redefini-los.

Provas futuras obrigatórias incluem os cortes da tabela com builder/GitHub reais, exclusividade de escritores após crash, espera/resposta liberando Slot, replay sem duplicação de PR/pergunta, cancelamento, limites preservados, adapter com FULL/correção SQLite e upgrade com perguntas pendentes, incluindo recusa de incompatibilidade e recuperação definida de migração interrompida. Backup/restore integrado não é gate do MVP, conforme a revisão operacional. A bateria Restate com executor simulado não prova esta composição. Nenhuma instalação, implementação ou prova foi autorizada/executada por esta resolução.

**Condição de aceite:** a escolha aprova o caminho de desenho; CA-01–12 continuam a demonstrar antes do aceite do MVP. Falta de evidência de API ou prova futura reprovada é bloqueio/retorno ao operador, não autorização para enfraquecer controles.
