# Investigar runtimes de agentes contra o contrato do PRD

Status: resolved
Claimed by: pesquisador delegado pelo responsável do mapa
Research branch: research/software-factory-agent-runtimes
Research worktree (histórica; removida limpa após verificação): /home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/sf-research-agent-runtimes
Context: cartografia Wayfinder aprovada nesta conversa; pesquisa documental AFK delegada.
Research workflow: 1cb0b420-981c-4677-86ed-705118696c24
Research state: pesquisa documental verificada e publicada; resolução não implica escolha técnica.
Local report: [Relatório preservado](../research/agent-runtimes.md)
Type: research
Label: wayfinder:research
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: none

## Question

Quais capacidades documentadas dos runtimes de agentes plausíveis atendem ao MVP, e quais exigiriam adaptação própria?

Investigar Pi/SDK e a proposta Pi Durable, Mastra, LangGraph e o enquadramento de Eve, sem obrigação de escolher um deles. Separar framework/SDK, runtime de agente e motor de workflow. Se algum nome/projeto for ambíguo, identificar a fonte canônica ou registrar a ambiguidade, sem atribuir capacidades de homônimos.

Cobrir ferramentas customizadas para ask user, suspensão sem manter builder/processo/slot ativo, retomada ou substituição com contexto, dois revisores paralelos sem escrita, exportação e compatibilidade de sessões, cancelamento de subprocessos, modelos por papel sem fallback silencioso, métricas de uso e skills versionadas. Distinguir controles impostos pelo runtime de instruções de prompt e integrações ainda necessárias.

Usar documentação/código oficiais, registrar versões/data de consulta, custo operacional/licença e lacunas de prova. Reaproveitar evidência local somente após verificar sua pertinência. Entregar matriz por requisito, opções mínimas plausíveis e fatos ainda desconhecidos; não escolher a arquitetura pelo humano.

Pesquisa documental apenas: não instalar, executar agentes/modelos, usar credenciais ou criar protótipos. Relatório em `.scratch/software-factory/research/agent-runtimes.md`, em branch de pesquisa separada, nunca integrada.

## References

- [PRD — Software Factory MVP](../prd.md): RF-05–07, RF-10, RF-12–13; RNF-01, RNF-03 e RNF-05.

## Comments

- Criado na cartografia aprovada; não é ticket de implementação.
- Supervisor verificou relatório e publicação após a conclusão do workflow de pesquisa.

## Answer

Pesquisa documental concluída e verificada pelo responsável do mapa. [Relatório imutável](https://github.com/Sanmoo/pkm/blob/0cb8c80ad7b708f31a9fc905f58a62d7a1a0299b/.scratch/software-factory/research/agent-runtimes.md), commit `0cb8c80ad7b708f31a9fc905f58a62d7a1a0299b`, branch `research/software-factory-agent-runtimes`. Consulta em 2026-11-03 UTC.

- Pi SDK/coding-agent e Pi Durable possuem contratos distintos de sessão/persistência; compatibilidade automática não foi demonstrada. Durable é experimental e declara um proprietário por storage, sem locking cross-process.
- Mastra oferece primitivas de pergunta/suspensão e paralelismo, mas recuperação durable exige configuração consciente; fencing de estado e cancelamento cooperativo não cercam worktree, subprocessos ou Docker.
- LangGraph Python oferece checkpoints/interrupts; nós podem reexecutar e efeitos externos exigem integração idempotente/reconciliação. Não é coding harness pronto, nem as conclusões do SDK Python devem ser extrapoladas ao JS.
- Eve oferece base self-hosted/world local, mas mudança de versão no self-host pode impedir retomada dos workflows antigos; conversa recuperada e workflow retomado são coisas diferentes.
- Nenhuma opção documenta sozinha o produto completo. Controle do Trabalho, filas/slots, autorização remota, propriedade de escritor, efeitos GitHub e isolamento permanecem contratos a especificar.

**Verificação:** relatório lido; referências/links locais e escopo de diff conferidos; SHA publicado confirmado no remoto. Fontes primárias por SHA de Pi Durable, Mastra durable e Eve worlds foram confrontadas por amostragem com as afirmações críticas. O pesquisador registrou 52 fontes e validações documentais; não houve teste de runtime/modelo/Docker. Esta resolução encerra a investigação documental, não aprova candidato nem comprova CA-01–12.

**Precisão de escopo:** liberar Slot e não manter uma Execução de builder ativa durante espera é o requisito de produto. Isso não obriga encerrar um serviço compartilhado/event loop do runtime que hospede estado suspenso; o contrato concreto será decidido, sem transformar a redação “processo ativo” da pergunta em requisito adicional ao PRD.

**Encaminhamento:** usar como evidência em [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md).
