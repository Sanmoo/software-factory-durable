# Ticket 16 — Convert readiness only with current evidence

Branch `implement/software-factory-mvp-16`, rebased on integration `01783ae`. Reuses ticket 14's publication/verification record
(`WorkView.publication`, `publishableContent`, `publicationStep`), ticket 15's checks explanation (`ChecksEvaluation`, `evaluateChecks`,
`checksTarget`, `recordChecks`, Q4B `readPullRequest`) and ticket 26's reconciliation gate; nothing of them is re-derived.

## Composition

- **Rules** (`src/control/rules/readiness.ts`, pure): `evaluateReadiness` → `ReadinessEvaluation` with independent reasons by area
  (ownership, publication, content, checks, conflict, impediment, dependencies, concurrency, installation, closed), each `confirmed` or
  `uncertain`. Ready only with no reason. Content = ticket 13 verification of the basis Execution re-checked with `publishableContent`, PR head
  equal to the verified head (no borrowed green), conformant description, no newer basis. Checks reasons: `indeterminate` → uncertain; wait/
  repair/operational/uncertain/strict/ownership → confirmed. Conflict tri-state (unknown = uncertain). Every Work impediment, dependency
  conclusion, unsettled/queued activity, open correction/recovery/scope update, and `RECONCILIATION_REQUIRED` (uncertain). Human review is a
  human stage, never read as a blocker. `sameBasis` (identity/head/base/requirements; base tip only under strict), `readinessAction`,
  `internalReadiness` (ready only from a recheck), `humanFlag`.
- **Durable desk** (`src/control/durable/readiness.ts`), a step of the owner loop's `afterCycle` after the checks pass (also while paused):
  0. an unsettled conversion is discovered first (full read of the flag), never resent; 1. evaluation from recorded facts; 2. when a
  conversion applies or ready is unconfirmed, a fresh full `readPullRequest` immediately before (recorded as the checks explanation) and
  re-evaluation; a changed basis invalidates (`RECHECK_CHANGED_BASIS`, recalculated next pass); 3. intent commit → `setDraft` outside any
  commit → attempt commit → independent observation → `confirmed` / `not-applied`. A not-applied conversion of the same basis is never
  repeated without `factory authorize-readiness <work> --reason <text>` (also the only way to restore ready over an unexpected human draft).
  Mark-ready only over a Factory draft (publication or its own convert-to-draft); convert-to-draft (reason `READINESS_LOST:<codes>`) only
  over a Factory ready; uncertain evidence withdraws internal readiness and flips nothing; a human ready is visible, never certified or reverted.
- **CodeRepository** Q4B `setDraft(pr, draft, effect)`; **GitHub** `setDraft`: fresh single-use `readiness-write` grant
  (`metadata:read, pull_requests:write`) used only for ONE GraphQL `markPullRequestReadyForReview` / `convertPullRequestToDraft` on the PR
  node (`clientMutationId` = effect id), then self-revoked. GraphQL errors = known failure; 5xx/transport/unexpected payload = unknown.
  Ticket 15's light read now also compares the draft flag (a flip forces a full read).
- `WorkView.readiness` shows internal readiness, flag (factory/observed), human draft/ready, authorization, effects and separate stages.

## AC → tests

| AC | Tests | Level |
| --- | --- | --- |
| 1 combined evaluation, independent reasons | `control/readiness-rules` AC1/AC6, AC1 | R |
| 2 recheck before converting; base advance alone no trigger | `readiness-rules` AC2; `control/readiness-flow` AC2/AC7 race | R + S |
| 3 intent → mutation → observation → confirmation; uncertain → discovery | `readiness-flow` AC3/AC6, AC3, V-12 (intent then owner death → discovery, never resent); `entrypoints/github-readiness` AC3 ×2 | S + I-local |
| 4 confirmed loss → draft with reason; transient → no flip | `readiness-rules` AC4, AC4/AC5, MED 6; `readiness-flow` AC4/AC5. **Operator decision:** the reason is recorded locally (effect `reason`, history, CLI), not posted on the PR | R + S |
| 5 Factory draft restored; human draft needs authorization; ready flag alone certifies nothing | `readiness-rules` AC5; `readiness-flow` AC5; `update-scope-cli` (CLI `authorize-readiness`) | R + S + I-local |
| 6 pending human review does not block; no approval/merge | `readiness-rules` AC1/AC6; `github-readiness` AC6; `architecture/publication-boundary` (only the two draft mutations) | R + I-local + static |
| 7 real conversion, races, correlation | `entrypoints/github-readiness-composed` (real 13/14/15/16 flow over the fixture); recipe tests | I(sub) + **P pending** |

Red → green: rules 0/8 against a throwing stub, then 8/8; the adapter/flow tests were red as type errors (missing `setDraft`).

## One-shot real-run recipe (`test/entrypoints/readiness16-qualification.ts`) — not run

