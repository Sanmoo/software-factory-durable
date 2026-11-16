# 23: Tratar feedback humano e reparos explícitos no mesmo ciclo

**What to build:** Pedidos humanos autorizados de revisão e comandos explícitos de reparo são tratados no mesmo ciclo de manutenção, com contexto preservado e resposta clara quando já atendidos, inaplicáveis ou impossíveis.

**Blocked by:** [22: Executar reparos automáticos por impedimentos efetivos](22-effective-impediments-and-automatic-repairs.md)

**Status:** resolved

## Acceptance criteria

- [x] CHANGES_REQUESTED de operador autorizado e repair explícito com motivo passam pela autenticação/correlação única de comandos, sem interpretar comentário comum/bot/terceiro como autorização.
- [x] Identidade/origem/versão e conteúdo relevante do pedido e seu tratamento são preservados; não depende só de cursor temporal ou transcript para reconstruir o contexto.
- [x] Pedido de commit anterior não desaparece por push; aprovação posterior/dismissal pode remover seu gatilho sem apagar pedidos independentes ou declarar aprovação humana de merge satisfeita.
- [x] Durante implementação/review/pergunta, feedback relevante acumula para próxima ativação segura; ordem observada/commit decide a correção aplicável, sem injeção/interrupção pelo feedback ou cobrança por evento.
- [x] Builder pode demonstrar já atendido/inaplicável, mas discordância real ou incapacidade de atender pedido humano exige ask user, não apenas não acolhimento permitido para achado interno.
- [x] Repair/update-scope durante atividade retornam aceito para depois, já atendido ou recusado conforme fase; resume ativo não cria outro Builder e nenhum comando ignora todos os impedimentos.
- [x] Provas com feedback GitHub/CLI e agente reais cobrem pedidos após push, desaparecimento de motivo, feedback durante review e consolidação/cobrança sem duplicata.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 10, 11.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-10, V-11 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-16. Feedback humano entra por um único registro durável do Trabalho (`feedback.requests`): `CHANGES_REQUESTED` de
operador com id fixado na configuração (reviews não trazem `performed_via_github_app`) e reparo explícito (`factory repair <work> --reason` ou
`/factory repair <motivo>` no Ticket/PR próprio, mesma autenticação/correlação dos `/factory answer`), com identidade, origem, autor, versão
(commit) e conteúdo; prosa, bots e terceiros só deixam resumo limitado. Push não remove o pedido (identidade sem head); aprovação posterior do
mesmo revisor ou dismissal retira só aquele gatilho, nunca declara aprovação de merge. Os pedidos entram na correção por ordem de commit, nunca
na atividade em curso: feedback durante a atividade continua a MESMA correção (cobrança preservada, uma vez por base publicada); só pedidos
entregues a uma Execução iniciada viram `treated`; os revisores recebem os pedidos aceitos como parte do pedido autorizado. Builder demonstra
já atendido/inaplicável ou pergunta (`ask_user`) em discordância. `repair` responde aceito/adiado/já coberto/recusado (com `nextStep`;
sem PR próprio aponta `update-scope`) e responde no Ticket por comentário do controlador; `resume` é o do ticket 25. Ensaio real
`q23-feedback-v3` (issue #47, PR #48): review do operador → uma correção cobrada, publicada no mesmo PR, tratada sem nova cobrança após o push;
`/factory repair` + segunda review durante o reparo → mesma correção continuada (cobrança preservada), resposta publicada no Ticket; pedido em
pausa + APPROVE → correção retirada sem cobrança; consumo total 2; veredito 11/11 calculado offline dos resultados salvos. Evidência:
`docs/evidence/23-human-feedback-and-explicit-repairs.md` e `docs/evidence/23-real-feedback-v{2,3}-*.json`.

## Comments

- 2026-11-15 (implementation, branch `implement/software-factory-mvp-23`, on ticket 22's `84ef010`): local increment and one-shot recipe
  `test/entrypoints/feedback23-qualification.ts` (namespace `y5/q23-feedback-v1`) ready. Real run NOT executed: needs operator authorization,
  the NEW synthetic issue pinned in the recipe and the operator's human reviews/comment/approval. See
  [evidence 23](../../../docs/evidence/23-human-feedback-and-explicit-repairs.md).
- 2026-11-16 (supervisor-authorized real runs): `q23-feedback-v1` (issue #38) held in `run` (Builder read denial, fixed in integration
  `994c326`); `q23-feedback-v2` (issue #42) held in `command` (reviewers lacked the accepted operator requests; recipe ended on a Builder
  Question — both fixed); `q23-feedback-v3` (issue #47, PR #48) all phases exit 0, verdict 11/11 offline. PR #48/issue #47 cleanup is the supervisor's.
