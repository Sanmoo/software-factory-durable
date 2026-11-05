# 29: Inspecionar toda a cadeia e o consumo pela CLI

**What to build:** O operador navega pela CLI humana ou JSON entre Ticket, Trabalho, Execuções, evidências e recursos, entendendo causa, histórico e próximo passo. Uso/custo e saídas grandes mostram limites de observação em vez de falso zero ou verde.

**Blocked by:** [17: Confirmar entrega e limpar somente recursos próprios](17-confirmed-delivery-and-owned-cleanup.md); [23: Tratar feedback humano e reparos explícitos no mesmo ciclo](23-human-feedback-and-explicit-repairs.md); [25: Operar retirada de autorização, cancelamento e novos ciclos](25-authorization-withdrawal-and-work-cycles.md); [28: Recuperar revisão parcial sem perder parecer válido](28-partial-review-recovery.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Status/list/show mostram pausa, Slots/filas e, por Trabalho, identidades, branch/PR, resultado/autorização/impedimentos, fase/espera, duração/última atividade, modelos/configuração e cleanup.
- [ ] History/logs/read de evidências são paginados e filtráveis por Execução/papel, com links/referências de perguntas, tentativas/correções/recoveries, gates, pareceres, efeitos, ambientes/boots e recursos.
- [ ] Consulta operacional passa por Control/Records com contratos públicos e sem banco paralelo/leitura offline de autoridade; indisponibilidade, recusa e resultado indeterminado têm códigos JSON estáveis, alcance e próximo passo sem segredo.
- [ ] Observações externas exibem instante/frescura/completude; íntegro, trecho truncado com íntegra disponível, captura incompleta, ausente, removido, expirado e desconhecido são distintos.
- [ ] Saída volumosa pode ser lida pelo agente em cópia seletiva filtrada no ambiente próprio, sem montar registros host ou criar ferramenta de logs; cópia editável não certifica gate.
- [ ] Uso/custo por papel/Execução/Trabalho/instalação inclui revisores/falhas/abortos quando mensuráveis e não duplica sessão retomada/notificação; completo/parcial/indisponível são distintos de zero observado.
- [ ] Estimativa SDK informa modelo/provider/unidade/moeda disponível e não é fatura; RAM/CPU/I/O/disco do adapter são separados de tokens/custo e configuração virtual, sem consultar billing ou inventar preços.
- [ ] Perda auxiliar de uso/progresso registra lacuna; falha de contexto/resultado crítico barra passos dependentes e solicita parada pertinente, sem alegar erro persistido se storage falhou nem publicar logs/sessões no GitHub.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 2.3, 11.3, 12.1, 12.2; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-11, V-15 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