`--plan` is inert. Phases `preflight`, `convert`, `inspect`, each once (wx tombstones, held results recorded, no retry), namespace
`/home/sanmoo/software-factory-test/y5/q16-readiness-v1`, source copies of `q14-publication-v8` migrated explicitly on the copy (ticket 33,
digest-checked, ticket 15's `migrateCopy`). Single expected mutation: PR #5 draft → ready by the App installation token of a fresh
readiness grant, revoked after. Guards: gh wrapper traces everything, forwards GET, and only in `convert` once each the exact mark-ready
document for node `PR_kwDOSuqsXs8AAAABPTSKww` and one `DELETE /installation/token`; CodeRepository wrapper allows only that `setDraft` once;
read-only tracker; no execution ports; the copy is paused. Ticket 26: the copied Work's Executions are settled in its record (preflight
checks it); the owner uses a fresh private runtime root listed by the real `inventoryRuntime` (empty), so dispatch is
`EXECUTION_NOT_ENABLED`, not `RECONCILIATION_REQUIRED`; the y5 root is only inventoried read-only as evidence; the real environment is never
touched.

## Operator decisions (supervisor, 2026-11-15)

Accepted: readiness runs while paused (tracking, not a trigger); no repeat until `authorize-readiness` or a new head/requirements basis;
only a Factory-placed ready is reverted; the draft reason is recorded locally.

## Static review fixes (review of `d47fe1c`)

| Finding | Fix | Tests |
| --- | --- | --- |
| MED 1 push between recheck and mutation | settle compares the mutation's `headRefOid` and the observed head with the evaluated head: `headMismatch` recorded, flag Factory-placed, internal readiness withdrawn; `HEAD_NOT_LINKED_BY_FACTORY` is a content loss (not an identity dispute), so the next evaluation restores draft | `readiness-flow` MED 1 |
| MED 2 lagging read after an applied mutation | the mutation response (desired flag + our clientMutationId, checked by the adapter) is primary evidence: a contrary read only counts `contradictions` and keeps the effect pending; no human label while unsettled | `readiness-flow` MED 2 |
| MED 3 authorization not bound | `authorization.binding` = that human draft (PR, head, observedAt) or that not-applied effect id; consumed once by the intent | `readiness-rules` MED 3; `readiness-flow` AC5/AC3 |
| MED 4 recipe followed a held preflight | `phaseGuard`: convert/inspect need `preflight-result.status === 'success'`, inspect needs `convert-result`; each phase once | `readiness16-recipe-safety` MED 4 |
| MED 5 stale dependencies | a fresh native dependency read (ticket 08's `evaluateWorkDependencies`, recorded for the published Work) before every recheck; the rechecked evaluation requires that attempt, otherwise `DEPENDENCIES_NOT_CURRENT` (uncertain) | `readiness-rules` MED 5; `readiness-flow` MED 5, AC3/AC6 (read order) |
| MED 6 strict + base advanced | checks `strict` reasons are uncertain: internal readiness withdrawn, never an automatic draft | `readiness-rules` MED 6 |
| LOW intent commit | the intent commit re-evaluates queue/impediments/Execution/correction/recovery/scope/publication as they are in that commit | `readiness-flow` (stale intents) |
| LOW never sent | `sendingAt` committed right before the mutation; an `intended` effect without it is settled `not-applied` + `neverSent`, allowing ONE automatic re-evaluation per basis; sent-but-unknown keeps the authorization requirement | `readiness-rules` LOW; `readiness-flow` LOW, V-12 |
| LOW ownership | any ownership reason blocks every mutation (`OWNERSHIP_DISPUTED`) | `readiness-rules` LOW |
| LOW recipe root / revocation | GitHub access root = the recipe namespace (own `credentials/` copy of the key, removed by inspect, and `run/`); the guard records the hash of the token that sent the mutation and allows only that token's `DELETE /installation/token` (never logged) | `readiness16-recipe-safety` |

Red → green: the rules review tests failed first (missing parameters/bindings); the flow review tests were written alongside the fix.

## Limitations

- A conflict/flag change on an unchanged head is seen within ticket 15's cadence (full re-read every 10 intervals; a draft flip triggers it).
- The draft-conversion reason is recorded locally (CLI), not posted on the PR.
- GraphQL has no REST API version: the version header is sent; a missing selected-version header is accepted only for GraphQL.

## Gate totals (rebased on `01783ae`)

`npm run test:ci`: **RESULT: PASS** — 203 files, 1251 tests, 1241 pass, 0 fail, 10 skipped; 202.5 s of 600 s (load 2.4 → 12.5). Ticket 16 files:
`github-readiness-composed` 11.8 s and `github-readiness` 7.8 s (then tiered `slow`), `readiness16-recipe-safety`, `readiness-flow`, `readiness-rules`,
`readiness16-qualification`. Real GitHub (P): not run.

Review-fix gate (same base `01783ae`): `npm run test:ci` **PASS** — 1260 tests, 1250 pass, 0 fail, 10 skipped; 189.1 s (load 7.6 → 12.7). An earlier
ci run of the fixes failed only `github-readiness-composed`: its wall-clock iteration bound expired under load after the added dependency read;
the bound was raised (the loop exits on the condition).
