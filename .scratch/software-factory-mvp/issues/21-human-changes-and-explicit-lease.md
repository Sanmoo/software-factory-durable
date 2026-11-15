# 21: Preservar mudanças humanas durante atualização da branch

**What to build:** Ao atualizar a branch do Trabalho, o Builder incorpora a base conforme a política do repositório e preserva mudanças humanas concorrentes. Lease falho ou base-alvo alterada gera reconciliação concreta, não sobrescrita nem nova expectativa capturada às cegas.

**Blocked by:** [10: Perguntar ao operador, cessar e retomar pela fila](10-durable-questions-and-queued-resumption.md); [14: Publicar e reconhecer o PR draft próprio](14-direct-draft-publication-and-discovery.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Rebase é padrão salvo estratégia documentada no AGENTS; ref/OID remoto esperado é capturado e preservado antes da preparação nos registros normais efetivamente usados.
- [ ] Escrita reescrita usa somente branch própria com force-with-lease de ref/OID explícitos; nunca force, tracking ref como expectativa perdida ou reescrita da base.
- [ ] Mudança não atribuível à Factory bloqueia próxima escrita e preserva local/expectativa; lease falho não recaptura a ponta e insiste automaticamente.
- [ ] Pergunta apresenta Trabalho/repo/branch/PR, refs conhecidas/atuais, resultado local, diferenças/autoria comprovável/incertezas e proposta; padrão incorpora/preserva mudanças humanas, descarte exige autorização específica.
- [ ] Resposta autoriza só a divergência concreta, sem renovar orçamento/escopo; nova mudança exige nova avaliação, e mudança de pedido segue autorização/versionamento de escopo.
- [ ] Troca de branch-alvo bloqueia continuação até restauração ou autorização de base compatível e reavaliação de comparação/instruções/reviews/checks; mero avanço da mesma base apta não dispara trabalho.
- [ ] Provas com Git/GitHub e agente reais incluem push humano concorrente, lease falho, recuperação de expectativa e nova divergência após resposta, sem sobrescrever conteúdo humano.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 9.1, 10.1; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-10, V-12 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Comments

- 2026-11-15 (implementation, branch `implement/software-factory-mvp-21`): local increment and one-shot recipe
  `test/entrypoints/humanchanges21-qualification.ts` (namespace `y5/q21-human-v1`) ready; `test:ci` PASS. Real run NOT executed: needs operator
  authorization, the NEW synthetic issue pinned in the recipe, and the operator's human pushes/answers. See
  [evidence 21](../../../docs/evidence/21-human-changes-and-explicit-lease.md).
- 2026-11-15: operator accepted the 5 open points of evidence 21 as MVP limits (different compatible base not authorizable; divergence
  detected only when a write is pending; reconciliation interrupted before start is fail-closed; no rebase onto a newer base with human
  commits; Questions on the issue). Static-review fixes in a follow-up commit (Control-side preservation check before linking, Builder push
  policy, failed reconciliation, restore re-evaluation, precedence, exact answers, recipe guards).
