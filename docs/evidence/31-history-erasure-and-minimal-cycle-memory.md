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

## Decisions taken here (supervisor: 1, 2 accepted; 3 recorded as a gap; 4 known limitation, closed by operator decision D-07; 5 = ticket 29)

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

## Real-run recipe (LOCAL only)

`test/entrypoints/forget31-qualification.ts`, namespace `/home/sanmoo/software-factory-test/y5/q31-forget-v1` (consumed; v2 after the review). Import and `--plan` are inert
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

### Run `q31-forget-v1` (run by the supervisor 2026-11-15): verdict **MET**, 21/21

The sources were copies, both already format 2 (`current`), so no migration ran.

| Case | Work | Private Records copy |
| --- | --- | --- |
| Delivered: q17-delivery-v4, #3 | `99fe871b` | 284 files, 155103 bytes |
| Cancelled: q25-cancel-v1, #18 cycle 1 | `e8801f16` | 39 files, 24842 bytes |

The cancelled Work's successor is cycle 2, `1299ce8d` (open).

| Check | Expected | Observed |
| --- | --- | --- |
| delivered plan | accepted, planned, 284 files | same |
| delivered forgotten (run A / restart B) | work-forgotten ×2 | same |
| delivered Records copy deleted | present false, no tombstone, 0 files | same; Records `forget` called once |
| delivered memory | delivered, merge confirmed, PR kept, allowed keys only | same |
| delivered polling after forget | existing:`99fe871b` | same |
| delivered explicit `new` (run B) | accepted, cycle 2, predecessor `99fe871b` | cycle 2 `0578d93e` |
| delivered polling after restart | existing: the new current cycle | existing:`0578d93e` |
| cancelled before its environment cleanup | not-applied, RESOURCES_PENDING | same |
| cancelled environment cleanup (labelled recipe port: preserve + remove answered absent) | accepted | same |
| cancelled plan → forgotten (A / B) | planned; work-forgotten ×2 | same |
| cancelled Records copy deleted | present false, no tombstone | same |
| cancelled memory | cancelled, no merge, no PR, allowed keys only | same |
| cancelled successor | existing:`1299ce8d` (A and B), still open | same |
| list/status | both in `forgotten`, absent from works; `status.forgotten.works` 1 each; note "covers only the Works still remembered" | same |
| owner stops | clean ×4 | same |
| sources unchanged | sha256 `9b9765a9…` | same |
| remote/Sandbox/Workers/credential writes | 0 | 0 |

Tracker reads were answered by refusing doubles (counted): `listCandidates`, `readTicket`, `readDependencyGraph`.

Observations copied here and scanned for secrets (no token, key or credential value matched):
- [verdict](31-real-forget-v1-verdict-2026-11-15.json)
- [preflight](31-real-forget-v1-preflight-2026-11-15.json)
- run A: [delivered](31-real-forget-v1-forget-a-delivered-2026-11-15.json), [cancelled](31-real-forget-v1-forget-a-cancelled-2026-11-15.json)
- run B: [delivered](31-real-forget-v1-forget-b-delivered-2026-11-15.json), [cancelled](31-real-forget-v1-forget-b-cancelled-2026-11-15.json)
- [inspect](31-real-forget-v1-inspect-2026-11-15.json)

Level: real local installation data (P on the Records/SQLite/Control boundaries this ticket changes). GitHub stays local by design. There was
no VM or model. The cancelled environment cleanup is a labelled stand-in (supervisor decision 2).

## Independent review of 41ef0e1 (fixed with TDD; recipe namespace `q31-forget-v2`)

