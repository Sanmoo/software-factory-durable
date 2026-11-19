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
- 2026-11-19 (supervisor): assets com ext4 journalado do ticket 47 gerados em `/home/sanmoo/software-factory-test/assets35/assets`, derivados de
  assets34 (manifesto `8efa506a…`) com `deriveJournaledGuestAssets`; só `rootfs` mudou (`has_journal`, estado `clean`). Pin novo: manifesto
  `72e00546beba8e1c8b4b6f9d7a17de635e27fe2de79ffa85688bb2bdeebb5c12`. A release do piloto 2 usa esse pin; ambientes preparados com o pin
  anterior (inclusive os da `pl1`) não sobem com ele, então o piloto 2 começa com ambientes novos.
