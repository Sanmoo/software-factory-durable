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
  the head (`filter=all`, every attempt, ≤10 pages), statuses of the head (≤10 pages), `compare/{baseTip}...{head}`, and a **final PR
  re-read**. Classic absence is reported only from an authorized complete branch read (`protected: false` or enforcement `off`); a
  403/404/hidden detail is `unknown`.
- Control rules (`src/control/rules/checks.ts`, pure): `evaluateChecks` →
  `ChecksEvaluation` (`src/control/types.ts`). Requirements accumulate from classic + every rule by **context + integration**, with the
  sources and strict/loose per source. Current result = latest attempt per (name, App, check suite) on the **current head**, latest status
  per context; homonymous check-run and status both count (all must satisfy). Semantics: check-run `success/skipped/neutral` satisfy,
  `failure` = repair, `action_required/stale` = operational, other/`cancelled/timed_out` = uncertain, not completed = waiting; status
  `success` satisfies, `pending` waits, `failure` repair, anything else uncertain. Independent reasons with categories
  `wait/repair/operational/uncertain/indeterminate/ownership/strict/closed`; outcome precedence not-applicable > indeterminate > failing >
  blocked > waiting > satisfied. Unsupported modalities (`workflows`, `merge_queue`, `required_deployments`, `code_scanning`, unknown
  rule types) are `RULE_NOT_INTERPRETABLE`; `pull_request`/`copilot_code_review` are `human-stage` (visible, not blocking).
  Ownership against ticket 14's link (id/node/number, App author, branch, repository, Work base, head among linked heads). Strict is
  confirmed against the current base tip; loose lag is only a note. Optional/other-SHA/other-origin results are visible only.
- Control durable (`src/control/durable/checks.ts`): `checksTarget(work)`, `recordChecks` (one commit; only for the PR still linked to the
  current open Work; identical explanation refreshes, a different one pushes the previous to `checks.history` (≤10) and appends one
  `checks-evaluated` history event), and `createChecksTracker` — a bounded pass (≤2 PR reads per tick, oldest first, skipped while the Work
  has a running activity). Wired in the **existing dispatcher tick**, before the pause check (tracking only), like ticket 14's discovery.
  No broker/scheduler/DI; never a Slot, queue entry, impediment, repair or readiness decision.

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
tick, ≤2 ticks in 5 min; plus the normal polling reads of the label. No model, no VM/Docker; every execution port refuses and records the
attempt. Exclusive intent tombstones, no retry; q14 storage only copied.

Expected observations: `checks.latest.pullRequest` = the linked PR (head = 14's linked head unless pushed since); completeness per read;
requirements = classic required checks + active (also organization) ruleset `required_status_checks` of `main` by context+integration with
strict per source. If `main` has no required check, `requiredSet: empty-complete` only when branch, classic detail and rules reads were all
complete — any 403/404 must show `unknown`, never empty. Outcome as GitHub really reports (e.g. `waiting` while Actions runs, `satisfied`
after). Required workflows/merge queue rules → `indeterminate RULE_NOT_INTERPRETABLE`. `conflict` from `mergeable`, `strict.state` from the
comparison. No execution effect in `events`, no queue/impediment change, every installation request a GET. To exercise more requirement
kinds, the operator may (optionally, outside the recipe) add a ruleset with a required check before `evaluate`; the recipe never changes
repository settings.

## Open design questions

1. **Status origin for integration-bound requirements.** REST statuses expose only `creator`; mapping it to a GitHub App id needs
   `GET /apps/{slug}` (outside the repository-scoped session). Now: a Bot-created homonymous status of an App-bound requirement is
   `indeterminate STATUS_ORIGIN_UNVERIFIABLE`; a User-created one is other-origin. Should Control resolve the App, or is indeterminate the
   accepted behaviour?
2. **Classic protection read path.** Absence of classic required checks is concluded from `GET /branches/{base}` (`protected:false` or
   enforcement `off`); when enforced, strictness/integrations come from `protection/required_status_checks` (Administration R). Whether the
   branch summary also reflects ruleset checks on real GitHub must be confirmed by the real run (duplicates are deduplicated; a hidden
   detail is `unknown`). Classic "require merge queue" is not exposed by REST and is a documented limitation.
3. **Attempts across check suites.** The latest attempt is chosen per (name, App, check suite); two current suites of the same App that
   disagree are `ATTEMPTS_INDISTINGUISHABLE` (e.g. a workflow triggered by both `push` and `pull_request`). Confirm with real Actions reruns.
4. **Impediments.** Operational/uncertain/strict-behind are reasons in the explanation only; no `Impediment` is created (readiness, ticket
   16, and repairs, ticket 22, consume the explanation). Confirm this split.
5. **Compare payload.** `compare` responses include files and may exceed the 2 MiB transport bound on large diffs → `STRICT_STATE_UNKNOWN`
   only when strict applies.

## Gate totals (base `d4483d1`, branch tip before this document)

Node `24.21.0` with `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 90`:

- `tsc -p tsconfig.json`: clean. `eslint . --max-warnings 0`: clean. `dependency-cruiser`: no violations (350 modules, 2110 dependencies).
- Every compiled `dist/test/**/*.test.js` one file at a time (`--experimental-test-module-mocks --test --test-concurrency=1`):
  **167 files, all exit 0; 1057 pass, 0 fail, 10 skipped** (`test/sandbox/gondolin.test.ts` stays `skip: true`). No flaky rerun needed.
- Ticket 15 files: `control/checks-rules` 9, `control/checks-flow` 3, `entrypoints/github-checks-reads` 5,
  `entrypoints/github-checks-composed` 1, `entrypoints/checks15-qualification` 2.
- Real GitHub (P): **not run** (no authorization in this session); recipe above.
