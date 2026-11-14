# 08: Liberar execução somente com dependências nativas satisfeitas

**What to build:** Um Trabalho só pode iniciar quando o grafo nativo de bloqueadores acessíveis foi lido e suas condições de satisfação foram comprovadas. O operador vê por que um dependente espera sem impedir o avanço dos independentes.

**Blocked by:** [07: Admitir um único Trabalho por Ticket elegível](07-unique-ticket-admission.md)

**Status:** resolved

## Acceptance criteria

- [x] Consulta usa exclusivamente blocked_by nativo via gh api/REST, com páginas/destinos completos e identidades qualificadas; não interpreta prosa, blocking inverso, duplicatas ou labels como fallback.
- [x] Travessia alcançável visita inclusive encerrados e distingue nó compartilhado de ciclo no caminho; relação inválida, ciclo, inacessibilidade e erro após página emitida impedem liberação.
- [x] Externo exige closed/completed; aberto/reaberto, not_planned, duplicate e motivo desconhecido não satisfazem.
- [x] Próprio exige merge confirmado do ciclo vigente ou último aplicável; fechamento da issue, cancelamento ou entrega de ciclo anterior não satisfazem ciclo novo, inclusive com memória mínima.
- [x] Avaliação registra origem/principal/escopo sem token, instante, completude e motivos, e é refeita antes de cada início/retomada/reparo; observação antiga não concede novo despacho.
- [x] Repos executáveis e acessíveis apenas para dependência são distintos; pré-voo não cria issues/arestas por repo nem certifica manualmente todos os pares.
- [x] Cenários reais locais/cross-repo/cross-owner/visibilidade declarados são comprovados sob autorização; omissão silenciosa não detectável é levada ao operador, não declarada suportada.
- [x] Regras e fluxos usam mesmos contratos com storage real temporário; bloqueador próprio fechado com PR aberto não libera, e impedido não bloqueia seleção independente.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 4.2, 4.3, 13.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-05, V-06 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-14: gating por `blocked_by` nativo com avaliação durável e reavaliada por round; satisfação só direta (decisão do operador); gate local 743/0; ensaio real (Sanmoo/java-springboot-event-sourcing #1/#3/#4) cobrindo próprio, externo open/not_planned/reopened/completed, ciclo recusado pelo GitHub e restart. Cenários cross-repo/cross-owner/visibilidade não exercitáveis com um repo, declarados. Evidência: `docs/evidence/08-native-dependency-gating.md`.
