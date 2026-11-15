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
| 7 real conversion, races, correlation | real conversion: run `q16-readiness-v1` below (**P**); races/correlation: `readiness-flow` AC2/AC7 race, MED 1, MED 2, V-12, LOW; `github-readiness-composed` (real 13/14/15/16 flow over the fixture) | P + S + I(sub) |

Red → green: rules 0/8 against a throwing stub, then 8/8; the adapter/flow tests were red as type errors (missing `setDraft`).

## One-shot real-run recipe (`test/entrypoints/readiness16-qualification.ts`)

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

Red → green: the rules review tests failed first (missing parameters/bindings). **TDD red was NOT observed** for the four flow review tests
(`readiness-flow` MED 1, MED 2, MED 5, LOW never-sent): they were written after the fix and passed at their first run.

## Real run `q16-readiness-v1` (2026-11-15, operator-authorized, run by the supervisor; consumed) — CONVERTED

Composition: this branch at `c28ad28` on `01783ae`, real App (id 5569788, installation 177599217), real gh behind the recipe guard, GitHub
access root = the namespace (key copy removed afterwards: `credentials/` empty), copies of `y5/q14-publication-v8`. Raw results copied
(secret scan over all files: no `ghs_/ghp_/gho_/ghu_/github_pat_`, JWT or private-key material; the guard stores only the token's sha256, not copied):
`16-real-readiness-{preflight,convert,inspect}-2026-11-15.json`, `16-real-readiness-copy-migrations-2026-11-15.json` (with the three intent
tombstones) and `16-real-readiness-gh-trace-2026-11-15.jsonl`.

| Expected (`plan().expected` + guards) | Observed | Verdict |
| --- | --- | --- |
| Copies only, migrated explicitly, preserved digest identical; original never opened | preflight and convert copies `factory-storage-1-to-2`, 1 → 2, preserved `74b96fb5…` before = after (state digest changed only by the migration record) | **met** |
| Preflight: own PR #5 linked; copied Work settled, no readiness; PR open, draft, at bfdd439 | Work `99fe871b…`, publication `published`; Execution ended completed, cessation confirmed, Slot released; PR #5 open, draft, head `bfdd439…`, node `PR_kwDOSuqsXs8AAAABPTSKww`; y5 inventory (read-only) lists the Work's own environment among 25 — not used, not touched | **met** |
| Convert: decision ready from the recheck, reasons [] | `latest.decision ready`, `source recheck`, reasons `[]`; basis PR #5 / head `bfdd439` / base `main` tip `8c058c9` / requirements `empty-complete` (ruleset 26435808: `pull_request` human-stage, `non_fast_forward`/`deletion`/`update` not check-related) / verified content `fe9faf…` | **met** |
| Fresh dependencies before the recheck | trace: `GET /issues/3`, `/issues/3/dependencies/blocked_by` right before the recheck collection | **met** |
| One effect: intent before attempt, applied, revoked, observation draft=false, confirmed | `mark-ready a6cb87ab…`: intended 14:58:04.568 → sending 14:58:04.571 → POST 14:58:06.048 → DELETE 14:58:07.100 → attempt `applied`, headRefOid `bfdd439`, revocation `revoked` → independent observation 14:58:13.971 draft=false, head `bfdd439` → `confirmed`; `contradictions 0`, no head mismatch | **met** |
| internal ready, flag.factory ready (readiness-effect), stages distinct | `internal ready`, flag `{factory ready, origin readiness-effect, observed ready}`, stages `{internal ready, flag ready, humanReview human-stage, delivery not-delivered}`; no human draft/ready recorded | **met** |
| Checks satisfied empty-complete; approval neither blocks nor is touched | checks `satisfied`, `empty-complete`, conflict `none`; the operator's APPROVED review on #5 unchanged (supervisor) | **met** |
| gh trace: GET only except ONE mark-ready POST and ONE revocation after it; nothing refused | 55 requests: 53 GET, 1 `POST graphql` (variables `{id: PR_kwDOSuqsXs8AAAABPTSKww, cid: a6cb87ab…}`), 1 `DELETE /installation/token` (tied to that token), 0 refused; `exactlyOneMutation: true`; owner outcome `clean`, dispatch `EXECUTION_NOT_ENABLED` | **met** |
| Inspect: PR open, not merged, draft false, head bfdd439; Work open, no impediment/queue change | `draftAfter false`, open, not merged, head `bfdd439`; Work `open`, queue unchanged (`pending false`), impediments only the presented `GLOBAL_PAUSE` of the recipe's pause on the copy; readiness `ready` | **met** |

Remaining GitHub state: PR #5 ready for review, open, approved by the operator; merge stays human.

### Coverage gap (honest)

The real run proves the happy path of the boundary (one correlated mutation, grant scope, revocation, observation, confirmation, fresh
dependencies, human-stage review). Convert-to-draft, human draft/authorization, lag, head mismatch, never-sent and unknown outcomes were not
exercised against real GitHub; they are S / I(sub) only. Real required checks remain absent from the test repository (ticket 15's gap).

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
