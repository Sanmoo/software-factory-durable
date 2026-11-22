# Agent instructions

Software Factory: fábrica local que transforma tickets autorizados em PRs revisáveis, com agentes, controle durável e merge humano.

## Engineering harness

- Entry Point rápido: `npm run test:fast` (ciclo de TDD e hook `pre-commit`).
- Entry Point completo: `npm run test:ci` é a **validação por mudança**; verde cobre só o escopo afetado que o relatório nomeia. `npm run test:full` é a **validação integral** noturna; verde vale para aquela árvore. Uma mudança só está pronta quando `npm run test:ci` está verde.
- O código é a fonte da verdade: quando um Guide e o código divergem, o código vence e o Guide é corrigido; para nomes, [GLOSSARY.md](GLOSSARY.md) vence e o código é corrigido.
- [GLOSSARY.md](GLOSSARY.md): antes de nomear algo do produto.
- [docs/guides/architecture.md](docs/guides/architecture.md): antes de criar módulo, import entre módulos ou mudar fronteira.
- [docs/guides/coding-standards.md](docs/guides/coding-standards.md): ao escrever código.
- [docs/guides/testing-strategy.md](docs/guides/testing-strategy.md): antes de escrever ou rodar testes.
- [docs/adr/](docs/adr/): antes de reverter uma decisão de arquitetura ou de engenharia.

## Issue tracker

Antes de consultar ou alterar specs, tickets ou mapas, ler `docs/agents/issue-tracker.md`.
Antes de classificar tickets, ler `docs/agents/triage-labels.md`.

## Provas e ensaios

Antes de preparar ou executar provas com modelos ou infraestrutura, ler os [guardrails de ensaios](docs/agents/experiment-proofs.md).

## Contexto de planejamento

Para decisões de produto e desenho do MVP, consultar `.scratch/software-factory/map.md` e os documentos que ele referencia.
Ao interpretar registros migrados, ler `docs/migrations/software-factory-from-pkm.md`: commits e caminhos antigos pertencem ao PKM de origem.

## Testes

`npm run test:ci` uma vez antes de entregar e de novo após rebase; `npm run test:fast` no ciclo de TDD.
As regras para quem escreve teste estão em [docs/guides/testing-strategy.md](docs/guides/testing-strategy.md).

Se um Entry Point falhar com `Disk quota exceeded` (o `/tmp` desta máquina tem limite de uso por usuário, e os testes de
release extraem mais de 1 GB lá), a falha é do ambiente, não da mudança: repetir com outro diretório temporário de caminho
curto, `TMPDIR=/var/tmp`. Um diretório dentro de `/home` não serve: o caminho fica longo e os testes do Sandbox recusam
com `SANDBOX_RUNTIME_PATH_TOO_LONG`.

## Integração e push

Toda mudança entra em `main` somente por pull request, com review e merge humanos
([ADR 0003](docs/adr/0003-integration-by-pull-request.md)). Isso substitui, neste repositório, o fluxo
global de conclusão que integra por fast-forward.

- Trabalhar numa branch própria, nunca em `main`. Com `npm run test:ci` verde, fazer push da branch e
  abrir o PR sem pedir confirmação. O corpo do PR traz a síntese, o resultado de `npm run test:ci` e
  `Closes #n`.
- Agente nunca faz merge; o merge é sempre rebase-merge feito por humano.
- Sem conflito com `main`, não atualizar a branch. Quando houver conflito, fazer rebase, rodar
  `npm run test:ci` de novo e `git push --force-with-lease` na branch de trabalho.
- Correções de review entram como commits na mesma branch.
- Provas e evidências não citam SHA de commit deste repositório como argumento de que algo foi
  executado; a referência é a issue ou o PR (`#n`).
- Continuam exigindo autorização: push forçado fora da branch de trabalho e publicação de branches de
  protótipo.
