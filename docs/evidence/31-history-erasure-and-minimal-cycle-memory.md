# Ticket 31 — History erasure (`forget`) keeping the minimal cycle memory

Branch `implement/software-factory-mvp-31`, on integration `7cf1adc` (tickets 08, 17, 25 and 30 integrated). Authority: spec §4.1, §4.2, §12.1,
§12.4; scenarios V-04, V-05 and V-14 (the memory part).

Level of this delivery:
- **S**: pure rules (eligibility, losses, minimal memory, own-dependency classification from the memory alone);
- **I**: storage-real flows (Pi Durable + SQLite). They use the REAL Records area (captures written by Records, whole-tree inspection and
  deletion), the REAL Sandbox removal on a synthetic environment (systemctl double), and the REAL admission, own-cycle memory, native
  dependency evaluation and `new` over the same storage, including a storage reopened after the forget;
- the REAL CLI → socket → owner path for the two new commands, and the public `openControl` (accept/inspect, polling, desks) in the recipe core.

Doubles: GitHub (tracker/CodeRepository, calls counted) and the calendar. No real GitHub, VM, model or credential was used.
`$HOME/software-factory-test` was not touched.

## What was built

| Layer | Module | What it does |
| --- | --- | --- |
| Records | `src/records/forget.ts` | `inspectWorkRecords`: walks the Work's WHOLE `<root>/<work>/` without following anything; any entry that is not a directory or regular file of this uid (symlink, device, socket, foreign owner) makes it `incomplete`. `forgetWorkRecords`: refuses an unsafe tree before touching anything; renames the area atomically to `<root>/.forget-<work>`, then removes it. A tombstone left by an interrupted deletion is shown by the inspection and removed by the next confirmed forget. |
| Control rules | `src/control/rules/forget.ts` | `forgetRefusals`: an ended Work only (delivered with its confirmed merge, or cancelled with confirmed cessation); `CANCEL_REQUIRED` for an own PR closed without merge; `PULL_REQUEST_NOT_CLOSED` for a cancelled cycle whose own PR is not observed closed (a later merge would still deliver it); every ticket 30 protection; pending recovery; any own resource not removed/absent; confirmed cleanup plan still executing; Records not composed or unsafe. `forgetLosses` (losses, what stays, what is never erased), `minimalMemoryOf`, `forgetBasis`. |
| Control durable | `src/control/durable/forget.ts` | `forget-plan` / `forget-confirm`, deduplicated by request id like ticket 30. The confirmation is revalidated: a changed basis is `PLAN_OBSOLETE`, so a plan never deletes more than it showed. The intent (`removing`) is recorded BEFORE the Records effect and revalidated again in that commit. The result commit keeps the memory only on `removed`/`absent`. In ONE commit it then: refreshes the Ticket memory, adds `ticket-index.forgotten[work]`, takes the Work out of `order` (but never out of `tickets`), retires the Work and Question records (Pi Durable deletes the revisions of a retired session document), and erases the text of the Work's answer/update-scope/authorize-readiness request inputs (the receipts stay). A lost intent becomes `indeterminate`; failures are `failed`; nothing is retried. |
| Desk | `retention-desk.ts` | Confirmed forgets run FIRST in the existing retention desk (same owner loop, no daemon), before the explicit cleanup plans and the sweeps. |
| Cycles | `cycles.ts` | `new` on a Ticket whose current cycle was forgotten works from the minimal memory (fresh Ticket read, predecessor link, cycle + 1). |
| Control/CLI | `control.ts`, `serve.ts`, `cli.ts`, composition | `factory forget <work> [--yes]` and `factory forget-confirm <work> <plan>` (`--yes` confirms under `<id>-confirm` with the same checks). `show <forgotten>` returns `work-forgotten`: the memory, what is not recoverable, and a `nextStep` saying this is neither expired nor missing. `list.forgotten`; `status.forgotten` with the note that totals cover only remembered Works. `detailPorts` gains `inspectTree`/`forget`. |

**What is forgotten:**
- the Work's whole Records area: logs, start receipts, review opinions and forwards, mutation intents/results, Question records, Host evidence,
  session copies and preserved evidence;
