# 29: Inspecionar toda a cadeia e o consumo pela CLI

**What to build:** O operador navega pela CLI humana ou JSON entre Ticket, Trabalho, Execuções, evidências e recursos, entendendo causa, histórico e próximo passo. Uso/custo e saídas grandes mostram limites de observação em vez de falso zero ou verde.

**Blocked by:** [17: Confirmar entrega e limpar somente recursos próprios](17-confirmed-delivery-and-owned-cleanup.md); [23: Tratar feedback humano e reparos explícitos no mesmo ciclo](23-human-feedback-and-explicit-repairs.md); [25: Operar retirada de autorização, cancelamento e novos ciclos](25-authorization-withdrawal-and-work-cycles.md); [28: Recuperar revisão parcial sem perder parecer válido](28-partial-review-recovery.md)

**Status:** resolved

## Acceptance criteria

- [x] Status/list/show mostram pausa, Slots/filas e, por Trabalho, identidades, branch/PR, resultado/autorização/impedimentos, fase/espera, duração/última atividade, modelos/configuração e cleanup.
- [x] History/logs/read de evidências são paginados e filtráveis por Execução/papel, com links/referências de perguntas, tentativas/correções/recoveries, gates, pareceres, efeitos, ambientes/boots e recursos.
- [x] Consulta operacional passa por Control/Records com contratos públicos e sem banco paralelo/leitura offline de autoridade; indisponibilidade, recusa e resultado indeterminado têm códigos JSON estáveis, alcance e próximo passo sem segredo.
- [x] Observações externas exibem instante/frescura/completude; íntegro, trecho truncado com íntegra disponível, captura incompleta, ausente, removido, expirado e desconhecido são distintos.
- [x] Saída volumosa pode ser lida pelo agente em cópia seletiva filtrada no ambiente próprio, sem montar registros host ou criar ferramenta de logs; cópia editável não certifica gate.
- [x] Uso/custo por papel/Execução/Trabalho/instalação inclui revisores/falhas/abortos quando mensuráveis e não duplica sessão retomada/notificação; completo/parcial/indisponível são distintos de zero observado.
- [x] Estimativa SDK informa modelo/provider/unidade/moeda disponível e não é fatura; RAM/CPU/I/O/disco do adapter são separados de tokens/custo e configuração virtual, sem consultar billing ou inventar preços.
- [x] Perda auxiliar de uso/progresso registra lacuna; falha de contexto/resultado crítico barra passos dependentes e solicita parada pertinente, sem alegar erro persistido se storage falhou nem publicar logs/sessões no GitHub.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 2.3, 11.3, 12.1, 12.2; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-11, V-15 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Comments

- 2026-11-15 (implement/software-factory-mvp-29, on top of the ticket 23 branch): `history`/`logs`/`log`/`usage` inspect kinds and CLI commands,
  `show.chain`, and status impediments/consumption. Usage comes from preserved Pi sessions (deduplicated; complete/partial/unavailable, never a
  false zero); evidence states are distinct; views fit one frame; stable error codes. Evidence and AC→test map:
  [docs/evidence/29-correlated-cli-observability-and-usage.md](../../../docs/evidence/29-correlated-cli-observability-and-usage.md).
  Local recipe `inspect29-qualification` is written, not run (after rebase). Proposal for the `RECOVERY_BLOCKED` unblock (via `resume`, tickets
  26/27) is recorded in the evidence. Not resolved until the review.
- 2026-11-16 (rebase onto 19c2327, review fixes): list/show/usage paging, Records-level logs paging, sessions bound to their boot, ticket 30
  session copies and `expired` details, ticket 31 forgotten Works, recipe hardening; `test:ci` green on 6715178. The `RECOVERY_BLOCKED`
  override is ticket 41 (ticket 29 stays observation-only).
- 2026-11-16 (supervisor): local run `y5/q29-inspect-v1` on 6715178 MET (both sources, every check). Gaps recorded: measured token usage
  was not exercised on real data (no readable session in either storage), and q18's logs listing is `incomplete` (non-capture entries in the
  evidence area).

## Answer

Correlated inspection and consumption delivered through Control and the CLI:
- `show` carries the chain, with phase/next step, models and freshness; `status` shows impediments and consumption.
- `history`/`logs`/`log` are paginated and filtered by Execution/role.
- `usage` per role/Execution/Work/installation is complete/partial/unavailable, never a false zero, with continued sessions deduplicated and
  ticket 30 copies read.
- Evidence states are distinct, views fit one frame, error codes are stable, and everything is read-only.

Tests are storage-real with real Records and sessions and the real CLI over the socket. The local run `q29-inspect-v1` over copies of
q18-journey-v4 and q25-cancel-v1 was met. Evidence:
[docs/evidence/29-correlated-cli-observability-and-usage.md](../../../docs/evidence/29-correlated-cli-observability-and-usage.md).
