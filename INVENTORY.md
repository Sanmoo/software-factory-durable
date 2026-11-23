# Inventário A1 — software-factory-durable (acceptance run de Sanmoo/skills#27)

Árvore inventariada: `main` em `fa17c6456b0e` (2026-11-21). [O] = observado, [I] = inferido, a confirmar.
Medições baratas num clone descartável (`um clone descartável`, `npm ci` do lockfile, bootstrap tsc → prepare:sdk → tsc).
Nada na aplicação, nos testes ou no tooling foi alterado.

## Entregável e borda
- [O] CLI `factory` empacotada como release autocontida (`src/entrypoints/release-build.ts`, `cli.ts`; evidência 32 em `docs/development.md`); controlador como dono durável por trás da CLI.
- [I] Borda mais externa = a CLI `factory` do tarball de release construído, executada como subprocesso.
- [O] A fixture de release usa assets de guest SINTÉTICOS, não bootáveis (`test/entrypoints/release-*` linha 12). [I, de #24 S4] Builder e revisores precisam de modelo real com autorização por execução (`docs/agents/experiment-proofs.md`).

## Domínio
- [O] Vocabulário: PRD §3 (`.scratch/software-factory/prd.md:61-74`): Ticket, Trabalho, Execução, Builder, Revisores, Slot, Reparo, Bloqueio, Pronto para revisão humana, Entregue.
- [O] Decisão registrada contra glossário global: `.scratch/software-factory/map.md:21`.
- [O] O domínio usa "gate" no sentido próprio (51 arquivos de `src/`, ex.: `control/rules/review.ts`, `control/durable/dispatch.ts`); "harness" aparece nas specs v2/Jira (`.scratch/software-factory-v2/spec.md`, `docs/guia-mvp-v2.md`).
- [O] Contextos candidatos = zonas do dependency-cruiser: contracts, protocol, records, platform/github, platform/host, issue-tracker, code-repository, sandbox, workers, control; `src/entrypoints` = raízes de composição (cli, controller, worker, adapter).
- [I] Classificação: core = control, workers; supporting = sandbox, issue-tracker, code-repository, records; generic = protocol, platform/*; contracts = shared kernel. (Mesma de #24.)
- [O] Trabalho em curso que mexe em contextos: Jira como issue tracker (`.worktrees/jira-contratos`, sessão pi ativa), sandbox Lambda (`src/sandbox/lambda/`).

## Fronteiras
- [O] Declaradas: `.dependency-cruiser.cjs` (matriz `allowed`, `public-entry:*` via `index.ts`, `composition:*`, `sdk:*-owner`, `no-cycles`, `classified-source*`); ESLint `no-restricted-syntax` (carregadores opacos, alias privado do SDK, nomes de adapter em Control, relógio/aleatoriedade em `control/rules`).
- [O] Observadas: 0 violações (734 módulos, 4990 dependências).
- [O] **Lacuna**: `options.exclude` `(^|/)(dist|\.git|\.worktrees|\.scratch)(/|$)` não é ancorado na raiz e esconde pacotes cuja entrada fica em `dist/`. Sonda: `import 'yaml'` em `src/control/rules/admission.ts` → "0 dependencies cruised", verde; `import 'node:fs'` → vermelho `pure-rules-imports`. Dependency rule e `sdk:*-owner` passam vaziamente para pacotes assim (yaml, pi-durable, chord…).
- [O] Prosa desatualizada: `docs/development.md` ("CLI compõe … somente tipos de Control") vs o carve-out `cli-workers-setup-only` na config.

## Ferramentas e checks existentes
| Contract | Check existente | Hoje |
|---|---|---|
| Types | tsc 6.0.3 strict (+noUncheckedIndexedAccess, exactOptionalPropertyTypes), `tsconfig.json` sobre src/test/scripts | 0 erros (após bootstrap; primeira passada sem SDK preparado: 33 erros esperados) |
| Lint | ESLint 10.14.0, só `no-restricted-syntax` (`eslint.config.mjs`) | 0 achados; vazio como linter (nenhum conjunto de regras do ecossistema) |
| Context boundaries | dependency-cruiser 18.7.2 | verde, com a lacuna acima |
| Dependency rule | `neutral-contracts`, `pure-rules-imports` + ESLint em `control/rules` | verde para módulos/builtins; cego para pacotes em `dist/` |
| Static metrics | só `no-cycles` | sem complexidade nem duplicação |
| Format | nenhum | — |
| Secrets | nenhum versionado; gitleaks 8.30.1 instalável via mise, sem pin no repo (`mise ERROR No version is set`) | — |
| Dependency vulnerabilities | nenhum | — |
| Avoided terms | nenhum; sem GLOSSARY.md | — |
| Guide pointers | `scripts/agent-checks/check.mjs` (escopo AGENTS.md, docs/agents/, .scratch/software-factory-v2/); só no GitHub Actions | sem regra de comandos; fora dos Entry Points |
| Unit / Integration | node:test, ~379 arquivos, camadas por velocidade (`test/tiers.json`), não por nível | sem nível declarado |
| E2E | nenhum; sem `.feature` | — |
| Mutation | nenhum | — |

- [O] Gate Proofs no `main`: nenhuma. Ferramental de prova existe só no branch não integrado `acceptance/adoption-2026-11-21` (`595f382a`, base `eafcb0a`, 80 commits atrás de `main`): `scripts/test-runner/{gate-proofs,proof-attribution,rehearse-modes,policy…}`.

## Entry Points e CI
- [O] `npm run test:fast`: tsc incremental + ESLint dos alterados (vs HEAD + não rastreados) + arquivos sem `slow`; teto 3 min.
- [O] `npm run test:ci`: dist limpo + tsc + ESLint + depcruise + todos os arquivos não-`full`; teto 10 min; flock de máquina. Sem seleção por mudança: roda tudo.
- [O] `npm run test:full`: ci + sandbox em disco real + passada em ordem aleatória.
- [O] CI hospedado (`.github/workflows/agent-checks.yml`) roda só `scripts/agent-checks/check.mjs` (documental, ~15 s, verde nas 10 últimas execuções). O "CI" real é o supervisor local rodando `test:ci` (`docs/agents/testing.md`).
- [O] Noturno: unidades systemd versionadas (`scripts/test-runner/systemd/`, 03:30, valida `origin/main` após fetch, #44) **não instaladas nesta máquina** (sem timer, sem `~/.local/state/software-factory/nightly-tests`). Cadência integral hoje não roda.
- [O] Sem pre-commit hook (`core.hooksPath` vazio).

## Testes que falham / ausentes
- [O, #27] Passada em ordem aleatória falha por dependência de ordem em `finite-qualification.test.ts` (reproduzida em `eafcb0a`). Não re-medido em `fa17c645`.
- [O] Caminho fixo do fixture Gondolin auditado, vermelho em `eafcb0a`, corrigido em `main` (`7bf0af02`).
- [?] Estado de `test:ci` em `fa17c645`: não medido (caro; fora do A1).

## Ambiente
- [O] Node 24.21.0 (`.node-version`, `engines`), npm 11.19.0, mise 2026.10.17 (sem `mise.toml`), docker 29.9.2, qemu 11.1.2, `/dev/kvm`, rede para o registry npm.

## Concorrência
- [O] `main` anda durante esta sessão (sessão pi em `wayfinder/jira-contratos`); 9 worktrees ligados com branches abertos. Um reformat da árvore inteira conflita com todos.

## Não estabelecido
- Estado de `test:ci`/`test:full` em `fa17c645`; achados de prettier, typescript-eslint, complexidade, jscpd, gitleaks, npm audit nesta árvore; custo de mutação nesta árvore (em #24: 58.473 mutantes, sem cobertura por teste no tap runner).

## Medições Q8a (clone descartável em um clone descartável fora do repositório, árvore fa17c645, 2026-11-22)
- test:ci: 375/377 arquivos verdes (2105 pass, 17 skip), 339 s de 600 s, carga inicial 0,7. Vermelhos: environment-base.test.ts (SANDBOX_RUNTIME_PATH_TOO_LONG) e sandbox-adapter-diagnostics.test.ts, ambos por TMPDIR longo do ambiente de medição; passam com TMPDIR curto. Pré-requisito: TMPDIR curto (sockets ≤107 bytes); /tmp é tmpfs com usrquota (estourou na 1ª tentativa).
- Ordem aleatória: test/entrypoints/finite-qualification.test.ts falha 2–3 de 17 nas sementes 1, 2, 3; passa 17/17 em ordem normal. test:full inteiro não rodado (parte sandbox pode bootar VM).
- Prettier 3.9.10 --check (ts/mts/cts/js/mjs/cjs): 704 arquivos diferem (src 192, test 497, scripts 13, 2 configs).
- ESLint + typescript-eslint 8.72.1 recommended + complexity 10: complexity 412 src / 282 test / 8 scripts; no-unused-vars 34 src / 47 test; prefer-const 3 src / 26 test; no-explicit-any 11 test; no-this-alias 2 test.
- jscpd 5.4.2: src 1,12% (56 clones); src+test 8,65% (1032 clones).
- gitleaks 8.30.1: árvore 16 (6 .scratch alpine-guest-evidence.json = fingerprints públicos de host key; 9 tokens sintéticos em testes; 1 src/sandbox/lambda/transport.ts:87:19 private-key = template literal do cabeçalho PEM gerado em runtime, sem material de chave). Histórico de HEAD: 16 (mesmos achados nos commits de origem).
- npm audit --audit-level=high: 0 high/critical (5 moderate).
