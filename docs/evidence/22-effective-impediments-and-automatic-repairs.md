# Ticket 22 — Automatic repairs for effective impediments

Branch `implement/software-factory-mvp-22`, based on ticket 21's branch (`implement/software-factory-mvp-21` @ `4852185`, under review; rebase
onto integration once 21 is integrated). Authority: [ticket 22](../../.scratch/software-factory-mvp/issues/22-effective-impediments-and-automatic-repairs.md),
spec §§4.3, 4.4, 9.2, 9.3, 10, 10.1; scenarios V-06/V-09/V-10. Reuses ticket 11 (continue/replace session, recovery context), 13 (review rounds,
verification), 14 (publication/discovery, update of the linked own PR), 15 (checks explanation), 16 (readiness, human flags), 19 (corrections
budget, `openCorrection` seam, reservation/consumption), 21 (explicit lease, divergences), 26 (admission re-checks), 39 (merge-blocking rules are
the operator's). No new queue, document family, scheduler, per-event state machine or consumption ACK.

**State: resolved (2026-11-16).** Local suite green (R/S/I-local) and the authorized real run `q22-repair-v1` passed (verdict 9/9, below).
A double does not prove the replaced boundary; the real run proves the conflict path only (see gaps).

## Design

- **Triggers** (`rules/repair.ts` `repairTriggers`, pure): from the latest ticket 15 explanation of the linked own PR at a head the Factory
  linked — `MERGE_CONFLICT` (GitHub `mergeable: false`, tri-state), `REQUIRED_CHECK_FAILED:<context>` (category `repair`: a current required
  result that failed, with its result URL/conclusion as evidence) and `STRICT_UPDATE_REQUIRED` (strict requirement, complete comparison behind the
  current base tip, and nothing waiting). Never: pending CI/review, unknown mergeability, optional or other-SHA results, loose lag (base
  advancing), operational/uncertain results, merge-blocking/unsupported base rules (ticket 39), a human head (ticket 21), a human draft/ready
  flag (ticket 16), an incomplete/changed/closed/unowned observation.
- **Durable state** (existing Work/correction/Execution): `WorkView.correction` gains `trigger` (`effective-impediment` | `internal`),
  `sequence`, `reasons[]` (code, subject, head, base tip, observed at, evidence), `headSha`, `basisExecutionId`; `queue.category` is
  `normal | repair` with `repairSequence` (installation counter `ticketIndex.repairSequence`); `WorkView.corrections[]` (bounded 10) keeps closed
  corrections (outcome, charged, reasons, head). `ExecutionView.request.repair` and `resume.reason: REPAIR_REQUESTED`. History:
  `repair-consolidated|withdrawn|revalidated|repeated`, `correction-closed`.
- **Repair desk** (`durable/repair.ts`, owner loop after checks and readiness, also while paused; never for a Work with an active Execution or
  running in this owner): ONE commit per Work decides (`repairDecision`) — `open` (new correction, new repair sequence, Work pending in the repair
  category, exhaustion visible at once via ticket 19), `consolidate` (same identity/charge; details such as the base tip refreshed), `withdraw`
  (a not-yet-charged correction whose reasons all disappeared: closed `withdrawn`, no charge, exhaustion impediment for it removed), `repeated`
  (the same fingerprint `code:subject@head` already treated by a CHARGED closed correction: `REPAIR_EVENT_ALREADY_TREATED`, nothing spent; lifted
  when no longer observed). Closure (`correctionClosure`): a charged correction closes when its Executions ended with confirmed cessation and the
  publication of its basis is `published` / `not-publishable` / settled (blocked/diverged/base-changed) — never waiting for CI.
- **Selection** (`queueOrder`): repairs first, FIFO by repair sequence, then normal FIFO by admission; no preemption (dispatcher and `list`/
  `status` selection; `queues.repair` populated).
- **Revalidation before start** (`dispatch.ts` `revalidateRepair`): for a pending, uncharged effective-impediment correction the dispatcher
  makes a FRESH complete read of the own PR, records the explanation and runs the repair observation again; withdrawn/changed ⇒ nothing admitted.
  Ownership, authorization, dependencies, pause and budget are re-checked by the existing admission commit (which also re-checks that
  `request.repair` equals the open correction and that the resume basis is the published verified basis).
- **Builder**: the session of the published verified basis is continued (`continue` + repair section) when compatible, otherwise a recovery
  prompt + repair section (ticket 11 rules, `builder-continuation`/`builder-recovery`, read-only `builder-start` grant). The section lists every
  reason with evidence (fenced data), the base update target (`fetch origin <base>`, `FETCH_HEAD` must be exactly the observed tip, rebase by
  default or the AGENTS.md strategy, keep commits it did not make), "already resolved ⇒ demonstrate, change nothing", "cannot fix ⇒ ask_user",
  and NEVER push/merge/approve/mark ready/bypass/change protection. For conflict/strict repairs the review handoff base is that tip. The push is
  ticket 14's publication activation of the new verified basis, updating the SAME PR with `--force-with-lease=<ref>:<published head>` (ticket 21
  divergence rules unchanged); its charge is `preserved`. A Question during the repair keeps the same correction/charge and request.

