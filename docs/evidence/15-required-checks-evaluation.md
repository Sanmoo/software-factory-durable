# Ticket 15 — Explain the required checks of the current own PR

Branch `implement/software-factory-mvp-15`, rebased onto integration `b2da9ae` (tickets 01–14, 19, 20, 26, 32, 33, 36). Control reads ticket
14's typed `WorkView.publication` (`state: 'published'`, `pullRequest`, `base`, `linkedHeads`, `verified.requiredChecks`). The composed test
(`test/entrypoints/github-checks-composed.test.ts`) now reaches the linked PR through ticket 14's **real** publication flow (ticket 13 rounds,
Builder double publishing with its own grant through the fixture, discovery and link) before explaining its checks. Only the storage-real
tracker tests (`test/control/checks-flow.test.ts`) still seed Works in exact publication states, now typed as `PublicationView`
(`test/control/checks-seed.ts`). Rebase conflicts resolved: `WorkView` (publication + checks), history union, dispatch tick (14's discovery
kept, ticket 15 not in the tick), fixture routing (14's `rules/branches` route defers to the checks world, which falls back to 14's
`branchRules`; `GET /pulls/{n}` serves the PR the Builder created when no override exists); ticket 14's recipe wrapper forwards
`readPullRequest`.

## Composition

- GitHub (`src/platform/github`): new reduced read purpose **`checks-read`** = Metadata, Contents, Pull requests, Checks, Statuses,
  Administration — all **read**, GET only, cached per repository/purpose like the other read grants. `GitHubSession.list(..., { items })`
  follows object-wrapped pages (`{ total_count, check_runs }`): a `total_count` that changes between pages or differs from the collected
  count is `INCOMPLETE_GITHUB_QUERY`, never a truncated listing.
