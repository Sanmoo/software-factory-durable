# Ticket 30 — Retention and explicit cleanup without losing needed context

Branch `implement/software-factory-mvp-30`, based on ticket 25's branch (`4a3f2fb`, on integration `8a91799`). Ticket 25 is not integrated
yet; this branch is rebased once the supervisor asks. Authority: spec §12.1, §12.3, §12.4; scenarios V-14 and V-15 (retention parts).

Level of this delivery:
- **S**: pure rules with controlled instants;
- **I**: storage-real flows (Pi Durable + SQLite). They use the REAL Records area (captures written by Records, inventory, session copies,
  confined removal), the REAL Sandbox removal and evidence export on synthetic environments (systemctl double), and the REAL Records copy of sessions;
- the REAL CLI → socket → owner path for the two new commands; the confined host session read is tested through the production composition.

Doubles: GitHub (CodeRepository) and the calendar. No real GitHub, VM, model or credential was used. `$HOME/software-factory-test` was not
touched.

## What was built

| Layer | Module | What it does |
| --- | --- | --- |
| Records (Q8) | `src/records/retention.ts` | `listDetails`: the Work's logs are the Records captures in `<root>/<work>/evidence/<uuid>/`, each with its Execution and complete/partial state. Its sessions are the preserved copies `<root>/<work>/sessions/<execution>.jsonl`. Ticket 17's preserved-evidence directories (`manifest.json`) are counted apart and are never targets. Any unexpected entry makes the inventory `incomplete`, and an incomplete inventory never proves absence. `preserveSessionCopy`: an exclusive, synced, hash-checked copy that never overwrites. `removeRecordsDetail`: removes one own capture (only its own files, completion marker first) or one session copy whose content still has the recorded hash. It refuses evidence, symlinks or extra entries, changed sessions and bad ids. A missing item counts as `absent` only under an intact Work directory. |
| Control rules | `src/control/rules/retention.ts` | `retentionDeadline` = confirmed merge + `days`, anchored to the merge. Undelivered Works get no deadline. `retentionProtections`: activity, Slot, unconfirmed cessation, open Question or unsettled Question publication, readiness/reopen/publication effect, cancellation still stopping, pending or blocked recovery of a cycle that can continue, pending resource cleanup, detail removal of unknown result. `classifyDetails` sorts each detail into retained / protected / in-use / eligible. `planExplicitCleanup` returns losses, warnings and refusals. `revalidateItem` and `planBasis` check a plan again when it runs. |
| Control durable | `src/control/durable/retention.ts`, `retention-desk.ts` | One commit per sweep and per decision: intent BEFORE each removal, result after it. A lost intent becomes `indeterminate`. An indeterminate item missing from a COMPLETE inventory becomes `absent`. Session preservation is recorded. `cleanup-plan` and `cleanup-confirm` are deduplicated by request id, like ticket 25's commands. The desk runs inside the existing owner loop, with no new daemon. It sweeps at the first cycle after the boot reconciliation settled the installation, then every `sweepSeconds` (daily). It also runs confirmed plans item by item after a fresh revalidation. |
| Ticket 17 reuse | `rules/delivery.ts`, `durable/delivery.ts`, `delivery-desk.ts` | (1) **Before** an own environment is removed, the recorded Builder sessions of its Executions are copied into Records. A failed copy blocks that environment; a `lost` one is recorded. (2) The same resource cleanup runs an explicit plan (`cleanup.explicit`): the environment of a cancelled Work (disposition `cancelled`, never its branch), or ONE fresh revalidated attempt of a delivered Work's refused/kept/failed resources. Each plan is swept exactly once (`consumed`). A resource attempted after the confirmation is not attempted again (crash → indeterminate, no implicit retry). |
| Control/CLI | `control.ts`, `serve.ts`, `cli.ts` | `factory cleanup <work> --select logs,sessions,environment,remote-branch [--yes]` records the plan and removes nothing. `factory cleanup-confirm <work> <plan>` confirms it. `--yes` sends the plan, then the confirmation under its own id `<id>-confirm`; the controller checks it exactly as a manual confirm. `show` carries `retention` with state, deadline, protections, inventory, preserved sessions, removals, totals, plans and `nextStep`. `status.retention` carries the counts, which keeps the growth of undelivered Works visible. |
| Composition | `entrypoints/controller/composition.ts` | `detailPorts(root)` (Records plus the host's confined session read). `retentionDays` comes from the configuration (default 30, the field already existed); `sweepSeconds: 86400`. |

**Never touched by this design:**
- base/default branches;
- the shared bare cache;
- other Works' or unknown resources;
- Docker;
- preserved evidence, summary, history, references, reviews and decisions (that is `forget`, ticket 31, not implemented);
- the branch or GitHub of a cancelled Work.

## AC → tests

| AC | Tests | Level |
| --- | --- | --- |
| 1. Sweep at boot (after reconciliation) and daily; delivered logs/sessions eligible 30 days after the confirmed merge, configurable; no extra daemon | `retention-rules` AC1 (deadline, 7 days configurable, no deadline without confirmed merge). `retention-flow` AC1: nothing before `settled`, boot sweep, not again before a day, a new owner process sweeps at boot, removal at day 40. `delivery-composition` ticket 30 (`retentionDays: 9` → port, `sweepSeconds` 86400). | S + I |
| 2. Undelivered (blocked/cancelled/closed unmerged) keep everything until explicit cleanup; age never authorizes deleting | `retention-rules` AC2 (open/cancelled/closed-unmerged at 4000 days → retained). `retention-flow` AC2 (cancelled at 400 days: no preservation or removal at all). | S + I |
| 3. Needed evidence and resources in use are protected past the deadline; the end of the protection makes them eligible at the next sweep with no new 30 days | `retention-rules` AC3 (8 protection kinds; a recovery impediment protects only a cycle that can continue; partial capture in use). `retention-flow` AC1 (activity at day 31 → `protected`; ends → removed at day 40, `dueAt` unchanged). | S + I |
| 4. Summary/history/references/reviews/decisions stay; preserving evidence precedes removing its source | `retention-flow` AC1: call order `preserve` → `preserve-session` → `remove`; the runtime is gone, the session copy survives; evidence, history and delivery are kept after expiry. `retention-details`: evidence is never a target. | S + I |
| 5. Explicit cleanup selects resources/logs/sessions, shows the plan of losses and needs confirmation, automation included, with the same checks | `retention-rules` AC5/AC7. `retention-flow` AC5/AC6/AC7 (plan removes nothing; losses/warnings; same-id replay; sessions; ticket 17 hand-off). `update-scope-cli` (real CLI/socket/owner: invalid args, identified request, `--yes` confirms nothing without an accepted plan, `cleanup-confirm`). | S + I |
| 6. Plan revalidated at execution (ownership, cessation, state, use, recovery); an old plan never removes what became active/protected | `retention-rules` AC6. `retention-flow`: superseded plan → `PLAN_SUPERSEDED`; activity started after the plan → every item `dropped BECAME_PROTECTED:ACTIVITY_RUNNING`, nothing removed. Execution-time revalidation per item (`settlePlanItems`). Ownership: the Sandbox re-proves the owner record. Records ids are confined to the Work directory, and a session is removed only at its recorded hash. | S + I |
| 7. Destroying environment/context of an open Work requires `cancel` first; warning when losing a session/log prevents resumption; never presume recreation or cancel implicitly | `retention-rules` AC5/AC7 (open and closed-unmerged → `CANCEL_REQUIRED` for every selection; `SESSION_NOT_RECORDED`; warning "`resume` does not recreate a session…"). `retention-flow` (open Work: refused, result unchanged; `SESSION_IN_ENVIRONMENT` until the environment cleanup preserved it; the result stays `cancelled`). | S + I |
| 8. Controlled clock and real storage/trigger/removal cover deadline, protection, partial failure and an obsolete selection; CLI explains removed/expired files instead of an empty list | `retention-flow` AC8: one failed log, one removed log, one session indeterminate; nothing retried by the next sweep; a crash after the intent → `RESULT_NOT_RECORDED`; absence in a complete inventory → `absent` without effect. `retention-rules` AC4/AC8 (`nextStep` names the removed counts; removals listed). `retention-details` (real files). | S + I |

**Red → green.** The code came before most of its tests in this ticket. I demonstrated red by mutation instead: each guard below was
disabled, the build recompiled and the new tests run; each mutation turned them red, and the sources were then restored.
- No session preservation before environment removal → 3 flow tests red.
- Protections ignored after the deadline → flow AC1 and rules AC3 red.
- No revalidation at confirmation → flow AC5–7 red.
- No cancel-first requirement → flow AC5–7 and rules AC5/AC7 red.
- Failed/indeterminate retried by the next sweep → flow AC8 red.

## Decisions taken here (accepted by the supervisor: 1, 2, 3; 5 = local recipe; 6 = reviewer sessions)

1. **"Open" for cleanup = result `open` or `closed-unmerged`.** Both cycles can still continue (`reopen` + `resume`). Every selection is
   refused with `CANCEL_REQUIRED`, consistent with spec §12.4 for `forget`. Explicit cleanup therefore applies only to `cancelled` and
   `delivered` Works.
2. **Sessions now live in Records.** Ticket 17's resource cleanup used to delete the boot runtime trees, and the recorded Builder sessions
   with them, at delivery time. That was earlier than the spec §12.3 table allows (logs/sessions of a delivered Work are retained 30 days).
   They are now copied into `<root>/<work>/sessions/` first, which matches spec §12.1. Deliveries cleaned before this change have no copy:
   nothing is listed for them, and no copy is invented.
3. **Logs are all Records captures of the Work.** They include tool outputs and event records (Question requests, start receipts, opinions),
   because the Records layout does not separate them. The protections keep whatever a pending item still needs; the authoritative content
   (Questions, reviews, decisions) lives in the controller documents and in the preserved evidence.
4. **No implicit retry, including by retention.** A `failed`/`refused`/`indeterminate` detail removal is not attempted again by the daily
   sweep; only an explicit plan does that. A read-only complete inventory may conclude `absent`. Ticket 17's own retries of `failed`
   resources are unchanged.
5. **Explicit cleanup of a delivered Work's refused/kept resources is that resource's ticket 17 path, under one fresh grant and with full
   revalidation.** A `kept` branch (atomic delete unavailable) stays kept and is never forced.

## Ticket 27 open item (unreadable Records request → `RECOVERY_BLOCKED` with no unblock command)

Retention and cleanup do **not** cover it, and they must not. While the cycle can continue, `IMPEDIMENT:RECOVERY_BLOCKED` is a protection:
the request capture and every detail stay. Explicit cleanup of such a Work is refused until `cancel`. After `cancel` the details can be
cleaned explicitly; that is an abandonment, not an unblock. Unblocking (an explicit operator decision to take the recovery without the
unreadable request) belongs to recovery, tickets 26/27. **Supervisor (decision 4): accepted. It is an open item owned by 26/27, tracked by
the supervisor.** Ticket 26's decision 3 already routes it to `resume`, which does not lift it today.

## Independent review of 115df70 (fixed with TDD; supervisor reverses decision 2)

| Finding | Fix | Tests |
| --- | --- | --- |
| Decision 2 reversed: only operational details expire | Records classifies each capture (fail-closed). A raw capture with a tool-call UUID is a **log**. A Records event envelope (start receipt, review opinion and its forward, mutation intent/result, Question request…) is `record:<kind>`. A `probe-*`/`handoff-*` output is `host-evidence`. Anything else is `unknown-kind`. Ticket 17's preserved evidence is never a target. Every class except log is **kept** until `forget` (ticket 31), counted in `inventory.kept` and re-checked at removal (`NOT_A_LOG_CAPTURE`). On the real q17 Records: 39 logs, 49 kept (25 host-evidence, 4 worker-start, 2 opinions, 2 forwards, 16 mutation records), 1 evidence directory, inventory complete. | `retention-details` (real-data shape), `retention-flow` AC1 (kept records remain), recipe storage test |
| MED: the 500-entry `removals` window allowed an implicit retry | `retention.unsettledIds` keeps every failed/refused/indeterminate id beyond the window. Only an explicit plan or a proven absence clears it. | `retention-flow` "never retried … left the window" (mutation red) |
| MED: an explicit resource plan executed later was not revalidated for protections | The resource cleanup checks `retentionProtections` (open Question, unsettled effect, activity…) before acting on an explicit plan. If the Work is still needed, the plan is dropped (`BECAME_PROTECTED:…`) and consumed: nothing is removed. Resource states are no longer rewritten to `pending` at confirmation; `explicitPending` selects the plan's resources. | `retention-flow` "revalidated at execution" (mutation red) |
| MED: an incomplete inventory still planned items | It now plans nothing for logs/sessions, so the losses are exactly what may be removed. | `retention-rules` AC5/AC7 |
| MED: a crash between `link` and `unlink` blocked a session copy | Records accepts the copy's own leftover temporary (nlink 2 on the same inode). The next preservation repairs it idempotently (hash verified, temporary unlinked). A temporary left before `link` is discarded. Removal takes the temporary with it. | `retention-details` crash-repair test |
| MED (recipe): protected/0 counted as a pass | Run B must end `expired` and remove logs AND sessions; protected counts as not met. A labelled synthetic session copy, named after a real Execution, exercises session removal. Namespace `q30-retention-v3`. | recipe storage test (protected run → not-met) |
| LOW: an unreadable or empty reviewer session blocked the environment | It is copied as opaque bytes with its hash (`readConfinedFile`). Only an unsafe file (symlink, foreign, writable) is reported with its code; it keeps the environment, and `nextStep` says what to do. | `delivery-composition`, `retention-flow` unsafe-session test |
| LOW: a refused/kept resource blocked the details for ever | `CLEANUP_PENDING` now holds only while the cleanup is waiting, a resource is retried automatically, or an explicit plan is unconsumed. The cleanup `nextStep` names `factory cleanup … --select environment|remote-branch`. | `retention-flow` hand-off test (logs expire with a kept branch; mutation red) |
| LOW: `[logs, environment]` dropped the logs | Explicit detail and resource items no longer wait for the resource cleanup (`CLEANUP_PENDING`/`DETAIL_REMOVAL_UNSETTLED`). | `retention-flow` AC5–7 |
| LOW: protection facts were read before the intent commit | Questions are read inside the intent commit, and activity is checked at commit time. | `retention-flow` (all removal paths) |
| LOW: `preserveSessionCopy` accepted any `workId` | It is validated with `identifier`. | `retention-details` |
| LOW: an all-refused plan superseded a valid one | A plan with no item supersedes nothing. | `retention-flow` "revalidated at execution" |

Session ownership no longer depends on a preservation record. A copy is owned when it is named after an Execution of the Work, and it is removed only at the hash the inventory or the plan saw.

## Real-run recipe (LOCAL only, supervisor decision 5: v1 not met, v2 met before the review; v3 pending)

`test/entrypoints/retention30-qualification.ts`, namespace `/home/sanmoo/software-factory-test/y5/q30-retention-v3` (v1/v2 consumed). Import and `--plan` are
inert (`retention30-qualification.test.ts`). The phases are one-shot, each with an exclusive intent tombstone and no retry:

1. **`preflight`.** Makes the namespace with an exclusive mkdir. COPIES `y5/q17-delivery-v4/authority` into `authority/`; a format-1 copy is
   migrated 1→2 with 33's `migrateStorage` via 17's `prepareAuthority`, and only the copy. Finds the delivered Work of Ticket #3 in an inert
   view of the copy. Copies `y5/<work>/` privately into `records/<work>/`: directories 0700, regular files only, a symlink or special file is
   refused. Records the inventory and the sha256 of the source storage.
2. **`sweep`.** Owner A runs with calendar = merge + 1 day: the boot sweep finds the details `retained`, and a `cleanup-plan` of
   logs/sessions/environment is recorded but never confirmed. Owner B then runs with calendar = merge + 31 days: the boot sweep removes the
   copy's expired details.
3. **`inspect`.** Writes `verdict.json`. Its checks: still delivered, `dueAt`, A retained, plan recorded, B expired with removed = before,
   evidence kept, source sha256 unchanged, zero remote/Sandbox calls.

There is no network:
- tracker and CodeRepository are local refusing doubles, and their calls are counted;
- Sandbox, Workers and credentials are refused;
- no App key is copied or read;
- a `remote-branch` selection is refused by the recipe itself (`RECIPE_REMOTE_SELECTION_REFUSED`).

`retention30-recipe-storage.test.ts` runs the same core on temporary fixtures: the private copy, the symlink refusal, the two real owner runs
through the public `openControl` with the production `detailPorts`, and a verdict of `met`.

### Run v1 (`q30-retention-v1`, run by the supervisor 2026-11-15): verdict NOT-MET, a harness defect

Met: delivered; `dueAt` 2026-12-15T15:08:56Z; run A retained with 0 removed; plan recorded; evidence kept (1); source unchanged; 0 remote
calls. Failed: run B `eligible` (expected `expired`), removed 0 (expected 88).

What the observations show (read-only):
- Run B's sweep found all 88 real logs eligible: complete inventory, no protection.
- It recorded the first intent batch of 50; `inspect` shows those 50 `removed` and 38 logs left.
- The recipe had stopped the owner as soon as the per-Work evaluation commit advanced `retention.sweeps`. That commit precedes the removal
  batches.
- The verdict read that early snapshot.

The product behaved as designed: the next boot or daily sweep removes the remaining 38 with no new period. The synthetic test had only 2
logs, so it never spanned a second batch.

Fix (recipe only):
- The owner run now waits for the desk's COMPLETED sweep (`status.retention.sweeps`).
- `retention30-recipe-storage.test.ts` now reproduces the real shape with 88 captures. It was red (38 left) before the fix and is green
  after.
- The new namespace is `q30-retention-v2`.

### Run v2 (`q30-retention-v2`, run by the supervisor 2026-11-15): verdict **MET**, 9/9

Source: a COPY of `q17-delivery-v4/authority`. It was already format 2 (`current`), so no migration ran; preserved digest `f56ec7e3…`. The
delivered Work's Records were copied privately: 284 files, 155103 bytes. Inventory: 88 logs, 0 sessions, 1 preserved evidence directory.
Ticket 17 had cleaned the environment before ticket 30, so no session copy exists for this Work.

| Check | Expected | Observed |
| --- | --- | --- |
| delivered | delivered | delivered |
| due-at | 2026-12-15T15:08:56.564Z (merge confirmed 2026-11-15T15:08:56.564Z + 30 d) | same |
| run A (merge + 1 d) | retained / 0 removed | retained / 0 removed |
| run A plan | planned (never confirmed) | planned |
| run B (merge + 31 d) | expired | expired |
| run B removed | 88 | 88 |
| evidence kept | 1 | 1 |
| source storage sha256 | ce45922c… | ce45922c… (unchanged) |
| remote/Sandbox calls | 0 | 0 |

Observations copied here and scanned for secrets (only field names such as `authorization` matched; no token, key or credential value):
- [verdict](30-real-retention-v2-verdict-2026-11-15.json)
- [preflight](30-real-retention-v2-preflight-result-2026-11-15.json)
- [run A](30-real-retention-v2-sweep-a-result-2026-11-15.json)
- [run B](30-real-retention-v2-sweep-b-result-2026-11-15.json)
- [inspect](30-real-retention-v2-inspect-result-2026-11-15.json)

Level: real local installation data (P on the Records/SQLite/Control boundaries this ticket changes). The GitHub doubles stay local by
design; there was no VM or model.

The V-14 "P" part (cleanup of a real delivery) remains ticket 17's `q17-delivery-v4`, already run.

## Gaps

- ~~Reviewer sessions went with the environment.~~ **Supervisor decision (6):** every agent session file of an Execution's boot runtime
  (`r/<boot>/w-<id>/profile/sessions/*.jsonl`, reviewers included) is copied into Records (`<execution>--rv-<16 hex of its ref>.jsonl`,
  role `reviewer`) before the environment is removed, read confined with its hash; an unreadable one blocks that environment's removal.
  It then follows the same 30-day rule and explicit cleanup. Tests: `retention-flow` AC1/AC5–7, `delivery-composition` ticket 30.
- `status.retention.sweeps/lastSweepAt` are per owner process, in memory. The per-Work `retention.lastSweepAt` is durable.
- The Records inventory is read per Work at each sweep (bounded at 20000 entries per Work). No global index exists.
