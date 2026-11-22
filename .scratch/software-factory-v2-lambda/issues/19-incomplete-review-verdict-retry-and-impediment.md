# 19: Parecer `incomplete`: nova tentativa e Bloqueio visível (A15)

**What to build:** O Host rebaixa um parecer a `incomplete` quando o revisor não leu todo o material exigido naquela invocação. Em sessão continuada o modelo não relê o que já viu, e o Host conta leituras por invocação. Hoje `incomplete` não tem nova tentativa (só falha tem) e o Trabalho fica aberto sem Bloqueio. Decidir e implementar: nova tentativa limitada para `incomplete` e/ou contagem de leitura que respeite a sessão continuada; e um Bloqueio com próximo passo quando a revisão termina `REVIEW_INCOMPLETE`.

Origem: [Aceite da v2 no perfil Lambda](16-v2-acceptance-on-lambda-profile.md), campanha de 2026-11-21 e 22. Os caminhos de evidência são relativos ao diretório local da campanha.

**Blocked by:** nenhum

**Type:** task

**Status:** migrado para [#24](https://github.com/Sanmoo/software-factory-durable/issues/24) em 2026-11-22; a issue é a versão canônica.
## Observed

- Ticket #135 do repositório real (Trabalho `0da1c800`): quatro pareceres `incomplete` nas rodadas r2 a r4, `review-verified not-verified:REVIEW_INCOMPLETE`, publicação `not-publishable`, nenhum Bloqueio. `resume --new-review-round` recusou com `REVIEWER_RETRY_LIMIT_NOT_PENDING`.
- Um `update-scope` do Operador iniciou uma nova Execução verificada (revisão r5 limpa, PR #138): existe saída, mas ela não é indicada como Bloqueio e depende de o Operador perceber.
- Evidência: `final-works/0da1c800-8766-4317-a68d-caf10257e6df.history.json` (10:33–10:41 e 12:43–12:57 UTC), `wfr2/show-1.json`; o motivo `REQUIRED_INPUT_NOT_FULLY_READ` por parecer está no registro corrido, janela 11.

## Why it matters

O gate do código passou e o trabalho estava preservado, mas a entrega parou por um detalhe de contagem de leitura, sem aviso ao Operador (autonomia e CA-12).

## Acceptance criteria

- [ ] Um parecer `incomplete` ganha nova tentativa limitada, ou a regra de leitura deixa de rebaixar o revisor que já leu o material na mesma sessão; a decisão fica registrada.
- [ ] Revisão que termina `REVIEW_INCOMPLETE` deixa um Bloqueio com código e próximo passo (o comando que inicia nova Execução verificada).
- [ ] Teste automatizado com revisor em sessão continuada que não relê um arquivo já lido.
