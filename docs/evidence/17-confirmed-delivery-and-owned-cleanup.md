# Ticket 17 — Confirmed delivery and cleanup of owned resources only

Branch `implement/software-factory-mvp-17`, based on integration `d4483d1` (tickets 01–13, 19, 20, 32).
Ticket 14 (own draft PR publication/discovery) was **not** integrated yet: it was read only, from its worktree.
Ticket 17 reads the own PR identity from 14's `publication.pullRequest` record **structurally**, through `ownPullRequestOf`.
Tests seed that record in 14's shape.
The real-run recipe needs 14 integrated first.

## What was built (composition actually tested)

| Layer | Module | What it does |
| --- | --- | --- |
| GitHub platform | `src/platform/github/index.ts` | New purposes: `delivery-read` (metadata/contents/pull_requests **read**) and `branch-cleanup` (metadata R, **contents W**, pull_requests R). `GitHubAccess.cleanup()` gives each attempt a **fresh single-use** grant that is never cached or used for tracking, and revokes it right after. The session can send only one closed `DELETE /repos/<repo>/git/refs/heads/<branch>`. |
| CodeRepository (Q4B) | `src/code-repository/delivery.ts` | `readPullRequest(pr)` returns the facts of the known own PR (merged, merged_at, merge commit, head/base); a failed read is `unavailable`. `cleanupBranch(selection, effect)` re-checks, under the cleanup grant: repository identity, not base/default, tip == merged own head, own PR still merged from that head, no open PR on the branch. Then it sends one DELETE and re-reads. Outcomes: `removed`, `absent` (from a complete read only), `refused`, `failed`, `indeterminate`. |
| Sandbox | `src/sandbox/evidence-export.ts` | `exportEvidence` copies `artifacts/{review,spec,instructions}` of an own environment with confined no-follow reads. Any symlink or special file fails the whole export. |
| Records (Q8 `preserve`) | `src/records/preserve.ts` | `preserveEvidence` writes into a new private `<root>/<work>/evidence/<id>/`, hashes and syncs each file and `manifest.json`, then returns a reference. A failed stage leaves nothing behind. |
| Control rules | `src/control/rules/delivery.ts` | Pure functions: merge decision by own PR/cycle identity, cleanup eligibility, the plan of owned resources and protected targets, per-resource outcome mapping, recovery of lost intents, pending selection, and the operator explanations. |
| Control durable | `src/control/durable/delivery.ts`, `delivery-desk.ts` | One commit records the merge, `result: delivered`, the minimal memory (`delivered`, `mergeConfirmed: true`), the exit from the queue and the start of cleanup. Each sweep records intent before every effect and the result after it, per resource. The desk runs in the existing owner loop before the dispatcher tick. |
| Dispatcher | `src/control/durable/dispatch.ts`, `execution.ts` | `interruptDelivered`: if a merge is confirmed while an activity runs, the activity is interrupted. Credentials are withdrawn (reason `delivered`), the own boot is stopped, and the Slot is released only after confirmed cessation. The Execution ends with `failure` / `WORK_DELIVERED`. `confirmActivation` refuses a Work that is not open. |
| Production | `src/entrypoints/controller/composition.ts` | `ports.cleanup` = the real `Sandbox.remove` plus the chain Sandbox export → Records preservation (records area = installation root), with `retrySeconds: 86400`. |

**Never touched by this design:**
- the base or default branch;
- the shared bare cache `cache/git/<id>.git`;
- other Works' or unknown environments, branches and PRs;
- Docker (no Docker operation is composed at all);
- controller history, records, reviews and decisions;
- `owner.json`, `removed.json` and the `cleanup-request` records of the Sandbox.

The Factory never merges, marks a PR ready or approves.

## AC → tests → evidence level

S = static/unit, I = storage-real integration (Pi Durable + SQLite, real Sandbox removal/export and real Records preservation on synthetic environments, with a systemctl double for the manager identity and a GitHub double). P = real boundary, still pending: see the recipe below.

