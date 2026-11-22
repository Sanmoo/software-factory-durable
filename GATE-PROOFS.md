# Gate Proofs

Registro da prova de cada quality gate e do seu resultado. As violações são executáveis em [scripts/test-runner/gate-proofs.ts](scripts/test-runner/gate-proofs.ts), fora dos dois Entry Points. Cada prova roda o Entry Point do seu tier numa cópia descartável com apenas aquela violação, e [scripts/test-runner/proof-attribution.ts](scripts/test-runner/proof-attribution.ts) só a conta quando o quality gate sob prova é o único vermelho, no local da violação (regras testadas em [test/runner/proof-attribution.test.ts](test/runner/proof-attribution.test.ts)). Um resultado registrado pertence à árvore contra a qual rodou.

| Quality gate | Estado | Tier · Entry Point | Ferramenta · versão | Violação | Resultado · gate que falhou | Escopo declarado → analisado | Árvore |
|---|---|---|---|---|---|---|---|
| Types | adotado | fast · `npm run test:fast` | tsc 6.0.3 | passar uma string onde `timeoutReached` recebe um número (`src/control/rules/budget.ts`) | vermelho: Types, TS2345 em `src/control/rules/budget.ts:112` | programa inteiro | `bb99c827` |
| Context boundaries | adotado | fast · `npm run test:fast` | dependency-cruiser 18.7.2 | importar o módulo não público `src/contracts/environment.ts` a partir de `src/records/index.ts` | vermelho: Context boundaries, `public-entry:contracts` | grafo inteiro | `bb99c827` |
| Dependency rule | adotado | fast · `npm run test:fast` | dependency-cruiser 18.7.2 | importar o pacote `yaml` (entrada em `dist/`) em `src/control/rules/budget.ts` | vermelho: Dependency rule, `pure-rules-imports` → `node_modules/yaml/dist/index.js` | grafo inteiro | `bb99c827` |
| Guide pointers | adotado | fast · `npm run test:fast` | `scripts/agent-checks/check.mjs` no Node 24.21.0 | apontar um link de `docs/guides/architecture.md` para um arquivo inexistente | vermelho: Guide pointers, `BROKEN_LINK` | todos os Guides | `bb99c827` |
| Lint | pendente | — | — | — | S2 | — | — |
| Avoided terms | pendente | — | — | — | S2 | — | — |
| Dependency vulnerabilities | pendente | — | — | — | S2 | — | — |
| Unit tests | pendente | — | — | — | S3 | — | — |
| Integration tests | pendente | — | — | — | S3 | — | — |
| Format | pendente | — | — | — | S4 | — | — |
| Secrets | pendente | — | — | — | S5 | — | — |
| Static metrics | pendente | — | — | — | S6 | — | — |
| E2E tests | bloqueado | — | — | — | precisa de assets de guest bootáveis, credenciais de modelo e autorização por execução | — | — |
| Mutation | pendente | — | — | — | decisão de runner, cadência ou escopo em aberto | — | — |
