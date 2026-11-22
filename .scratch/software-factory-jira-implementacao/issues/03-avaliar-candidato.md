# 03: Explicar se um candidato Jira pode iniciar

**What to build:** Antes de autorizar execução, o controlador distingue candidato apto, bloqueado e não verificável. A avaliação é exercitável sem habilitar novas admissões.

**Blocked by:** [01 — Separar a origem do Ticket do destino do Trabalho](01-separar-origem-e-destino.md)

Status: resolved

- [x] Em transporte REST v3 simulado, buscar por projeto e etiqueta em todas as páginas JQL e reler pelo ID estável. Usar credencial só no host e na origem HTTPS configurada; token sentinela ausente de logs, observações, prompts e comentários.
- [x] Com componentes completos, deduplicar destinos autorizados: duas rotas iguais ou uma válida mais componente sem rota dão um destino. Separar zero, divergência, lista parcial e etiqueta retirada. Usar a rota vigente na releitura, não a da busca.
- [x] Resolver tipo e sentido de Blocks pelo catálogo. Apenas quem bloqueia o Card conta, inclusive fora do projeto e sem etiqueta. Usar categoria Done, não nome do status. Tipo ou direção ambíguos exigem indicação do operador.
- [x] Distinguir lista visível vazia válida ou todos Done, vizinho aberto e fato não verificável (campo/página ausente, 403/404, timeout). Registrar origem, instante e cobertura visível sem alegar completude global. Nenhuma avaliação cria Trabalho, comenta ou despacha.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §3; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).

## Answer

O controlador avalia candidatos Jira sem admitir: transporte HTTPS do host (origem fixa, basic auth com token lido no host, falhas tipadas 401/403/404/429+Retry-After/5xx/timeout, resposta limitada), busca JQL por projeto e etiqueta em todas as páginas (`nextPageToken`/`isLast`), releitura por ID com componentes e vínculos, catálogo de tipos de vínculo e categoria de status do vizinho. Regras puras em `src/control/rules/jira-admission.ts` (`routeTicket`, `blockerDirection`, `evaluateJiraCandidate`) e avaliação somente leitura em `src/control/durable/jira-evaluation.ts` (`evaluateJiraSource`/`evaluateJiraTicket`): apto, bloqueado, não verificável ou não candidato, com origem, instante e cobertura visível; nenhum Trabalho, comentário ou despacho. A composição de produção passa a usar o transporte real (`JIRA_CLIENT_NOT_COMPOSED` removido); descoberta Jira continua desligada.

Commits: `5f4d1f18` (avaliação), `c90dcd35` (recusa de segmentos `%2e%2e`). Gate: `npm run test:ci` PASS (2185 testes, 0 falhas).