| AC | Tests | Level |
| --- | --- | --- |
| 1. Delivery needs a confirmed merge of the own PR/cycle identity, not an issue/PR closure or Builder text. A merge during an activity is still delivery and stops new agent actions. | `delivery-rules`: merge decision, identity, closure. `delivery-flow` AC1 ×2: open, unavailable, closed-unmerged and foreign identity do not deliver; the Builder's "merged" text does not deliver; only the own PR is read; `ownCycles` gives `delivered/mergeConfirmed`; after delivery, renewal and admission are refused. `delivery-control-flow`: a real dispatcher activity is interrupted by the merge, then nothing new is activated and `update-scope` returns `not-applied`. `github-delivery`: real adapter merge facts. | S + I. P pending. |
| 2. Automatic cleanup starts only after merge and confirmed cessation, with evidence preserved outside the removed environment. | `delivery-rules` eligibility. `delivery-flow` AC2/3/5: waits on `CESSATION_UNCONFIRMED`, preserves before removing (order checked), manifest content checked. `delivery-flow`: evidence that cannot be preserved blocks only that environment. `evidence-export`, `preserve`, `delivery-composition`. | S + I |
| 3. Plan and per-resource intent/result cover worktree/checkout, local and remote branches, temporaries and the environment. Base, unknown resources and other Works are protected; no global Docker cleanup. | `delivery-rules` plan. `delivery-flow` AC2/3/5: a foreign environment and its runtime are kept, the shared cache is kept, base and foreign remote branches are kept, `owner.json` is kept. `github-delivery`: base/default refusal, foreign refs untouched. | S + I |
| 4. The remote branch uses its own cleanup grant and ownership/concurrency preconditions, without widening the normal tracking token. | `github-delivery`: one `branch-cleanup` grant `{metadata R, contents W, pull_requests R}`, revoked after use. Tracking reads use `delivery-read` only. Refusals for moved tip, open PR, unmerged PR and default branch. Local refusal of base or invalid names with nothing sent. | S + I (synthetic gh). P pending. |
| 5. Results distinguish removed, proven absence, partial failure and indeterminate. A failed query does not prove absence; success on one resource does not close the others. | `delivery-rules` mapping. `delivery-flow` partial-failure test (hard link → workspace `refused`, disk/temporaries removed, branch `failed`, delivery kept). `delivery-flow` crash test (`RESULT_NOT_RECORDED` → indeterminate, then revalidated). `github-delivery` lost DELETE (indeterminate, then `absent`) and a failed read reported as `failed`, not absent. | S + I |
| 6. A retry selects only pending resources, after revalidation, and keeps refs, history, reviews, decisions and protected records. Cleanup does not wait for detail retention. | `delivery-flow` partial-failure retry (attempt counts `[1,2,2,1,2]`, preserve called once), cadence test (boot sweep plus daily, a refused tip change is never forced). The sweep happens in the cycle right after cessation, with no retention wait. | S + I |
| 7. The CLI explains delivery and pending cleanup separately. The real integration includes an authorized human merge, a partial failure and a retry that touches no foreign resource. | `delivery-control-flow`: the `show` payload has separate `delivery` and `cleanup` sections with their own `nextStep`, and `status.delivery` holds the counts. Real part: `delivery17-qualification.ts` (recipe and inert tests). | S + I. **P not run** (no authorization). |

**Red → green.** Each layer was compiled and run red before it went green. Captures are in the scratchpad:
- adapter: `cleanupBranch is not a function` (×10);
- export/preserve: `NOT_IMPLEMENTED` and a missing export;
- rules: `ERR_MODULE_NOT_FOUND`;
- desk: `ERR_MODULE_NOT_FOUND`, plus `mergeConfirmed: false` before the `ownCycles` producer fix;
- control wiring: `condition not reached`;
- composition: `cleanup` undefined.

## Real-run recipe (not run here: no real GitHub, credentials, VM or `$HOME/software-factory-test` were used)

`test/entrypoints/delivery17-qualification.ts`. Run it after ticket 14 is integrated **and** its q14 run produced a linked own draft PR (`/home/sanmoo/software-factory-test/y5/q14-publication-v6`). Each phase is one-shot and has an exclusive tombstone. Run each one only with an explicit operator grant:

```sh
node dist/test/entrypoints/delivery17-qualification.js --plan       # inert
node dist/test/entrypoints/delivery17-qualification.js preflight
#   OPERATOR (human, own GitHub account): mark the recorded own PR ready and MERGE it into main,
#   leaving "Delete branch" unchecked (repository auto-delete of head branches OFF).
node dist/test/entrypoints/delivery17-qualification.js deliver
node dist/test/entrypoints/delivery17-qualification.js retry
node dist/test/entrypoints/delivery17-qualification.js inspect
```

**Exact effects:**

- **preflight** (read-only):
  - copies the q14 storage into `q17-delivery-v1/authority`; the source is never written;
  - inspects that copy: own PR linked, Work open, every Execution ended with confirmed cessation;
  - GitHub reads: the own PR (must be open and not merged), every `refs/heads` and `refs/tags` tip;
  - host inventory: `environments/*` with owner workId, `r/*`, `cache/git/*`.