| Finding | Fix | Tests |
| --- | --- | --- |
| MED: refused/not-applied `answer`/`update-scope` texts were not linked, so they survived forget | Every answer, update-scope and authorize-readiness request is linked to its Work in the SAME commit, whatever its outcome (`work.contentRequests`, an optional field of `factory.work` v1: no new document kind, storage format unchanged). Forget erases all linked inputs plus the ones the Work/Questions reference. | `forget-flow` AC1 (three refused requests erased; mutation red) |
| MED: rewritten request docs might keep prior revisions | Checked against the REAL store: session documents are current-only, so Pi Durable deletes the earlier revisions of a document rewritten as a base (every Factory doc checkpoints) and of a retired one. The test reads `document_revisions` of the real SQLite file: none of the 7 seeded texts remains. Free pages/WAL: closed later by D-07 (storage scrub, below). | `forget-flow` AC1 (`storedRevisions`) |
| MED: a cancelled cycle's PR closed without merge can be reopened and merged later, and nothing would observe it | The memory keeps the PR identity in `watch`. The delivery desk keeps reading it (bounded, least recently read first, also after closed-unmerged). A confirmed merge turns the memory into a delivery (result, merge fact, PR, Ticket cycle memory), and the own blocker becomes satisfied. | `forget-flow` AC2 (watched, then merged → delivered + dependency satisfied; no read after delivery; mutation red) |
| MED: re-confirming a dropped/failed/indeterminate plan answered `already-satisfied` | It now answers `not-applied` with `PLAN_DROPPED:…`, `PLAN_FAILED:…` or `PLAN_INDETERMINATE:…`. | `forget-flow` revalidation test |
| MED (recipe): the environment stand-in checked a path that never exists | It checks the REAL path the product would remove (`<y5>/environments/<env>`). If that exists it refuses and never answers absent; the cancelled forget then stays refused and nothing is deleted. Preflight records the presence; the verdict expects the matching branch. | `forget31-recipe-storage` (guard + both verdict branches) |
| LOW: sources hash, nested memory keys | `sources-unchanged` also hashes the real `<y5>/<work>/` Records trees. `memoryViolations` checks every nested key against `memoryShape`, and Question entries must be ids. | `forget31-qualification`, `forget31-recipe-storage` |
| LOW: `new` after a forgotten cycle fabricated its basis | The new cycle's label comes from the FRESH Ticket read (refused if the read shows none). The current cycle is found the way the commit finds it (index current, forgotten or not). The forgotten-cancelled path is tested. | `forget-flow` AC2 (label id 77 from the read) |
| LOW: an unsafe entry appearing after the rename was reported `refused` | Once anything has changed, the result is `failed RECORDS_FORGET_PARTIAL[_UNSAFE]` with counts; the tombstone is shown by the next inspection. | `records/forget` mid-removal test |
| LOW: the readiness request id was parsed from history detail | The `detail.split` is gone: ids come from `work.contentRequests` and the structured fields only. | `forget-flow` AC1 |
| LOW: `question <id>` of a forgotten Work | The memory keeps Question ids only; the query answers `question-forgotten`. | `forget-flow` AC4 (public Control) |
| LOW: unsettled ticket-30 removals; a confirmed plan stuck without the Records port | Removals `intended`/`indeterminate` refuse with `DETAIL_REMOVAL_UNSETTLED` (next step: sweep or `factory cleanup`). Only a `removing` plan blocks (`FORGET_IN_PROGRESS`); a confirmed plan not started is superseded by a newer eligible plan, and its next step says so. | `forget-rules`, `forget-flow` revalidation test |

### Run `q31-forget-v2` (run by the supervisor 2026-11-15, after the review): verdict **MET**, 20/20

The sources are the same as v1 (copies; format 2, no migration). At preflight the real q25 environment `y5/environments/env-41d60b6e…` EXISTED,
so the cancelled case took the refused branch, as designed.

| Check | Expected | Observed |
| --- | --- | --- |
| delivered plan | accepted, planned, 284 files | same |
| delivered forgotten (A / restart B) | work-forgotten ×2 | same |
| delivered Records copy deleted, Records `forget` called once | absent, no tombstone | same |
| delivered memory | delivered, merge confirmed, PR kept, no disallowed key at any depth | same (`[]`) |
| delivered polling after forget / explicit `new` / polling after restart | existing:`99fe871b`; cycle 2 with predecessor `99fe871b`; existing: the new cycle | existing:`99fe871b`; cycle 2 `8242ef7d`; existing:`8242ef7d` |
| cancelled before its environment cleanup | not-applied, RESOURCES_PENDING | same |
| cancelled stand-in (real environment present) | cleanup accepted, port refused-present | same |
| cancelled after it | still not-applied, RESOURCES_PENDING; shown `work` ×2; Records copy kept (39 files) | same |
| cancelled successor | existing:`1299ce8d` (A and B), open | same |
| list/status | delivered forgotten (1), cancelled not (0); note | same |
| owner stops | clean ×4 | same |
| source storages AND real Records sources unchanged | same digests | same |
| remote/Sandbox/Workers/credential writes | 0 | 0 |

