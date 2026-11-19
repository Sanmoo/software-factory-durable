# 49: `factory usage` mede as Execuções encerradas por orçamento ou interrupção

**What to build:** no piloto 35 o `factory usage` da instalação terminou com `measurement: partial`, 48 atividades, 20 `unavailable`, e total de
14,3 M tokens. A soma deduplicada do uso registrado nas próprias sessões preservadas (`pl1/r/*/profile/sessions/*.jsonl`, campo `usage` de cada
mensagem do assistente) deu 53,2 M tokens. As atividades não medidas são justamente as Execuções que terminaram `WORKER_INTERRUPTED` (orçamento,
abort): o registro da Execução fica com `end.session: null`, embora o arquivo da sessão exista. Com isso o teto de consumo aprovado pelo
operador (regra de parada do piloto) não podia ser controlado pelo produto; o supervisor precisou somar as sessões por fora.

**Blocked by:** —

**Type:** task

**Status:** needs-triage

## Acceptance criteria

- [ ] Uma Execução interrompida cuja sessão existe registra a referência da sessão (como as que terminam normalmente), e `usage` a mede.
- [ ] `usage` distingue "não medido porque a sessão não existe" de "não medido porque a referência não foi registrada"; o segundo caso não
  ocorre mais.
- [ ] Mensagens copiadas em sessões continuadas continuam contadas uma vez (regra atual).
- [ ] Opcional (decisão de triagem): teto de tokens por instalação com pausa automática registrada.
- [ ] Teste de regra e prova com as sessões do piloto (`pl1`): o total do `usage` bate com a soma das sessões.

## Comments

- Evidência: `pl1-pilot-evidence/usage-final.json`, `session-tokens-final.txt`, `session-tokens.py`.
