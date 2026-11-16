# Ticket 29: correlated inspection and consumption through the CLI

Branch `implement/software-factory-mvp-29`, rebased onto 19c2327 (ticket 23 on 22 on integration c645639, which has 17/18/21/25/28/30/31/40). The two ticket 29 commits are squashed into one.

## What was built

- **Control `inspect`** gains four read-only query kinds: `history` (paginated, filtered by Execution/role), `logs` (the Work's protected Records
  captures with their state), `log` (one bounded page of one text capture), and `usage` (one Work or the whole installation).
  - `show` gains `chain`. It correlates Ticket → Work/cycle/predecessor → Executions (purpose, phase, outcome, charge, duration, verification,
    recoveries, review rounds and each reviewer's attempt/source/opinion reference) → Questions → corrections/feedback → publication → checks →
    readiness → delivery → cleanup. It also carries protected references (never their content), recorded models per role, the configuration,
    and the derived phase/wait/next step. Each external observation has its instant, age and completeness.
  - `status` gains `impediments` (open Works by code) and `consumption`: Executions, budget consumption, and measured / lower-bound / unknown time.
- **Pure rules** live in `src/control/rules/inspection.ts`. **Handlers** live in `src/control/durable/inspection.ts`. **Ports** are optional:
  `ExecutionPorts.records` (`find`/`read`) and `ExecutionPorts.workers.observeUsage`. The production composition wires both
  (`inspectionRecords`, and `createWorkers().observeUsage` over `src/workers/session-usage.ts`). `Records.find` now also reports each capture's `format`.
- **Usage** comes from the SDK's own per-entry usage in preserved Pi sessions (assistant messages, usage/compaction/branch-summary entries).
  - Entries are deduplicated by `sessionId:entryId`, so a continued session is counted once.
  - Errors and aborts are counted.
  - Measurement is `complete`, `partial` or `unavailable`. An unavailable activity carries no number, and totals add up measured parts only.
  - Cost is labelled `sdk-catalog-estimate` with `currency: null`. No billing is queried and no price is invented.
  - Adapter RAM/CPU/disk are reported separately as `unavailable` (`ADAPTER_RESOURCE_METRICS_NOT_OBSERVED`).
- **Evidence states** are `complete`, `truncated` (more by reference, `nextOffset`), `partial`, `absent`, `removed` (the session's environment
  was removed by the Work's own cleanup), `expired` (reserved for ticket 30's retention removals on rebase) and `unknown`.
  - Raw captures and sessions are never displayed.
  - A page never splits a UTF-8 character.
- **Frames:** pages are cut to fit one 64 KiB frame (`page.fitted`, `nextCursor`). A view that still does not fit returns `VIEW_TOO_LARGE` with
  a next step. Before this change it closed the connection, which read as "controller unavailable".
- **Errors and CLI:**
  - Inspection errors carry `code`, `scope`, `outcome` and `nextStep` (`INVALID_QUERY`, `DIAGNOSTIC_UNAVAILABLE`, `VIEW_TOO_LARGE`).
  - The offline CLI error carries `CONTROLLER_UNAVAILABLE`, `scope`, `outcome` and `nextStep`.
  - Exit codes: 0 = view, 2 = invalid/refused/not found, 3 = unavailable (including a logs listing that is not composed or not readable), 4 = indeterminate.
  - New commands: `factory history <work> [--execution --role --cursor --limit]`, `factory logs <work> [same | --read <capture> [--offset n]]`, `factory usage [<work>]`.
  - There is no offline operational reader. Inspecting a copy goes through the public Control without `run` (recipe only).
- `src/entrypoints/controller/inspection.ts` holds the owner's inspect answer (`answerInspection`) and a read-only endpoint (`serveInspection`, which
  refuses every `accept`) used by the recipe.

## AC → tests