Observations copied here and scanned for secrets (no token, key or credential value matched):
- [verdict](31-real-forget-v2-verdict-2026-11-15.json)
- [preflight](31-real-forget-v2-preflight-2026-11-15.json)
- run A: [delivered](31-real-forget-v2-forget-a-delivered-2026-11-15.json), [cancelled](31-real-forget-v2-forget-a-cancelled-2026-11-15.json)
- run B: [delivered](31-real-forget-v2-forget-b-delivered-2026-11-15.json), [cancelled](31-real-forget-v2-forget-b-cancelled-2026-11-15.json)
- [inspect](31-real-forget-v2-inspect-2026-11-15.json)

The v1 cancelled forget relied on the earlier, vacuous stand-in guard. It is superseded by v2 and is not evidence of a cancelled forget on
real data.

## Storage scrub after forget (operator decision D-07, 2026-11-16)

Branch `implement/software-factory-mvp-d07`, on integration `01a2dcb`. Decision: after `forget`, deleted controller records must not stay
recoverable in SQLite free pages or the WAL.

**Which store.** The controller authority is one SQLite file, `<installation>/data/control.sqlite`, and its `-wal`. The Factory owns it, and it
is the Pi Durable `SqliteStorage` (a session store whose documents are the Factory's records). The "Pi Durable session store" is therefore the
same file and is covered by the same scrub. Worker sessions are not in SQLite: they are Pi coding-agent JSONL files (`release-build`:
`workerSessions`), and their copies live in the Work's Records area, which `forget` deletes whole. No other SQLite file holds Work data.

**Design.** After the forget's result commit, the retention desk (in the owner loop) runs `VACUUM`, then `PRAGMA wal_checkpoint(TRUNCATE)`. It
then records the result in the minimal memory and truncates the WAL again (`src/control/durable/retention-desk.ts` `scrubForgotten`,
`src/control/durable/store.ts` `vacuum`/`checkpoint`, `src/control/durable/forget.ts` `recordScrub`).
- **Why VACUUM and not only `PRAGMA secure_delete`.** `secure_delete` zeroes content only when it is deleted while the pragma is on. A Work's
  records are rewritten many times during its life. Each rewrite frees the old revision's cells, so an installation that ran without
  `secure_delete` already holds those old revisions in free pages. Turning `secure_delete` on also leaves the old page images in the WAL until
  the WAL is reset. `VACUUM` rebuilds the file from the live rows only, whatever happened before, and the checkpoint with `TRUNCATE` copies
  every WAL frame back and cuts the WAL to zero bytes. The step checks that the checkpoint was complete (`busy = 0`, every frame checkpointed)
  and that the `-wal` file has 0 bytes. Otherwise the attempt fails with `SCRUB_CHECKPOINT_INCOMPLETE` or `SCRUB_WAL_NOT_TRUNCATED`. VACUUM
  keeps every `INTEGER PRIMARY KEY` rowid. `document_revisions` has a composite key. Pi Durable does not depend on implicit rowids.
- **Lock and concurrency.** The scrub runs only inside the owner process, which holds the canonical-storage `flock` (`data/control.lock`) for
  its whole life, so no other process has the file open. It uses the owner's single connection, the same one Pi Durable uses, through chord's
  serial operation queue. Each `transaction` (`BEGIN IMMEDIATE … COMMIT`) holds that queue until it settles, so `VACUUM` starts only when no
  transaction is open, and every Control command or desk commit waits behind it. Nothing runs beside it. The cost is that commands wait for the
  duration of one VACUUM, once per forget.
- **Crash safety and re-attempt.** The forget's result commit itself sets `memory.scrub = { state: 'pending', attempts: 0 }`, so the forget
  never depends on the scrub. `VACUUM` is a transaction: a crash during it leaves the previous valid database (SQLite rolls it back from the
  WAL), with the scrub still `pending`. The first desk cycle of every owner run attempts any pending scrub, and so does a new forget. A failed
  attempt (for example `SQLITE_FULL`) is recorded (`attempts`, `lastAttemptAt`, `code`) and attempted again once per sweep period. A crash
  between the VACUUM and its result commit only causes one more, idempotent, attempt. A memory forgotten before D-07 has no `scrub` and counts
  as pending, so existing installations are scrubbed once on their first owner run.
- **Reporting.** `show <work>` (`work-forgotten`) carries `memory.scrub`. Its `nextStep` says "Controller storage scrubbed at …" or "scrub
  PENDING (last attempt …: CODE)", and in the pending case it says that the records may remain in free pages/WAL until the scrub completes.
  `status.forgotten.scrubPending` counts the pending ones, and failures also appear in the retention desk's `failures` (`storage-scrub`). The
  plan's warning describes the scrub instead of the old limitation. A desk composed without the storage port (no production composition
  does this) leaves the scrub `pending`, which is visible and never reported as scrubbed.

