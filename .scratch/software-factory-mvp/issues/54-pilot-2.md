# 54: Piloto 2 — prova real das correções dos bloqueadores do piloto 1

**What to build:** uma janela autorizada de piloto, nos moldes do ticket 35, para provar em execução real as correções dos tickets 47, 48, 50
e 51, que fecham só com testes offline. Pedido de autorização próprio (raiz, repositório de teste, Tickets, teto de tokens, regras de parada),
seguindo os guardrails de ensaios.

**Blocked by:** 44, 47, 48, 50, 51, 53

**Type:** task

**Status:** migrado para [#19](https://github.com/Sanmoo/software-factory-durable/issues/19) em 2026-11-22; a issue é a versão canônica.
## Acceptance criteria

- [ ] Pedido de autorização do piloto 2 aprovado pelo operador antes de qualquer boot.
- [ ] (47) Build Gradle interrompido pelo fim do orçamento seguido de boot da recovery/continuação no mesmo ambiente, sem
  `START_PRESERVED_DISK_CHECK_REQUIRED`.
- [ ] (48) Um Ticket de código médio entregue sem `grant`.
- [ ] (50) Recusa de boot por memória volta à fila sozinha; uma recusa não transitória é retomada por decisão do operador sem `cancel` + `new`.
- [ ] (51) Um Ticket médio com as revisões Spec e Standards verificadas.
- [ ] (44) O repositório de teste com `.factory/environment.yaml` (JDK 25, mergeado pelo operador) tem `java -version` 25 no guest do primeiro
  Trabalho sem ação do Builder, o mesmo ambiente nos seguintes, e Testcontainers/Ryuk funcionando; o gate do Ticket é só o comando do projeto.
- [ ] (53) Perguntas por Ticket separadas por origem (Ticket, skill, ambiente, produto).
- [ ] Relatório do piloto 2 com resultado por critério e novos achados registrados como tickets.

## Comments

- Criado na triagem de 2026-11-19 a partir dos critérios de prova real retirados de 47, 48, 50 e 51.
- Relacionados: [35](35-authorized-pilot-and-human-mvp-assessment.md), relatório do piloto 1 em `docs/evidence/35-pilot-report.md`.
- 2026-11-19 (supervisor): assets com ext4 journalado do ticket 47 gerados em `/home/sanmoo/software-factory-test/assets35/assets`, derivados de
  assets34 (manifesto `8efa506a…`) com `deriveJournaledGuestAssets`; só `rootfs` mudou (`has_journal`, estado `clean`). Pin novo: manifesto
  `72e00546beba8e1c8b4b6f9d7a17de635e27fe2de79ffa85688bb2bdeebb5c12`. A release do piloto 2 usa esse pin; ambientes preparados com o pin
  anterior (inclusive os da `pl1`) não sobem com ele, então o piloto 2 começa com ambientes novos.
- 2026-11-20 (supervisor): janela do piloto 2 aberta às 03:19 UTC e encerrada às 05:41 UTC pela regra de parada global (defeito da Factory que
  bloqueia todo Trabalho), sem nenhuma entrega. Comprovados: (44) ambiente declarado preparado (JDK 25) e reaproveitado; (50) recusa de memória
  volta à fila sozinha (duas vezes); (48) fim de orçamento com continuação no mesmo ambiente (`requests` 40); (51) revisões Standards e Spec
  limpas no #125. Reprovado: (47) a parada `clean` perde escritas de metadados do disco raiz → `START_PRESERVED_DISK_CHECK_REQUIRED` nos três
  Trabalhos, inclusive depois de `replace-disk`. Novos tickets: [55](55-guest-stop-loses-root-metadata-writes.md) (defeito do disco),
  [56](56-gate-declaration-against-observed-run.md), [57](57-reviewer-retries-charge-work-recoveries.md),
  [58](58-not-publishable-without-pr-next-step.md). Ruleset restaurado, serviço parado, chave da App removida; `pl2` preservada como evidência
  (Trabalhos pausados). 62,3 M tokens nas sessões. Detalhe em `docs/evidence/54-pilot-2-authorization-request.md` §11 e
  `/home/sanmoo/software-factory-test/pl2-pilot-evidence/findings.md`. Um novo piloto fica bloqueado por 55.
- 2026-11-20 (supervisor), **correção do comentário anterior:** o critério (47) **não** foi reprovado. A investigação do [55](55-guest-stop-loses-root-metadata-writes.md)
  mostrou que nenhuma escrita do guest se perdeu: a checagem de disco do start convertia a imagem inteira com o limite de 30 s das chamadas
  pequenas. Sob carga (discos de 13–17 GiB, três checagens juntas depois do reinício), a conversão era cortada e o disco recusado. O "dano"
  que o supervisor viu era de cópias truncadas, e o "disco novo do replace-disk" era o disco antigo (o remédio deu `not-needed`). A conversão
  completa do disco do #124 passa no `e2fsck`. A parada global das 05:41 se baseou nesse diagnóstico errado. Corrigido em `532402e`
  (passos de imagem inteira com limite de 30 min; motivo da recusa registrado). Os três Trabalhos da `pl2` têm discos íntegros e voltam com
  `--retry-blocked-start` numa release com a correção. A prova real do (47) continua pendente: fim de orçamento com continuação no mesmo
  ambiente passou, mas as paradas sob carga só foram checadas com a correção fora do piloto (ticket 55, 6 runs).
- 2026-11-20 (supervisor), **janela 2 encerrada:** os três Trabalhos foram entregues (PRs #130, #131 e #132 mesclados pelo operador). O (47)
  ficou comprovado com a correção 55. Corrigidos na janela: [60](60-truncated-bash-copy-denied-by-snapshot-probe.md) e
  [61](61-concurrent-own-publication-flags-unexpected-ref.md). Auditoria de restrições aberta em
  [62](62-controller-restrictions-audit.md). Reversão feita (ruleset restaurado, serviço parado, chave da App removida). Detalhe em
  `docs/evidence/54-pilot-2-authorization-request.md` §13.
