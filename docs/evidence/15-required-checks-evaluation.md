# Ticket 15 — Explain the required checks of the current own PR

Branch `implement/software-factory-mvp-15`, based on integration `d4483d1` (tickets 01–13, 19, 20, 32). Ticket 14 (own draft PR
publication/discovery) is **not integrated in this base**: Control consumes ticket 14's record of the linked own PR **structurally**
(`WorkView.publication` with `state: 'published'`, `pullRequest {pullRequestId, nodeId, number, headRef, headSha, author.id}`, `base`,
`linkedHeads`, `verified.requiredChecks`), exactly the shape of ticket 14's `PublicationView`. Tests that need a linked PR seed that record
(`test/control/checks-seed.ts`); after the rebase onto 14 the same code reads the typed field and the seed can be replaced by 14's flow.

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
| 7 Controlled data + real integration; instant/completeness/limitations, no atomic snapshot | `checks-rules` AC7 (observedAt/completedAt, completeness map, head/base/state change during collection, closed/merged, other PR); `github-checks-reads` AC7 (re-read exposes a push); `checks-flow` AC7 (stale link, bounded/rotating reads, stop); `entrypoints/github-checks-composed` (public Control + real adapters + tick); `checks15-qualification` (recipe inert/guards) | S + I(sub); **P pending** |

## One-shot real-run recipe (`test/entrypoints/checks15-qualification.ts`)

Read-only against the own draft PR that ticket 14's real run (`/home/sanmoo/software-factory-test/y5/q14-publication-v6`, issue #3 of
`Sanmoo/java-springboot-event-sourcing`) created and linked. **Requires**: this branch rebased onto ticket 14 (so `WorkView.publication` is
produced by the real flow), q14's `discover-result.json` present (PR linked), and q14 ended without a held Slot. Explicit operator grant
needed (real App key, real GitHub reads). `--plan` prints the exact effects and bounds.

```
node dist/test/entrypoints/checks15-qualification.js --plan
node dist/test/entrypoints/checks15-qualification.js preflight   # exclusive q15-checks-v1/, copy of q14 storage, linked PR, raw readPullRequest
node dist/test/entrypoints/checks15-qualification.js evaluate    # another copy as authority, one owner run (polling 180 s), stop when checks recorded (≤5 min)
node dist/test/entrypoints/checks15-qualification.js inspect     # copy of evaluate storage: checks view + second raw readPullRequest
```

(Each with the Node command prefix of the development gate.) Bounds: GitHub = App token issuance POSTs + GETs only; per evaluation ≈
1 PR + 1 branch + ≤1 classic detail + ≤10 rules pages + ≤10 check-run pages + ≤10 status pages + ≤1 compare + 1 PR re-read; ≤2 Works per
pass, ≤2 passes in 5 min; plus the normal polling reads of the label. No model, no VM/Docker. **Dispatch disabled**: no execution ports are
composed (`EXECUTION_NOT_ENABLED`) and the evaluate copy is paused first (local pause on the copy), so no Work is admitted or started.
**Read-only**: the IssueTracker is wrapped so `postComment` is refused locally (a pending Question copied from q14 can never be
published), and gh runs behind a wrapper (`q15-checks-v1/gh-guard.mjs`) that records every request in `gh-trace.jsonl` and refuses with
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

## Design decisions and remaining questions

Operator decisions (supervisor review of `3b096e5`): (1) `STATUS_ORIGIN_UNVERIFIABLE` only when the requirement is bound to an
integration AND the homonymous status creator cannot be tied to it; a requirement accepting any source counts the status — implemented
with the slug tie above. (4) Confirmed: 15 explains; tickets 16/22 decide impediments.

Remaining for the real run:
1. Whether `GET /branches/{base}` reflects ruleset checks in its protection summary (duplicates are deduplicated; hidden detail is
   `unknown`). Classic "require merge queue" is not exposed by REST (documented limitation).
2. Real Actions reruns: confirm that a rerun appears as a new attempt (same suite) or a newer suite with a later `started_at`.
3. `compare` payloads on large diffs may exceed the 2 MiB transport bound → `STRICT_STATE_UNKNOWN` only when strict applies.

## Gate totals (after the review fixes, base `d4483d1`)

Node `24.21.0` with `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 90`:

- `tsc -p tsconfig.json`: clean. `eslint . --max-warnings 0`: clean. `dependency-cruiser`: no violations.
- Every compiled `dist/test/**/*.test.js` one file at a time (`--experimental-test-module-mocks --test --test-concurrency=1`):
  **168 files, 1066 pass, 0 fail, 10 skipped** (`test/sandbox/gondolin.test.ts` stays `skip: true`). Under parallel machine load
  `entrypoints/normal-oauth` hit the 90 s outer timeout (17/18 done) and `workers/sdk-profile` exited 1 with no test result; both were rerun
  alone and passed (18/18, 1/1).
- Ticket 15 files: `control/checks-rules` 11, `control/checks-flow` 4, `entrypoints/github-checks-reads` 9,
  `entrypoints/github-checks-composed` 1, `entrypoints/checks15-qualification` 2, `entrypoints/checks15-recipe-safety` 2.
- Real GitHub (P): **not run** (no authorization in this session); recipe above.
