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

## Integração e push

Depois de integrar o trabalho em `main` por fast-forward, conforme o fluxo global de conclusão, fazer
`git push origin main` em seguida, sem pedir confirmação. Isso substitui, neste repositório, a regra
global de só fazer push com autorização explícita. Continuam exigindo autorização: push de outras
branches, qualquer push forçado e publicação de branches de protótipo.
