# 25: Operar retirada de autorização, cancelamento e novos ciclos

**What to build:** O operador consegue suspender, cancelar, reabrir e solicitar novo ciclo sem confundir fechamento com entrega ou apagar efeitos já enviados. Mudanças externas e comandos não ressuscitam automaticamente Trabalhos encerrados.

**Blocked by:** [10: Perguntar ao operador, cessar e retomar pela fila](10-durable-questions-and-queued-resumption.md); [14: Publicar e reconhecer o PR draft próprio](14-direct-draft-publication-and-discovery.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Retirar label/fechar issue impede próximas ativações, mas ativo autorizado pode concluir/publicar; repor label/reabrir issue não remove suspensão sem resume explícito e requisitos atuais.
- [ ] Cancelamento persiste proibição antes de interromper, fecha novas ferramentas/publicações/renovações e pede parada; capacidade só é liberada após cessação comprovada, preservando artefatos.
- [ ] Efeito remoto já enviado pode concluir e é reconciliado; cancelamento não fecha PR, apaga branch nem desfaz GitHub, e merge confirmado prevalece como entrega mantendo histórico do cancelamento.
- [ ] PR fechado sem merge permanece ciclo vigente/não entregue com contadores; fechamento não prova morte de ativo e não provoca substituição, reabertura ou retomada automática.
- [ ] Reopen opera somente PR próprio fechado sem merge e não concede resume, escopo ou orçamento; retomada exige comando/requisitos próprios.
- [ ] New após entrega/cancelamento cria Trabalho com predecessor e recursos próprios, somente após cessação/reconciliação necessária; PR anterior ainda aberto exige decisão explícita sem adoção/fechamento silenciosos.
- [ ] Label persistente, polling, respostas tardias, restart e cleanup não redisparam ciclo; resolver um impedimento não remove os demais.
- [ ] CLI/GitHub e processos reais cobrem retirada/reposição, fechamento, cancelamento durante comando e merge concorrente, com resultado/impedimentos/histórico compreensíveis.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 4.1, 5.4, 11.3, 12.3; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-04, V-11, V-13 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Comments

- 2026-11-15 (implement/software-factory-mvp-25): implementação local integrada ao controlador (retirada/resume, cancel, closed-unmerged,
  reopen, new) com fluxos storage-real e CLI; evidência e mapa AC→teste em
  [docs/evidence/25-authorization-withdrawal-and-work-cycles.md](../../../docs/evidence/25-authorization-withdrawal-and-work-cycles.md).
  Receita real `test/entrypoints/cancel25-qualification.ts` (namespace `y5/q25-cancel-v1`) pronta e **não executada**: exige autorização
  do operador, a issue sintética criada pelo supervisor e seu número fixado em `syntheticTicket`. Ticket não resolvido até a evidência real.