## AC → tests

R = pure rules; S = real Control + Pi Durable/SQLite with real 13/14/15/16 flows and doubled GitHub/Sandbox/Workers/credentials/clock.

| AC | Tests | Level |
| --- | --- | --- |
| 1 triggers vs non-triggers | `repair-rules` AC1 ×2 (conflict, failed required check with URL evidence, strict, several; pending, unknown, optional, other SHA, loose lag, `action_required`, strict while waiting, merge-blocking rule, human draft, human head, changed head, unpublished, no explanation); `repair-flow` non-triggers (5 cases over 12 cycles each, no correction/activation) | R + S |
| 2 existing records, no extra queue/state machine/ACK | `repair-flow` AC1… (one `correction-opened`, reasons/charge on the correction/Execution, `corrections[]`); `repair-rules` AC2… | R + S |
| 3 repair sequence, FIFO, priority without preemption, budget preserved | `repair-rules` AC3 (`queueOrder`), consolidation keeps identity; `repair-flow` AC1… (sequence 1 then 2, `queues.repair`, publication charge `preserved`, consumed 1) | R + S |
| 4 revalidation before start; withdraw without charge | `repair-flow` AC4 (paused tracking-pass withdrawal; then withdrawal by the dispatcher's fresh complete read on unpause; consumed 0, nothing launched); `repair-rules` withdraw | R + S |
| 5 reasons to the Builder, validation/reviews, leased publication, no parallel writer | `repair-flow` AC1… (continue prompt with the repair section and `FETCH_HEAD` tip, handoff base = tip, read-only grant, reviews, lease on the published head, same PR #4); `repair-rules` AC5 | R + S |
| 6 closes without CI; new failure may open another; repeated event blocks | `repair-flow` AC1… (closed `published` before any CI result; new failure of the NEW head ⇒ correction 2 blocked by `CORRECTION_LIMIT_REACHED`, no activation); `repair-flow` AC6 (same head ⇒ `REPAIR_EVENT_ALREADY_TREATED`, no second activation, lifted when green); `repair-rules` AC6 closure | R + S |
| 7 real integrations | real run `q22-repair-v1` (below): one repair consolidated and charged once, base advance not a trigger, same PR | A (real) |

Mutations (restored; detected): `repeated` branch disabled ⇒ 2 failures (rules + flow AC6); dispatcher revalidation bypassed ⇒ 2 flow failures
(AC1, AC4). TDD honesty: tests were written right after each rule/flow slice, not strictly red-first; the flow test's first run failed for real
(the continuation prompt named no branch; the repair section now states `base=/branch=/checkout=`).

## One-shot real-run recipe (`test/entrypoints/repair22-qualification.ts`)

Namespace `/home/sanmoo/software-factory-test/y5/q22-repair-v1` (own GitHub access root; `O_EXCL` copy of `y5/credentials/app.pem`, missing =
`APP_KEY_SOURCE_MISSING` before any effect); `ticket.number` is 0 until the supervisor pins the NEW issue (refuses every phase). `correctionLimit: 1`;
`setDraft` stubbed (never sent: the PR stays draft so the update path applies). Phases: `preflight` (read-only) → `run` (implementation +
publication: own draft PR at H1) → `advance` (HUMAN step 1: the operator merges an own PR adding `docs/FACTORY_REPAIR_BASE_NOTE.md` into main;
3 polling cycles: no correction, no activation, budget 0) → `conflict` (HUMAN step 2: the operator merges an own PR adding
`docs/FACTORY_REPAIR.md` with other content ⇒ add/add conflict ⇒ ONE correction, fresh revalidation, repair Execution, leased update H1→H2 of the
SAME PR, correction closed `published`, 3 quiet cycles) → `inspect` (B2 ancestor of H2, file at H2, every push leased) / `stop-environment`.

Repository setup (operator authorization required): no required check/workflow is needed. Ruleset 26435808 on main (`pull_request` with 1
approval and, if re-enabled, `update`) blocks the operator's own merges: either the operator merges the two human PRs with the operator's own
bypass (never the App), or the supervisor temporarily disables `update` / sets approvals to 0 for those two merges and restores them right after
step 2 is observed. `REQUIRED_CHECK_FAILED`/`STRICT_UPDATE_REQUIRED` on the real boundary would need a trivial required status check (workflow +
ruleset) — not part of this recipe.

## Gate

`npm run test:ci` on `4852185` + this change: **PASS** — static tsc 22.0 s, eslint 12.8 s, depcruise 5.1 s; parallel lane 222 files (N=8), serial
lane 1 file; 1348 tests: 1338 pass, 0 fail, 10 skipped; 280.9 s of 600 s (lock wait 108.8 s apart). New test files are fast and parallel-safe
(temporary storage, doubles, manual clock): no `test/tiers.json` entry. `test/sandbox/gondolin.test.ts` stays `skip:true`.

## Supervisor decisions (2026-11-15) applied

- **(3) never rewrite human commits.** `humanTips` = every non-own tip the operator authorized to incorporate (ticket 21 divergences). With any,
  `updateStrategy` is `merge`: the repair section tells the Builder to `merge --no-ff FETCH_HEAD` (merge commit, every SHA kept, human content kept;
  AGENTS.md mandating rebase ⇒ `ask_user`, never a rebase); rebase only when every commit since the base is the Factory's own.
  `request.repair.humanTips` is recorded at revalidation; every capture of the repair carries `handoff.preserve = <latest human tip>` and
  `publishableContent` requires the Host's `preserved {commit, ancestor: true}` (else `HUMAN_CHANGE_PRESERVATION_UNKNOWN`/`HUMAN_CHANGE_NOT_PRESERVED`,
  closed `not-publishable`, nothing pushed). Ticket 21's Control-wide ancestry check/push guard will apply on top after the rebase.
  Tests: `repair-rules` decision 3 ×2 (strategy, text, publishability); `repair-flow` decision 3 ×2 (ticket 21 path then conflict: merge prompt,
  preserve, leased publication; dropped human commit ⇒ not published) and AC1 (own commits only ⇒ rebase, no preserve). Red first (missing
  exports); a mutation dropping the publishability check fails 2 tests.
- **(1) strict accepted.** `correction.nextStep` (`correctionNextStep`) states that under strict each base advance is a new correction charged to
  the corrections budget (`<available> of <limit> left`, then `factory grant`). Tests: `repair-rules` decision 1, `repair-flow` decision 1.
- **(2), (4)** accepted as designed.

## Independent review (84ef010) — fixes

| Finding | Fix | Test |
| --- | --- | --- |
| HIGH uncertain/ineligible read (`none`) withdrew an uncharged correction | `TriggerOutcome.none.certain`: only a complete eligible read without impediment is certain; anything else decides nothing (correction, sequence, pending kept); a fresh uncertain read before admission is `repair-not-revalidated` | `repair-rules` review HIGH; `repair-flow` review HIGH/MED |
| MED failed revalidation stalled the whole dispatch | the tick skips that Work for the pass (position kept) and selects the next eligible one | `repair-flow` review HIGH/MED (unreadable PR, #5 dispatched); mutation `return` instead of skip fails it |
| MED interrupted/Question-resumed repair lost `request.repair` | every later activation of the CHARGED correction carries its last repair request (reasons, human tips, base tip; interruption prompt gets the repair section; handoff tip/preserve follow); admission re-checks it against the correction | `repair-flow` review MED (operational recovery prompt, handoff base); mutation dropping the carry fails it |
| MED reasons consolidated after the charge stored as charged | `defer`: kept in `correction.pendingReasons` (uncharged, never "treated"); the next activation of that correction delivers them (moved into `reasons` in its admission commit); after closure they are re-evaluated | `repair-rules` review MED; `repair-flow` review MED |
| LOW | uncertain `none` never lifts `REPAIR_EVENT_ALREADY_TREATED`; `REQUIRED_CHECK_FAILED` needs matching failed-result evidence (else uncertain); conflict/strict fingerprints include the base tip; `repair-revalidated` deduplicated; withdraw restores `pending` from the cause recorded at opening (`queueWasPending`) plus recovery/scope; recipe copies the key after guard + intent of each GitHub phase and removes it in that phase's `finally` | `repair-rules` review LOW; recipe test |

## Rebase onto integration `c645639` (ticket 21 final)

Re-applied as one change on top of 21's final version (its commit and reconciliation fixes were kept as integrated). Reconciled: the publication
lease names the configured remote URL and the Builder Host's push policy (`push-policy.ts`) allows only that exact push (repair activations have
none); `humanTips` is now exactly the tip set ticket 21's Control-side ancestry/content check requires at linking (`preservationTips(knownRemote)`,
waived tips excluded), so the merge strategy and that check agree; flow tests model ancestry with `remote.graph`; waits use
`test/runner/budget.ts` `untilHolds` (ticket 40), no iteration-count waits.

