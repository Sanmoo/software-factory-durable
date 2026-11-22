# Gate Proofs

Registro da prova de cada quality gate e do seu resultado. As violações são executáveis em [scripts/test-runner/gate-proofs.ts](scripts/test-runner/gate-proofs.ts), fora dos dois Entry Points. Cada prova roda o Entry Point do seu tier numa cópia descartável com apenas aquela violação, e [scripts/test-runner/proof-attribution.ts](scripts/test-runner/proof-attribution.ts) só a conta quando o quality gate sob prova é o único vermelho, no local da violação (regras testadas em [test/runner/proof-attribution.test.ts](test/runner/proof-attribution.test.ts)). Um resultado registrado pertence à árvore contra a qual rodou. Para um quality gate de conjunto alterado (Lint no fast), a prova declara o arquivo da violação e só conta quando o relatório mostra que o gate analisou exatamente esse arquivo.

| Quality gate | Estado | Tier · Entry Point | Ferramenta · versão | Violação | Resultado · gate que falhou | Escopo declarado → analisado | Árvore |
|---|---|---|---|---|---|---|---|
| Types | adotado | fast · `npm run test:fast` | tsc 6.0.3 | passar uma string onde `timeoutReached` recebe um número (`src/control/rules/budget.ts`) | vermelho: Types, TS2345 em `src/control/rules/budget.ts:112` | programa inteiro | `24cb41a0` |
| Context boundaries | adotado | fast · `npm run test:fast` | dependency-cruiser 18.7.2 | importar o módulo não público `src/contracts/environment.ts` a partir de `src/records/index.ts` | vermelho: Context boundaries, `public-entry:contracts` | grafo inteiro | `24cb41a0` |
| Dependency rule | adotado | fast · `npm run test:fast` | dependency-cruiser 18.7.2 | importar o pacote `yaml` (entrada em `dist/`) em `src/control/rules/budget.ts` | vermelho: Dependency rule, `pure-rules-imports` → `node_modules/yaml/dist/index.js` | grafo inteiro | `24cb41a0` |
| Guide pointers | adotado | fast · `npm run test:fast` | `scripts/agent-checks/check.mjs` no Node 24.21.0 | apontar um link de `docs/guides/architecture.md` para um arquivo inexistente | vermelho: Guide pointers, `BROKEN_LINK` | todos os Guides | `24cb41a0` |
| Lint | adotado | fast · `npm run test:fast` | ESLint 10.14.0 + typescript-eslint 8.72.1 | adicionar uma variável não usada em `src/control/rules/budget.ts` | vermelho: Lint, `@typescript-eslint/no-unused-vars` em `src/control/rules/budget.ts:113` | `src/control/rules/budget.ts` → `src/control/rules/budget.ts` | `24cb41a0` |
| Avoided terms | adotado | fast · `npm run test:fast` | `scripts/test-runner/avoided-terms.ts` (parser do TypeScript 6.0.3) | nomear um identificador de Slot `seatLimit` em `src/control/rules/budget.ts` | vermelho: Avoided terms, `avoided:seat` | `src/`, `test/`, `scripts/` | `24cb41a0` |
| Dependency vulnerabilities | adotado | full · `npm run test:ci` | npm 11.19.0 `audit --audit-level=high` | travar `minimist@0.0.8` | vermelho: Dependency vulnerabilities, critical em `minimist` (GHSA-xvch-5gv4-984h, GHSA-vh95-rmgr-6w4m) | o lockfile | `24cb41a0` |
| Unit tests | pendente | — | — | — | S3 | — | — |
| Integration tests | pendente | — | — | — | S3 | — | — |
| Format | pendente | — | — | — | S4 | — | — |
| Secrets | pendente | — | — | — | S5 | — | — |
| Static metrics | pendente | — | — | — | S6 | — | — |
| E2E tests | bloqueado | — | — | — | precisa de assets de guest bootáveis, credenciais de modelo e autorização por execução | — | — |
| Mutation | pendente | — | — | — | decisão de runner, cadência ou escopo em aberto | — | — |