- **operator**: a human marks the own PR ready and merges it. This is the only merge, and the Factory never does it.
- **deliver** (real; only the controller runs):
  - Every prepare/start/activate/credential is refused, so no VM, model or Builder runs.
  - GitHub reads: the own PR and polling reads.
  - Control records the delivery.
  - Evidence is preserved first: `artifacts/{review,spec,instructions}` of the own environment are copied into `y5/<work>/evidence/<id>/`.
  - Then **removed** through `Sandbox.remove` of that own environment only: `root.qcow2`, `workspace/` (checkout and local branch), `artifacts/`, and `r/<boot>` for each boot of that environment.
  - The remote-branch cleanup is **provoked to fail once**: the wrapper returns `failed` without calling GitHub.
  - Expected: delivered, cleanup `pending` with only `remote-branch` pending, `status.delivery = {delivered: 1, cleanup.pending: 1}`.
- **retry** (real): a new owner process does the boot sweep and revalidates and deletes **only** the own branch.
  - GitHub write: one fresh `branch-cleanup` grant, one `DELETE /repos/Sanmoo/java-springboot-event-sourcing/git/refs/heads/factory/3-<work8>`, and the grant's self-revocation.
  - Environments are not touched again.
  - Expected: `remote-branch` `removed` (or `absent` if GitHub had already deleted it), cleanup `complete`.
- **inspect** (read-only):
  - Control view from a copy;
  - own PR `merged`;
  - `refsDiff` must be `{removed: [refs/heads/factory/3-<work8>], added: [], moved: []}`;
  - the host inventory after the run shows only the own environment's data gone (`owner.json` and `removed.json` kept), the own runtime dirs gone, every other environment and runtime dir unchanged, and the shared cache unchanged;
  - the evidence manifest is present.

## Open design questions / gaps