## Real run `q22-repair-v1` (2026-11-16, operator-authorized, run by the supervisor; consumed) — PASSED

Branch `run/q22-repair` = `172b027` + pin of issue **#31**; namespace `y5/q22-repair-v1`; real GitHub App, Gondolin/KVM VM and model. Human
steps by the supervisor from the operator account: PR #33 (base note, base `9cf5bb5` → `8f28ce8`) and PR #34 (conflicting
`docs/FACTORY_REPAIR.md`, base → `85822b6`), both squash-merged into main; ruleset 26435808 relaxed (no `update`, 0 approvals) only during the
run and restored afterwards (`pull_request:1`, `non_fast_forward`, `deletion`, `update`). `inspect` saved no verdict (recipe gap, fixed: inspect
now saves `verdictOf(...)`); the verdict below was computed OFFLINE from the saved results, no rerun, no GitHub read
(`test/entrypoints/repair22-verdict.test.ts` recomputes it from the copies and checks its sensitivity). Records (secret scan: 0 token/key
shapes; sessions `tokenPattern: false`): [preflight](22-real-repair-preflight-result-2026-11-16.json), [run](22-real-repair-run-result-2026-11-16.json),
[advance](22-real-repair-advance-result-2026-11-16.json), [conflict](22-real-repair-conflict-result-2026-11-16.json),
[inspect](22-real-repair-inspect-result-2026-11-16.json), human steps 1/2 requested/observed, [verdict](22-real-repair-verdict-2026-11-16.json).

