# 23: Tratar feedback humano e reparos explícitos no mesmo ciclo

**What to build:** Pedidos humanos autorizados de revisão e comandos explícitos de reparo são tratados no mesmo ciclo de manutenção, com contexto preservado e resposta clara quando já atendidos, inaplicáveis ou impossíveis.

**Blocked by:** [22: Executar reparos automáticos por impedimentos efetivos](22-effective-impediments-and-automatic-repairs.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] CHANGES_REQUESTED de operador autorizado e repair explícito com motivo passam pela autenticação/correlação única de comandos, sem interpretar comentário comum/bot/terceiro como autorização.
- [ ] Identidade/origem/versão e conteúdo relevante do pedido e seu tratamento são preservados; não depende só de cursor temporal ou transcript para reconstruir o contexto.
- [ ] Pedido de commit anterior não desaparece por push; aprovação posterior/dismissal pode remover seu gatilho sem apagar pedidos independentes ou declarar aprovação humana de merge satisfeita.
- [ ] Durante implementação/review/pergunta, feedback relevante acumula para próxima ativação segura; ordem observada/commit decide a correção aplicável, sem injeção/interrupção pelo feedback ou cobrança por evento.
- [ ] Builder pode demonstrar já atendido/inaplicável, mas discordância real ou incapacidade de atender pedido humano exige ask user, não apenas não acolhimento permitido para achado interno.
- [ ] Repair/update-scope durante atividade retornam aceito para depois, já atendido ou recusado conforme fase; resume ativo não cria outro Builder e nenhum comando ignora todos os impedimentos.
- [ ] Provas com feedback GitHub/CLI e agente reais cobrem pedidos após push, desaparecimento de motivo, feedback durante review e consolidação/cobrança sem duplicata.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 10, 11.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-10, V-11 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Comments

- 2026-11-15 (implementation, branch `implement/software-factory-mvp-23`, on ticket 22's `84ef010`): local increment and one-shot recipe
  `test/entrypoints/feedback23-qualification.ts` (namespace `y5/q23-feedback-v1`) ready. Real run NOT executed: needs operator authorization,
  the NEW synthetic issue pinned in the recipe and the operator's human reviews/comment/approval. See
  [evidence 23](../../../docs/evidence/23-human-feedback-and-explicit-repairs.md).
