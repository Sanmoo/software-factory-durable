# 07: Admitir um único Trabalho por Ticket elegível

**What to build:** O operador torna uma issue elegível e vê um único Trabalho persistente, com origem, posição e impedimentos compreensíveis. Repetir polling ou reiniciar não duplica o ciclo nem adota PR alheio.

**Blocked by:** [04: Diagnosticar o acesso GitHub pela identidade da Factory](04-github-app-access-diagnostics.md)

**Status:** resolved

## Acceptance criteria

- [x] Somente repo autorizado, issue aberta e label efetiva configurada autorizam entrada; identidades GitHub qualificadas e estáveis são preservadas além de nomes/números/URLs.
- [x] Ausência de ciclo vigente, Trabalho, índice Ticket/ciclo e sequência de admissão são confirmados atomicamente; polling concorrente/repetido e restart não criam duplicatas.
- [x] PR associado não reconhecido como próprio impede admissão/adoção automática e é reportado com motivo e próximo passo.
- [x] List/status/show apresentam resultado, autorização, fila e impedimentos sem colapsar dimensões; listagem parcial ou falha remota não comprova ausência de Ticket/label/PR.
- [x] Polling usa padrão de 60 segundos configurável, respeita headers/rate limit/backoff e não sobrepõe consultas descontroladamente; pausa impede novos disparos, não acompanhamento.
- [x] Fluxo padrão não altera labels, assignees, Projects ou status personalizados nem captura a especificação pelo controlador.
- [x] Testes de fluxo com persistência real e integração GitHub autorizada demonstram admissão única e diagnóstico; despacho aguarda a avaliação de dependências e a fatia de ativação.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 3.2, 3.3, 3.4, 4.1, 11.2, 12.1; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-04, V-15 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-14: admissão única durável com polling, list/status/show e associação nativa de PR; gate local 719/0; dois ensaios reais no GitHub (Sanmoo/java-springboot-event-sourcing, issues #1 e #3) sem mutações. Evidência: `docs/evidence/07-unique-ticket-admission.md`.
