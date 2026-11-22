# 21: Reparo de conflito descartado para satisfazer o portão de preservação (A17)

**What to build:** Num reparo automático de conflito, o Builder fez rebase (história reescrita), não rodou o gate, o portão de preservação recusou o push não fast-forward e o Builder executou `git reset --hard` para a ponta publicada, descartando o reparo. A correção fechou como `not-publishable`, o PR seguiu em conflito e o Trabalho ficou aberto sem Bloqueio e sem nova correção. Tratar as três pontas: orientação do reparo de conflito (merge da base, sem reescrever história publicada), portão que não aceita como "preservado" um estado que descarta commits locais, e Bloqueio quando a correção fecha sem publicar.

Origem: [Aceite da v2 no perfil Lambda](16-v2-acceptance-on-lambda-profile.md), campanha de 2026-11-21 e 22. Os caminhos de evidência são relativos ao diretório local da campanha.

**Blocked by:** nenhum

**Type:** task

**Status:** needs-triage

## Observed

- Ticket #10 do repositório de apoio (Trabalho `0e0d892b`), PR #36: `correction-opened` automático às 13:58:05 UTC; `review-verified not-verified:GATE_NOT_RUN:ticket-validation-13-steps`; `preservation-refused ci-wait:HEAD_NOT_PUBLISHED` (HEAD `562dc90` não é a ponta da branch na origem); 43 s depois `preservation-accepted` na ponta antiga (`7b83a36`); `correction-closed not-publishable`. Nenhum Bloqueio até o cancelamento.
- O rebase e o `git reset --hard` constam do registro corrido (fim da janela 11); o histórico mostra a recusa e o aceite na ponta antiga. Não foi repetido.
- Evidência: `final-works/0e0d892b-d452-4c98-9e96-7694d1a57f40.history.json` (13:58–14:12 UTC), `final-works/0e0d892b-d452-4c98-9e96-7694d1a57f40.show.json`.

## Why it matters

Trabalho revisado é jogado fora sem registro de perda, e o Trabalho para sem próximo passo: contraria a preservação (V2-05) e a autonomia. Sem disco persistente não há como recuperar o reparo descartado.

## Acceptance criteria

- [ ] O reparo de conflito é orientado a incorporar a base sem reescrever a história já publicada da branch.
- [ ] O portão de preservação não aceita um HEAD que regrediu em relação a commits locais vistos na recusa anterior sem registrar o descarte (perda visível ou ref de marcador).
- [ ] Correção que fecha `not-publishable` com o PR ainda em conflito deixa Bloqueio com próximo passo ou abre nova correção dentro do orçamento.
- [ ] Teste automatizado do cenário: rebase, recusa do portão, tentativa de reset.
