# 10: Morte do ambiente encerra a ativação

**What to build:** Na prova de continuidade, a ativação seguiu viva depois da morte do ambiente. Aqui isso deixa de acontecer: o adapter observa a
condição do ambiente pelo serviço em intervalo declarado, haja ou não chamada em curso. Cessação confirmada cancela a chamada em voo,
nega novas chamadas e faz o Controle encerrar a ativação. Observa-se o ambiente, não o trabalho: silêncio do agente ou comando longo
continuam não sendo motivo de parada.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-15 (gate obrigatório: a prova reprovou a ausência disto, I2).

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 06

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] O adapter consulta a condição do ambiente pelo serviço no intervalo declarado no perfil, com ou sem chamada em curso.
- [ ] Cessação confirmada com chamada em voo: a chamada é cancelada e devolvida como falha de ambiente encerrado.
- [ ] Depois da cessação confirmada, toda nova chamada de ferramenta é negada.
- [ ] O Controle encerra a ativação: nenhum pedido de modelo nem chamada de ferramenta acontece depois da cessação confirmada (asserção explícita no teste, por ser o gate obrigatório da spec).
- [ ] Comando longo e agente silencioso com ambiente vivo não encerram nada; a regra "sem watchdog sobre trabalho silencioso" do MVP permanece.
- [ ] Falha ao consultar o serviço não equivale a cessação: o resultado é desconhecido e a observação segue.
- [ ] O encerramento registra o boot com o motivo observado, para os tickets de perda.
