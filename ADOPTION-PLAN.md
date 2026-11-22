# Plano de adoção: engineering harness do software-factory-durable

Status: **aprovado pelo mantenedor em 2026-11-22**, antes de qualquer mudança na aplicação, nos testes ou no tooling. Os registros de cada etapa vêm ao fim.
Árvore medida: `main` em `fa17c6456b0e` (2026-11-22). Acceptance run de Sanmoo/skills#27, caminho de adoção.
Respostas confirmadas: `INTERVIEW-ANSWERS.md`, seção _Adoption_. Inventário e medições: `INVENTORY.md`.

"Harness" e "gate" pertencem ao domínio da fábrica. Este plano e os Guides que ele escreve dizem **engineering harness** e **quality gate** (ADR). Os nomes das Gate Contracts (Format, Lint…) são nomes próprios.

## Execução

- Destino de integração: `main`, por fast-forward, com `git push origin main` após cada integração (AGENTS.md do repositório). Uma branch e um worktree por etapa (`.worktrees/harness-sN`), com rebase sobre `main` antes do fast-forward quando `main` andar.
- O ferramental do branch `acceptance/adoption-2026-11-21` (#24) é portado, não reescrito. As partes mecânicas (reformat, correções de lint, reescrita de tokens) são refeitas nesta árvore. Toda Gate Proof roda de novo na árvore da etapa: evidência de #24 não vale aqui.
- Cada etapa começa re-medindo seus achados na árvore em que começa. Um achado de dívida legada que este plano não nomeia é uma emenda aprovada como o plano, nunca uma entrada silenciosa.
- Orçamento de investigação de teste vermelho: 1 h por etapa. Depois disso o Gate afetado fica pendente.

## Gate Floor: estado atual

Todo quality gate está **pendente** na árvore medida. Uma ferramenta existente não é um quality gate adotado: nenhuma tem Gate Proof no `main`.

| Quality gate | Check existente | Estado | Etapa |
|---|---|---|---|
| Types | tsc 6.0.3 strict, verde | pendente (sem prova) | S1 |
| Context boundaries | dependency-cruiser 18.7.2, verde | pendente (filtro `dist` esconde alvos de terceiros) | S1 |
| Dependency rule | `neutral-contracts`, `pure-rules-imports`, ESLint em `control/rules` | pendente (vazio para pacotes com entrada em `dist/`) | S1 |
| Guide pointers | `scripts/agent-checks/check.mjs`, só no GitHub Actions | pendente (escopo parcial, sem regra de comandos) | S1 |
| Lint | ESLint 10.14.0, só `no-restricted-syntax` | pendente (vazio como linter) | S2 |
| Avoided terms | nenhum; sem `GLOSSARY.md` | pendente (ausente) | S2 |
| Dependency vulnerabilities | nenhum | pendente (ausente) | S2 |
| Unit tests | node:test por velocidade, não por nível | pendente (sem nível) | S3 |
| Integration tests | idem | pendente (sem nível) | S3 |
| Format | nenhum | pendente (ausente) | S4 |
| Secrets | nenhum versionado | pendente (ausente) | S5 |
| Static metrics | só `no-cycles` | pendente (parcial) | S6 |
| E2E tests | nenhum | **bloqueado** | — |
| Mutation | nenhum | pendente (decisão aberta) | — |

## Entry Points, modos, orçamento, cadência (todas as etapas)

- **Fast Entry Point**: `npm run test:fast` (retido). Um hook `pre-commit` versionado o chama; instalar o hook (`core.hooksPath`) é passo do operador.
- **Full Entry Point**: o runner `scripts/test-runner/run`, retido, com os dois modos:
  - validação por mudança: `npm run test:ci`, rodado pelo supervisor local sob o lock de máquina antes de entregar e após rebase. Essa execução é o CI do projeto (ADR). O GitHub Actions mantém só o job documental.
  - validação integral: `npm run test:full`, chamado às 03:30 pelo timer systemd versionado, sobre `main`.
- **Política de seleção**: código versionado ao lado do runner com cada check, seu tier, as mudanças que o fazem aplicar, o escopo que verifica, a cadência, o custo estimado e o orçamento. Escopo afetado = arquivos alterados + dependentes pelo grafo do dependency-cruiser, contra uma base única (`main`, ou `VALIDATION_BASE`). As dependências que o grafo não vê (testes que rodam o artefato construído ou alcançam código por processo filho) são declaradas na política. Amplia em manifesto/lockfile, config compartilhada, config de quality gate, arquivos de ignore, CI/runner/política, ou impacto não estabelecido. Validação exigida acima do orçamento é inconclusiva e não inicia nada caro.
- **Orçamento**: validação por mudança ≤ 15 min de relógio (o teto `ci` passa de 600 s para 900 s; medido hoje: 339 s ocioso). Validação integral: noturna, ≤ 2 h (`RuntimeMaxSec`).
- **Checks periódicos** (só integral): sandbox em disco real e a passada em ordem aleatória, já em `test:full`. A política registra a proteção entre execuções e o risco residual de cada um. O último resultado integral é publicado em `$XDG_STATE_HOME/software-factory/nightly-tests/`, onde a validação por mudança o lê. A cadência da política é checada contra o `OnCalendar` do timer.
- **Pré-requisito de ambiente**: `TMPDIR` curto (caminhos de socket ≤ 107 bytes); o `/tmp` desta máquina é tmpfs com cota por usuário. Vai para o Guide de testes.
- **Passo do operador**: instalar as unidades systemd (agora apontando para `main`) e o hook. Sem a instalação nenhum check periódico é adotável, porque a cadência não roda.
- **Rehearsal**: script executável fora dos dois Entry Points que ensaia os modos numa cópia descartável (dependente pego sem ampliar; config compartilhada amplia; acima do orçamento é inconclusivo e não inicia nada; integral roda um check periódico que a validação por mudança só reporta). A transcrição não é commitada.
- **Gate Proofs**: um arquivo de provas executável fora dos dois Entry Points; cada prova roda o Entry Point do tier numa cópia descartável com uma só violação, e as regras de atribuição são testadas. Resultados em `GATE-PROOFS.md`.

## S1: modos, quality gates estruturais, Guides

- **Escopo**: repositório inteiro; `src/`, `test/` e `scripts/` conforme cada Contract mede.
- **Contracts realizados**: Types, Context boundaries, Dependency rule, Guide pointers; os dois modos e a política de seleção.
- **Critérios de adoção**:
  - Types: tsc strict sobre `src`, `test` e `scripts` (`tsconfig.json` existente); fast.
  - Context boundaries: o mapa do dependency-cruiser é o context map, com o carve-out `cli-workers-setup-only`. `options.exclude` ancorado na raiz (`^(dist|\.git|\.worktrees|\.scratch)(/|$)`): o código de terceiros continua não percorrido (`doNotFollow`), mas visível como alvo. Fast.
  - Dependency rule: modelo de domínio = `src/contracts` e `src/control/rules`; regras existentes. `sdk:*-owner` vale para código de produção em `src/` (decisão 8o de #24, confirmada). Fast.
  - Guide pointers: o checker documental é retido e estendido a `GLOSSARY.md`, `docs/guides/`, `docs/adr/`, caminhos entre crases e à regra de comandos (um Guide só nomeia os Entry Points e os modos). Entra no fast Entry Point.
- **Achados tolerados**: nenhum (os quatro estão verdes; o filtro corrigido é re-medido na etapa).
- **Gate Proofs**: Types: argumento de tipo errado numa função de `src/control/rules`. Context boundaries: import de um módulo não público de outro contexto. Dependency rule: import de um **pacote** com entrada em `dist/` (ex.: `yaml`) num módulo de `src/control/rules`, para a cegueira não voltar escondida. Guide pointers: link de Guide para arquivo inexistente.
- **Mudanças de tooling**: modos e política no runner, resultado inconclusivo, leitura do último integral; dependency-cruiser e checker documental no fast; nightly validando `main`; hook `pre-commit`; `mise.toml` fixando gitleaks 8.30.1 (Node continua em `.node-version`); rehearsal; arquivo de provas.
- **Guides** (em português, como os existentes; identificadores e nomes de quality gate em inglês):
  - `AGENTS.md` emendado: Entry Points e modos, o que cada verde cobre, o código é a fonte da verdade (o `GLOSSARY.md` prevalece em nomes), links para o glossário, os Guides e os ADRs. Symlink `CLAUDE.md`.
  - `GLOSSARY.md` criado: termos do PRD §3 com os identificadores ingleses; _Avoid_: Work → job; Slot → seat; Repair → hotfix. Só vocabulário de produto, sem modelo novo (`map.md:21` honrado).
  - `docs/guides/architecture.md` criado a partir da parte de arquitetura de `docs/development.md`, que passa a apontar para ele; a prosa desatualizada sobre a CLI é corrigida.
  - `docs/guides/testing-strategy.md` substitui `docs/agents/testing.md` (movido e emendado, links atualizados), com o pré-requisito de `TMPDIR`.
  - `docs/guides/coding-standards.md` criado (só julgamento; ponteiros para formatter, linter e metrics).
  - `docs/adr/`: 0001 o `test:ci` supervisionado local é o CI da validação por mudança; 0002 terminologia qualificada do engineering harness.
- **Orçamento**: 1 sessão de trabalho; `test:ci` verde depois da etapa.
- **Continua pendente**: tudo fora de S1.

## S2: Lint, Avoided terms, Dependency vulnerabilities

- **Critérios de adoção**:
  - Lint: ESLint 10.14.0 retido com suas regras, mais typescript-eslint 8.72.1 `recommended`, sobre `src`, `test` e `scripts`; `--max-warnings 0`; fast. A convenção de `_` para bindings mantidos de propósito é configurada em `no-unused-vars`. A complexidade não é Lint (é S6).
  - Avoided terms: checker que lê as linhas _Avoid_ do `GLOSSARY.md`, faz o parse dos identificadores (sem ler texto de string ou comentário) e os divide em camelCase, snake_case e kebab-case, sobre `src`, `test` e `scripts`; fast.
  - Dependency vulnerabilities: `npm audit --audit-level=high` com o npm fixado em `engines` (11.19.0) sobre o lockfile; full; selecionado por mudança de lockfile ou manifesto, por ampliação e no integral.
- **Mudanças de código**: corrigir os 125 achados medidos (34 `no-unused-vars` + 3 `prefer-const` em src; 47 `no-unused-vars`, 26 `prefer-const`, 11 `no-explicit-any`, 2 `no-this-alias` em test), menos os que a convenção de `_` cobre. Renomear qualquer identificador com termo evitado que o checker encontrar. Comportamento preservado; `test:ci` verde.
- **Achados tolerados**: nenhum. Vulnerabilities: 0 high/critical hoje (5 moderate, abaixo do limite).
- **Gate Proofs**: Lint: variável não usada. Avoided terms: um identificador de Slot renomeado para `seatLimit`. Vulnerabilities: travar `minimist@0.0.8` (advisory crítico publicado).
- **Guides**: `coding-standards.md` ganha ponteiros para a config do ESLint.
- **Orçamento**: 1 sessão + um `test:ci` depois das correções.

## S3: níveis Unit e Integration

- **Critérios de adoção**:
  - Um `level` (unit ou integration) versionado por arquivo de teste, na política do runner; nenhum arquivo é movido. O cruise de fronteiras falha um teste declarado unit que alcança I/O de runtime (`node:fs`, `node:child_process`, `node:net` ou helper que cria processo).
  - Unit tests: todo arquivo unit passa; fast (o fast Entry Point roda o nível unit; um filtro ainda alcança qualquer teste). Integration tests: todo arquivo integration passa, com a fixture local de `gh` e providers de modelo roteirizados como os únicos dublês (sistemas de terceiros na fronteira); full. As receitas `*-qualification` reais continuam fora dos níveis (autorizadas pelo operador).
- **Contrato de regressão**: a suíte `test:ci` atual; `journey-composed` e `release-install/artifact/upgrade` são as jornadas prioritárias.
- **Investigação**: `test/entrypoints/finite-qualification.test.ts` falha 2–3 de 17 testes em ordem aleatória (sementes 1, 2, 3) e passa em ordem normal. É investigado dentro do orçamento e corrigido preservando o comportamento afirmado. Sem quarentena e sem retry. Se não fechar, Unit/Integration continua adotável na validação por mudança, e o resultado integral fica vermelho e registrado.
- **Achados tolerados**: nenhum.
- **Gate Proofs**: Unit: inverter uma condição numa operação de `src/control/rules`. Integration: quebrar um mapeamento num adapter (ex.: rótulos no adapter do issue tracker).
- **Guides**: `testing-strategy.md` ganha as definições de nível e o ponteiro para a política de níveis.
- **Orçamento**: 1 sessão.

## S4: Format (reformat aprovado como etapa própria)

- **Gatilho**: só começa quando você disser que os branches ativos estão integrados ou pausados (hoje: 9 worktrees e uma sessão pi commitando em `main`).
- **Antes do reformat**: identificar os testes que afirmam a forma do texto-fonte (em #24 foram 6, que passaram a ler a fonte por `test/architecture/source-text.ts`). A atualização de expectativa deles precisa da sua aprovação antes de ser feita.
- **Critérios de adoção**: Prettier 3.9.10 fixado, modo check, sobre `*.{ts,mts,cts,js,mjs,cjs}`; fast; conjunto alterado na validação por mudança, árvore inteira no integral. Um commit só de formatação, listado em `.git-blame-ignore-revs`. Hoje: 704 arquivos diferem.
- **Achados tolerados**: nenhum.
- **Gate Proof**: desindentar uma linha, declarando o arquivo como escopo da prova.
- **Orçamento**: 1 sessão + `test:ci` depois do reformat.

## S5: Secrets

Vem depois de S4 porque as identidades dos achados na árvore usam linha e coluna.

- **Critérios de adoção**: gitleaks 8.30.1 (via `mise.toml`) sobre a árvore de trabalho e o histórico alcançável de HEAD (não todas as refs locais); fast. Um wrapper casa cada achado com uma entrada da política de tolerância pela identidade (commit ou árvore, arquivo, regra, linha:coluna) e falha achados sem entrada, entradas duplicadas, achados que cresceram e entradas obsoletas.
- **Mudanças de código**: os 9 tokens sintéticos de `test/` são reescritos para formas que o gitleaks não reconhece, comportamento preservado.
- **Achados tolerados**, cada um com a sua decisão explícita registrada ao lado da entrada na política:
  - árvore: os 6 de `.scratch/software-factory-v2/research/alpine-guest-evidence.json` ("fingerprint público de host key SSH em evidência que não se altera; sem credencial") e o de `src/sandbox/lambda/transport.ts` ("template do cabeçalho PEM de uma chave gerada em runtime; sem material de chave"). Medidos em `fa17c645` (apêndice abaixo); re-identificados na árvore pós-reformat.
  - histórico de HEAD: os 16 achados do apêndice ("fixture sintética, fingerprint público ou template; sem credencial").
- **Regra de aperto**: uma entrada sai na mesma mudança revisada que remove o seu achado; uma entrada obsoleta falha. Um achado de segurança novo depois do início da adoção só é tolerado por nova decisão explícita registrada ao lado dele; qualquer outro achado novo é corrigido.
- **Gate Proof**: adicionar um arquivo com uma chave de acesso AWS falsa bem formada.
- **Orçamento**: 1 sessão.

## S6: Static metrics

- **Critérios de adoção**: complexidade ≤ 10 por função (ESLint `complexity`), zero ciclos (`no-cycles` existente), duplicação ≤ 3% (jscpd 5.4.2), sobre `src/` (produção). `test/` e `scripts/` ficam fora do escopo declarado, como alvos que não são de produção; o motivo fica na config. Fast.
- **Achados tolerados**: as 412 funções de `src/` acima do limite, cada uma pela sua identidade (arquivo + função + valor medido; função anônima também pela posição), listadas no apêndice "complexity-src" medido em `fa17c645`. S6 roda depois do reformat e re-identifica as posições na mesma mudança revisada, sem acrescentar nem elevar nenhuma entrada. Duplicação: 1,12% em `src/` (56 clones), dentro do limite, sem tolerância.
- **Regra de aperto**: uma função que baixa de complexidade baixa (ou remove) sua entrada na mesma mudança revisada; uma que sobe falha; uma função nova acima de 10 falha.
- **Gate Proof**: uma função nova em `src/control/rules` com onze ramos independentes.
- **Orçamento**: 1 sessão.

## Fora das etapas

- **E2E tests — bloqueado.** O Contract pede cenários que dirigem a CLI `factory` da release construída e que, juntos, alcançam todos os contextos. A fixture de release tem assets de guest sintéticos e não bootáveis, e Builder e revisores precisam de sessões reais de modelo sob autorização por execução. **Para desbloquear**: uma release com os assets de guest reais e bootáveis, credenciais de modelo e autorização por execução para a rodada E2E. Quando houver: @cucumber/cucumber fixado, features em Gherkin português (`# language: pt`), você aprova os cenários antes das step definitions.
- **Mutation — pendente.** Em #24, o Stryker 10.1.1 gerou 58.473 mutantes, e o tap runner não tem cobertura por teste (cerca de 12 h só no nível unit). **Decisão aberta**: um runner com cobertura por teste, uma cadência e um orçamento mais longos para a execução sobre o código inteiro, ou um escopo menor aprovado por emenda. A contagem é medida de novo quando a etapa existir.

## Expectativa de estabelecimento

Ao fim de S1–S6, E2E continua bloqueado e Mutation pendente: o engineering harness **não estará estabelecido**, e o relatório final dirá isso, com o estado de cada quality gate.

## Apêndice A — Secrets, árvore de trabalho (fa17c645)

| Arquivo | Regra | Linha:coluna | Tratamento |
|---|---|---|---|
| `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 33:1168 | tolerado por decisão explícita |
| `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 33:1362 | tolerado por decisão explícita |
| `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 37:1168 | tolerado por decisão explícita |
| `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 37:1362 | tolerado por decisão explícita |
| `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 37:1922 | tolerado por decisão explícita |
| `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 37:2116 | tolerado por decisão explícita |
| `test/control/budget-doubles.ts` | generic-api-key | 83:31 | reescrito em S5 (token sintético) |
| `test/control/delivery-control-flow.test.ts` | generic-api-key | 34:66 | reescrito em S5 (token sintético) |
| `test/control/cycles-flow.test.ts` | generic-api-key | 34:66 | reescrito em S5 (token sintético) |
| `test/control/continuation-flow.test.ts` | generic-api-key | 52:31 | reescrito em S5 (token sintético) |
| `test/control/review13-question-flow.test.ts` | generic-api-key | 64:45 | reescrito em S5 (token sintético) |
| `src/sandbox/lambda/transport.ts` | private-key | 87:19 | tolerado por decisão explícita |
| `test/control/question-flow.test.ts` | generic-api-key | 41:31 | reescrito em S5 (token sintético) |
| `test/entrypoints/inspect29-qualification.test.ts` | jwt | 35:85 | reescrito em S5 (token sintético) |
| `test/entrypoints/long34-provider.ts` | generic-api-key | 13:15 | reescrito em S5 (token sintético) |
| `test/sandbox/lambda-tools.test.ts` | generic-api-key | 465:10 | reescrito em S5 (token sintético) |

## Apêndice B — Secrets, histórico de HEAD (fa17c645)

| Commit | Arquivo | Regra | Linha:coluna |
|---|---|---|---|
| `a1af7992ba5c377a3333f672194751557e2e7aef` | `test/sandbox/lambda-tools.test.ts` | generic-api-key | 465:10 |
| `0aed0e8b786d32211f2b74cfd40fc0e3f052abac` | `src/sandbox/lambda/transport.ts` | private-key | 82:19 |
| `0d2e225ffdd44c7fd9089131c04a141b931b88d2` | `test/entrypoints/long34-provider.ts` | generic-api-key | 11:15 |
| `f6b463c83399b5f86709f5e2ce711162242e4c81` | `test/entrypoints/inspect29-qualification.test.ts` | jwt | 35:85 |
| `da556394ac379673709b2f8468d675d12bb8cdcd` | `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 33:1168 |
| `da556394ac379673709b2f8468d675d12bb8cdcd` | `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 33:1362 |
| `da556394ac379673709b2f8468d675d12bb8cdcd` | `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 37:1168 |
| `da556394ac379673709b2f8468d675d12bb8cdcd` | `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 37:1362 |
| `da556394ac379673709b2f8468d675d12bb8cdcd` | `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 37:1922 |
| `da556394ac379673709b2f8468d675d12bb8cdcd` | `.scratch/software-factory-v2/research/alpine-guest-evidence.json` | generic-api-key | 37:2116 |
| `dc080a446b6a95423dd98855229f04309366908b` | `test/control/cycles-flow.test.ts` | generic-api-key | 33:66 |
| `a719df2e0e60ffa8eb08b09f703c0f90ba5ed316` | `test/control/delivery-control-flow.test.ts` | generic-api-key | 33:66 |
| `807f6798d600c9c467ac6fbe3d382f5015375d51` | `test/control/review13-question-flow.test.ts` | generic-api-key | 60:45 |
| `48eb6e96a54617034f91f0cbb2855e819ee82637` | `test/control/continuation-flow.test.ts` | generic-api-key | 42:31 |
| `6be181a3118602987aa0456e1c119c229d7b01fb` | `test/control/budget-doubles.ts` | generic-api-key | 71:31 |
| `04f4878f03609ed4168962302cd2c933e1be1f56` | `test/control/question-flow.test.ts` | generic-api-key | 40:31 |

## Apêndice C — Static metrics, complexidade em src/ (fa17c645, 412 entradas)

| # | Arquivo | Função | Linha:coluna | Complexidade |
|---|---|---|---|---|
| 1 | `src/code-repository/delivery.ts` | Async method `readOwnMerge` | 69:5 | 14 |
| 2 | `src/code-repository/delivery.ts` | Async method `cleanupBranch` | 103:5 | 14 |
| 3 | `src/code-repository/delivery.ts` | Async arrow function | 112:71 | 25 |
| 4 | `src/code-repository/index.ts` | Async function `associate` | 109:3 | 31 |
| 5 | `src/code-repository/index.ts` | Async arrow function | 169:84 | 14 |
| 6 | `src/code-repository/index.ts` | Async method `findPublication` | 266:5 | 27 |
| 7 | `src/code-repository/loss-markers.ts` | Async method `cleanupLostMarkers` | 54:5 | 17 |
| 8 | `src/code-repository/pull-request.ts` | Arrow function | 104:41 | 28 |
| 9 | `src/code-repository/pull-request.ts` | Arrow function | 134:56 | 13 |
| 10 | `src/code-repository/pull-request.ts` | Async function `requirements` | 154:3 | 13 |
| 11 | `src/code-repository/pull-request.ts` | Async function `readPullRequest` | 191:10 | 17 |
| 12 | `src/contracts/environment.ts` | Function `validateEnvironmentDeclaration` | 34:8 | 11 |
| 13 | `src/contracts/environment.ts` | Arrow function | 45:86 | 13 |
| 14 | `src/control/durable/admission.ts` | Async arrow function | 93:34 | 16 |
| 15 | `src/control/durable/admission.ts` | Arrow function | 142:50 | 13 |
| 16 | `src/control/durable/admission.ts` | Async function `ownCycles` | 160:8 | 23 |
| 17 | `src/control/durable/admission.ts` | Async arrow function | 191:34 | 17 |
| 18 | `src/control/durable/boot-swap.ts` | Async arrow function | 28:34 | 11 |
| 19 | `src/control/durable/boot-swap.ts` | Async arrow function | 58:34 | 11 |
| 20 | `src/control/durable/boot-swap.ts` | Async arrow function | 77:34 | 14 |
| 21 | `src/control/durable/boot-swap.ts` | Async arrow function | 116:34 | 12 |
| 22 | `src/control/durable/checks.ts` | Async arrow function | 35:34 | 19 |
| 23 | `src/control/durable/checks.ts` | Async method `pass` | 93:5 | 27 |
| 24 | `src/control/durable/control.ts` | Async function `openControl` | 114:8 | 42 |
| 25 | `src/control/durable/control.ts` | Async method `afterCycle` | 157:5 | 11 |
| 26 | `src/control/durable/control.ts` | Arrow function | 217:65 | 20 |
| 27 | `src/control/durable/control.ts` | Arrow function | 231:78 | 20 |
| 28 | `src/control/durable/control.ts` | Arrow function | 248:99 | 14 |
| 29 | `src/control/durable/control.ts` | Async method `accept` | 287:5 | 21 |
| 30 | `src/control/durable/control.ts` | Async method `inspect` | 319:5 | 55 |
| 31 | `src/control/durable/control.ts` | Async method `run` | 427:5 | 24 |
| 32 | `src/control/durable/control.ts` | Async arrow function | 436:33 | 11 |
| 33 | `src/control/durable/cycles.ts` | Async arrow function | 63:43 | 16 |
| 34 | `src/control/durable/cycles.ts` | Async arrow function | 95:43 | 17 |
| 35 | `src/control/durable/cycles.ts` | Async arrow function | 130:43 | 21 |
| 36 | `src/control/durable/cycles.ts` | Async arrow function | 168:43 | 13 |
| 37 | `src/control/durable/cycles.ts` | Async arrow function | 204:43 | 19 |
| 38 | `src/control/durable/cycles.ts` | Async function `acceptNewCycle` | 256:8 | 16 |
| 39 | `src/control/durable/cycles.ts` | Async arrow function | 280:43 | 22 |
| 40 | `src/control/durable/cycles.ts` | Async arrow function | 383:34 | 20 |
| 41 | `src/control/durable/cycles.ts` | Async function `reopen` | 452:3 | 12 |
| 42 | `src/control/durable/delivery-desk.ts` | Async function `sweep` | 87:3 | 37 |
| 43 | `src/control/durable/delivery-desk.ts` | Async method `cycle` | 158:5 | 19 |
| 44 | `src/control/durable/delivery.ts` | Async arrow function | 30:34 | 36 |
| 45 | `src/control/durable/dispatch.ts` | Async function `renew` | 119:3 | 14 |
| 46 | `src/control/durable/dispatch.ts` | Async function `reviewRound` | 298:3 | 72 |
| 47 | `src/control/durable/dispatch.ts` | Async arrow function | 351:110 | 12 |
| 48 | `src/control/durable/dispatch.ts` | Async arrow function | 373:54 | 25 |
| 49 | `src/control/durable/dispatch.ts` | Async arrow function | 417:76 | 21 |
| 50 | `src/control/durable/dispatch.ts` | Async function `authorizedChangesOf` | 503:3 | 11 |
| 51 | `src/control/durable/dispatch.ts` | Async function `activationPlan` | 554:3 | 124 |
| 52 | `src/control/durable/dispatch.ts` | Async function `substituteInstruction` | 700:3 | 20 |
| 53 | `src/control/durable/dispatch.ts` | Async function `publicationPlan` | 728:3 | 18 |
| 54 | `src/control/durable/dispatch.ts` | Async function `reconciliationPlan` | 762:3 | 30 |
| 55 | `src/control/durable/dispatch.ts` | Async function `discover` | 823:3 | 27 |
| 56 | `src/control/durable/dispatch.ts` | Async function `reconcileOne` | 868:3 | 20 |
| 57 | `src/control/durable/dispatch.ts` | Async function `execute` | 895:3 | 312 |
| 58 | `src/control/durable/dispatch.ts` | Async arrow function | 944:154 | 12 |
| 59 | `src/control/durable/dispatch.ts` | Async arrow function | 997:146 | 12 |
| 60 | `src/control/durable/dispatch.ts` | Async arrow function | 1032:49 | 19 |
| 61 | `src/control/durable/dispatch.ts` | Async arrow function | 1061:56 | 32 |
| 62 | `src/control/durable/dispatch.ts` | Async arrow function | 1118:109 | 34 |
| 63 | `src/control/durable/dispatch.ts` | Async arrow function | 1185:44 | 12 |
| 64 | `src/control/durable/dispatch.ts` | Arrow function | 1366:18 | 12 |
| 65 | `src/control/durable/dispatch.ts` | Async arrow function | 1546:184 | 67 |
| 66 | `src/control/durable/dispatch.ts` | Async function `revalidateRepair` | 1997:3 | 39 |
| 67 | `src/control/durable/dispatch.ts` | Async function `dispatchOne` | 2095:3 | 91 |
| 68 | `src/control/durable/execution.ts` | Function `interruptionBasis` | 31:8 | 15 |
| 69 | `src/control/durable/execution.ts` | Async arrow function | 86:34 | 183 |
| 70 | `src/control/durable/execution.ts` | Function `consumeReservation` | 258:8 | 11 |
| 71 | `src/control/durable/execution.ts` | Arrow function | 317:110 | 14 |
| 72 | `src/control/durable/execution.ts` | Async arrow function | 382:48 | 17 |
| 73 | `src/control/durable/execution.ts` | Async arrow function | 465:49 | 17 |
| 74 | `src/control/durable/execution.ts` | Async arrow function | 499:34 | 19 |
| 75 | `src/control/durable/execution.ts` | Async arrow function | 566:34 | 11 |
| 76 | `src/control/durable/execution.ts` | Async arrow function | 580:34 | 11 |
| 77 | `src/control/durable/execution.ts` | Async arrow function | 600:49 | 20 |
| 78 | `src/control/durable/execution.ts` | Async arrow function | 631:34 | 26 |
| 79 | `src/control/durable/execution.ts` | Function `applyConfirmedCessation` | 658:8 | 23 |
| 80 | `src/control/durable/execution.ts` | Async arrow function | 700:34 | 12 |
| 81 | `src/control/durable/feedback.ts` | Async arrow function | 50:34 | 39 |
| 82 | `src/control/durable/feedback.ts` | Async arrow function | 104:34 | 21 |
| 83 | `src/control/durable/feedback.ts` | Async function `observeFeedback` | 200:8 | 12 |
| 84 | `src/control/durable/feedback.ts` | Async arrow function | 230:34 | 13 |
| 85 | `src/control/durable/forget.ts` | Async arrow function | 54:43 | 13 |
| 86 | `src/control/durable/forget.ts` | Async arrow function | 79:43 | 16 |
| 87 | `src/control/durable/forget.ts` | Function `contentRequestIds` | 149:8 | 15 |
| 88 | `src/control/durable/forget.ts` | Async arrow function | 171:34 | 25 |
| 89 | `src/control/durable/forget.ts` | Async arrow function | 213:34 | 13 |
| 90 | `src/control/durable/format.ts` | Async function `examine` | 74:8 | 53 |
| 91 | `src/control/durable/inspection.ts` | Async function `inspectLogs` | 29:8 | 18 |
| 92 | `src/control/durable/inspection.ts` | Async function `inspectLog` | 64:8 | 25 |
| 93 | `src/control/durable/inspection.ts` | Async function `workUsage` | 108:8 | 32 |
| 94 | `src/control/durable/inspection.ts` | Async function `inspectUsage` | 168:8 | 11 |
| 95 | `src/control/durable/loss.ts` | Async arrow function | 14:34 | 13 |
| 96 | `src/control/durable/migration.ts` | Async function `migrateStorage` | 23:8 | 19 |
| 97 | `src/control/durable/origin-divergence.ts` | Async arrow function | 35:34 | 11 |
| 98 | `src/control/durable/origin-divergence.ts` | Async arrow function | 59:34 | 20 |
| 99 | `src/control/durable/origin-read.ts` | Async function `readOriginOf` | 10:8 | 13 |
| 100 | `src/control/durable/polling.ts` | Async function `entry` | 80:3 | 12 |
| 101 | `src/control/durable/polling.ts` | Async function `publish` | 118:3 | 18 |
| 102 | `src/control/durable/polling.ts` | Async function `dependencies` | 153:3 | 17 |
| 103 | `src/control/durable/polling.ts` | Async function `cycle` | 175:3 | 18 |
| 104 | `src/control/durable/preservation.ts` | Async arrow function | 15:34 | 13 |
| 105 | `src/control/durable/preservation.ts` | Async arrow function | 35:34 | 12 |
| 106 | `src/control/durable/publication.ts` | Async arrow function | 30:34 | 12 |
| 107 | `src/control/durable/publication.ts` | Arrow function | 46:40 | 36 |
| 108 | `src/control/durable/publication.ts` | Arrow function | 87:40 | 30 |
| 109 | `src/control/durable/publication.ts` | Arrow function | 111:40 | 13 |
| 110 | `src/control/durable/publication.ts` | Arrow function | 143:40 | 11 |
| 111 | `src/control/durable/publication.ts` | Async arrow function | 184:52 | 89 |
| 112 | `src/control/durable/publication.ts` | Async arrow function | 345:52 | 22 |
| 113 | `src/control/durable/publication.ts` | Async arrow function | 407:34 | 15 |
| 114 | `src/control/durable/question-desk.ts` | Async function `publishPending` | 23:3 | 25 |
| 115 | `src/control/durable/question-desk.ts` | Async function `publishReplies` | 59:3 | 22 |
| 116 | `src/control/durable/question-desk.ts` | Async function `ingestAnswers` | 81:3 | 13 |
| 117 | `src/control/durable/questions.ts` | Async arrow function | 58:34 | 15 |
| 118 | `src/control/durable/questions.ts` | Async arrow function | 130:34 | 19 |
| 119 | `src/control/durable/questions.ts` | Async arrow function | 172:34 | 25 |
| 120 | `src/control/durable/readiness.ts` | Arrow function | 50:55 | 23 |
| 121 | `src/control/durable/readiness.ts` | Arrow function | 84:55 | 17 |
| 122 | `src/control/durable/readiness.ts` | Arrow function | 129:55 | 24 |
| 123 | `src/control/durable/readiness.ts` | Async arrow function | 173:34 | 21 |
| 124 | `src/control/durable/readiness.ts` | Async method `pass` | 225:5 | 32 |
| 125 | `src/control/durable/recovery-request.ts` | Function `applyRecoveryRequest` | 10:8 | 12 |
| 126 | `src/control/durable/recovery.ts` | Function `unconfirmedBoot` | 36:8 | 20 |
| 127 | `src/control/durable/recovery.ts` | Function `boundDiscoveredDuration` | 113:1 | 11 |
| 128 | `src/control/durable/recovery.ts` | Async arrow function | 140:34 | 108 |
| 129 | `src/control/durable/recovery.ts` | Function `settleInterruptedReviews` | 322:1 | 13 |
| 130 | `src/control/durable/recovery.ts` | Async function `reconcileExecution` | 336:8 | 15 |
| 131 | `src/control/durable/recovery.ts` | Async function `recordUninspectedLoss` | 368:1 | 16 |
| 132 | `src/control/durable/recovery.ts` | Async function `reconcileBoot` | 386:8 | 48 |
| 133 | `src/control/durable/repair.ts` | Async arrow function | 28:34 | 75 |
| 134 | `src/control/durable/repair.ts` | Async method `pass` | 162:5 | 13 |
| 135 | `src/control/durable/retention-desk.ts` | Async function `executeForgets` | 95:3 | 15 |
| 136 | `src/control/durable/retention-desk.ts` | Async function `executePlans` | 145:3 | 18 |
| 137 | `src/control/durable/retention-desk.ts` | Async method `cycle` | 178:5 | 15 |
| 138 | `src/control/durable/retention.ts` | Async function `preserveSessions` | 73:8 | 12 |
| 139 | `src/control/durable/retention.ts` | Arrow function | 116:40 | 21 |
| 140 | `src/control/durable/retention.ts` | Arrow function | 188:40 | 21 |
| 141 | `src/control/durable/retention.ts` | Arrow function | 229:40 | 11 |
| 142 | `src/control/durable/retention.ts` | Async arrow function | 309:43 | 22 |
| 143 | `src/control/durable/review-recovery.ts` | Arrow function | 27:78 | 19 |
| 144 | `src/control/durable/review-recovery.ts` | Async arrow function | 70:34 | 17 |
| 145 | `src/control/durable/review.ts` | Arrow function | 41:101 | 47 |
| 146 | `src/control/durable/review.ts` | Arrow function | 50:65 | 21 |
| 147 | `src/control/durable/review.ts` | Arrow function | 115:78 | 22 |
| 148 | `src/control/durable/review.ts` | Async arrow function | 176:34 | 12 |
| 149 | `src/control/durable/scope.ts` | Async arrow function | 21:34 | 14 |
| 150 | `src/control/durable/store.ts` | Async function `openStore` | 21:8 | 21 |
| 151 | `src/control/rules/admission.ts` | Function `evaluateEntry` | 25:8 | 13 |
| 152 | `src/control/rules/boot-notice.ts` | Function `originContinuity` | 27:8 | 11 |
| 153 | `src/control/rules/budget-continuation.ts` | Function `budgetEndProgress` | 14:8 | 13 |
| 154 | `src/control/rules/budget-continuation.ts` | Function `builderBudgetPolicy` | 44:8 | 11 |
| 155 | `src/control/rules/budget-continuation.ts` | Function `stateSummary` | 93:8 | 31 |
| 156 | `src/control/rules/budget.ts` | Function `durationView` | 100:8 | 15 |
| 157 | `src/control/rules/checks.ts` | Arrow function | 72:25 | 36 |
| 158 | `src/control/rules/checks.ts` | Function `evaluateChecks` | 162:8 | 93 |
| 159 | `src/control/rules/checks.ts` | Arrow function | 168:69 | 11 |
| 160 | `src/control/rules/continuation.ts` | Function `scopeUpdateDecision` | 25:8 | 13 |
| 161 | `src/control/rules/continuation.ts` | Function `sessionDecision` | 44:8 | 13 |
| 162 | `src/control/rules/continuation.ts` | Function `recoveryContext` | 76:8 | 18 |
| 163 | `src/control/rules/cycles.ts` | Function `authorizationChange` | 51:8 | 20 |
| 164 | `src/control/rules/cycles.ts` | Function `reopenDecision` | 127:8 | 11 |
| 165 | `src/control/rules/cycles.ts` | Function `newCycleDecision` | 143:8 | 18 |
| 166 | `src/control/rules/delivery.ts` | Function `ownPullRequestOf` | 16:8 | 11 |
| 167 | `src/control/rules/delivery.ts` | Function `decideMerge` | 34:8 | 18 |
| 168 | `src/control/rules/delivery.ts` | Function `cleanupEligibility` | 66:8 | 16 |
| 169 | `src/control/rules/delivery.ts` | Function `planCleanup` | 89:8 | 14 |
| 170 | `src/control/rules/dependencies.ts` | Function `evaluateDependencies` | 83:8 | 27 |
| 171 | `src/control/rules/divergence.ts` | Function `knownRemote` | 28:8 | 18 |
| 172 | `src/control/rules/divergence.ts` | Function `divergenceQuestion` | 66:8 | 17 |
| 173 | `src/control/rules/environment.ts` | Function `environmentOutcome` | 23:8 | 12 |
| 174 | `src/control/rules/feedback.ts` | Function `reviewRequests` | 24:8 | 14 |
| 175 | `src/control/rules/forget.ts` | Function `forgetRefusals` | 19:8 | 31 |
| 176 | `src/control/rules/forget.ts` | Function `minimalMemoryOf` | 66:8 | 17 |
| 177 | `src/control/rules/inspection.ts` | Function `chainExecution` | 78:1 | 29 |
| 178 | `src/control/rules/inspection.ts` | Function `phaseOf` | 100:8 | 20 |
| 179 | `src/control/rules/inspection.ts` | Function `chainOf` | 124:8 | 72 |
| 180 | `src/control/rules/inspection.ts` | Function `usageActivity` | 219:8 | 37 |
| 181 | `src/control/rules/inspection.ts` | Function `usageSubjects` | 284:8 | 31 |
| 182 | `src/control/rules/inspection.ts` | Function `sessionLocator` | 306:8 | 15 |
| 183 | `src/control/rules/inspection.ts` | Function `bootConsumption` | 375:8 | 21 |
| 184 | `src/control/rules/preservation.ts` | Function `gateDecision` | 22:8 | 12 |
| 185 | `src/control/rules/publication.ts` | Function `publishableContent` | 25:8 | 37 |
| 186 | `src/control/rules/publication.ts` | Function `preservationCheck` | 115:8 | 17 |
| 187 | `src/control/rules/publication.ts` | Function `otherPublications` | 169:8 | 11 |
| 188 | `src/control/rules/publication.ts` | Function `decideDiscovery` | 225:8 | 107 |
| 189 | `src/control/rules/publication.ts` | Function `descriptionCheck` | 367:8 | 17 |
| 190 | `src/control/rules/publication.ts` | Function `publicationPrompt` | 395:8 | 14 |
| 191 | `src/control/rules/publication.ts` | Function `publicationStep` | 472:8 | 39 |
| 192 | `src/control/rules/questions.ts` | Function `parseFactoryCommand` | 20:8 | 14 |
| 193 | `src/control/rules/questions.ts` | Function `validateQuestionRequest` | 88:8 | 11 |
| 194 | `src/control/rules/questions.ts` | Function `recoveredQuestionDecision` | 134:8 | 14 |
| 195 | `src/control/rules/questions.ts` | Function `recoveryPrompt` | 203:8 | 13 |
| 196 | `src/control/rules/questions.ts` | Arrow function | 223:57 | 22 |
| 197 | `src/control/rules/quiescence.ts` | Arrow function | 8:29 | 11 |
| 198 | `src/control/rules/readiness.ts` | Function `readinessBasis` | 28:8 | 20 |
| 199 | `src/control/rules/readiness.ts` | Function `evaluateReadiness` | 49:8 | 69 |
| 200 | `src/control/rules/readiness.ts` | Function `readinessAction` | 134:8 | 33 |
| 201 | `src/control/rules/readiness.ts` | Function `readinessNextStep` | 181:8 | 12 |
| 202 | `src/control/rules/recovery.ts` | Function `overrideBlockedRecoveryDecision` | 213:8 | 26 |
| 203 | `src/control/rules/recovery.ts` | Function `retryBlockedStartDecision` | 284:8 | 25 |
| 204 | `src/control/rules/recovery.ts` | Function `newReviewRoundDecision` | 332:8 | 22 |
| 205 | `src/control/rules/repair.ts` | Function `repairTriggers` | 27:8 | 35 |
| 206 | `src/control/rules/repair.ts` | Function `repairDecision` | 96:8 | 26 |
| 207 | `src/control/rules/repair.ts` | Function `correctionClosure` | 137:8 | 26 |
| 208 | `src/control/rules/retention.ts` | Function `retentionProtections` | 30:8 | 35 |
| 209 | `src/control/rules/retention.ts` | Function `planExplicitCleanup` | 130:8 | 52 |
| 210 | `src/control/rules/retention.ts` | Function `revalidateItem` | 202:8 | 12 |
| 211 | `src/control/rules/review-recovery.ts` | Function `sameReviewProfile` | 110:8 | 13 |
| 212 | `src/control/rules/review-recovery.ts` | Function `carryPlan` | 128:8 | 21 |
| 213 | `src/control/rules/review-recovery.ts` | Function `preservedReviewContext` | 175:8 | 16 |
| 214 | `src/control/rules/review.ts` | Arrow function | 46:33 | 21 |
| 215 | `src/control/rules/review.ts` | Function `concludeRound` | 102:8 | 18 |
| 216 | `src/control/rules/review.ts` | Function `sameProposal` | 156:8 | 11 |
| 217 | `src/control/rules/review.ts` | Function `classifyCapture` | 175:8 | 12 |
| 218 | `src/control/rules/review.ts` | Function `opinionCorrelated` | 202:8 | 16 |
| 219 | `src/control/rules/review.ts` | Function `inheritedRounds` | 231:8 | 12 |
| 220 | `src/control/rules/review.ts` | Function `verifyExecution` | 258:8 | 44 |
| 221 | `src/control/rules/review.ts` | Arrow function | 294:33 | 30 |
| 222 | `src/control/rules/review.ts` | Arrow function | 332:65 | 11 |
| 223 | `src/control/rules/substitute.ts` | Function `substituteVersions` | 44:8 | 16 |
| 224 | `src/control/rules/substitute.ts` | Function `substitutePackage` | 74:8 | 32 |
| 225 | `src/entrypoints/cli.ts` | Function `inspectionOptions` | 46:1 | 50 |
| 226 | `src/entrypoints/cli.ts` | Function `inspectionQuery` | 67:1 | 15 |
| 227 | `src/entrypoints/cli.ts` | Async function `operational` | 78:1 | 90 |
| 228 | `src/entrypoints/cli.ts` | Arrow function | 129:44 | 11 |
| 229 | `src/entrypoints/cli.ts` | Async function `main` | 156:8 | 255 |
| 230 | `src/entrypoints/configuration.ts` | Async function `readConfiguration` | 68:8 | 15 |
| 231 | `src/entrypoints/controller/composition.ts` | Async function `composeProductionExecution` | 140:8 | 21 |
| 232 | `src/entrypoints/controller/inspection.ts` | Async function `answerInspection` | 31:8 | 16 |
| 233 | `src/entrypoints/controller/owner.ts` | Async function `own` | 11:1 | 26 |
| 234 | `src/entrypoints/controller/serve.ts` | Async method `message` | 39:29 | 12 |
| 235 | `src/entrypoints/controller/upgrade.ts` | Async function `readJournal` | 64:8 | 13 |
| 236 | `src/entrypoints/controller/upgrade.ts` | Async function `selectedRelease` | 82:1 | 14 |
| 237 | `src/entrypoints/controller/upgrade.ts` | Async function `compatibility` | 112:1 | 71 |
| 238 | `src/entrypoints/controller/upgrade.ts` | Async function `finish` | 244:1 | 16 |
| 239 | `src/entrypoints/controller/upgrade.ts` | Async function `upgrade` | 276:8 | 55 |
| 240 | `src/entrypoints/controller/upgrade.ts` | Async function `main` | 388:1 | 12 |
| 241 | `src/entrypoints/doctor.ts` | Async function `doctor` | 10:8 | 45 |
| 242 | `src/entrypoints/release-build.ts` | Async function `copyTree` | 34:8 | 16 |
| 243 | `src/entrypoints/release-build.ts` | Async arrow function | 94:52 | 16 |
| 244 | `src/entrypoints/release-build.ts` | Function `unaccountedShippedPaths` | 144:8 | 18 |
| 245 | `src/entrypoints/release-build.ts` | Async function `buildRelease` | 210:8 | 50 |
| 246 | `src/entrypoints/release-build.ts` | Async function `main` | 406:1 | 13 |
| 247 | `src/entrypoints/release.ts` | Function `productionBuilderPrompt` | 116:8 | 14 |
| 248 | `src/entrypoints/release.ts` | Async arrow function | 228:89 | 14 |
| 249 | `src/entrypoints/release.ts` | Async function `verifyReleaseTree` | 296:8 | 16 |
| 250 | `src/entrypoints/release.ts` | Async function `inspectRelease` | 344:8 | 24 |
| 251 | `src/entrypoints/setup.ts` | Async function `setup` | 28:8 | 20 |
| 252 | `src/entrypoints/setup.ts` | Async function `setupService` | 97:8 | 12 |
| 253 | `src/issue-tracker/index.ts` | Async function `readDependencyGraph` | 132:3 | 36 |
| 254 | `src/issue-tracker/index.ts` | Async method `postComment` | 289:5 | 22 |
| 255 | `src/platform/github/index.ts` | Function `validate` | 181:3 | 11 |
| 256 | `src/platform/github/index.ts` | Function `parseResponse` | 192:3 | 58 |
| 257 | `src/platform/github/index.ts` | Async function `issue` | 277:3 | 30 |
| 258 | `src/platform/github/index.ts` | Async function `appRequest` | 298:5 | 16 |
| 259 | `src/platform/github/index.ts` | Arrow function | 322:35 | 13 |
| 260 | `src/platform/github/index.ts` | Async method `list` | 387:8 | 26 |
| 261 | `src/platform/github/index.ts` | Async function `revokeToken` | 432:3 | 12 |
| 262 | `src/platform/github/index.ts` | Async function `pullMutation` | 452:3 | 44 |
| 263 | `src/platform/github/index.ts` | Async method `comment` | 520:6 | 25 |
| 264 | `src/platform/github/index.ts` | Async method `cleanup` | 565:6 | 15 |
| 265 | `src/platform/github/index.ts` | Async method `deleteRefIfAt` | 588:47 | 20 |
| 266 | `src/platform/github/index.ts` | Async method `read` | 658:6 | 18 |
| 267 | `src/platform/host/index.ts` | Async function `controllerPaths` | 27:8 | 19 |
| 268 | `src/platform/host/index.ts` | Async function `verifyControllerLock` | 56:8 | 11 |
| 269 | `src/platform/host/worker-bootstrap.ts` | Function `rolePolicies` | 78:1 | 25 |
| 270 | `src/platform/host/worker-launch.ts` | Function `planWorkerLaunch` | 32:8 | 13 |
| 271 | `src/platform/host/worker-launch.ts` | Async function `privateJson` | 102:1 | 12 |
| 272 | `src/platform/host/worker-launch.ts` | Async function `prepareReviewerContinuation` | 147:8 | 21 |
| 273 | `src/platform/host/worker-launch.ts` | Async function `launchWorker` | 190:8 | 16 |
| 274 | `src/platform/host/worker-launch.ts` | Arrow function | 253:31 | 18 |
| 275 | `src/platform/host/worker-launch.ts` | Async arrow function | 278:24 | 21 |
| 276 | `src/platform/host/worker-secret-ipc.ts` | Function `message` | 84:3 | 13 |
| 277 | `src/platform/host/worker-secret-ipc.ts` | Async method `acknowledgeSecrets` | 103:5 | 14 |
| 278 | `src/platform/host/worker-secret-ipc.ts` | Function `message` | 195:3 | 11 |
| 279 | `src/platform/host/worker-session-file.ts` | Async function `readConfinedFile` | 37:8 | 25 |
| 280 | `src/protocol/index.ts` | Arrow function | 50:19 | 17 |
| 281 | `src/records/forget.ts` | Async function `scan` | 32:1 | 12 |
| 282 | `src/records/forget.ts` | Async function `forgetWorkRecords` | 80:8 | 18 |
| 283 | `src/records/index.ts` | Async function `privateDirectory` | 53:1 | 12 |
| 284 | `src/records/index.ts` | Function `visit` | 127:3 | 20 |
| 285 | `src/records/index.ts` | Async function `openCapture` | 222:3 | 11 |
| 286 | `src/records/index.ts` | Async method `write` | 318:9 | 11 |
| 287 | `src/records/index.ts` | Async generator function `stream` | 392:5 | 21 |
| 288 | `src/records/index.ts` | Async function `readPage` | 448:3 | 43 |
| 289 | `src/records/index.ts` | Async function `find` | 505:3 | 35 |
| 290 | `src/records/retention.ts` | Async function `captureClass` | 38:1 | 11 |
| 291 | `src/records/retention.ts` | Async function `listEvidence` | 109:1 | 18 |
| 292 | `src/records/retention.ts` | Async function `listSessions` | 131:1 | 11 |
| 293 | `src/records/retention.ts` | Async function `preserveSessionCopy` | 170:8 | 19 |
| 294 | `src/records/retention.ts` | Async function `removeRecordsDetail` | 211:8 | 30 |
| 295 | `src/sandbox/adapter.ts` | Async function `runSandboxAdapter` | 28:8 | 15 |
| 296 | `src/sandbox/adapter.ts` | Async arrow function | 64:29 | 17 |
| 297 | `src/sandbox/artifact-seeds.ts` | Async function `seedArtifacts` | 57:8 | 22 |
| 298 | `src/sandbox/bash-tools.ts` | Async arrow function | 71:126 | 48 |
| 299 | `src/sandbox/boot-markers.ts` | Method `observe` | 28:5 | 11 |
| 300 | `src/sandbox/capacity.ts` | Function `capacityDiagnostic` | 64:8 | 15 |
| 301 | `src/sandbox/checkout-fingerprint.ts` | Async function `fingerprintCheckout` | 20:8 | 21 |
| 302 | `src/sandbox/checkout-fingerprint.ts` | Async arrow function | 39:58 | 14 |
| 303 | `src/sandbox/checkout-inspection.ts` | Async function `inspectCheckout` | 15:8 | 24 |
| 304 | `src/sandbox/checkout.ts` | Async method `prepare` | 149:5 | 21 |
| 305 | `src/sandbox/checkout.ts` | Async function `reconcileInterruptedCaches` | 197:8 | 14 |
| 306 | `src/sandbox/cleanup-publication.ts` | Async function `recoverLinkedPublication` | 16:1 | 21 |
| 307 | `src/sandbox/cleanup-publication.ts` | Async function `publishCleanupRecord` | 44:8 | 11 |
| 308 | `src/sandbox/confined.ts` | Async function `components` | 10:1 | 11 |
| 309 | `src/sandbox/environment-base.ts` | Function `parseResolvedManifest` | 119:8 | 21 |
| 310 | `src/sandbox/environment-base.ts` | Async function `prepareBase` | 222:1 | 36 |
| 311 | `src/sandbox/evidence-export.ts` | Async function `exportEvidence` | 16:8 | 14 |
| 312 | `src/sandbox/filesystem.ts` | Async function `checkDiskFilesystem` | 95:8 | 20 |
| 313 | `src/sandbox/filesystem.ts` | Async function `ownDisk` | 146:1 | 14 |
| 314 | `src/sandbox/filesystem.ts` | Async function `replacePreservedDisk` | 230:8 | 16 |
| 315 | `src/sandbox/filesystem.ts` | Async function `copyBaseDisk` | 273:8 | 16 |
| 316 | `src/sandbox/gondolin-sdk-profile.ts` | Async function `context` | 74:1 | 36 |
| 317 | `src/sandbox/gondolin-sdk-profile.ts` | Async function `verifyPrepared` | 139:1 | 13 |
| 318 | `src/sandbox/gondolin-sdk-profile.ts` | Async function `prepareDevelopmentGondolinSdk` | 161:8 | 12 |
| 319 | `src/sandbox/guest-assets.ts` | Async function `readAsset` | 28:1 | 22 |
| 320 | `src/sandbox/guest-assets.ts` | Async function `inspectGuestAssets` | 70:8 | 16 |
| 321 | `src/sandbox/guest-journal.ts` | Async function `deriveJournaledGuestAssets` | 21:8 | 20 |
| 322 | `src/sandbox/index.ts` | Async method `start` | 362:5 | 32 |
| 323 | `src/sandbox/index.ts` | Async method `prepare` | 421:5 | 16 |
| 324 | `src/sandbox/index.ts` | Async method `validate` | 448:5 | 22 |
| 325 | `src/sandbox/inventory.ts` | Async function `inventoryRuntime` | 22:8 | 22 |
| 326 | `src/sandbox/lambda/artifacts.ts` | Async function `collectLambdaArtifacts` | 234:8 | 12 |
| 327 | `src/sandbox/lambda/artifacts.ts` | Async function `restoreLambdaArtifacts` | 305:8 | 15 |
| 328 | `src/sandbox/lambda/boot.ts` | Function `ended` | 155:1 | 16 |
| 329 | `src/sandbox/lambda/boot.ts` | Async function `startLambdaBoot` | 243:8 | 51 |
| 330 | `src/sandbox/lambda/boot.ts` | Async function `observeLambdaBoot` | 371:8 | 20 |
| 331 | `src/sandbox/lambda/boot.ts` | Async function `stopLambdaBoot` | 416:8 | 21 |
| 332 | `src/sandbox/lambda/cli-service.ts` | Function `classify` | 33:1 | 11 |
| 333 | `src/sandbox/lambda/cli-service.ts` | Function `listedMicrovms` | 188:8 | 16 |
| 334 | `src/sandbox/lambda/image-cleanup.ts` | Async function `cleanupInstallationImages` | 49:8 | 30 |
| 335 | `src/sandbox/lambda/image.ts` | Async function `prepareLambdaImage` | 95:8 | 46 |
| 336 | `src/sandbox/lambda/owner.ts` | Async function `removeLambdaEnvironment` | 124:8 | 11 |
| 337 | `src/sandbox/lambda/reconciliation.ts` | Function `planLambdaReconciliation` | 41:8 | 15 |
| 338 | `src/sandbox/lambda/reconciliation.ts` | Async function `reconcileLambdaInstallation` | 78:8 | 23 |
| 339 | `src/sandbox/lambda/ssh-transport.ts` | Async function `connect` | 79:3 | 12 |
| 340 | `src/sandbox/lambda/tools.ts` | Async function `recovered` | 70:1 | 16 |
| 341 | `src/sandbox/lambda/tools.ts` | Async arrow function | 135:67 | 22 |
| 342 | `src/sandbox/lambda/tools.ts` | Async method `bind` | 274:5 | 12 |
| 343 | `src/sandbox/lambda/transport.ts` | Async method `exec` | 132:5 | 17 |
| 344 | `src/sandbox/lambda/usage.ts` | Function `lambdaBootUsage` | 21:8 | 18 |
| 345 | `src/sandbox/lambda/usage.ts` | Async function `lambdaImageBuilds` | 46:8 | 13 |
| 346 | `src/sandbox/lambda/validate.ts` | Async function `accountChecks` | 37:1 | 36 |
| 347 | `src/sandbox/lifecycle.ts` | Async function `metadata` | 64:8 | 26 |
| 348 | `src/sandbox/lifecycle.ts` | Async function `observeBootEnvironment` | 148:8 | 35 |
| 349 | `src/sandbox/lifecycle.ts` | Async function `observeEnvironment` | 218:8 | 23 |
| 350 | `src/sandbox/owner-registration.ts` | Async method `message` | 66:5 | 75 |
| 351 | `src/sandbox/preparation-vm.ts` | Async method `run` | 66:5 | 13 |
| 352 | `src/sandbox/preparation-vm.ts` | Async function `runEnvironmentPreparation` | 113:8 | 23 |
| 353 | `src/sandbox/prepare.ts` | Async function `prepareEnvironment` | 45:8 | 30 |
| 354 | `src/sandbox/prepare.ts` | Async arrow function | 58:53 | 22 |
| 355 | `src/sandbox/proposal-identity.ts` | Async function `observeProposal` | 19:8 | 33 |
| 356 | `src/sandbox/read-tools.ts` | Async function `serveReadTools` | 137:8 | 12 |
| 357 | `src/sandbox/read-tools.ts` | Async function `executeBoundTool` | 179:3 | 111 |
| 358 | `src/sandbox/read-tools.ts` | Async arrow function | 280:71 | 11 |
| 359 | `src/sandbox/read-tools.ts` | Async method `executeTool` | 412:5 | 35 |
| 360 | `src/sandbox/remove.ts` | Async function `deleteResource` | 34:1 | 18 |
| 361 | `src/sandbox/remove.ts` | Async function `removeEnvironment` | 87:8 | 18 |
| 362 | `src/sandbox/start.ts` | Async function `startEnvironment` | 90:8 | 58 |
| 363 | `src/sandbox/stop.ts` | Async function `stopEnvironment` | 24:8 | 30 |
| 364 | `src/sandbox/storage-observation.ts` | Async function `diskUsage` | 30:1 | 16 |
| 365 | `src/sandbox/storage-observation.ts` | Async arrow function | 75:69 | 19 |
| 366 | `src/sandbox/write-tools.ts` | Async arrow function | 122:137 | 25 |
| 367 | `src/sandbox/write-tools.ts` | Async function `execute` | 270:10 | 45 |
| 368 | `src/workers/ask-user.ts` | Async method `execute` | 31:5 | 14 |
| 369 | `src/workers/bash.ts` | Function `guestPresentation` | 32:1 | 23 |
| 370 | `src/workers/bash.ts` | Async method `exec` | 96:19 | 17 |
| 371 | `src/workers/bash.ts` | Async method `execute` | 125:5 | 40 |
| 372 | `src/workers/builder-handoff.ts` | Async method `execute` | 85:5 | 21 |
| 373 | `src/workers/edit.ts` | Async method `execute` | 93:5 | 22 |
| 374 | `src/workers/edit.ts` | Async method `access` | 123:9 | 14 |
| 375 | `src/workers/edit.ts` | Async method `readFile` | 138:9 | 16 |
| 376 | `src/workers/edit.ts` | Async method `writeFile` | 153:9 | 13 |
| 377 | `src/workers/factory-oauth.ts` | Function `verifySelectedModules` | 35:1 | 11 |
| 378 | `src/workers/factory-oauth.ts` | Function `validatePath` | 66:1 | 19 |
| 379 | `src/workers/factory-oauth.ts` | Function `credential` | 89:1 | 14 |
| 380 | `src/workers/factory-oauth.ts` | Async arrow function | 200:43 | 13 |
| 381 | `src/workers/factory-oauth.ts` | Function `privateSetupDirectory` | 259:1 | 13 |
| 382 | `src/workers/factory-oauth.ts` | Async function `firstFactoryOAuthLogin` | 287:8 | 13 |
| 383 | `src/workers/factory-oauth.ts` | Method `notify` | 356:7 | 13 |
| 384 | `src/workers/gates.ts` | Arrow function | 81:58 | 17 |
| 385 | `src/workers/handoff.ts` | Arrow function | 215:99 | 11 |
| 386 | `src/workers/handoff.ts` | Function `parseHandoffSummary` | 245:8 | 15 |
| 387 | `src/workers/index.ts` | Async method `observeStart` | 157:3 | 15 |
| 388 | `src/workers/index.ts` | Async method `observe` | 210:5 | 15 |
| 389 | `src/workers/index.ts` | Async method `deliver` | 231:8 | 29 |
| 390 | `src/workers/index.ts` | Async method `activate` | 266:6 | 62 |
| 391 | `src/workers/index.ts` | Async arrow function | 349:22 | 46 |
| 392 | `src/workers/oauth-qualification.ts` | Function `budgetFor` | 36:8 | 11 |
| 393 | `src/workers/oauth-qualification.ts` | Arrow function | 71:52 | 12 |
| 394 | `src/workers/opinion-observation.ts` | Async function `observeOpinionRecord` | 19:8 | 21 |
| 395 | `src/workers/push-policy.ts` | Function `pushDenied` | 20:8 | 18 |
| 396 | `src/workers/question-observation.ts` | Async function `observeQuestionRecord` | 19:8 | 26 |
| 397 | `src/workers/read.ts` | Async function `page` | 36:7 | 19 |
| 398 | `src/workers/read.ts` | Async method `access` | 52:9 | 12 |
| 399 | `src/workers/review.ts` | Method `observe` | 50:5 | 32 |
| 400 | `src/workers/review.ts` | Function `composeOpinion` | 100:8 | 24 |
| 401 | `src/workers/sdk-profile.ts` | Async function `ownedTree` | 46:1 | 12 |
| 402 | `src/workers/sdk-profile.ts` | Async function `prepareDevelopmentSdk` | 54:8 | 31 |
| 403 | `src/workers/sdk-profile.ts` | Async function `verify` | 104:3 | 16 |
| 404 | `src/workers/session-usage.ts` | Function `sessionUsage` | 19:8 | 35 |
| 405 | `src/workers/session-usage.ts` | Async function `observeSessionCopyUsage` | 63:8 | 24 |
| 406 | `src/workers/session-usage.ts` | Async function `observeSessionUsage` | 93:8 | 22 |
| 407 | `src/workers/skill-pack.ts` | Async function `loadSkillPack` | 64:8 | 11 |
| 408 | `src/workers/worker-process.ts` | Async method `executeTool` | 45:37 | 36 |
| 409 | `src/workers/worker-process.ts` | Async function `run` | 91:8 | 42 |
| 410 | `src/workers/worker-session.ts` | Async function `reopenSession` | 41:1 | 14 |
| 411 | `src/workers/worker-session.ts` | Async function `executeSession` | 61:8 | 127 |
| 412 | `src/workers/worker-start.ts` | Async function `startWorker` | 48:8 | 44 |

## Registros das etapas

(preenchidos ao fim de cada etapa)
