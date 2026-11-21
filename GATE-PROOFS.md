# Gate Proofs

The record of each quality gate's proof and outcome. The violations are executable in [scripts/test-runner/gate-proofs.ts](scripts/test-runner/gate-proofs.ts), out of both Entry Points; each runs the Entry Point of its tier on a disposable copy with only that violation, and [scripts/test-runner/proof-attribution.ts](scripts/test-runner/proof-attribution.ts) counts it only when the gate under proof is the one red, at the violation's location. A recorded outcome belongs to the tree it ran against.

| Quality gate | State | Tier · Entry Point | Tool · version | Violation | Outcome · failing gate | Tree |
|---|---|---|---|---|---|---|
| Types | adopted | fast · `npm run test:fast` | tsc 6.0.3 | pass a string where `timeoutReached` takes a number (`src/control/rules/budget.ts`) | red: Types, TS2345 at `src/control/rules/budget.ts` | S1_TREE |
| Context boundaries | adopted | fast · `npm run test:fast` | dependency-cruiser 18.7.2 | import the non-public `src/contracts/environment.ts` from `src/records/index.ts` | red: Context boundaries, `public-entry:contracts` | S1_TREE |
| Dependency rule | adopted | fast · `npm run test:fast` | dependency-cruiser 18.7.2 | import `node:fs` in `src/control/rules/budget.ts` | red: Dependency rule, `pure-rules-imports` | S1_TREE |
| Guide pointers | adopted | fast · `npm run test:fast` | `scripts/agent-checks/check.mjs` on Node 24.21.0 | link `docs/guides/architecture.md` to a missing file | red: Guide pointers, `BROKEN_LINK` | S1_TREE |
| Format | pending | — | — | — | not wired yet (S2) | — |
| Lint | pending | — | — | — | not wired yet (S2) | — |
| Secrets | pending | — | — | — | not wired yet (S2) | — |
| Avoided terms | pending | — | — | — | not wired yet (S2) | — |
| Unit tests | pending | — | — | — | levels not declared yet (S3) | — |
| Integration tests | pending | — | — | — | levels not declared yet (S3) | — |
| Dependency vulnerabilities | pending | — | — | — | not wired yet (S3) | — |
| E2E tests | pending | — | — | — | no Gherkin yet (S4) | — |
| Mutation | pending | — | — | — | not wired yet (S5) | — |
| Static metrics | pending | — | — | — | complexity and duplication resolved in S6, pending in this run | — |

The whole-input quality gates above analyze their whole input in every run, so no proof declares a scope.
