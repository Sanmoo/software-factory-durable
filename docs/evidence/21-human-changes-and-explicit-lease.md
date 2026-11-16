# Ticket 21 — Preserving human changes during the branch update (explicit lease)

Branch `implement/software-factory-mvp-21` on integration `b88bcec`. Reuses ticket 10's Question identity/desk (publication on the
Ticket, `/factory answer` ingestion, CLI answer), ticket 14's publication record (`attempts` with the expectation actually used,
`linkedHeads`, discovery, publish-only activation with `builder-publish`), ticket 16/17's consumers of `linkedHeads`, and ticket 26's admission
re-checks. No Factory-side push, no wrapper, no parser of shell output.

## Design

- **Attribution** (`rules/divergence.ts` `knownRemote`): a head is the Factory's only by recoverable evidence — a head it linked as its own
  PR head (`linkedHeads`) or a head one of its publication activations carried (`attempts`). The branch name never proves authorship.
- **Expectation** (AC1): the lease of the next write is the one RECORDED before preparation — the last attempt's `expectedRemote`, else the
  authorized tip, else the last linked head. It is never a tracking ref nor re-read after a failed lease.
- **Detection** (`decideDiscovery`, new outcome `diverged`): the own PR (or the own branch ref) at a head that is neither attributable nor
  the authorized tip blocks the next write. The discovery reads GitHub's comparison `expected...current` in the same safe read
  (`CodeRepository.findPublication({ compareFrom })`, Contents R). After an attempt, a complete comparison WITHOUT the verified head means the
  lease failed (`LEASE_FAILED`); the verified head among the commits means a human pushed after our push; otherwise `LEASE_OUTCOME_UNKNOWN`.
  Uncertainties are explicit: differences unknown, truncated comparison, Factory commits missing on the remote, unlinked authors, PR head
  differing from the ref. Ticket 14's `PUBLISHED_HEAD_NOT_VERIFIED`/`REMOTE_BRANCH_CHANGED` blocks remain for EARLIER Factory heads.
- **Question** (AC3/AC4): in the same commit as the decision, Control records a `controller-divergence` Question (ticket 10 document family,
  destination = Ticket issue because the PR surface is still not enabled), `QUESTION_PENDING` + `HUMAN_CHANGE_RECONCILIATION` impediments and
  `publication.state = diverged`; the local result (verified head) and the expectation are kept. The text names Work/repo/branch/PR, base,
  known/current/local refs, commits with the GitHub account when GitHub links one ("account unproven" otherwise), files, uncertainties and the
  proposal (default: incorporate and preserve), within the Question limits.
- **Answer** (AC5, `reconciliationAnswer`): `incorporate [note]` authorizes the default; `discard <exact current tip>` authorizes discarding
  exactly those commits; anything else (incl. "ok", another tip, a scope request) authorizes nothing and the branch is evaluated again
  (a new Question). The authorization (`publication.reconciliation`) is bound to the divergence id, Question, answer hash and authorized tip;
  it renews no budget/scope (the reconciliation Execution has no scope updates; budget counters untouched).
- **Incorporate**: a reconciliation Execution (`resume.reason RECONCILIATION_AUTHORIZED`, `request.reconciliation`, phaseId
  `builder-reconciliation`, read-only `builder-start` grant, new session) re-checked in the admission commit. Its self-contained prompt: fetch
  the branch and check FETCH_HEAD is exactly the authorized tip (else stop: new change), rebase the Factory's own commits onto it by default or
  follow the update strategy documented in the repository AGENTS.md; the tip must stay an ancestor; never rebase onto a newer base here;
  conflicts with the human intent go to `ask_user`; never push. Then the normal gates/reviews (they apply to the incorporated content).
- **Preservation proof** (deterministic): the invocation's `handoff.preserve` makes the constant guest capture program run
  `git merge-base --is-ancestor <tip> HEAD` and report `preserved: {commit, ancestor}` (parsed strictly; an answer about another commit or
  an unrequested one is refused). `publishableContent` of a reconciliation basis requires it (`HUMAN_CHANGE_PRESERVATION_UNKNOWN`,
  `HUMAN_CHANGE_NOT_PRESERVED`).
