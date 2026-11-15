# 18: Demonstrar a primeira jornada integrada completa

**What to build:** Uma jornada autorizada conecta todas as fronteiras já construídas, do Ticket elegível ao merge humano e cleanup, passando por pergunta e dois reviews reais. O resultado é evidência de composição operável, não aceite do MVP por um caso feliz.

**Blocked by:** [11: Continuar contexto e incorporar apenas mudanças de escopo autorizadas](11-context-continuation-and-authorized-scope.md); [16: Converter prontidão somente com evidências atuais](16-evidence-based-readiness.md); [17: Confirmar entrega e limpar somente recursos próprios](17-confirmed-delivery-and-owned-cleanup.md)

**Status:** resolved

## Acceptance criteria

- [x] Cenário de integração registra previamente host/conta/storage, recursos GitHub descartáveis, App, operadores, modelos/custos, falhas permitidas, cleanup e responsável pelo merge humano autorizados.
- [x] Mesmo Trabalho percorre admissão/dependências, fila, recibo de início, pedido/instruções preservados, implementação e pergunta/resposta com cessação/liberação de Slot e retorno pela fila.
- [x] Standards e Spec reais emitem pareceres completos, Builder trata achados, gates reais são registrados e publicação direta cria draft próprio com descrição curta.
- [x] Controlador comprova requisitos e prontidão, humano realiza merge, e observação confirma entrega/cleanup próprio sem ação de merge do agente.
- [x] CLI/histórico/evidências ligam Ticket, Trabalho, Execuções/papéis, fontes, perguntas, pareceres, resultados, Git/PR e recursos; ausências/bloqueios não desaparecem do relatório.
- [x] Registro distingue tempos ativos/esperas, intervenções e consumo disponível; referencia subcasos já provados sem apresentar esse percurso como bateria completa de adversidades ou utilidade no piloto.
- [x] Falha/inconclusivo bloqueia esta demonstração dependente e recebe causa/próximo passo, sem dispensar requisitos para concluir a jornada.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 13.2, 13.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-07, V-08, V-09, V-11, V-14, V-15, V-17 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-15 pelo ensaio real `q18-journey-v4` (issue #14 de `Sanmoo/java-springboot-event-sourcing`), executado pelo supervisor
com autorização do operador, na composição de produção (`composeProductionAccess` + `composeProductionExecution`).

- Admissão do #14, fila, recibo, pedido preservado; Pergunta publicada como comentário; cessação e Slot liberado; resposta real
  `/factory answer` da conta do operador ingerida pelo controlador; retomada pela fila (`QUESTION_ANSWERED`).
- Standards e Spec reais com pareceres completos na rodada 1 (sem achados neste ensaio: tratamento de achados provado no teste composto e
  no ensaio real do ticket 13); gate documentado `ticket-validation` passou e ficou vinculado ao conteúdo final; verificação `verified`.
- Ativação só de publicação: o Builder publicou o draft #15 (`factory/14-2ece4778` @ `54b268d`) pela URL configurada; descrição conforme.
- Prontidão parou, explicada, em `MERGE_BLOCKED_UPDATE_RESTRICTED` (regra `update`); o supervisor removeu `update` (autorizado); `ready`:
  a Factory converteu #15 para ready (uma mutação, grant revogado). Aprovação e merge humanos (merge commit `9cf5bb5`, `merged_by` Sanmoo,
  sem bypass); `deliver`: entrega confirmada, evidência preservada, ambiente próprio removido, branch própria apagada atomicamente;
  `inspect`: `delivered 1`, cleanup `complete 1`, issue fechada, só `main` mudou; nenhum token. `update` restaurado depois.
- Tentativas anteriores, todas com causa e correção registradas: v1 (preflight: label listava #1 e #7), v2 (#7: gate inventado
  `typecheck-lint` → `HANDOFF_GATE_NOT_DOCUMENTED`), v3 (#10: checkout reutilizado sem `origin` → instrução com a URL configurada).
- Não é bateria de adversidades nem utilidade de piloto (tickets 34/35).
- Evidência: `docs/evidence/18-first-integrated-delivery-journey.md` e `docs/evidence/18-real-journey-v4-*`.

## Comments

**2026-11-15 — implementação (real run pendente de autorização).** Lacunas da composição de produção corrigidas: o prompt de produção do
Builder proibia publicar sem a exceção da ativação de publicação (ticket 14); o acesso do owner virou `composeProductionAccess`, usado pelo
owner, pelo teste composto e pela receita. Teste composto `test/entrypoints/journey-composed.test.ts`: um único owner run da composição de
produção sobre o fixture gh leva um Ticket da admissão ao cleanup (pergunta, retomada, rodadas com achado tratado, publicação, checks,
parada explicada por `update`, ready, merge humano, entrega, deleção atômica da branch própria). Receita one-shot
`test/entrypoints/journey18-qualification.ts` (namespace `y5/q18-journey-v1`; issue sintética a fixar pelo supervisor; fases preflight, run,
ready, deliver, inspect, stop-environment). Evidência: `docs/evidence/18-first-integrated-delivery-journey.md`. Checkboxes não marcados até
o ensaio real.

