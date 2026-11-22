# 10: Habilitar e suspender a descoberta Jira ao lado do GitHub

**What to build:** O operador pode ligar a fonte Jira em produção com o fluxo completo e suspender apenas novas admissões, sem abandonar Trabalhos já iniciados.

**Blocked by:** [07 — Cancelar somente o Trabalho daquele Card](07-cancelar-no-card.md); [09 — Registrar Entregue mesmo com o Jira indisponível](09-registrar-entrega.md)

Status: resolved

- [x] Com serviços simulados e composição de produção, exercitar v2 com dois trackers, mesmo número aparente e mesmo destino. Verificar origens distintas e o percurso do Card marcado à resposta, PR, merge e aviso. No v1, verificar fluxo GitHub sem abrir segredo nem chamar Jira.
- [x] Com discover: false, não admitir novos Tickets da fonte. Perguntas, entradas e avisos de Trabalhos existentes continuam no Card persistido. Retirar a credencial deixa pendência local com Ticket/Trabalho, motivo, efeito e ação segura; restaurá-la permite retomar sem desviar ao GitHub.
- [x] Orientar configuração no host (URL, e-mail, arquivo de token, permissões mínimas), suspensão e recuperação. Não exigir conta exclusiva ou accountId fornecido, elevar acesso ou expor o segredo ao agente.
- [x] Validar a matriz offline com IDs sintéticos, relógio injetado, armazenamento privado, registro de chamadas e controles positivos para as ausências verificadas. Gate: npm run test:ci. Não usar credenciais reais nem tratar fixtures como homologação de tenant.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §6; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).

## Answer

Descoberta Jira liberada em produção (`composeProductionAccess` compõe `ticketSources[].discover` como configurado; a constante
`jiraDiscoveryReleased` do ticket 01 foi removida). `discover: false` desliga só novas admissões (a fonte nem é listada); o adapter
continua composto e Trabalhos existentes seguem no Card persistido.

- **Credencial retirada**: um POST de comentário que falha com `JIRA_CREDENTIAL_UNAVAILABLE` (nada enviado) não conta para o limite de
  cinco recusas; o efeito fica `failed`/pendente em `status.jiraNotices.unpublished` (Card, Trabalho, motivo, ação segura) e o link em
  `status.jiraLinks.pending`, até o arquivo voltar; então sai uma vez, no mesmo Card, sem comando do operador. Antes, a pergunta/aviso
  era abandonada após cinco passadas.
- **Diagnóstico**: `factory doctor --authenticated` traz `jiraResults` (uma leitura `GET /rest/api/3/mypermissions` por fonte):
  `projectRead`/`commentCreate`/`remoteLinks` = `granted|missing|unverified`, `commentAudience`/`blockerVisibility` sempre `unverified`;
  `JIRA_PERMISSION_MISSING` nomeia a permissão a pedir; não-ok sai com exit 3.
- **Teste composto** `test/entrypoints/jira-coexistence-composed.test.ts` (fast, ~1 s): composição de produção das fontes e do adapter Jira
  (transporte HTTPS do host, arquivo de token, dublê HTTP cru `jira-http-world.ts`), contratos GitHub por `githubDoubles`, Control real.
  v2 com `acme/project#42` e `PAG-42` no mesmo destino (dois Trabalhos, origens distintas; o GitHub segue a regra de bloqueio nativo);
  Card marcado → pergunta → `/factory sim` → PR → merge → link `Entregue` + aviso, uma vez; `discover:false` com Card novo ignorado e
  conversa do existente; token removido/restaurado; `/factory cancel` exato só cancela o Trabalho do Card (resposta no Card, Trabalho GitHub #42 intacto); v1 até a entrega sem criar cliente Jira, sem ler token, zero trocas Jira; sentinela
  ausente de views, SQLite, prompts e comentários (controle positivo: o Basic auth carrega o token). Teste de adapter
  `test/issue-tracker/jira-access.test.ts`.
- **Docs**: `docs/jira-installation.md` (conta/token/permissões mínimas, YAML v2, doctor, comandos no Card, suspensão, recuperação,
  atualização, limites da evidência); link em `docs/local-installation.md`.
- Matriz §7: linhas 1-6 e 8 já cobertas pelos testes dos tickets 02-09 (`test/control/jira-*`, `storage-migration-2-to-3`,
  `test/issue-tracker/jira-*`); linha "Coexistência" coberta aqui. Stderr do controlador não é exercido (teste em processo).

Commits: 008f86ca (feat), 1b76b119 (resposta), seguido do teste composto de cancelamento e do ajuste de entrada pública.