- **Lease** (AC2): with the authorization in force, discovery requests the publish-only activation with `expectedRemote = authorized tip`,
  i.e. `--force-with-lease=refs/heads/<own branch>:<tip>` (ticket 14 prompt). Attempts under an authorization count only if they leased exactly
  that tip (`attemptsOf`), so a lease refused BEFORE the authorization is not "attempted" for it, while nothing is repeated without one. A
  remote change after the answer is a NEW divergence against the authorized tip (`superseded`, new Question), never a renewed lease.
  Linking the reconciled head consumes the authorization.
- **Base target** (AC6): the linked own PR (same immutable id) whose only difference is its base → `base-changed` +
  `BASE_TARGET_CHANGED` impediment; re-read each cycle; restored → the decision applies (`publication-base-restored`). A published Work whose
  base merely advances triggers no discovery, Execution, review, rebase or draft.

## AC → tests (level)

R = rules; S = real Control + SQLite with doubled boundaries; I-local = real adapter over the gh world fixture / real host git+python.

| AC | Tests | Level |
| --- | --- | --- |
| 1 rebase default unless AGENTS; expectation captured/preserved | `divergence-rules` AC1/AC2 (knownRemote, prompt), `humanchanges-flow` lease-failed (attempt expectation kept), reconciliation request (`strategy`, `expected`) | R + S |
| 2 only own branch, explicit ref:OID lease; never force/tracking ref/base rewrite | `divergence-rules` AC1/AC2, `humanchanges-flow` (prompt leases exactly the authorized tip), recipe `pushViolations` | R + S |
| 3 unattributable change blocks; failed lease not recaptured | `divergence-rules` AC3 ×2, `humanchanges-flow` (no activation while open; lease failure never retried), `publication-rules` (updated) | R + S |
| 4 Question content; default incorporate; discard specific | `divergence-rules` AC4/AC5, `humanchanges-flow` (published on the Ticket, `ok` asks again, discard exact tip) | R + S |
| 5 answer authorizes only that divergence; no budget/scope renewal; new change → new evaluation | `divergence-rules` AC5, `humanchanges-flow` (budget equal, no scope ids, second human push → superseded + new Question) | R + S |
| 6 target-branch change blocks until restored; base advance triggers nothing | `divergence-rules` AC6, `humanchanges-flow` AC6 | R + S |
| preservation proof | `handoff-capture` ticket 21 (real git: ancestor / dropped / never fetched; strict parse), `activate-review` ticket 21 (launch payload, malformed refused) | I-local |
| comparison read | `github-publication` ticket 21 (compare commits/accounts/files; same tip; 404 = unknown) | I-local |
| 7 real Git/GitHub/agent | recipe ready (`humanchanges21-qualification`), **not run** | — |

## One-shot real-run recipe (`test/entrypoints/humanchanges21-qualification.ts`)

Namespace `/home/sanmoo/software-factory-test/y5/q21-human-v1` (GitHub access root, with an `O_EXCL` copy of `y5/credentials/app.pem`; a
missing key fails loudly before any effect). Inert `--plan`/import; tombstones; `phaseGuard` (order, each once, previous success); the NEW
issue number is a reviewed constant (0 = `TICKET_NOT_PINNED`); proposed docs-only title/body in the plan. Phases and HUMAN steps (operator's
own account; plain fast-forward pushes; exact commands saved in `human-step-<k>-requested.json`):

1. `preflight` — read-only checks (operator id, label = exactly the issue, no associated PR/`factory/<n>-` branch, protected base, App id).
2. `run` — implementation + publication → own draft PR at H1.
3. `race` — fixed `update-scope` → implementation H2 → update requested with lease H1 → the recipe HOLDS the publication activation until
   **human step 1** (new file `docs/FACTORY_HUMAN_NOTE.md`, commit C1 on H1) → the Builder's leased push is rejected → `diverged`
   (`lease-failed`), Question 1 published. **Answer 1**: `/factory answer <q1> incorporate`.
