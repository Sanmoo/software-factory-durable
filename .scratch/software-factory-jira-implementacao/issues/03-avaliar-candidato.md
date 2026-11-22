# 03: Explicar se um candidato Jira pode iniciar

**What to build:** Antes de autorizar execução, o controlador distingue candidato apto, bloqueado e não verificável. A avaliação é exercitável sem habilitar novas admissões.

**Blocked by:** [01 — Separar a origem do Ticket do destino do Trabalho](01-separar-origem-e-destino.md)

Status: ready-for-agent

- [ ] Em transporte REST v3 simulado, buscar por projeto e etiqueta em todas as páginas JQL e reler pelo ID estável. Usar credencial só no host e na origem HTTPS configurada; token sentinela ausente de logs, observações, prompts e comentários.
- [ ] Com componentes completos, deduplicar destinos autorizados: duas rotas iguais ou uma válida mais componente sem rota dão um destino. Separar zero, divergência, lista parcial e etiqueta retirada. Usar a rota vigente na releitura, não a da busca.
- [ ] Resolver tipo e sentido de Blocks pelo catálogo. Apenas quem bloqueia o Card conta, inclusive fora do projeto e sem etiqueta. Usar categoria Done, não nome do status. Tipo ou direção ambíguos exigem indicação do operador.
- [ ] Distinguir lista visível vazia válida ou todos Done, vizinho aberto e fato não verificável (campo/página ausente, 403/404, timeout). Registrar origem, instante e cobertura visível sem alegar completude global. Nenhuma avaliação cria Trabalho, comenta ou despacha.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §3; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).