**Proof (TDD, level I: local, real SQLite file).** `test/control/forget-scrub.test.ts`:
1. A unique marker `D07-MARKER-<uuid>` is written three times in the Work's Question record, so earlier revisions sit in freed pages, and it is
   asserted present in the raw bytes of `control.sqlite` + `control.sqlite-wal`. Then plan → confirm → desk cycle runs. The raw bytes of both
   files no longer contain the marker, and `memory.scrub.state` is `scrubbed`. **Red first:** before the change the same test failed on
   `the forgotten marker is still recoverable from the SQLite file or its WAL` (`actual: true`).
2. A failing storage port (`SQLITE_FULL`) leaves the Work forgotten and the scrub `pending` (`attempts 1`, code kept). A desk without the port
   leaves it `pending`. The store is then closed and reopened (the durable state a crash mid-VACUUM leaves), and the first cycle of the new
   desk scrubs it (`attempts 2`, marker absent from the raw bytes).

`forget-flow` AC1 now composes the real storage port and checks `scrub: scrubbed, attempts 1`. `forget-rules` AC6 checks the warning and the
three `nextStep` variants. The ticket 31 recipe's `memoryShape` allows the content-free `scrub` keys.

Not proven: a real SIGKILL during a VACUUM (SQLite's own atomicity covers it; the Factory's part, the durable `pending` state, is proven by
the reopen), and file-system level remanence (sectors freed by the truncation, SSD wear levelling, backups). Those are outside a SQLite scrub,
as are external copies already named in the warning.

## Gaps

- **Cancelled forget on real data:** q25's environment still exists, so v2 proves only the refused branch on real data (refused before and after the
  environment stand-in, nothing deleted). The forget of a cancelled cycle after its environment's REAL removal is proven at flow level
  (`forget-flow` AC2: REAL Sandbox removal of a synthetic environment, then forget, watch and later merge).

- **Recorded gap (supervisor decision 3):** the forgotten Ticket's evaluation as a native blocker is proven only at flow level (`forget-flow`,
  REAL dependency evaluation and own-cycle lookup over real storage). It is not in the real-data recipe, because nothing in the copies
  depends on it.
- **Closed by operator decision D-07 (2026-11-16):** supervisor decision 4 (deleted controller records may remain in SQLite free
  pages/WAL) is no longer a limitation. The controller storage is now scrubbed after every forget. See
  [Storage scrub after forget (D-07)](#storage-scrub-after-forget-operator-decision-d-07-2026-11-16).
- Usage aggregates are ticket 29's (supervisor decision 5); `status.forgotten.note` already says totals cover only remembered Works.

- A request receipt with operator text is found only through the Work's own references, listed in decision 5.
- Ticket 30's per-owner `status.retention` counters cover remembered Works only. The `forgotten` note says so.
