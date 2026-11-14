# 19: Aplicar limites, timeout opcional e concessões explícitas

**What to build:** O operador entende quanto orçamento foi reservado/consumido, por que uma Execução atingiu limite ou timeout e como conceder capacidade adicional explicitamente. Esperas e reinícios não zeram contadores nem criam um teto global implícito.

**Blocked by:** [09: Iniciar Builder com checkout próprio e pedido preservado](09-builder-start-and-preserved-request.md); [10: Perguntar ao operador, cessar e retomar pela fila](10-durable-questions-and-queued-resumption.md)

**Status:** resolved

## Acceptance criteria

- [x] Correções e recoveries têm limites separados configuráveis, padrão três/três; reserva é atômica na admissão e consumo único depende de início confirmado, não de cada teste, push ou evento.
- [x] Não início comprovado libera sem consumo; início incerto mantém reserva. Pergunta/continuação preservam identidade e cobrança da correção, e configuração/restart não apagam esgotamento.
- [x] Grant via ingresso autorizado adiciona corrections ou recoveries com histórico sem reiniciar contadores; falha de autorização/configuração e esgotamento não geram loop automático.
- [x] Timeout é opcional por repo e por Execução, incluindo comandos/reviews; ausente não há corte de 60 minutos, e espera externa encerra atividade/relógio sem contornar timeout já atingido.
- [x] Relógio monotônico local governa duração viva/timer independente de logs, sem comparar origens entre processos nem substituir relógio dos waits Pi Durable; calendário é apresentação/auditoria.
- [x] Timeout configurado interrompe/bloqueia para intervenção; duração comprovada, estimada e desconhecida após crash são distintas, e impossibilidade de excluir ultrapassagem impede retomada automática.
- [x] CLI mostra limites/reservas/consumos, duração/última atividade e ação necessária; silêncio não é travamento, desconhecido não é zero e cancelamento permanece acessível.
- [x] Regras/fluxos com tempo controlado e disparo real pertinente comprovam limiar, espera, ajuste de calendário e histórico, sem exigir longa espera real em toda permutação.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 4.4, 5.7, 11.3, 12.1; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-06, V-13, V-15 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-14: limites separados de correção/retomada com reserva atômica e consumo único, concessão explícita, timeout opcional por repo/Execução com relógio monotônico, reconciliação após crash e visão de limites na CLI; sem corte implícito de relógio em produção. Gate local 931/0; ensaio real com timeout em 90 s, interrupção, revogação e bloqueio sem loop. Evidência: `docs/evidence/19-budgets-optional-timeout-and-grants.md`.
