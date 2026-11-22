# 18: PR fechado por exclusão da branch: causa visível e próximo passo que funciona (A12)

**What to build:** Quando a branch de um Trabalho com PR aberto é apagada na origem, o GitHub fecha o PR. Hoje o Bloqueio `PULL_REQUEST_CLOSED_UNMERGED` manda rodar `factory reopen`, que não pode funcionar sem a branch, e a causa (branch ausente) não aparece. A Factory passa a mostrar a causa e um próximo passo executável; a resposta a uma Pergunta pendente não fica sem leitura.

Origem: [Aceite da v2 no perfil Lambda](16-v2-acceptance-on-lambda-profile.md), campanha de 2026-11-21 e 22. Os caminhos de evidência são relativos ao diretório local da campanha.

**Blocked by:** nenhum

**Type:** task

**Status:** migrado para [#23](https://github.com/Sanmoo/software-factory-durable/issues/23) em 2026-11-22; a issue é a versão canônica.
## Observed

- Ticket #28 do repositório de apoio (Trabalho `8019ed17`), em Pergunta com o PR #29 aberto: branch apagada às 09:12:31 UTC → `pull-request-closed-unmerged`; `factory reopen` → `reopen-attempted known-failure:GITHUB_GRAPHQL_UNPROCESSABLE`, `reopen-not-applied`; o Bloqueio continuou indicando `reopen`. A resposta à Pergunta não foi lida em 10 minutos (`QUESTION_PENDING` permaneceu).
- Evidência: `final-works/8019ed17-3e55-45d0-b77f-552b0d9f5b07.history.json`, `final-works/8019ed17-3e55-45d0-b77f-552b0d9f5b07.show.json`; registro corrido, janela 9.

## Why it matters

O Operador recebe um próximo passo que falha e não vê por quê (CA-12). O caso sem PR já é tratado (Pergunta de `restart` ou `end`); com PR aberto não.

## Acceptance criteria

- [ ] Com o PR fechado e a branch ausente na origem, o `show` diz que a branch não existe mais.
- [ ] O próximo passo indicado é executável nesse estado (por exemplo reiniciar ou encerrar, como no caso sem PR) e não indica `factory reopen`.
- [ ] `factory reopen` com a branch ausente responde com a causa, não com um erro genérico do GitHub.
- [ ] A resposta a uma Pergunta pendente nesse estado é lida, ou o `show` diz por que não será.