- CodeRepository (`src/code-repository/pull-request.ts`, approved Q4B op **`readPullRequest(pr)`**: "PR próprio conhecido → fatos atuais
  correlacionados … Não decide prontidão"). Separate GET reads, each with its own completeness (`Known<T>` = complete | unknown+code):
  PR (identity, head/base, draft, merged, `merge_commit_sha`, tri-state `mergeable`), base branch (tip + classic protection summary),
  classic `protection/required_status_checks` (strict, contexts, `checks[].app_id`) only when the summary says checks are enforced,
  `rules/branches/{base}` (active rules incl. organization/enterprise rulesets; `required_status_checks` parameters parsed), check-runs of
  the head (`filter=all`, every attempt, ≤10 pages), statuses of the head (≤10 pages), `compare/{baseTip}...{head}`, then the base tip,
  classic detail and rules **again** (`final`, spec §9.2 step 6) and a **final PR re-read**. Classic absence is reported only from an
  authorized complete branch read (`protected: false` or enforcement `off`); a 403/404/hidden detail is `unknown`. An item (check run,
  status, rule) that fails its schema is unknown **alone** (`status/state: 'unparsed'`, `unparsed: true`, name kept when readable). A
  check-run listing that reaches 1000 items (GitHub's 1000-suite cap) is `unknown CHECK_RUNS_LIMIT_REACHED`. `unless: {headSha, baseRef}`
  makes a **light read**: when the open PR still has that head/base, only the PR is read and `unchanged` is returned.
- Control rules (`src/control/rules/checks.ts`, pure): `evaluateChecks` →
  `ChecksEvaluation` (`src/control/types.ts`). Requirements accumulate from classic + every rule by **context + integration**, with the
  sources and strict/loose per source. Current result = latest attempt per (name, App, check suite) on the **current head**, latest status
  per context; homonymous check-run and status both count (all must satisfy). Several current suites of the same App/name: the suite with
  the latest `started_at` is the current attempt (a failed rerun in a newer suite after an older green → `failing`); suites with missing or
  equal instants that disagree → `ATTEMPTS_INDISTINGUISHABLE`. Statuses: a requirement accepting any source uses the latest status of the
  context; an integration-bound one uses the latest status whose creator is tied to it (`<app slug>[bot]`, slug from that App's own check
  runs), with `NEWER_STATUS_FROM_OTHER_ORIGIN` when a newer status of another origin hides it; a User or another known App's bot is other
  origin; `STATUS_ORIGIN_UNVERIFIABLE` only for a Bot creator when the integration's slug is unknown (operator decision 1). Unparsed items:
  `RESULT_UNPARSED:<context>` for that requirement only, `RESULT_UNPARSED_UNNAMED` when nameless; unparsed rule → `RULE_NOT_INTERPRETABLE`.
  Requirements changed between start and end → `REQUIREMENTS_CHANGED_DURING_COLLECTION`; base tip advanced → indeterminate only under
  strict, otherwise a note (base advancing is never a trigger). Semantics: check-run `success/skipped/neutral` satisfy,
  `failure` = repair, `action_required/stale` = operational, other/`cancelled/timed_out` = uncertain, not completed = waiting; status
  `success` satisfies, `pending` waits, `failure` repair, anything else uncertain. Independent reasons with categories
  `wait/repair/operational/uncertain/indeterminate/ownership/strict/closed`; outcome precedence not-applicable > indeterminate > failing >
  blocked > waiting > satisfied. Unsupported modalities (`workflows`, `merge_queue`, `required_deployments`, `code_scanning`, unknown
  rule types) are `RULE_NOT_INTERPRETABLE`; `pull_request`/`copilot_code_review` are `human-stage` (visible, not blocking).
  Ownership against ticket 14's link (id/node/number, App author, branch, repository, Work base, head among linked heads). Strict is
  confirmed against the current base tip; loose lag is only a note. Optional/other-SHA/other-origin results are visible only.
- Control durable (`src/control/durable/checks.ts`): `checksTarget(work)`, `recordChecks` (one commit; only for the PR still linked to the
  current open Work; a different explanation pushes the previous to `checks.history` (≤10) and appends one `checks-evaluated` event), and
  `createChecksTracker`. The pass is a separate step of the **existing owner loop's `afterCycle`**, run AFTER the question desk and the
  dispatch tick (off the dispatch critical path), whatever the dispatch barrier or pause. Per Work: minimum interval = polling interval;
  exponential backoff (×2, up to ×16) on unavailable reads, and never earlier than any GitHub-indicated wait (`waitSeconds`) of any read;
  a stable explanation (satisfied/failing/blocked/not-applicable) of an unchanged head gets only light reads, a full collection every 10
  intervals; ≤2 PR reads per pass and a sliding window of ≤20 full collections per 10 minutes for the installation. An explanation identical
  to the recorded one (apart from its instants) is **not committed**. Skipped while the Work has an activity (`reserved`/`started`, or
  running in this process). No broker/scheduler/DI; never a Slot, queue entry, impediment, repair or readiness decision (decision 4).

## AC → tests (evidence level)

S = pure/storage-real with doubles; I(sub) = real adapter/transport with the gh/GitHub boundary substituted by `github-world-fixture`;
P = real GitHub (pending: recipe below). Red runs were observed for the rules (0/8 with a throwing stub), the durable flow (0/3 with a
stub tracker) and the composed path (condition not reached before wiring the tick); the adapter test's red was the missing operation.

| AC | Tests | Level |
| --- | --- | --- |
| 1 Complete reads (identity/head/base/test merge, tri-state, classic, rulesets, check-runs/statuses with pagination/attempt/origin/SHA) | `entrypoints/github-checks-reads` AC1 ×2 (complete collection with pageSize 1, GET-only trace, exact `checks-read` grant; rate limit mid-collection); `control/checks-rules` reorder/duplication, mergeability | I(sub) + S |
| 2 Accumulation classic+rulesets, context/integration, strict/loose; 404/denied/rollup never absence | `checks-rules` AC2 (accumulation, strict sources; unknown classic/rules → `REQUIREMENTS_UNKNOWN`), strict vs base tip; `github-checks-reads` AC1/AC2 (truncated listing, hidden rules/protection, denied branch → unknown; absence only from authorized complete branch read) | S + I(sub) |
| 3 Pertinent SHA, current origin/attempt; homonymous both; rerun not covered by older green | `checks-rules` AC3 ×2 (queued/failed rerun, other SHA, other App, indistinguishable suites, check+status both, unverifiable status origin) | S |
| 4 Distinct semantics; absent/pending = wait without Slot | `checks-rules` AC4; `control/checks-flow` AC4/AC7 (durable waiting: queue/impediments/held Slots unchanged) | S (storage-real) |
| 5 Failure / operational / uncertain own reasons; optional/old visible without repair | `checks-rules` AC5; `checks-flow` (failure classified, nothing launched; earlier explanation kept as history); composed (optional failure visible) | S + I(sub) |
| 6 Unsupported modality = indeterminate; empty set only from complete authorized reads | `checks-rules` AC2/AC6 | S |
| Review MED 2 / LOW cadence: interval, backoff + waitSeconds, light reads, window bound, no rewrite | `checks-flow` review MED 2 and AC4/AC7 (identical explanation not committed); `github-checks-reads` light read (one GET) | S + I(sub) |
| Review LOW classification: newer-suite failed rerun, status origin, unparsed items, 1000 cap, start/end requirements | `checks-rules` AC3 (suites, tied/other-origin/unverifiable status), review LOW unparsed, spec §9.2 step 6; `github-checks-reads` per-item parse, 1000 cap, final re-read | S + I(sub) |
| Review MED 1: recipe read-only | `checks15-recipe-safety` (gh guard forwards GET only, refuses POST/DELETE/GET+input/no method with exit 97, traces all; read-only tracker never forwards a comment); `checks15-qualification` | S (temp fixtures) |
| 7 Controlled data + real integration; instant/completeness/limitations, no atomic snapshot | `checks-rules` AC7 (observedAt/completedAt, completeness map, head/base/state change during collection, closed/merged, other PR); `github-checks-reads` AC7 (re-read exposes a push); `checks-flow` AC7 (stale link, bounded/rotating reads, stop); `entrypoints/github-checks-composed` (public Control + real adapters + tick); `checks15-qualification` (recipe inert/guards) | S + I(sub) + **P** (empty-complete path, see the real run) |

## One-shot real-run recipe (`test/entrypoints/checks15-qualification.ts`)

Read-only against the own **draft PR #5** (head `factory/3-99fe871b` @ `bfdd439`, base `main`) that ticket 14's real v8 run
(`/home/sanmoo/software-factory-test/y5/q14-publication-v8`, issue #3 of `Sanmoo/java-springboot-event-sourcing`) published and linked;
observations in the fresh namespace `q15-checks-v2`. **Requires**: q14-v8's `discover-result.json` present. Preflight holds unless the
copied storage links exactly PR #5 on `factory/3-99fe871b`; a head moved since `bfdd439` is recorded (`headStillLinked`) and explained as
`HEAD_NOT_LINKED_BY_FACTORY`, never adopted.

**Storage format.** q14-v8 is format-1 storage (pre ticket 33) and the integrated code refuses implicit migration
(`STORAGE_MIGRATION_REQUIRED`). Each phase copies it (`snapshotStorage`, exclusive) and then `migrateCopy` migrates ONLY that copy (path
must be inside `q15-checks-v2/`) with ticket 33's `migrateStorage`, passing the preserved digest inspected before as `expectedDigest`, and
requires the same preserved digest afterwards; before/after `format`, `preservedDigest` and `stateDigest` are saved as
`preflight-copy-migration.json` / `evaluate-copy-migration.json`. The q14 original is never opened. Tested on a format-1 fixture
(`checks15-recipe-safety`): implicit open refused, original bytes unchanged, copy migrated with identical preserved digest, idempotent. Explicit operator grant
needed (real App key, real GitHub reads). `--plan` prints the exact effects and bounds.

```
node dist/test/entrypoints/checks15-qualification.js --plan
node dist/test/entrypoints/checks15-qualification.js preflight   # exclusive q15-checks-v2/, copy of q14 storage, linked PR, raw readPullRequest
node dist/test/entrypoints/checks15-qualification.js evaluate    # another copy as authority, one owner run (polling 180 s), stop when checks recorded (≤5 min)
node dist/test/entrypoints/checks15-qualification.js inspect     # copy of evaluate storage: checks view + second raw readPullRequest
```

(Each with the Node command prefix of the development gate.) Bounds: GitHub = App token issuance POSTs + GETs only; per evaluation ≈
1 PR + 1 branch + ≤1 classic detail + ≤10 rules pages + ≤10 check-run pages + ≤10 status pages + ≤1 compare + 1 PR re-read; ≤2 Works per
pass, ≤2 passes in 5 min; plus the normal polling reads of the label. No model, no VM/Docker. **Dispatch disabled**: no execution ports are
composed (`EXECUTION_NOT_ENABLED`) and the evaluate copy is paused first (local pause on the copy), so no Work is admitted or started.
**Read-only**: the IssueTracker is wrapped so `postComment` is refused locally (a pending Question copied from q14 can never be
published), and gh runs behind a wrapper (`q15-checks-v2/gh-guard.mjs`) that records every request in `gh-trace.jsonl` and refuses with
exit 97 — the real gh never runs — anything but an explicit `GET` without input; installation-token issuance is the only POST (native
HTTPS of the App adapter, not gh). `evaluate-result.getOnly` is computed from the trace. Exclusive intent tombstones, no retry; the q14
storage is only copied.

Expected observations: `checks.latest.pullRequest` = the linked PR (head = 14's linked head unless pushed since); completeness per read;
requirements = classic required checks + active (also organization) ruleset `required_status_checks` of `main` by context+integration with
strict per source. If `main` has no required check, `requiredSet: empty-complete` only when branch, classic detail and rules reads were all
complete — any 403/404 must show `unknown`, never empty. Outcome as GitHub really reports (e.g. `waiting` while Actions runs, `satisfied`
after). Required workflows/merge queue rules → `indeterminate RULE_NOT_INTERPRETABLE`. `conflict` from `mergeable`, `strict.state` from the
comparison. No comment attempt in `events`, no queue/impediment change, `getOnly: true`. To exercise more requirement
kinds, the operator may (optionally, outside the recipe) add a ruleset with a required check before `evaluate`; the recipe never changes
repository settings.

## Real run `q15-checks-v2` (2026-11-15, operator-authorized, run by the supervisor; consumed)

Composition: this branch on `b2da9ae` (`6ba2e12`…`4c2a62e`), real App (id 5569788, installation 177599217), real gh behind the GET-only
guard, copies of `y5/q14-publication-v8`. Raw observations copied (secret scan: no `ghs_/ghp_/gho_/ghu_/github_pat_`, JWT or key
material): `15-real-checks-preflight-2026-11-15.json`, `15-real-checks-evaluate-2026-11-15.json`, `15-real-checks-inspect-2026-11-15.json`,
`15-real-checks-copy-migrations-2026-11-15.json` (with the three intent tombstones) and `15-real-checks-gh-trace-2026-11-15.jsonl`.

| Expected (recipe `plan().expected` + guards) | Observed | Verdict |
| --- | --- | --- |
| Copies only; each copy migrated explicitly, preserved digest checked before and identical after; original never opened | preflight and evaluate copies `factory-storage-1-to-2`, format 1 → 2, preserved digest `74b96fb5…` before = after, state digest changed only by the migration record (`5e4982e5…` → `cd40bb9d…`); the recipe never opens `q14-publication-v8` (only `copyFile`) | **met** |
| Preflight: the copied storage links exactly the own PR #5 on `factory/3-99fe871b`; raw facts | publication `published`, branch `factory/3-99fe871b`, base `main`, linkedHeads `[bfdd439…]`; PR #5 open, draft, not merged, head `bfdd439…` (`headStillLinked: true`), author `sanmoo-factory[bot]` (Bot 351187749) | **met** |
| `checks.latest.pullRequest` = the linked PR; observedAt ≤ completedAt; completeness per read | #5 @ `bfdd439…`, base tip `8c058c9…`; observed 13:30:51.087Z → completed 13:31:04.319Z; pullRequest/baseTip/classic/rules/checkRuns/statuses/comparison/recheck all `complete` | **met** |
| Requirements = classic + active (also inherited) ruleset required checks, by context+integration, strict per source | classic `none` from the authorized complete branch read (`STATUS_CHECKS_NOT_ENFORCED`: `protected: true` with a summary reporting classic status checks not enforced; the protection detail endpoint was therefore not read); rules of ruleset 26435808 (Repository): `pull_request` (human-stage), `non_fast_forward`, `deletion`, `update` (not-check-related); no `required_status_checks` rule → `requirements: []` | **met** |
| No required check configured: `empty-complete` only when branch, classic and rules reads were all complete; 403/404 → unknown | `requiredSet: empty-complete`, note `REQUIRED_SET_EMPTY_FROM_COMPLETE_AUTHORIZED_READS`, every read complete, start and final requirement reads identical. The 403/404 branch was not exercised for real (no denial occurred) | **met** (denial path fixture-only) |
| Outcome as GitHub really reports; unsupported modalities → indeterminate | `satisfied`, `reasons: []`; no workflows/merge-queue/deployments rule exists, so `RULE_NOT_INTERPRETABLE` did not apply | **met** (unsupported path fixture-only) |
| Conflict from `mergeable`; strict from the base-tip comparison; optional/other-SHA visible only | `mergeable: true` with `mergeable_state: blocked` (the human review rule) → `conflict: none` — the aggregate `blocked` was not read as a conflict or a check failure; strict `not-required`, comparison `ahead` 1 / behind 0; check runs `[]`, statuses `[]` → optional/otherSha empty | **met** |
| Tracking only: no comment, no queue/impediment change, GET only | evaluate events: `pause-copy` and one `read-pull-request` (observed, full collection); no `post-comment`; queue `pending: false` unchanged; impediments only the presented `GLOBAL_PAUSE` of the recipe's own pause on the copy; `getOnly: true`; gh trace: **32 requests, all `GET`, 0 refused** (preflight 10, evaluate 12 incl. the label poll, inspect 10); App token issuance went over native HTTPS, outside the gh trace | **met** |
| One explanation recorded, one history event | `checks-evaluated` `satisfied@bfdd439…:` once; `checks.history: []` | **met** |
| Inspect re-read agrees | second readPullRequest: same head, classic none, check runs/statuses empty | **met** |

Side observation (not a ticket 15 effect): the evaluate owner shows the copied Work with `dispatch.state: executing` and
`RECONCILIATION_REQUIRED` (the copied q14 publication Execution was not settled for this new owner; `runtimeInventory: 'unknown'` keeps
dispatch closed). The checks pass still ran because the Execution was neither `reserved` nor `started`, which is the intended rule.

### Coverage gap (honest)

The test repository's `main` has **no required check** (classic status checks not enforced; its ruleset carries only `pull_request`,
`non_fast_forward`, `deletion`, `update`) and the PR head has **no check run and no status**. The real run therefore proves the read
paths, the grant, pagination entry, the empty-set-from-complete-reads decision, rule interpretation, mergeability/strict facts, the
read-only guarantees and the copy migration — but **not** with real data: pending, failing, rerun (same or newer suite),
skipped/neutral, homonymous check-run + status, integration-tied statuses, other-origin/other-SHA results, strict-behind, unsupported
modalities, multi-page listings or denied reads. Those are fixture-level only (S / I(sub)).

**Proposal:** a follow-up real run is warranted before readiness (ticket 16) relies on real CI, but it should not block ticket 15: the
operator (not the Factory, which never holds Workflows) adds to the test repository a trivial GitHub Actions workflow on `pull_request`
and a repository ruleset requiring its check (strict on), then re-runs this recipe in a fresh namespace twice: once while the run is
pending (expect `waiting REQUIRED_CHECK_PENDING`), once after success (expect `satisfied` with the Actions integration id), and
optionally after a manual failing re-run (expect `failing`, latest attempt current). This also answers questions 1–2 below. Suggested
as part of ticket 16's real evidence or a small dedicated ticket; the operator decides.

## Design decisions and remaining questions

Operator decisions (supervisor review of `3b096e5`): (1) `STATUS_ORIGIN_UNVERIFIABLE` only when the requirement is bound to an
integration AND the homonymous status creator cannot be tied to it; a requirement accepting any source counts the status — implemented
with the slug tie above. (4) Confirmed: 15 explains; tickets 16/22 decide impediments.

Real-run questions, answered as far as `q15-checks-v2` allows:
1. **Branch summary vs rulesets — partially answered.** For a base protected only by a ruleset, `GET /branches/main` returned a
   protection summary reporting classic status checks not enforced, read with the installation token, so classic absence was concluded
   from an authorized complete read without the Administration detail endpoint. Whether the summary would also list a *ruleset*
   required check remains unknown (the ruleset has none); the follow-up run above answers it. Classic merge queue: still not exposed.
2. **Actions reruns — not answered** (no check runs on the head). Follow-up run.
3. **Compare payload — partially answered.** For a one-commit, one-file diff `compare` returned well within the transport bound
   (`ahead` 1 / behind 0); large diffs remain untested and only matter under strict.

## Gate totals (rebased on `b2da9ae`)

`npm run test:ci` (`scripts/test-runner/run ci`, machine lock, clean `dist/`): **RESULT: PASS** — static (tsc, prepare-sdk, ESLint
`--max-warnings 0`, dependency-cruiser) then 194 files (193 parallel N=8 + 1 serial): 1196 tests, 1186 pass, 0 fail, 10 skipped; 200.7 s of
the 600 s budget at load ~15; `admission-cli` quarantined (ticket 37, not coverage). An earlier ci run on this branch failed only in
`workers/public-copy-read` (`spawnSync … ETIMEDOUT` under load 14, unrelated to ticket 15); the rerun passed. Ticket 15 files:
`control/checks-rules` 11, `control/checks-flow` 4, `entrypoints/github-checks-reads` 9 (tier slow), `entrypoints/github-checks-composed` 1
(tier slow), `entrypoints/checks15-qualification` 2, `entrypoints/checks15-recipe-safety` 3, `architecture/publication-boundary` (gate
extended for the read-only `readPullRequest`). Real GitHub (P): not run (the supervisor runs the recipe).