4. `reconcile` — reconciliation (preserve C1) → the next discovery is HELD until **human step 2** (`docs/FACTORY_HUMAN_NOTE_2.md`, C2 on C1)
   → new divergence against C1, Question 2, no push. **Answer 2**: `incorporate`.
5. `finish` — reconciliation (preserve C2) → publication with `--force-with-lease=<ref>:C2` → linked H4.
6. `inspect` — compare C1...H4 / C2...H4 (ahead), both files at H4, every session push names its exact lease, no bare force.

Expected preservation outcome: both human commits are ancestors of the final head, their files unchanged; the only rejected write is the
racing lease; no Factory write ever lands over an unauthorized remote tip.

## Gate

`npm run test:ci` on `b88bcec` + this change: **PASS** — static tsc 23.0 s, eslint 13.7 s, depcruise 5.1 s; parallel lane 219 files (N=8),
serial lane 1 file; 1335 tests: 1325 pass, 0 fail, 10 skipped; 226.5 s of 600 s. Quarantined (not coverage, ticket 37): admission-cli,
normal-worker, publication-composition, public-copy-read. No new tier entry (all new files fast and parallel-safe: temporary storage/repos).
Tests were written alongside the implementation (not strictly red-first); the ticket 14 rule assertions superseded by ticket 21 (unknown
head on the own PR → `diverged`) failed against the new code and were updated deliberately.

## Review fixes (static review of 4852185)

Gate after rebase onto integration `8a91799` (ticket 37): `npm run test:ci` PASS — 1353 tests, 1343 pass, 0 fail, 10 skipped, 198.1 s, nothing
quarantined (an earlier run failed only on a transient tmpfs quota, EDQUOT, from concurrent runs; rerun green).
Gate after the fixes: `npm run test:ci` PASS — 1343 tests, 1333 pass, 0 fail, 10 skipped, 234.6 s of 600 s (same 4 quarantined files).
The first run had controller-ownership cancelled under load; it passed alone (8/8) and in the rerun.

- HIGH (Control-side enforcement): before linking ANY new own head, `preservationCheck` requires every commit others pushed — divergence
  tips (with the paths their change touched), unattributable discovery tips, and every tip the branch PUSH ACTIVITY reports (a human push's
  `after`, or the `before` a Factory push replaced) — to be an ancestor of the head (GitHub comparison `ahead`/`identical`) with those paths
  unchanged since it; otherwise `diverged` (`kind: lost`, `LOST_HUMAN_CHANGE`), never linked, Question. Unknown activity/comparison decides
  nothing. A lost change can only be explicitly discarded (`discard <tip>`, recorded in `waived`) or restored by the operator.
  Red shown: with the check disabled, the recaptured-lease and revert flow tests fail (2/7); green with it.
- HIGH (Builder-side guard): the Builder Host's Bash refuses, before the guest, every push except the exact
  `git -C /workspace/checkout push --force-with-lease=refs/heads/<own>:<expected> origin <head>:refs/heads/<own>` derived by Control for the
  publication activation (`pushPolicy`), and any `gh api`/curl write to git refs; no push at all outside it or in the PR-only continuation.
  **Sanctioned exception** (supervisor sign-off 2026-11-15): `src/workers/push-policy.ts` is the ONE guest-side push guard and the only
  exception to ticket 14's "no Git/gh wrapper or shell parser" rule (`publication-boundary.test.ts` exempts exactly this file). It only
  refuses; it never publishes or registers effects. Ticket 18 reuses this module (single implementation).
- MED-HIGH: a reconciliation whose basis is not publishable settles the authorization `failed` with its reasons, keeps the earlier
  verified result and re-evaluates the branch (a new Question).
- MED: the base-restoring read decides nothing; the next complete read re-evaluates before any write. Content proof includes the human
  paths (revert detected). Reconciliation precedes a pending scope update, which stays pending. Exact answers only; the Question keeps the
  reply instruction and the uncertainties under the bounds ("+N more").
