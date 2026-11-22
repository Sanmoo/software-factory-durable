# 10: Habilitar e suspender a descoberta Jira ao lado do GitHub

**What to build:** O operador pode ligar a fonte Jira em produção com o fluxo completo e suspender apenas novas admissões, sem abandonar Trabalhos já iniciados.

**Blocked by:** [07 — Cancelar somente o Trabalho daquele Card](07-cancelar-no-card.md); [09 — Registrar Entregue mesmo com o Jira indisponível](09-registrar-entrega.md)

Status: ready-for-agent

- [ ] Com serviços simulados e composição de produção, exercitar v2 com dois trackers, mesmo número aparente e mesmo destino. Verificar origens distintas e o percurso do Card marcado à resposta, PR, merge e aviso. No v1, verificar fluxo GitHub sem abrir segredo nem chamar Jira.
- [ ] Com discover: false, não admitir novos Tickets da fonte. Perguntas, entradas e avisos de Trabalhos existentes continuam no Card persistido. Retirar a credencial deixa pendência local com Ticket/Trabalho, motivo, efeito e ação segura; restaurá-la permite retomar sem desviar ao GitHub.
- [ ] Orientar configuração no host (URL, e-mail, arquivo de token, permissões mínimas), suspensão e recuperação. Não exigir conta exclusiva ou accountId fornecido, elevar acesso ou expor o segredo ao agente.
- [ ] Validar a matriz offline com IDs sintéticos, relógio injetado, armazenamento privado, registro de chamadas e controles positivos para as ausências verificadas. Gate: npm run test:ci. Não usar credenciais reais nem tratar fixtures como homologação de tenant.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §6; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).