1. ~~**Remote-branch concurrency.**~~ Decided by the supervisor and implemented: atomic `updateRefs` or keep the branch (see Review fixes). Original note: GitHub REST has no conditional ref deletion, so the precondition is a re-read of the tip immediately before the DELETE. A human push landing in that millisecond window would be deleted (GitHub's "Restore branch" can recover it). There are two atomic alternatives:
   - GraphQL `updateRefs` with `beforeOid` (it exists in the schema, but its availability for App tokens has not been verified for real);
   - a `git push --force-with-lease=<ref>:<tip>` deletion, which the contract's "sem push mediado" might be read to forbid.

   This needs an operator decision; the contract was not changed.
2. **`cleanupBranch`/`readPullRequest` are optional** on the `CodeRepository` interface. Q4B names both operations; making them optional only keeps the other tickets' doubles compiling. Absent means delivery and branch cleanup are not composed.
3. The `branch-cleanup` grant also reads pull requests, to revalidate the merged own PR and the absence of an open PR on the branch in the same grant. This stays within the controller's PR ceiling. Please confirm.
4. **Cancellation (ticket 25) does not exist yet.** "Merge during cancellation" is covered as a merge during an active activity. `recordMergeObservation` accepts only `result: 'open'`. If ticket 25 adds a cancelled state before cessation, delivery must still win there.
5. A PR closed without merge is only observed and recorded (`closed-unmerged`, not delivered). The cycle/result transition belongs to ticket 25.
6. **Preserved evidence** = review captures and the preserved spec/instruction versions. Not preserved:
   - Factory seeds and the agent's output copies (their originals are protected elsewhere);
   - the workspace checkout (the delivered content is on GitHub, and the review diffs are preserved).

   An `artifacts/` tree that no longer exists is recorded as `absent` and does not block removal.
7. **Retry cadence.**
   - A `waiting` cleanup is re-checked every cycle, because the check is local and has no effect.
   - `failed`/`indeterminate`/`refused` resources are retried at each controller boot and then daily (`retrySeconds`, default 86400, reusing spec §12.3's sweep cadence).
   - A `refused` resource (e.g. a moved tip) stays visible and asks for an operator decision.
8. The own PR identity is read structurally from ticket 14's record. After the rebase onto 14 it could be typed directly. The data shape is already identical.

## Review fixes (supervisor static review of 7fbad82)

| Finding | Fix | Tests (red at 7fbad82 → green) |
| --- | --- | --- |
| Decision on question 1 / MED 1: race window | The deletion is ATOMIC and conditional: GraphQL `updateRefs` with `{name: refs/heads/<own>, beforeOid: merged own head, afterOid: 0…0, force: false}`. It is sent right after a fresh tip re-read; GitHub changes nothing if the ref moved. There is no REST DELETE path anymore. If `updateRefs` is unavailable for the token, the branch is **kept**: outcome `kept`, code `ATOMIC_DELETE_UNAVAILABLE`, nextStep `kept: atomic delete unavailable`. It is never deleted without a precondition. | `github-delivery`: atomic body and order; race refused with the new tip and nothing deleted; unavailable → kept. The fixture checks the mutation contract. Real availability for the App token is checked in the real run (recipe `expected`). |
| MED 2: stacked PRs | `pulls?state=open&base=<own branch>`; any result → `refused BRANCH_BASE_OF_OPEN_PULL_REQUEST`, branch kept. | `github-delivery` stacked case |
| MED 3: starvation | Reads go least-recently-read first (`delivery.lastReadAt`), at most 8 per cycle. A recorded `closed-unmerged` is not re-read. | `delivery-flow` MED3/MED4; closed-unmerged test |
| MED 4: one throw aborted `afterCycle` | Each Work's observation and sweep sits in its own try/catch, recorded in the desk's in-memory `view().failures`. A `readWorks` failure is caught, `cycle()` never throws, and `afterCycle` also catches it. The question desk and the dispatcher always run. | `delivery-flow` MED3/MED4 |
| LOW: head SHA ownership | `ownPullRequestOf` carries `heads` = 14's `linkedHeads` ∪ linked `headSha`; without any, there is no own identity. A merged head outside it → `HEAD_NOT_OWN_CONTENT`. | `delivery-rules`, `delivery-flow` AC1 |
| LOW: branch null / null base repository | A null `work.branch` gives `OWN_BRANCH_UNKNOWN` (no self-comparison). A null `baseRepositoryId` gives `BASE_MISMATCH`. | `delivery-rules` |
| LOW: refused retried | `refused`/`kept` are never retried automatically: no intent and no fresh write grant (`retryable`). The operator decides, through explicit cleanup in ticket 30. `failed`/`indeterminate`/`pending` are retried at boot and daily. | `delivery-rules`, `delivery-flow` partial/cadence/daily |
| LOW: truncation | `branchTip` uses a complete `matching-refs` listing. More than 10 pages, or any failed or invalid listing, throws and is reported as `failed`/`indeterminate`, never `absent`. A failed re-read after the deletion → `indeterminate`. | `github-delivery` failed read ≠ absence, lost answer |
| LOW: evidence path | Kept as `<installation root>/<work>/evidence/<id>/`. This is the existing integrated Records area (`createRecords({root})` / `recordsRoot`, where the boot owner already writes protected outputs; the ticket 13 recipe reads `${root}/${work}/evidence`). It is outside every guest mount. Spec §12.1 names `data/records/<work_id>/evidence/`; moving only the ticket 17 copies would split one Records area in two. **Open:** relocating the whole Records root to `data/records` is a cross-ticket change (Records/Workers/Sandbox owner), outside 17. | n/a (documented) |
| LOW: recipe | `branchGuard`: every call in `deliver` returns a provoked failure without GitHub; in `retry` at most ONE real call, further calls are refused locally. `deliver`/`retry` use `capacity: 0`, so the dispatcher never reserves or holds any Work. | `delivery17-qualification` |

New outcome: `kept` (`BranchCleanupResult`, `CleanupOutcome`). It is listed in the cleanup `nextStep` among the "refused/kept: never retried automatically" resources.

Ticket 14's real run left the own branch `factory/3-28c75e5a` with no PR. Ticket 17 never touches such a branch: no own PR is linked, so there is no delivery and no cleanup plan. Branch cleanup also requires the merged own PR head to equal the tip.

## Gates (this worktree, after the last commit)

- `tsc -p tsconfig.json`: 0 errors.
- `eslint . --max-warnings 0`: exit 0.
- `dependency-cruiser --config .dependency-cruiser.cjs --output-type err-long .`: no violations (357 modules, 2166 dependencies).
- Every compiled `dist/test/**/*.test.js`, run one file at a time with `--experimental-test-module-mocks --test --test-concurrency=1`: **170 files, 1068 passed, 0 failed, 10 skipped**. The skips are pre-existing; `test/sandbox/gondolin.test.ts` stays `skip: true`.
- New ticket 17 files (all green), 31 tests in total:
  - `github-delivery` (10)
  - `evidence-export` (2)
  - `preserve` (2)
  - `delivery-rules` (6)
  - `delivery-flow` (7)
  - `delivery-control-flow` (1)
  - `delivery-composition` (1)
  - `delivery17-qualification` (2)
