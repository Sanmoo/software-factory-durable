# Issue tracker: Local Markdown

Issues e specs deste repositório ficam em `.scratch/`.

## Convenções

- Uma feature por diretório: `.scratch/<feature>/`.
- Spec: `.scratch/<feature>/spec.md`.
- Tickets: `.scratch/<feature>/issues/<NN>-<slug>.md`.
- Um arquivo por ticket, numerado a partir de `01`.
- A linha `Status:` registra o estado de triagem definido em
  `docs/agents/triage-labels.md`.
- Comentários são acrescentados em `## Comments`.

## Publicar no tracker

Criar ou atualizar o arquivo correspondente em `.scratch/`.
Não publicar automaticamente em nd, GitHub Issues ou Jira.

## Consultar um ticket

Ler o arquivo indicado pelo usuário ou localizar o ticket
no diretório da feature.

## Wayfinding

- Mapa: `.scratch/<feature>/map.md`.
- Tickets filhos: arquivos individuais em `issues/`.
- `Type:` identifica research, prototype, grilling ou task.
- `Blocked by:` referencia os números dos pré-requisitos.
- A fronteira contém tickets abertos, desbloqueados e não
  reivindicados, em ordem numérica.
- Para tickets Wayfinder, usar `Status: claimed` antes do trabalho.
- Ao resolver, acrescentar `## Answer`, usar `Status: resolved`
  e registrar no mapa uma síntese com link.

## Backlog anterior

O conteúdo existente em `.vault/` não é migrado nem apagado
por este setup. A nova configuração não autoriza sua alteração.
