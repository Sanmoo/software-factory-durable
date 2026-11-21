# Gate Proofs

The record of each quality gate's proof and outcome. The violations are executable in [scripts/test-runner/gate-proofs.ts](scripts/test-runner/gate-proofs.ts), out of both Entry Points; each runs the Entry Point of its tier on a disposable copy with only that violation, and [scripts/test-runner/proof-attribution.ts](scripts/test-runner/proof-attribution.ts) counts it only when the gate under proof is the one red, at the violation's location. A recorded outcome belongs to the tree it ran against.

| Quality gate | State | Tier · Entry Point | Tool · version | Violation | Outcome · failing gate | Scope declared → analyzed | Tree |
|---|---|---|---|---|---|---|---|
| Types | adopted | fast · `npm run test:fast` | tsc 6.0.3 | pass a string where `timeoutReached` takes a number (`src/control/rules/budget.ts`) | red: Types, TS2345 at `src/control/rules/budget.ts` | whole program | `7915f50` |
| Context boundaries | adopted | fast · `npm run test:fast` | dependency-cruiser 18.7.2 | import the non-public `src/contracts/environment.ts` from `src/records/index.ts` | red: Context boundaries, `public-entry:contracts` | whole graph | `7915f50` |
| Dependency rule | adopted | fast · `npm run test:fast` | dependency-cruiser 18.7.2 | import `node:fs` in `src/control/rules/budget.ts` | red: Dependency rule, `pure-rules-imports` | whole graph | `7915f50` |
| Guide pointers | adopted | fast · `npm run test:fast` | `scripts/agent-checks/check.mjs` on Node 24.21.0 | link `docs/guides/architecture.md` to a missing file | red: Guide pointers, `BROKEN_LINK` | every Guide | `7915f50` |
| Format | adopted | fast · `npm run test:fast` | prettier 3.9.10 | misindent one line of `src/control/rules/budget.ts` | red: Format, `not-formatted` at `src/control/rules/budget.ts` | `src/control/rules/budget.ts` → `src/control/rules/budget.ts` | `7915f50` |
| Lint | adopted | fast · `npm run test:fast` | ESLint 10.14.0 + typescript-eslint 8.72.1 | add an unused variable to `src/control/rules/budget.ts` | red: Lint, `@typescript-eslint/no-unused-vars` | `src/control/rules/budget.ts` → `src/control/rules/budget.ts` | `7915f50` |
| Secrets | adopted | fast · `npm run test:fast` | gitleaks 8.30.1 | add `docs/proof-credentials.txt` with a well-formed fake AWS key id and secret | red: Secrets, `aws-access-token` and `generic-api-key` (working tree), the one violating file | history of HEAD + uncommitted files | `7915f50` |
| Avoided terms | adopted | fast · `npm run test:fast` | `scripts/test-runner/avoided-terms.ts` (TypeScript 6.0.3 parser) | name a Slot identifier `seatLimit` in `src/control/rules/budget.ts` | red: Avoided terms, `avoided:seat` | `src/`, `test/`, `scripts/` | `7915f50` |
| Unit tests | pending | — | — | — | levels not declared yet (S3) | — | — |
| Integration tests | pending | — | — | — | levels not declared yet (S3) | — | — |
| Dependency vulnerabilities | pending | — | — | — | not wired yet (S3) | — | — |
| E2E tests | pending | — | — | — | no Gherkin yet (S4) | — | — |
| Mutation | pending | — | — | — | not wired yet (S5) | — | — |
| Static metrics | pending | — | — | — | complexity and duplication resolved in S6, pending in this run | — | — |

Format and Lint analyze only the changed files in the fast Entry Point; their proofs declare the violating file, and the attribution counts them only when the report's analyzed list is exactly that file.