- Recipe: lease oid must equal a Control-recorded attempt; API ref writes and `-f/-u/+` detected; tracker write guard; one `set -euo pipefail`
  human script that aborts on another tip; inspect only after `finish` succeeded; key copy after the intent tombstone; preflight checks
  the activity endpoint is readable.

## MVP limits accepted by the operator (2026-11-15)



1. Authorizing a DIFFERENT compatible base is not implemented: the Work's base is configuration-bound; only restoration lifts the block.
2. Base change/human pushes are detected only when a write is pending (discovery runs for a new basis/attempt); a published Work with an
   unknown head is left to readiness (ticket 16) and delivery (ticket 17 requires a linked head).
3. A reconciliation Execution interrupted before start (ticket 26 path) keeps the authorization `executing` and is refused re-admission
   (fail-closed, operator recovery).
4. Rebasing onto a newer base when human commits exist would rewrite them: excluded from the reconciliation activation (repairs of 22/23).
5. Questions still go to the Ticket issue, not the PR surface.

## Real run q21-human-v3 (issue #13, consumed) — held fail-closed

The Builder chained `git rev-parse HEAD && <exact leased push>`; the push policy refused it locally (`PUSH_POLICY_DENIED`, nothing sent) and
the Builder, following "never repeat", stopped; discovery then blocked `PUBLICATION_OUTCOME_UNCONFIRMED` + `REMOTE_BRANCH_ABSENT` (correct).
Fixes: the denial says it is a LOCAL refusal (nothing sent, not a publication attempt) and to run the exact command ALONE as its own bash
call; the publish-only prompt says the same and allows correcting it ONCE in the same activation. The policy stays strict (no chained or
compound acceptance; test with the exact chained command). Limit (documented, not changed): Control records the attempt at the activation
commit and cannot know a push was only policy-denied without parsing shell output, so an activation whose ONLY push was denied still ends
fail-closed (blocked, operator recovery); the in-activation correction is what avoids burning it. Namespace now `q21-human-v4`, issue unpinned.

Also in this round: (a) v2's race timed out while holding the publication activation and left its boot running; every end of a Control
phase (success, held, timeout, throw) now stops the owner, then stops through the public Sandbox every boot the phase started and records
its confirmed cessation (`<phase>-cessation.json`; unconfirmed = held); the human-step wait is 60 min (race/reconcile deadlines 150 min).
(b) Ticket 18 compatibility: the publish-only instruction and the Builder push policy take the SAME remote token from one Control constant
(`publicationRemote`, `origin` here; ticket 18 may set the configured `https://github.com/<owner>/<repo>.git`); the policy accepts exactly the
emitted token and refuses any other form.

## Real run q21-human-v4 (issue #16, consumed) — reconcile stalled; fixed

Race succeeded (C1 pushed, lease failed, Question answered `incorporate`). The reconciliation Execution rebased cleanly onto C1, then the
model provider failed (`WORKER_PROVIDER_UNAVAILABLE` → `WORKER_INTERRUPTED`); ticket 26 queued an operational recovery but dispatch/admission
only accepted an `authorized` reconciliation, so the Work never dispatched. Fix: an `executing` authorization bound to the interrupted
reconciliation Execution is continued by ticket 26's recovery with the SAME `request.reconciliation` (preserve check, later lease), no
resume, no scope; its instruction starts with the reconciliation facts (FETCH_HEAD check, no push). Flow test (red with the fix disabled):
interrupted → recovered → published with the lease on the authorized tip. Recipe: one recovery of the phase's implementation allowed.
Rebased (squashed) onto integration `cc7b411` (ticket 18): the instruction and the push policy use the configured
`https://github.com/<owner>/<repo>.git` remote from one Control function; the single guest push guard stays `src/workers/push-policy.ts`.
Namespace `q21-human-v5`, issue unpinned. Gate: `npm run test:ci` PASS — 1382 tests, 1372 pass, 0 fail, 10 skipped, 219.2 s.

## Real run q21-human-v5 (issue #19, consumed) — reconciliation not verified; fixed

