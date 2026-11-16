# 31: Excluir histórico conservando memória mínima dos ciclos

**What to build:** O operador pode excluir o histórico elegível de um Trabalho encerrado, sabendo o que deixa de ser recuperável. A Factory conserva somente a memória mínima necessária para não redisparar Ticket nem avaliar dependência própria como externa.

**Blocked by:** [08: Liberar execução somente com dependências nativas satisfeitas](08-native-dependency-gating.md); [30: Aplicar retenção e cleanup explícito sem perder contexto necessário](30-retention-and-explicit-cleanup.md)

**Status:** resolved

## Acceptance criteria

- [x] Forget é operação local separada de cleanup, com seleção/plano/confirmação e revalidação; exige Trabalho encerrado sem recursos ou efeitos pendentes.
- [x] PR fechado sem merge requer cancelamento prévio para excluir histórico; aberto/ativo/pendente é recusado sem alterar dados para forçar elegibilidade.
- [x] Memória mínima conserva Ticket/repo/Trabalho, ordem e vínculo dos ciclos, resultado e, para entregue, identidade do PR/fato de merge confirmado; não conserva conteúdo do pedido, logs ou pareceres.
- [x] Label/polling/restart depois da exclusão não cria outro Trabalho; novo ciclo depende de new explícito e passa a ser o ciclo avaliado.
- [x] Dependência própria entregue continua satisfeita pelo ciclo aplicável, cancelada não satisfaz e novo ciclo não herda merge antigo; ausência de histórico não a transforma em externa.
- [x] CLI diferencia histórico excluído, evidência ausente/expirada e resumo mínimo remanescente; agregados de consumo restantes não se apresentam como toda a vida da instalação.
- [x] Testes com storage real e fluxo de dependências/admissão após exclusão demonstram antirredisparo e classificação correta; operação não promete apagar referências GitHub, cópias externas ou backup.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 4.1, 4.2, 12.1, 12.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-04, V-05, V-14 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Implemented on `implement/software-factory-mvp-31`: `factory forget`/`forget-confirm`, keeping the minimal cycle memory. Evidence:
[ticket 31](../../../docs/evidence/31-history-erasure-and-minimal-cycle-memory.md).
- Local runs: `q31-forget-v1` met 21/21; `q31-forget-v2` met 20/20, after the independent review.
- Gaps: the cancelled forget on real data (the q25 environment still exists, so only the refused branch was shown); the forgotten Ticket as a
  blocker (flow level only).
- Operator decision D-07 (2026-11-16), implemented on `implement/software-factory-mvp-d07`: after each forget the owner scrubs the controller
  SQLite (`VACUUM` + `wal_checkpoint(TRUNCATE)`, on its own serialized connection under the control lock). The scrub stays `pending` in the
  memory until it completes, and a failure or crash is re-attempted. `show`/`status` report it. Proof at level I (local, real SQLite file): a
  seeded marker is absent from the raw `control.sqlite` and `-wal` bytes after the forget, and the test was red before the change. This
  replaces the former free pages/WAL limitation.
