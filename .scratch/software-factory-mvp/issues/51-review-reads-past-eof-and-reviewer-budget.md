# 51: Revisão incompleta falsa por leitura além do fim, e orçamento do revisor para mudanças médias

**What to build:** no piloto 35 nenhuma revisão real terminou verificada:

- **#124 (rodadas 1 e 4):** o revisor Spec leu o índice, o patch completo e os 17 arquivos alterados inteiros e concluiu `clean`, mas o Host
  rebaixou a rodada para incompleta (`SOURCE_UNREADABLE`) porque o revisor pediu leituras além do fim de arquivos já lidos até o fim ("Offset
  401 is beyond end of file (259 lines total)"). `src/workers/review.ts:111` conta toda leitura falha em `hostChecks.failedReads`. O Builder
  perguntou ao operador duas vezes como seguir.
- **#124 (rodada 4):** o Standards foi interrompido (`REVIEWER_INTERRUPTED`) com o limite de recovery do revisor.
- **#126 (3º ciclo):** o Standards concluiu `clean` em 12 requisições; o Spec esgotou o orçamento `reviewer-v1` de 24 requisições três vezes
  (`WORKER_QUALIFICATION_CLOSED`) e a Execução ficou retida com `REVIEWER_RETRY_LIMIT`, sem comando para continuar. O Ticket foi retirado do
  piloto. O ticket 43 já tinha mantido o orçamento em 24 depois de corrigir a releitura em reconciliações.

**Blocked by:** —

**Type:** task

**Status:** needs-triage

## Acceptance criteria

- [ ] Leitura além do fim de um arquivo que o revisor já leu até a última linha não é fonte ilegível; o motivo do Host diz o caminho e o
  offset quando a leitura falha de verdade (teste de regra com os casos do piloto).
- [ ] Orçamento do revisor revisto com as medições do piloto (requisições por rodada no #124, #125 e #126); proporcional ao tamanho da mudança
  ou com um teto maior registrado na release.
- [ ] `REVIEWER_RETRY_LIMIT` tem decisão explícita do operador (nova rodada, aceitar a rodada com a opinião disponível, ou cancelar),
  registrada; a Execução não fica retida indefinidamente.
- [ ] Prova real: um Ticket médio com as duas revisões verificadas.

## Comments

- Evidência: `pl1-pilot-evidence/findings.md` itens 11 e 12; `artifacts/review/r1/index.json` do ambiente do #124; sessões dos revisores em
  `pl1/r/BJksTe-QQZ2bYkcgbfjdkg/`.
- Relacionados: [43](43-reconciliation-review-own-patch.md), [52](52-cancel-of-held-execution.md).
