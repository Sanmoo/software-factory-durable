# Validar a continuidade do agente entre boots em Lambda MicroVMs

Status: claimed
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

## Comments

- 2026-11-20: aberto ao aprovar a rubrica da prova de infraestrutura sem harness.
- 2026-11-20: reivindicado pelo Operador (sessão Claude Code); branch `docs/v2-agent-continuity-proof`, worktree `.worktrees/v2-agent-continuity-proof/`, destino `main`. Primeira etapa: rubrica, perfil e plano para aprovação, sem modelos nem recursos AWS.