- the Work record: history, Executions, reviews, gates, decisions, scope updates, budget, delivery/cleanup/retention records;
- its Question records (texts, answers);
- the operator text in its request inputs.

**What stays (the minimal memory, `ForgottenWork` + `memory.cycles`):**
- Ticket identity (repository, repositoryId, issueId, number, url), repository/base, Work id, cycle, predecessor, admission sequence;
- the result;
- for a delivery, the PR identity (number, id, node id, url), `mergeConfirmed` and its instant;
- the admission label (a configuration fact) and the forget origin (request and plan ids).

The index entry `tickets[key]` is kept, so admission answers `existing`.

**Never touched:** GitHub (issue, comments, PR, branch), other Works, protected resources, backups/external copies. Each plan says so in its
warning, and `limitations` says so too.

## AC → tests

| AC | Tests | Level |
| --- | --- | --- |
| 1. Separate local operation, select/plan/confirm, revalidation; ended Work with nothing pending | `forget-rules` AC1/AC2. `forget-flow` AC1 (plan deletes nothing; same-id replay; confirmation deletes nothing; desk executes). `forget-flow` revalidation test (activity after plan → `BECAME_INELIGIBLE:PROTECTED`; superseded; tree changed after confirmation → `PLAN_OBSOLETE` before any effect; crash after intent → `indeterminate`, never retried; failure keeps the Work, not retried; a new plan completes). `cleanup-cli` (real CLI/socket/owner). | S + I |
| 2. Closed-unmerged needs cancel first; open/active/pending refused without changing data | `forget-rules` AC1. `forget-flow` AC2: open → `WORK_NOT_ENDED` (result unchanged); closed-unmerged → `CANCEL_REQUIRED` (never cancels); cancelled with an own PR not observed closed → `PULL_REQUEST_NOT_CLOSED`; open Question → `PROTECTED`; environment left → `RESOURCES_PENDING` with the `factory cleanup` next step; refusals touch nothing. | S + I |
| 3. Memory keeps Ticket/repo/Work, cycle order/link, result, PR + confirmed merge; no request content, logs or opinions | `forget-rules` AC3. `forget-flow` AC1 (exact memory; the index JSON contains none of the seeded question/answer/scope/opinion/tool-output texts; Records area and Question docs gone; request inputs erased, receipts kept). Recipe `memoryKeys` whitelist. | S + I |
| 4. Label/polling/restart create no other Work; a new cycle needs explicit `new` and becomes the evaluated one | `forget-flow` AC1 (`admitTicket` → `existing`; `new` → cycle 2 with the forgotten predecessor; then `existing` = cycle 2). `forget-flow` AC4 (storage reopened: `existing`, own memory). Recipe core: polling over the public Control answers `existing` after the forget and after a restart. | I |
| 5. Own delivered blocker stays satisfied; cancelled does not; new cycle does not inherit the old merge; never external | `forget-rules` AC5 (memory only). `forget-flow` AC1/AC2 with the REAL `evaluateWorkDependencies` + `ownCycles`: delivered forgotten → `satisfied`, own (`minimal-memory`); after `new` → `pending OWN_CYCLE_NOT_DELIVERED`; cancelled forgotten with issue closed/completed → `pending OWN_CYCLE_CANCELLED`, own. | S + I |
| 6. CLI tells deleted history from absent/expired evidence and the remaining summary; aggregates are not the whole life | `forget-rules` AC6 (losses/keeps/warnings; forgotten `nextStep` "not an expired or missing record"). Recipe core: `show` → `work-forgotten`, `list.forgotten`, `status.forgotten.note`. Ticket 30's `retention.nextStep` already names expired/removed details. | S + I |
| 7. Storage-real tests with the dependency/admission flow show anti re-trigger and correct classification; no promise about GitHub, copies or backups | All `forget-flow` tests (storage-real). The plan warning: "Not erased: GitHub…, backups, exports, earlier copies…; an external copy can bring deleted data back". | I |

