# Validar a continuidade do agente entre boots em Lambda MicroVMs

Status: resolved
Type: prototype
Label: wayfinder:prototype
Map: [Software Factory v2 — ambientes reconstruíveis em Lambda MicroVMs](../map.md)
Blocked by: 02

## Question

Com o harness do MVP no host e as ferramentas executando em uma MicroVM, o agente retoma um Trabalho
depois de uma troca de boot (planejada ou por perda), partindo do estado publicado no Git remoto,
sem supor arquivos que não existem mais e sem repetir efeitos externos ambíguos?

## Scope

- A [prova de infraestrutura](02-lambda-microvms-prototype.md) roda sem harness por decisão do
  Operador em 2026-11-20: ela mostra que o serviço permite reconstruir, não que o agente continua.
  Este ticket cobre essa segunda metade.
- Só faz sentido se Docker e transporte tiverem resultado utilizável na prova anterior; resultado
  negativo lá volta ao Operador antes de qualquer trabalho aqui.
- Exige um adapter provisório que ligue as ferramentas do agente ao transporte validado. Código
  descartável, em branch própria; não é a implementação da v2.
- Cobrir troca planejada antes do limite de vida, perda antes do push com sessão substituta, e o
  contexto entregue à sessão que continua.

## Inherited resources and cleanup

A [prova de infraestrutura](02-lambda-microvms-prototype.md#answer) teve resultado utilizável. Por decisão
do Operador em 2026-11-20, seus recursos ficaram retidos para este ticket, que herda o cleanup: imagens
`sfv2proof-min` e `sfv2proof-full`, bucket de artefatos, log groups, roles `sfv2proof-operator` e
`sfv2proof-build` (AWS, `us-east-1`, tag `experiment=sf-v2-lambda-proof`), repositório privado
`Sanmoo/sfv2proof-synthetic` com deploy key, e o código descartável na branch `prototype/v2-lambda-microvms`.
Inventário e ordem de remoção no [relatório](../research/lambda-proof-results.md). Se este ticket for
fechado sem execução, o cleanup continua devido. A autorização de custo e prazo da prova anterior não se
estende a este ticket.

## Authorization gate

Consome tokens de modelo e recursos AWS. Antes de executar: rubrica aprovada, perfil do harness e
modelo resolvido registrados, e autorização específica de consumo, custo, prazo e cleanup, conforme
os [guardrails de ensaios](../../../docs/agents/experiment-proofs.md).

## Answer

Aceito pelo Operador em 2026-11-20, com dois critérios contratuais reprovados. Detalhe e evidência no
[relatório](../research/agent-continuity-results.md), com [avaliação por critério](../research/agent-continuity-assessment.json)
sobre a [rubrica v1](../research/agent-continuity-rubric.json) e [evidência sanitizada](../research/agent-continuity-evidence.json).

**Em parte, no perfil testado.** Pi 1.5.2 do MVP no host, `gpt-6-luna`, ferramentas por um adapter
provisório sobre SSH/WebSocket, tarefa sintética, Controle como fixture, uma campanha válida:

- **Troca planejada: sim.** Avisado, o agente publicou o WIP, o gate aceitou e a MicroVM cessou antes de
  existir outra. No boot reconstruído do Git remoto, a mesma sessão conferiu o estado real e reconstruiu
  artefatos ignorados e imagem Docker antes de usá-los.
- **Efeito externo ambíguo: não repetido.** O contador ficou em 1, com o comando disponível; a sessão
  substituta citou o registro do controlador ao pular o passo.
- **Perda antes do push: retomada sem presumir o que se perdeu, mas incompleta.** A sessão substituta
  refez o trabalho perdido e parou antes do commit final e do push, por entender que dependiam do efeito
  incerto. O critério da sessão substituta foi reprovado por isso.
- **Morte do ambiente não encerra a ativação.** Depois da perda a sessão fez mais dois pedidos de modelo
  e uma tentativa de ferramenta, recusada. O critério de quietude foi reprovado por isso.

**O que a consolidação precisa tratar:**

- O controlador encerra a ativação quando o ambiente morre, e o adapter cancela a chamada em voo ao
  confirmar a cessação (a detecção pelo SSH levou 42 s).
- O que a sessão substituta faz com os passos posteriores a um efeito incerto, e como a reconciliação é
  pedida e autorizada.
- Commit e push antes de toda devolução de controle impostos pelo gate, inclusive para a substituta.
- O aviso de reconstrução entregue à sessão que continua: foi suficiente em uma frase; sem ele não foi testado.

**Não provado aqui:** variância do modelo (uma campanha), troca sob pressão real da margem, gate
recusando, reconciliação, revisores, suspend/resume, oito horas, repositório real. Não é aceite da
fábrica, adapter da v2 nem homologação de produção.

**Consumo e cleanup.** 11 de 12 ativações e 48 de 120 pedidos de modelo; 8 de 12 MicroVMs, 0,43 h;
estimativa abaixo de US$ 0,20 de US$ 10. A primeira campanha foi inválida por defeito do runner e
consumiu 5 ativações. Cleanup total concluído e verificado, inclusive os recursos herdados da prova de
infraestrutura; evidência bruta retida só localmente. Código descartável na branch
`prototype/v2-agent-continuity`, não integrada.

## Comments

- 2026-11-20: aberto ao aprovar a rubrica da prova de infraestrutura sem harness.
- 2026-11-20: reivindicado pelo Operador (sessão Claude Code); branch `docs/v2-agent-continuity-proof`, worktree `.worktrees/v2-agent-continuity-proof/`, destino `main`. Primeira etapa: rubrica, perfil e plano para aprovação, sem modelos nem recursos AWS.
- 2026-11-20: formato decidido com o Operador: Pi real no host com ferramentas por SSH e Controle como fixture; troca planejada com a mesma sessão e perda com sessão substituta; tarefa leve com estado reconstruível. Propostos o [plano de execução](../research/agent-continuity-execution-plan.md) e a [rubrica v1](../research/agent-continuity-rubric.json), ambos pendentes de aprovação. Nada executado.
- 2026-11-20: o Operador aprovou a [rubrica v1](../research/agent-continuity-rubric.json) ([aprovação](../research/agent-continuity-rubric-approval.json)) e autorizou os tetos do [plano](../research/agent-continuity-execution-plan.md) sem ajustes, com cleanup total ao final.
- 2026-11-20: campanha executada. [Resultados](../research/agent-continuity-results.md) com vereditos propostos e [evidência sanitizada](../research/agent-continuity-evidence.json), pendentes de revisão do Operador. Dois critérios contratuais propostos como reprovados na letra (sessão substituta não concluiu a fase; ativação seguiu viva após a perda). Cleanup ainda não executado; nenhuma MicroVM ativa.
- 2026-11-20: resultados aceitos pelo Operador com os dois critérios reprovados; cleanup total concluído e verificado; resolvido.