| Expectation (plan) | Observed | Met |
| --- | --- | --- |
| run: own draft PR at H1 | PR #32 linked at H1 `afc13e9` (attempt expected absent), budget corrections 1/0 | yes |
| advance: base advance ⇒ nothing | base `8f28ce8` observed; checks of H1 `satisfied`, conflict `none`, note `LOOSE_BRANCH_BEHIND_BASE`; no correction, 0 activations, 0 grants, consumed 0 | yes |
| conflict: ONE correction `MERGE_CONFLICT main @H1 ^85822b6` | one correction (sequence 1), reasons exactly that, `mergeable:false` evidence; `repair-revalidated` once (fresh read) | yes |
| repair Execution | `REPAIR_REQUESTED`, `builder-continuation` (same session) with the repair section, `builder-start` grant only, handoff base `85822b6`, reviews r4 (standards+spec), charge `consumed` | yes |
| strategy (decision 3) | no non-own commit on the Factory branch (no divergence) ⇒ rebase expected: session ran `git fetch origin main`, checked FETCH_HEAD = `85822b6`, `git rebase 85822b6…`, resolved keeping the operator line; H2 `2644c67` has the single parent `85822b6` (compare `85822b6...2644c67` ahead 1 / behind 0). H1 is NOT an ancestor of H2 — by design (own commit rewritten; human commits would have required a merge) | yes |
| same PR, exact lease | publication activation `--force-with-lease=refs/heads/factory/31-36b542ff:afc13e9… <configured URL> 2644c67…:refs/heads/factory/31-36b542ff`; PR #32 head `2644c67`, mergeable `true`; `pushViolations: []` | yes |
| closes without CI, charged once | correction closed `published` (head `2644c67`) at the linking; corrections {limit 1, consumed 1, reserved null}; publication charge `preserved` | yes |
| no re-trigger | quiet window 06:27→06:33 (≥ 3 cycles): 0 activations after closure; checks of H2 `satisfied`, conflict `none` | yes |
| file at head | `docs/FACTORY_REPAIR.md` keeps the operator's lines and has `## Steps` | yes |

Gaps (accepted): `REQUIRED_CHECK_FAILED`, `STRICT_UPDATE_REQUIRED` and the merge strategy over human commits are proven at rule/flow level
only (the test repository has no required check; no human commit was on the Factory branch). Readiness was evaluated `ready` internally but
no draft/ready conversion was sent (recipe stub).

## Open questions

1. Strict: `STRICT_UPDATE_REQUIRED` triggers only with nothing waiting; every later base advance under strict is a new event on the new head
   and costs a correction (bounded by the budget). Confirm.
2. A human draft/ready over the Factory's flag suppresses repairs (operator decides); a merge-blocking rule does not suppress a conflict/check
   repair (it stays the operator's, never repaired). Confirm.
3. Resolved (supervisor decision 3): merge, never rebase, when the branch holds human commits.
4. Findings are treated inside each repair's own review rounds (ticket 13); `CHANGES_REQUESTED`/explicit commands are ticket 23.
5. A state change of an unchanged head (e.g. mergeability flipping) is seen by ticket 15's full re-read (≤ 10 intervals); the fresh read
   before admission always sees the current state.