**Red → green.** I wrote the code before most of these tests, so red was shown by mutation. For each mutation below I recompiled and ran
`forget-flow` + `forget-rules`, then restored the sources:
- M1: forget removes the Ticket index entry → 3 tests red (re-admission, `new`, restart).
- M2: no revalidation in the intent → 1 test red (`PLAN_OBSOLETE` before any effect).
- M3: a lost intent is re-executed instead of settled `indeterminate` → 1 test red.
- M4: pending resources not checked → 2 tests red.

## Decisions taken here (for the supervisor)

1. **A cancelled cycle whose own PR is not observed closed is refused (`PULL_REQUEST_NOT_CLOSED`).** Spec §12.3 says a confirmed merge still
   delivers a cancelled cycle. Without its record, a later human merge would never be seen, and the memory would keep saying "cancelled".
   Closing the PR on GitHub (which the Factory observes) makes it eligible. It also means `new` after a forget never needs
   `--keep-predecessor-pr`.
2. **Every own resource must be concluded first,** including a delivered Work's `kept` remote branch. Forget never removes a resource; the
   refusal names the `factory cleanup` selection.
3. **The Records area is deleted whole and fail-closed.** Unlike ticket 30's per-detail removal, the class of a capture does not matter here.
   An unsafe entry refuses everything. Order: Records first, authority second. A crash in between leaves the Work with an `indeterminate`
   plan and a tombstone, which a new explicit plan removes.
4. **A confirmation is dropped when the basis changed** (tree size, result, Executions, Questions, cleanup). This holds at confirmation and
   again in the intent. The deletion therefore never exceeds the losses shown.
5. **Request receipts keep their outcome and lose their text.** Replaying such a request id is then refused with `REQUEST_ID_CONFLICT`, never
   re-applied. Receipts without operator text (cancel, cleanup, forget) are unchanged. Ids are found from the Work and its Questions
   (answers, ignored answers, scope updates, readiness authorizations).
6. **Usage aggregates (ticket 29) do not exist yet.** `status.forgotten` and its note state the rule for every current total.

## Real-run recipe (LOCAL only; prepared, NOT run)

`test/entrypoints/forget31-qualification.ts`, namespace `/home/sanmoo/software-factory-test/y5/q31-forget-v1`. Import and `--plan` are inert
(`forget31-qualification.test.ts`). Phases are one-shot with exclusive intent tombstones and no retry:

1. **`preflight`.** COPIES `q17-delivery-v4/authority` (delivered #3) and `q25-cancel-v1` (cancelled #18 cycle 1, open cycle 2). A format-1
   copy is migrated. Each Work's Records are copied privately (symlinks refused). The phase inspects each tree and records both source
   digests.
2. **`forget`.** Owner runs on the copies, through `Control.accept`/`inspect`:
   - run A, delivered: plan → confirm → forgotten.
   - run A, cancelled: plan first, expected refused `RESOURCES_PENDING`. Then the explicit environment cleanup, answered by a **labelled
     recipe port**: the copy has no environment, the port refuses if one exists, and the real VM environment under q25 is never touched.
     Then plan → confirm → forgotten.
   - each run A then waits two polling rounds listing the same Ticket, which must answer `existing`.
   - run B (restart): listed again → `existing`. For delivered, an explicit `new` (Ticket read answered locally) creates cycle 2 with the
     forgotten predecessor.
3. **`inspect`.** Writes `verdict.json`. It has 21 checks, and a no-op fails it. Nothing is sent to GitHub; tracker/repository writes, Sandbox,
   Workers and credentials are counted and must be 0.

`forget31-recipe-storage.test.ts` (slow tier) runs the same core on temporary fixtures: four real owner runs and a verdict of `met`; a no-op
gives `not-met`.

Not covered by the recipe: own-dependency evaluation of the forgotten Ticket as a blocker. No pending Work in the copies is blocked by it, and
the public Control has no other entry. It is proven at I level in `forget-flow`.

## Gaps

- SQLite free pages/WAL may still hold deleted bytes until reused or checkpointed. The spec does not promise sanitation, and the plan warning
  says so.
- A request receipt with operator text is found only through the Work's own references, listed in decision 5.
- Ticket 30's per-owner `status.retention` counters cover remembered Works only. The `forgotten` note says so.
