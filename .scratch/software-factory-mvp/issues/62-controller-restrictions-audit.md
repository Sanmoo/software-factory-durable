# 62: Auditoria das restrições do Controller com base nos pilotos

**What to build:** o operador avalia que o Controller tem restrições demais e que elas geram paradas e intervenções. Nos pilotos 1 e 2,
a maioria dos bloqueios veio de defeitos ou limites mal calibrados em volta de regras corretas (55, 56, 57, 59, 60, 61), mas algumas
restrições parecem rígidas demais. Auditar cada restrição do Controller e propor manter, recalibrar, criar um caminho de saída ou relaxar.

**Blocked by:** —

**Type:** task

**Status:** migrado para [#21](https://github.com/Sanmoo/software-factory-durable/issues/21) em 2026-11-22; a issue é a versão canônica.
## Acceptance criteria

- [ ] Inventário das restrições do Controller (limites, recusas, bloqueios, regras de verificação e publicação), cada uma com: o que protege,
  quantas vezes bloqueou nos pilotos 1 e 2 (acerto ou falso positivo), custo observado (recuperações, tokens, intervenções do operador).
- [ ] Proposta por restrição: manter, recalibrar, criar saída ou relaxar, com a justificativa.
- [ ] Fora de revisão (invariantes): o Factory nunca aprova nem faz merge, não contorna proteção de branch, credenciais isoladas, push só na
  branch própria.
- [ ] Decisões do operador registradas e convertidas em tickets de implementação.

## Comments

- Candidatos observados no piloto 2: orçamento do revisor (48 requisições) esgotado repetidamente; `not-publishable` sem próximo passo (58);
  achado só heurístico do Standards impede verificação até o operador pedir `not-adopted`; o guest não enxerga a base atualizada fora da
  correção de conflito (Pergunta do #126); recuperações operacionais consumidas por defeitos do Host.
- Evidência: `docs/evidence/54-pilot-2-authorization-request.md` §11–13; `/home/sanmoo/software-factory-test/pl2-pilot-evidence/findings.md`
  item 14; `/home/sanmoo/software-factory-test/pl1-pilot-evidence/`.
