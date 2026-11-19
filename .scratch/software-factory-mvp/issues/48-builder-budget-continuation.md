# 48: Orçamento do Builder dimensionado para código real, e fim de orçamento como continuação

**What to build:** no piloto 35 toda Execução de Builder em Tickets de código Java esgotou o orçamento `builder-v1` (60 requisições,
`src/workers/oauth-qualification.ts`) em 10–30 minutos: #126 (61 requisições/60 ferramentas, 09:01 UTC), #124 (09:18), #125 (09:30) e
várias depois. O SDK fecha a sessão (`WORKER_QUALIFICATION_CLOSED`), a Execução termina `WORKER_INTERRUPTED` e o controlador abre uma
**recovery**, que consome 1 das 3 do Trabalho. A recovery começa sem o contexto da conversa: relê Ticket, código e skills, e às vezes repete
Perguntas já respondidas (seams). Os Trabalhos #124 e #125 esgotaram as recoveries só por isso e precisaram de `grant`. A parada da VM no fim
do orçamento é também a origem das falhas de disco do ticket 47.

**Blocked by:** —

**Type:** task

**Status:** needs-triage

## Acceptance criteria

- [ ] O orçamento por Execução do Builder é revisto com base nas medições do piloto (requisições e ferramentas por Execução nos Tickets #124–#126)
  e registrado na release; o operador pode ajustá-lo por repositório sem fallback silencioso.
- [ ] Fim de orçamento com progresso (commits ou checkout alterado desde o início) vira **continuação** cobrada num contador próprio e
  limitado, não `recoveries`; sem progresso continua indo para recovery.
- [ ] A continuação recebe um resumo estruturado e limitado do estado (última fase, gate rodado e resultado, Perguntas respondidas e respostas),
  sem reler a sessão inteira; respostas já dadas não geram Pergunta repetida.
- [ ] A parada no fim do orçamento usa a parada limpa do ticket 47.
- [ ] Prova real: um Ticket de código médio entregue sem `grant`.

## Comments

- Evidência: `pl1-pilot-evidence/findings.md` item 8; sessões em `pl1/r/*/profile/sessions/` (contagens por Execução no relatório do piloto).
- Relacionados: [45](45-recovery-cause-and-build-timeouts.md), [47](47-clean-guest-stop-and-disk-recovery.md), [49](49-usage-of-budget-closed-sessions.md).
