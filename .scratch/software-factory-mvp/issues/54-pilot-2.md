# 54: Piloto 2 — prova real das correções dos bloqueadores do piloto 1

**What to build:** uma janela autorizada de piloto, nos moldes do ticket 35, para provar em execução real as correções dos tickets 47, 48, 50
e 51, que fecham só com testes offline. Pedido de autorização próprio (raiz, repositório de teste, Tickets, teto de tokens, regras de parada),
seguindo os guardrails de ensaios.

**Blocked by:** 47, 48, 50, 51

**Type:** task

**Status:** needs-triage

## Acceptance criteria

- [ ] Pedido de autorização do piloto 2 aprovado pelo operador antes de qualquer boot.
- [ ] (47) Build Gradle interrompido pelo fim do orçamento seguido de boot da recovery/continuação no mesmo ambiente, sem
  `START_PRESERVED_DISK_CHECK_REQUIRED`.
- [ ] (48) Um Ticket de código médio entregue sem `grant`.
- [ ] (50) Recusa de boot por memória volta à fila sozinha; uma recusa não transitória é retomada por decisão do operador sem `cancel` + `new`.
- [ ] (51) Um Ticket médio com as revisões Spec e Standards verificadas.
- [ ] Relatório do piloto 2 com resultado por critério e novos achados registrados como tickets.

## Comments

- Criado na triagem de 2026-11-19 a partir dos critérios de prova real retirados de 47, 48, 50 e 51.
- Relacionados: [35](35-authorized-pilot-and-human-mvp-assessment.md), relatório do piloto 1 em `docs/evidence/35-pilot-report.md`.
