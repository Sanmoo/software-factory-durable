# Issue tracker: GitHub Issues

Issues, specs e mapas novos deste repositório vivem como issues em `Sanmoo/software-factory-durable`.
Usar o CLI `gh` para todas as operações; dentro do clone ele infere o repositório.

Este é o tracker de desenvolvimento da Factory. Ele não configura a Factory para processar este
repositório; apontar a Factory para cá é uma decisão separada do operador.

## Convenções

- **Criar:** `gh issue create --title "..." --body-file <arquivo>` (corpo multilinha via arquivo ou heredoc).
- **Ler:** `gh issue view <n> --json number,title,body,labels,assignees,comments`.
- **Listar:** `gh issue list --state open --json number,title,labels,assignees`, com filtros `--label` e `--state`.
- **Sub-issue:** `gh issue create --parent <mãe> ...`, ou `gh issue edit <mãe> --add-sub-issue <filho>` depois.
- **Comentar:** `gh issue comment <n> --body-file <arquivo>`.
- **Labels:** `gh issue edit <n> --add-label "..."` / `--remove-label "..."`.
- **Fechar sem código:** comentar a resposta e depois `gh issue close <n>`.
- Uma spec ou um mapa é uma issue-mãe; seus tickets são sub-issues. Não há label nem milestone por feature.
- No corpo de uma issue, `#n` aponta para issues e PRs deste repositório. Ao citar outro repositório,
  usar `owner/repo#n` ou pôr a referência em código.

## Entrega por pull request

Uma mudança entra em `main` somente por PR, com review e merge humanos (ADR 0003, em
[docs/adr/0003-integration-by-pull-request.md](../adr/0003-integration-by-pull-request.md)).
O corpo do PR traz a síntese da resposta, o resultado de `npm run test:ci` e `Closes #n`; o merge
humano fecha a issue. Agente nunca faz merge.

**PRs como superfície de pedido: não.** PRs externos não passam pela triagem.

## Quando uma skill disser "publicar no issue tracker"

Criar uma issue no GitHub.

## Quando uma skill disser "buscar o ticket"

Ler a issue como em **Ler**.

## Wayfinding

- **Mapa:** uma issue com a label `wayfinder:map`, com o corpo Notes / Decisions so far / Fog.
- **Ticket filho:** sub-issue do mapa, com a label `wayfinder:<tipo>` (`research`, `prototype`, `grilling`, `task`).
- **Bloqueio:** dependência nativa do GitHub. Criar a aresta com
  `gh api --method POST repos/Sanmoo/software-factory-durable/issues/<filho>/dependencies/blocked_by -F issue_id=<id>`,
  em que `<id>` é o database id do bloqueador (`gh api repos/Sanmoo/software-factory-durable/issues/<n> --jq .id`),
  não o número. O ticket está desbloqueado quando todos os bloqueadores estão fechados.
- **Fronteira:** sub-issues abertas do mapa, sem bloqueador aberto
  (`issue_dependencies_summary.blocked_by` igual a zero) e sem assignee, na ordem do mapa.
- **Reivindicar:** `gh issue edit <n> --add-assignee @me`, a primeira escrita da sessão.
- **Resolver:** comentar a resposta, fechar a issue e acrescentar ao Decisions so far do mapa uma síntese com link.

## Arquivo anterior

`.scratch/` guarda o tracker Markdown local, congelado em 2026-11-22: tickets resolvidos, specs, mapas,
PRD e pesquisas continuam válidos como referência, mas não recebem tickets novos. Os tickets que ainda
estavam abertos migraram para issues; cada arquivo migrado aponta para a sua issue. Ver
[.scratch/README.md](../../.scratch/README.md).

O conteúdo de `.vault/` continua fora deste tracker e não é alterado por ele.
