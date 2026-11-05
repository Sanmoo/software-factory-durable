# 18: Demonstrar a primeira jornada integrada completa

**What to build:** Uma jornada autorizada conecta todas as fronteiras já construídas, do Ticket elegível ao merge humano e cleanup, passando por pergunta e dois reviews reais. O resultado é evidência de composição operável, não aceite do MVP por um caso feliz.

**Blocked by:** [11: Continuar contexto e incorporar apenas mudanças de escopo autorizadas](11-context-continuation-and-authorized-scope.md); [16: Converter prontidão somente com evidências atuais](16-evidence-based-readiness.md); [17: Confirmar entrega e limpar somente recursos próprios](17-confirmed-delivery-and-owned-cleanup.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Cenário de integração registra previamente host/conta/storage, recursos GitHub descartáveis, App, operadores, modelos/custos, falhas permitidas, cleanup e responsável pelo merge humano autorizados.
- [ ] Mesmo Trabalho percorre admissão/dependências, fila, recibo de início, pedido/instruções preservados, implementação e pergunta/resposta com cessação/liberação de Slot e retorno pela fila.
- [ ] Standards e Spec reais emitem pareceres completos, Builder trata achados, gates reais são registrados e publicação direta cria draft próprio com descrição curta.
- [ ] Controlador comprova requisitos e prontidão, humano realiza merge, e observação confirma entrega/cleanup próprio sem ação de merge do agente.
- [ ] CLI/histórico/evidências ligam Ticket, Trabalho, Execuções/papéis, fontes, perguntas, pareceres, resultados, Git/PR e recursos; ausências/bloqueios não desaparecem do relatório.
- [ ] Registro distingue tempos ativos/esperas, intervenções e consumo disponível; referencia subcasos já provados sem apresentar esse percurso como bateria completa de adversidades ou utilidade no piloto.
- [ ] Falha/inconclusivo bloqueia esta demonstração dependente e recebe causa/próximo passo, sem dispensar requisitos para concluir a jornada.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 13.2, 13.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-07, V-08, V-09, V-11, V-14, V-15, V-17 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
