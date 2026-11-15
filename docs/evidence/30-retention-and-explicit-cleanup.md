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

## Decisions taken here (for supervisor review)

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
unreadable request) belongs to recovery, tickets 26/27. Ticket 26's decision 3 already routes it to `resume`, which does not lift it today.

## Real-run recipe

None was written. This ticket changes no GitHub, VM or model boundary. Its boundaries are the Records filesystem, the Sandbox removal, the
SQLite authority and the CLI/socket/owner path, and the local suite exercises each of them for real. The V-14 "P" part (cleanup of a real
delivery) is ticket 17's `q17-delivery-v4`, already run. Still open, for an operator decision: a local-only run over a COPY of a real
installation (e.g. `y5/q17-delivery-v4` → `y5/q30-retention-v1`) that checks the inventory of Records produced by real runs. It could fold
into the ticket 18/35 journey.

## Gaps

- ~~Reviewer sessions went with the environment.~~ **Supervisor decision (6):** every agent session file of an Execution's boot runtime
  (`r/<boot>/w-<id>/profile/sessions/*.jsonl`, reviewers included) is copied into Records (`<execution>--rv-<16 hex of its ref>.jsonl`,
  role `reviewer`) before the environment is removed, read confined with its hash; an unreadable one blocks that environment's removal.
  It then follows the same 30-day rule and explicit cleanup. Tests: `retention-flow` AC1/AC5–7, `delivery-composition` ticket 30.
- `status.retention.sweeps/lastSweepAt` are per owner process, in memory. The per-Work `retention.lastSweepAt` is durable.
- The Records inventory is read per Work at each sweep (bounded at 20000 entries per Work). No global index exists.
