# 48: Orçamento do Builder dimensionado para código real, e fim de orçamento como continuação

**What to build:** no piloto 35 toda Execução de Builder em Tickets de código Java esgotou o orçamento `builder-v1` (60 requisições,
`src/workers/oauth-qualification.ts`) em 10–30 minutos: #126 (61 requisições/60 ferramentas, 09:01 UTC), #124 (09:18), #125 (09:30) e
várias depois. O SDK fecha a sessão (`WORKER_QUALIFICATION_CLOSED`), a Execução termina `WORKER_INTERRUPTED` e o controlador abre uma
**recovery**, que consome 1 das 3 do Trabalho. A recovery começa sem o contexto da conversa: relê Ticket, código e skills, e às vezes repete
Perguntas já respondidas (seams). Os Trabalhos #124 e #125 esgotaram as recoveries só por isso e precisaram de `grant`. A parada da VM no fim
do orçamento é também a origem das falhas de disco do ticket 47.

**Blocked by:** 47

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Orçamento por Execução do Builder passa a 150 requisições, 300 ferramentas e 60 minutos, registrado na release. O operador pode ajustá-lo
  por repositório até 2× desses valores; acima disso a configuração é recusada (sem fallback silencioso).
- [ ] Fim de orçamento com progresso (commits ou checkout alterado desde o início) vira **continuação** cobrada num contador próprio de
  5 continuações por Trabalho, não `recoveries`; sem progresso continua indo para recovery.
- [ ] A continuação recebe um resumo estruturado e limitado do estado (última fase, gate rodado e resultado, Perguntas respondidas e respostas),
  sem reler a sessão inteira; respostas já dadas não geram Pergunta repetida.
- [ ] A parada no fim do orçamento usa a parada limpa do ticket 47.
- [ ] Testes offline cobrem detecção de progresso, limite de continuações, resumo limitado e não repetição de Perguntas respondidas.

## Comments

- Evidência: `pl1-pilot-evidence/findings.md` item 8; sessões em `pl1/r/*/profile/sessions/` (contagens por Execução no relatório do piloto).
- A prova real (Ticket de código médio entregue sem `grant`) foi para o [54](54-pilot-2.md).
- Relacionados: [45](45-recovery-cause-and-build-timeouts.md), [47](47-clean-guest-stop-and-disk-recovery.md), [49](49-usage-of-budget-closed-sessions.md).
- 2026-11-19 triagem (operador, decisões registradas): 150 requisições / 300 ferramentas / 60 min, ajuste por repositório até 2×; 5 continuações por Trabalho; bloqueado pelo 47 (parada limpa); prova real no 54.