| AC | Tests |
| --- | --- |
| 1 status/list/show: pause, Slots/queues, identities, branch/PR, phase/wait, duration/last activity, models/configuration, cleanup | `inspection-rules` (phase priority, chain models/references/observations), `inspection-flow` "show carries the correlated chain", `inspect-cli` (status impediments/consumption, show chain) |
| 2 history/logs paginated and filtered by Execution/role, with links | `inspection-rules` (roles, links, page/fit), `inspection-flow` history and logs, `inspect-cli` history filters, `inspect29-qualification` (real CLI over a copy with composed Records) |
| 3 through Control/Records only; stable codes for unavailable/refused/indeterminate | `inspect-cli` (INVALID_ARGUMENTS ×12, offline CONTROLLER_UNAVAILABLE exit 3 with scope/nextStep, work-not-found 2, RECORDS_NOT_COMPOSED exit 3), `inspection-flow` (INVALID_WORK_ID, not-found) |
| 4 observation instant/freshness/completeness; complete/truncated/partial/absent/removed/expired/unknown are distinct | `inspection-rules` (captureState/pageState, removed), `inspection-flow` (truncated pages rebuild the full output, partial capture, absent capture, raw not displayed, hash mismatch vs lost) |
| 5 large output read by the agent through a filtered selective copy; the editable copy certifies nothing | Existing ticket 05 copy-read mechanism (no new tool, no Records mount). The logs view states this limitation. |
| 6 usage per role/Execution/Work/installation; failures/aborts included; no double count; complete/partial/unavailable ≠ zero | `inspection-rules` (dedupe, aggregates), `session-usage`, `inspection-flow` usage, `inspect29-qualification` (185 tokens through the CLI) |
| 7 SDK estimate with model/provider/unit/currency, not an invoice; adapter resources separate | `inspection-rules` (cost shape), `inspection-flow` (`resources.state`) |
| 8 auxiliary loss is a gap; critical failure blocks; nothing published to GitHub | Unreadable usage entries make the measurement `partial` (`USAGE_ENTRIES_UNREADABLE`); an observation failure makes it `unavailable`; a failed query is `DIAGNOSTIC_UNAVAILABLE`, never an empty or green result. The critical-persistence paths are unchanged from earlier tickets. Inspection writes nothing and publishes nothing. |

## Recipe (LOCAL, not run)

`test/entrypoints/inspect29-qualification.ts run` uses the namespace `y5/q29-inspect-v1` (an exclusive mkdir). For each of `q18-journey-v4` and `q25-cancel-v1`:

1. Copy the storage. A format-1 copy is migrated on the copy only.
2. Copy that storage's Works' Records and named session files, bounded at 1 GiB.
3. Open the public Control without `run`, with only the read-only Records/usage ports composed.
4. Serve it read-only on `<copy>/run/control.sock`.
5. Run the real CLI: status/list/usage, then show/history (page, next page, `--execution`, `--role`)/logs (listing, `--role`, `--read` + next page)/usage for each Work.

The recorded checks cover exit codes, JSON, frame fit, secret patterns, the chain, no false zero, paging, and explained logs. Its path is
tested over a temporary root in `inspect29-qualification.test.ts`. Run it only after rebasing onto the integration branch (it needs 25/30).

## Decisions and open items

1. **`RECOVERY_BLOCKED` from an unreadable Records request (supervisor decision 1):** ticket 29 stays observation-only. The explicit operator
   override through `resume` is the new **ticket 41** (owners 27/29), published in the integration branch (36698c0). Ticket 29 makes the case
   inspectable: `show.chain.phase = blocked / impediment:RECOVERY_BLOCKED` with its next step, the Execution's recovery record,
   `logs <work> --execution <id>` with the capture's `partial`/`unknown` state, and `history --execution`.
2. **Ticket 30 session copies and retention (supervisor decision 2), done at the rebase.** When a recorded runtime session is gone, usage reads
   the Work's Records copy (`<work>/sessions/<execution>[--rv-…].jsonl`) that retention recorded as `preserved`. The copy is read confined and
   verified against the recorded hash, and a reviewer's copy is matched by its `sourceRef`.
   - A session copy or log that a retention sweep removed is `expired` (`SESSION_EXPIRED_BY_RETENTION`, `CAPTURE_EXPIRED_BY_RETENTION`).
   - One removed by an explicit cleanup is `removed`. Neither is ever absent or zero, and both exit 2.
   - **Ticket 31:** `history`/`logs`/`log`/`usage` of a forgotten Work answer `work-forgotten` with its minimal memory. `list`/`show`/`status`
     keep ticket 31's forgotten views; the installation `usage` notes that forgotten Works are not in its total.
   - Tests: `inspection-retention`.
   - **Ticket 40:** the new tests use `remainingMs()`/`untilHolds()` (no numeric `timeout:`, no counted wait loop).
   - The inspect answer now lives in ticket 25's `serve.ts`, through `answerInspection`.
3. **`list` paginates (supervisor decision 3):** `--cursor/--limit`, in admission order. Queues and selection stay installation-wide.
   - Over the socket `list` always pages (default 50), and the page is fitted to one frame.
   - A single Work too big for the frame is returned compacted (`compacted` counts and next step).
   - An in-process call with no page argument still returns the full list (recipes).
