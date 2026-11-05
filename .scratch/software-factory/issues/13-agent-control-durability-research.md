# Verificar plataformas de agentes como autoridade durável do Trabalho

Status: resolved
Claimed by: pesquisador delegado pelo responsável do mapa
Claim context: rodada de durabilidade autorizada pelo operador; sessão supervisora Pi `01a1a0f3-937b-72a8-8dc8-48e21281587a`.
Research branch: research/software-factory-agent-control
Research worktree (histórica; removida limpa após publicação/verificação): /home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/sf-research-agent-control
Research report: .scratch/software-factory/research/agent-control-durability.md
Research workflow: e7e44352-d35b-4c31-bcc2-bdac2708af23
Publication owner: supervisor; pesquisadores têm read/write/web sem shell/git. Após entrega, supervisor valida, commita e publica somente a branch de pesquisa correspondente via SSH BatchMode; sem merge/PR.
Research state: pesquisa documental verificada e publicada pelo supervisor; worktree removida limpa, branches de evidência preservadas, sem escolha tecnológica.
Local report: [Relatório preservado](../research/agent-control-durability.md)
Type: research
Label: wayfinder:research
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: none

## Question

Mastra durable, LangGraph e Pi Durable podem sustentar cada um o controle durável do Trabalho e não apenas o contexto do agente? Para cada candidato, qual composição mínima permite preservar admissão, ordem/categoria da fila, Slot, pergunta e intenção/resultado de efeitos, e qual controle ainda precisa ser escrito fora dele?

Esta é uma complementação estreita da pesquisa inicial, não sua repetição. Ler primeiro o relatório imutável de runtimes e reutilizar suas fontes/snapshots. Não reavaliar modelos, skills, revisores, custo de tokens, isolamento ou ferramentas de coding. Investigar somente as lacunas da fronteira de controle: transações/CAS/commits disponíveis ao host, cardinalidade e exclusividade de tarefas/runs/threads, fila global FIFO/reparos e admissão durável sem Slot durante espera, política explícita de crash/retry, propriedade de execução versus processo externo e atualização com perguntas pendentes.

Tratar os três como candidatos individuais efetivos. Mastra: distinguir workflows comuns, durable agent, runner in-process/evented e motor externo; verificar política de recovery e fronteira transacional do store. LangGraph: não extrapolar Python para JS; identificar se uma composição local em cada SDK muda garantias relevantes, especialmente checkpoint síncrono e concorrência no mesmo thread. Pi Durable: examinar alcance dos commits atômicos docs/tasks, ownership de um processo por storage, wake/resume, configurabilidade da sincronização e substituição/migração com registry atualizado. Se documentação faltar, leitura estática do código oficial é permitida; não executar o código obtido.

Para cada um, fornecer mapa conceitual de autoridade e janelas de crash: efeito externo concluído antes do checkpoint; pergunta persistida/publicada; reserva/Slot antes do spawn; crash do controlador enquanto o builder continua. Identificar se o host precisa de outro banco/coordenador e por quê, sem pressupor essa necessidade. Descrever limites de atualização com parada controlada, distinguindo mudança de schema, de código do workflow e do perfil do agente. Não afirmar impossibilidade pela ausência de API documentada.

Fontes primárias por versão/SHA; aproximadamente 2000–3000 palavras no total mais tabela. Sem escolha/ranking, implementações, instalação de serviços, modelos, provas, credenciais reais ou alterações de host. Lacunas empíricas devem permanecer explícitas.

## References

- [PRD — Software Factory MVP](../prd.md): RF-01, RF-03–04, RF-10, RF-12–13, RNF-01 e CA-03/05/06/07.
- [Investigar runtimes de agentes contra o contrato do PRD](03-agent-runtime-research.md): pesquisa resolvida; não reabrir nem relançar.
- [Relatório imutável de runtimes](https://github.com/Sanmoo/pkm/blob/0cb8c80ad7b708f31a9fc905f58a62d7a1a0299b/.scratch/software-factory/research/agent-runtimes.md): seções 3.2–3.4, 4, 6 e 7 e fontes primárias D1, M2–M4, L1–L3.
- [Escolher a estratégia mínima de durabilidade e recuperação](02-durability-strategy.md).
- [Matriz de evidências e lacunas de durabilidade](../durability-comparison.md).

## Comments

- O operador exigiu Mastra, LangGraph e Pi Durable na comparação como candidatos reais. Esta investigação complementa apenas fatos decisivos que a pesquisa de runtimes não resolveu.

## Answer

Complementação documental concluída e verificada, sem reabrir a pesquisa inicial. [Relatório imutável](https://github.com/Sanmoo/pkm/blob/8bad2459743f16d4724bcb730af7a648ab45ec2f/.scratch/software-factory/research/agent-control-durability.md), commit `8bad2459743f16d4724bcb730af7a648ab45ec2f`, branch `research/software-factory-agent-control`; consulta 2026-11-03.

- **Mastra:** estado/workflows podem hospedar um gestor serializado como hipótese de composição; CAS de status, claims e transações examinados têm escopo por run/operação, não transação host multi-run universal. Recovery do agent precisa ser subordinado à admissão/reconciliação; não há motor externo ou segundo banco obrigatório demonstrado.
- **LangGraph:** state/checkpoints podem guardar um gestor global serializado pelo host. Saver/thread não é mutex de invokes nem transação global de Slots. Python e JS foram distinguidos: o código JS no SHA 2f7b082df1fdf18122e41dead7cce7cda3c7fb6a contém barreira sync por superstep, divergindo dos docs congelados. Isso não demonstra todas as fronteiras iniciais nem equivalência universal entre SDKs.
- **Pi Durable:** documentos Session e commits de docs/tasks/submit(tx) podem incorporar controle do Trabalho à mesma autoridade, sem banco/motor extra obrigatório. Respeitar uma admissão por commit e ordem de leituras/escritas; host garante único owner. Resume/submit/wait podem iniciar scheduler e não devem disparar antes da reconciliação. Registry e migrações são explícitos; helper Node configura NORMAL sem flag synchronous.
- Em todos, FIFO/reparos/Slots, autorização remota e descoberta de efeitos/processos continuam domínio da fábrica. O relatório explicita onde cada primitiva reduz handoffs, sem concluir que as composições sejam equivalentes ou que alguma seja a mais simples.

**Verificação do supervisor:** relatório integralmente lido (2943 palavras); API/spec de commits/admissão Pi, CAS de status Mastra, helper Node NORMAL e barreira sync JS confrontados com fontes primárias por SHA. Referências locais/citações e escopo único conferidos; git diff --check do novo arquivo passou. O relatório privado de baseline retornou 404 em HTTP público; sua existência/conteúdo foram verificados pelo objeto Git 0cb8c80ad7b708f31a9fc905f58a62d7a1a0299b, hash idêntico da cópia lida e SHA da branch remota por SSH, não por suposição de acesso público. Supervisor committou/publicou somente a branch desta pesquisa via SSH BatchMode e confirmou SHA remoto com ls-remote.

**Preservação e limites:** worktree removida limpa; branches local/remota preservadas, sem merge/PR. Nenhum candidato foi instalado/executado e não houve prova de recovery. Persistem riscos de versões beta/experimentais, compatibilidade/migração e integração real dos mecanismos. Esta resolução não aprova tecnologia nem comprova CA-03/05/06/07.