Race and the reconciliation itself worked (C1 incorporated, C2 pushed during reconcile, Question 2 published), but the reconciliation's
verification was `not-verified`: the Builder declared no gate (`GATES_NOT_DECLARED`) and did not adopt the Spec finding about the human file
without an authorization (`REQUIREMENT_NON_ADOPTION_NOT_AUTHORIZED:7/spec/S1`); its `ask_user` was refused because a Builder Question after
the PR link had no enabled destination. Fixes: the reconciliation instruction (and its recovery form) carries the implementation duties —
re-run and declare every documented gate; treat every finding; a finding about the preserved remote commits is not adopted WITH the answered
divergence Question as concrete authorization (correlated by ticket 13's verification); anything else goes to ask_user. Builder Questions
after the PR link go to the Ticket issue (PR surface not enabled), like the divergence Questions. Recipe: `inspect` runs after any ended
phase (held or not), never while one runs. Namespace `q21-human-v6`, issue unpinned. Gate: `npm run test:ci` PASS — 1384 tests, 1374 pass, 0 fail, 10 skipped.

## Real run q21-human-v6 (issue #24, consumed) — implementation gate unverified; fixed

Not a regression of the v5 reconciliation duties (that run was the plain implementation). The Builder declared the gate
`cd /workspace/checkout && test -f … && grep -q '^## Steps' …` but ran it only EMBEDDED: inside its commit script (round 1) and then as
`cd /workspace && <that command>` (round 2). The Host ledger takes a gate result only from a Bash call of exactly the declared command, so
both rounds ended `GATE_RESULT_NOT_FOUND` → `GATE_RESULT_UNVERIFIED:ticket-validation`. Fix (workers): the handoff refuses, in session and
without using a round, a `run` gate whose command ran only embedded (`HANDOFF_GATE_NOT_RUN`, with the exact command to run ALONE); a gate
that never ran at all keeps ticket 13's semantics (accepted, unverified). Red/green test with the exact v6 shapes. Namespace `q21-human-v7`.

## Real run q21-human-v7 (issue #25, consumed) — Builder Question during reconcile; fixed

The answer was ingested and the reconciliation ran (dbfc968 kept as an ancestor), but the Spec reviewer again flagged the human-added file as
out of scope and the Builder asked a Question instead of using the authorization; the Work correctly waited for the answer, but the recipe
neither surfaced Builder Questions nor allowed a question-resumed activation. Fixes: the reconciliation's reviewers receive, as data, the
operator-authorized preserved commits/files with the authorizing Question id (not the Builder's work, not a finding; Builder changes to
those files still reviewed); the Builder duty says a finding about them is not-adopted under that authorization, never a new Question. Recipe:
a Builder Question keeps the phase waiting and is saved to `operator-question-requested-<n>.json` (id/text, never auto-answered; wait ≥60 min);
one question-resumed or recovery activation is allowed in reconcile/finish. Namespace `q21-human-v8`, issue unpinned.

## Real run q21-human-v8 (issue #27, consumed) — Spec review incomplete; fixed

Not the v7 change (it adds prompt text, no required input). The Spec reviewer read EVERY required input in full with `offset: 1, limit: 2000`
and concluded clean, but the Host read observer only credited unlimited reads, so all five required inputs were "not fully read" and the
opinion was downgraded to incomplete (`REQUIRED_INPUT_NOT_FULLY_READ`) in rounds 7–9; the Builder then asked the operator. Fix (workers): a
limited read is full when the file ended inside the window (the SDK returns it without truncation and without its
`[N more lines in file. Use offset=X to continue.]` notice); with the notice, coverage advances to X. Red/green test with the exact shapes.
Intended handling of an incomplete opinion (tickets 12/13/28): it is a review result, not a reviewer failure — no retry; the Builder may hand
off again and the end-of-Execution verification is `not-verified` (`REVIEW_INCOMPLETE`), so nothing is published; asking the operator is
allowed but not required. Namespace `q21-human-v9`, issue unpinned.