4. **Human output:** inspection keeps the existing pretty-printed JSON as its human output (same convention as `show`/`list`).

## Independent review of 3fa8a7b (fixed with TDD)

| Finding | Fix | Tests |
| --- | --- | --- |
| MED: a reviewer session counted when only under `root/r/` | The usage facet takes the Execution's `boot`. The session must lie in that boot's runtime tree, normalized, with no `.`/`..` segment; otherwise `unavailable` (`SESSION_NOT_OF_EXECUTION`). A Builder session's recorded hash is verified (mismatch → `altered`). A reviewer session has no recorded hash, so it is `unverified` and its measurement is `partial` (`SESSION_INTEGRITY_UNVERIFIED`), never `complete`. | `session-usage` (binding/foreign/`..`/no boot/hash), `inspection-rules` |
| MED (recipe): `root/r/../../x` passed the check | `containedPath`: the path must be normalized, contain no `.`/`..`, lie under `<root>/r`, have its real path (symlinks resolved) under the root, and land at the same place inside the copy. Otherwise it is refused and recorded. | `inspect29-qualification` paths test |
| MED (recipe): two Control opens / composed ports | ONE Control on the copy, never `run`. No `access` is composed, so no dispatcher, reconciliation, polling or GitHub can exist. The Records/usage ports open lazily, after the copy. The storage state digest before opening equals the digest after closing (`copy-unchanged` check). | `inspect29-qualification` (digest equal), fixture creates the Slots document a controller leaves |
| MED: second `createRecords` on the live root | Opening only checks the private directory (realpath/lstat). `find`/`read` are read-only. A test snapshots the whole tree (mode/size/mtime/hash) around a second instance's find/read while another instance's capture is in flight; the tree is unchanged and the live capture still finishes. | `find-paging` |
| MED (recipe): secret shapes | Added sk-proj-, sk-ant-, JWT, OAuth access/refresh/id tokens, ya29., GitHub ghr_. Every match is redacted before parsing, keeping or saving; the count is recorded. | `inspect29-qualification` redaction test |
| MED: `--offset` ≥ bytes | `OFFSET_OUT_OF_RANGE` (state `absent`, exit 2), never an empty `complete` page | `inspection-flow` logs |
| MED: `show` of big Works | When the view does not fit: compacted Work (history, earlier Executions and review rounds left out with counts), `omitted.nextSteps` naming paged commands (`history --limit`, `show --cursor/--limit`, `question <id>`), `chain.executions` paged by `--cursor/--limit`. `VIEW_TOO_LARGE` next steps are per kind and always a smaller page, never the same command. | `inspection-flow` "a big Work stays inspectable", `inspect-cli` |
| MED: logs of Works past the Records listing cap | `Records.find` pages by capture id (`after`/`limit`, `next`), filters by `role` and looks a capture up by `id`. A paged call has no listing cap. `logs --after <capture>` replaces the index cursor; `logs --read` looks the capture up directly. | `find-paging`, `inspection-flow` (every capture reached by following `next`) |
| LOW: pagers make progress | A single oversized history entry or Work is returned trimmed/compacted with a marker. A log page reads at least 4 bytes (one whole character). | `inspection-rules`, `inspection-flow` (limit 1) |
| LOW: exit codes | 0 view; 2 invalid/refused/not found/absent (`CAPTURE_NOT_FOUND`, `OFFSET_OUT_OF_RANGE`); 3 unavailable/incomplete/unknown (logs listing not `complete`, log `unknown`); 4 indeterminate | `inspect-cli` |
| LOW: installation usage unbounded | Installation `usage` pages Works (`--cursor/--limit`, default 50). The Workers facet caches hash-verified observations keyed by file identity (ref, hash, inode, size, mtime), so a changed file is read again. | `inspection-flow` (page; tampering after a measurement is seen) |
| LOW: freshness and untrusted text | An observation is `complete` only with a completeness proof: polling uses the repository read's completeness, discovery and delivery report incomplete reads as `incomplete`, feedback is `unproven`, readiness is `derived-*`. Log pages carry `trust: untrusted-captured-output`. | `inspection-rules`, `inspection-flow` |

The CI flakes (fixed-timeout fork chains under load: `normal-edit`, `worker-process`, `public-bash-copy`) belong to ticket 40. They are not classified as slow here.
