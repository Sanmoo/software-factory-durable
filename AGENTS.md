# Agent instructions

## Issue tracker

Antes de consultar ou alterar specs, tickets ou mapas, ler `docs/agents/issue-tracker.md`.
Antes de classificar tickets, ler `docs/agents/triage-labels.md`.

## Provas e ensaios

Antes de preparar ou executar provas com modelos ou infraestrutura, ler os [guardrails de ensaios](docs/agents/experiment-proofs.md).

## Contexto de planejamento

Para decisões de produto e desenho do MVP, consultar `.scratch/software-factory/map.md` e os documentos que ele referencia.
Ao interpretar registros migrados, ler `docs/migrations/software-factory-from-pkm.md`: commits e caminhos antigos pertencem ao PKM de origem.

## Testes

Antes de escrever ou rodar testes, ler `docs/agents/testing.md`.
O gate de desenvolvimento é `npm run test:ci` (uma vez antes de entregar e de novo após rebase);
no ciclo de TDD usar `npm run test:fast`. Isso substitui a regra antiga do handoff
"um arquivo compilado por vez". Teste lento ou não paralelizável ganha entrada justificada em
`test/tiers.json`; relógio falso em vez de `sleep`; sem caminho ou porta fixos; crash/SIGKILL reais
só fora de `fast`, com um cenário representativo por mecanismo e as variações como testes de regra pura.
