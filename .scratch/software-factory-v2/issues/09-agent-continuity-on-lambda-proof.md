# Validar a continuidade do agente entre boots em Lambda MicroVMs

Status: open
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

## Authorization gate

Consome tokens de modelo e recursos AWS. Antes de executar: rubrica aprovada, perfil do harness e
modelo resolvido registrados, e autorização específica de consumo, custo, prazo e cleanup, conforme
os [guardrails de ensaios](../../../docs/agents/experiment-proofs.md).

## Comments

- 2026-11-20: aberto ao aprovar a rubrica da prova de infraestrutura sem harness.
