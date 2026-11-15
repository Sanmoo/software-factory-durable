# 30: Aplicar retenção e cleanup explícito sem perder contexto necessário

**What to build:** O operador vê e controla a remoção de detalhes e recursos sem perder contexto necessário ou apagar Trabalho não entregue automaticamente. Retenção e cleanup explícito preservam evidências protegidas e revalidam segurança no momento da remoção.

**Blocked by:** [17: Confirmar entrega e limpar somente recursos próprios](17-confirmed-delivery-and-owned-cleanup.md); [25: Operar retirada de autorização, cancelamento e novos ciclos](25-authorization-withdrawal-and-work-cycles.md)

**Status:** resolved

## Acceptance criteria

- [x] Varredura de boot após reconciliação e diária torna logs/sessões de entregue elegíveis por padrão 30 dias após merge confirmado, configurável, sem daemon adicional.
- [x] Não entregues, inclusive bloqueados/cancelados/PR fechado sem merge, conservam detalhes até limpeza explícita; prazo não autoriza apagar para abrir espaço.
- [x] Evidência necessária a pendência/efeito/cleanup e recurso em uso são protegidos mesmo após prazo; fim da pendência torna elegível na próxima varredura, sem novos 30 dias.
- [x] Resumo/histórico/referências/revisões/decisões ficam até exclusão explícita e não somem com ambiente; preservar evidências necessárias precede remoção de origem.
- [x] Cleanup explícito seleciona recursos/logs/sessões, apresenta plano de perdas e exige confirmação, inclusive modo de automação com mesmas verificações.
- [x] Plano é revalidado ao executar por ownership, cessação, estado, uso e necessidade de recuperação; recurso que se tornou ativo/protegido não é apagado por plano antigo.
- [x] Destruir ambiente/contexto de Trabalho aberto exige cancelamento prévio; aviso explica quando remover sessão/log inviabiliza retomada, sem presumir recriação por resume ou cancelar implicitamente.
- [x] Regras com relógio controlado e integração real de armazenamento/disparo/remoção cobrem prazo, proteção, falha parcial e seleção obsoleta; CLI explica arquivos removidos/expirados em vez de vazio.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 12.1, 12.3, 12.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-14, V-15 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Comments

- 2026-11-15 (implement/software-factory-mvp-30, sobre a branch do 25): retenção de logs/sessões (varredura no boot após reconciliação e
  diária, 30 dias após merge confirmado, configurável por `retentionDays`), proteções, sessões preservadas em Records antes da remoção do
  ambiente, e cleanup explícito `factory cleanup <work> --select … [--yes]` / `factory cleanup-confirm <work> <plan>` com plano de perdas,
  confirmação e revalidação por item. Fluxos storage-real com Records/Sandbox reais e CLI real; evidência e mapa AC→teste em
  [docs/evidence/30-retention-and-explicit-cleanup.md](../../../docs/evidence/30-retention-and-explicit-cleanup.md). Sem receita real
  (nenhuma fronteira GitHub/VM/modelo alterada); decisões para revisão do supervisor registradas na evidência. Ticket não resolvido até a
  revisão.
- 2026-11-15 (supervisor): decisões 1–4 aceitas; 6 (sessões de revisores preservadas) implementada; receita local
  `retention30-qualification`: v1 NÃO atendida (defeito da receita: parava o owner antes de os lotes de remoção terminarem; 50 de 88),
  v2 ATENDIDA 9/9 sobre cópia de `q17-delivery-v4`. Item aberto de desbloqueio de `RECOVERY_BLOCKED` pertence aos tickets 26/27.

## Answer

Retenção e cleanup explícito entregues e qualificados (fluxos storage-real + CLI real + execução local real v2 atendida 9/9).
Evidência: [docs/evidence/30-retention-and-explicit-cleanup.md](../../../docs/evidence/30-retention-and-explicit-cleanup.md).
