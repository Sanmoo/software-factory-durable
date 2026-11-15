# Ticket 18 — First integrated delivery journey

Branch `implement/software-factory-mvp-18`, rebased on integration `8a91799` (tickets 01–17, 19, 20, 26, 28, 32, 33, 36–39).
This ticket composes what tickets 09–17, 26 and 39 built. It adds no per-ticket logic: it closes the gaps that kept ONE unattended
controller run of the **production composition** (`src/entrypoints/controller/composition.ts`) from carrying a real Ticket end to end,
proves the whole chain at composed level over the gh fixture, and pins the one-shot real recipe. The agent never used GitHub, a VM, a model or credentials; the supervisor ran the recipe with the operator's authorization. Real run
**`q18-journey-v4` PASSED end to end** (below); v1–v3 found product/recipe gaps, all fixed.

## Composition gaps found and fixed

| Gap | Effect on a real journey | Fix |
| --- | --- | --- |
| The production Builder system prompt said "Never push, open pull requests, change GitHub state" with no exception, and every Builder session got the SAME prompt. | It contradicted Control's publish-only instruction (ticket 14); every publishing recipe (q14 v6–v8) used its own prompt, so production publication had never run. A single prompt would also tell a publish-only session to "call the handoff tool" it does not have. | **Per-session-mode prompts** (supervisor decision): `productionProfile.prompts.builder` (implementation/review-round: write, bash, read, edit, ask_user, handoff; never publishes) and `prompts.builderPublication` (publish-only: write, bash, read, ask_user; the lease push and ONE draft PR only). `productionBuilderPrompt({ phaseId, tools })` selects by the activation phase Control sets (`builder-initial`/`-recovery`/`-continuation` vs `builder-publication`) and the exact tool set (`builderToolNames`, the same prediction session continuation uses); any other combination (e.g. a future reconciliation mode, ticket 21) refuses the activation before launch. Workers apply it through the new `builderPrompt` configuration. Tests: `journey-composed` (each mode's prompt names only its session's tools), `activate-review` (the launch carries the mode prompt; an unsupported mode launches nothing). |
| A publish-only Builder holds `contents:write` + `pull_requests:write`: GitHub permissions cannot separate push from merge nor draft creation from ready/merge (review HIGH 2). | The guest could push another branch, mark ready or merge outside the host gh guard. | (a) **Guest command policy** — supervisor decision: ticket 21's `src/workers/push-policy.ts` is the single implementation. The policy built here (`src/workers/guest-command-policy.ts`, wired into Builder Bash) is kept in a SEPARATE, unintegrated commit on top of this branch, to be folded into `push-policy.ts` (merge/ready/review/API refusals) once 21 is integrated: Builder Bash commands are checked before reaching the guest — publish-only session: only Control's exact lease push onto `factory/<n>-<work8>`, an own `--draft` PR, a body-only `gh pr edit`; every session: never `gh pr merge/ready/review/close`, `gh api`, curl/wget, raw API/graphql, forced/destructive pushes; implementation sessions never push or create PRs. A refusal is a tool error, recorded for the gate ledger, never critical. It reads command TEXT (obfuscation possible): defence in depth. (b) **Backstop** in Control: after a publication attempt, a blocking discovery whose reasons show an out-of-scope effect (other ref changed, own PR not draft/merged/closed, own branch or head moved, a second own PR) adds the impediment `GUEST_EFFECT_OUT_OF_SCOPE` (rule `guestEffectOutOfScope`). Bot approvals are not read: GitHub refuses an approval by the PR's own author. Tests (this commit): `publication-rules`, `publication-flow` (tag push and non-draft PR after the guest published). |
| The owner's Control access (IssueTracker, CodeRepository, operators, dependency scopes, lazy App identity) was built inline in `owner.ts`. | No test or recipe could compose exactly what the owner composes; each recipe rebuilt its own access. | `composeProductionAccess({ github, effective })` in `composition.ts`, used by `owner.ts` (behaviour unchanged), by the composed journey test and by the ticket 18 recipe. Control's `AccessDependencies`/`ConfiguredRepository` types are exported. |
| The gh world fixture lacked the delivery/cleanup surface (repository `node_id`/`default_branch`, open-PR listings by head/base, `merged` from `merged_at`, `/graphql` `updateRefs`). | The full chain (through ticket 17's cleanup) could not run in ONE world; 13–16 and 17 had separate fixtures. | Test fixture only (`github-world-fixture.ts`), with GitHub's semantics (a ref not at `beforeOid` changes nothing; `contents:write` required). |
| The shared qualification root `y5` holds other storages' environments. | A real production boot there lists them as `UNKNOWN_RESOURCE:environment:*` and keeps dispatch closed (correct for an installation; y5 is not one). | Not a product change. The recipe passes the production `inventoryRuntime(y5)` restricted to environments of Works of ITS storage, records the full listing, and holds on any unknown entry or cache in preparation. Reported as an open question. |

No other gap appeared: with these, the production ports and access carried the composed journey unchanged (question → recovery → rounds →
verification → publication → checks → merge-blocked stop → ready → human merge → delivery → owned cleanup).

## AC → tests → level

S = Control + SQLite with doubled boundaries; I(sub) = real adapters/issuer/gh transport over the gh world fixture (substituted GitHub);
P = real run (recipe, pending authorization). A substitute never proves the boundary it replaces.

| AC | Tests | Level |
| --- | --- | --- |
| 1 Scenario registers host/account/storage, disposable GitHub resources, App, operators, models/costs, allowed failures, cleanup and the human merger beforehand | `journey18-qualification.ts` `plan()` (roots, App/purposes, operator pinned by id, model/budgets, bounds, allowed effects, cleanup, `operatorSteps` for approval/merge); `journey18-qualification.test` (inert import/`--plan`, refusals before pinning) | D + S |
| 2 Same Work: admission/dependencies, queue, start receipt, preserved request, implementation, question/answer with cessation/Slot release and return through the queue | `journey-composed` (one owner run, production composition): Question recorded and published as a comment, `end.outcome question`, cessation confirmed, Slot released, `QUESTION_PENDING`; operator `/factory answer` comment read by the production tracker; recovery `QUESTION_ANSWERED` through the queue | I(sub) + **P (v4)** |
| 3 Standards and Spec complete opinions; Builder treats findings; gates recorded; direct publication creates own draft with a short description | `journey-composed`: Spec finding S1 in round 1, treated `not-adopted` under the answered Question's authorization, gates `passed`, verification `verified`; publish-only Execution with `builder-publish` from the REAL Builder credentials; push + draft PR by the Builder with ITS grant; `publication.state published`, PR #4 linked | I(sub) + **P (v4)** |
| 4 Controller proves requirements and readiness; human merges; observation confirms delivery/cleanup without agent merge | `journey-composed`: with `update` active, readiness `not-ready`, reason `MERGE_BLOCKED_UPDATE_RESTRICTED`, next step "adjust the base protection", zero draft mutations; after the operator removes it, ONE `markPullRequestReadyForReview`; human merge edited into the fixture; `result delivered`; cleanup `complete` (environment, checkout, local branch, temporaries, remote branch by ONE `updateRefs`); GitHub writes are exactly comment, Builder push, Builder PR, mark-ready, updateRefs; no merge/approval | I(sub) + **P (v4)** |
| 5 CLI/history/evidence link Ticket, Work, Executions/roles, sources, questions, opinions, results, Git/PR and resources; absences/blocks stay visible | `journey-composed` (list/show/status: three Executions with modes/resume reasons, Question answered, verification treatments, PR, delivery counts); recipe `inspect` (status/list/show, own PR facts, refs diff, issue state, environment listing, evidence manifest, gh trace summary, secret scan) | I(sub) + **P (v4)** |
| 6 Record separates active times/waits, interventions and consumption; references proven subcases; not presented as the adversity battery or pilot usefulness | recipe events carry calendar + monotonic times per port call and the answer receipt; Execution timing in the views; `plan().limits`; this document's subcase references below | D + **P (v4)** |
| 7 Failure/inconclusive blocks this demonstration with cause and next step, without waiving requirements | `journey-composed` merge-blocked stop; `journey18-recipe-safety`: `journeyOutcome` (ready ≠ merge-blocked ≠ held/not-publishable/publication-blocked/second question), `phaseGuard` (deliver only after a confirmed ready, ready only after merge-blocked, one-shot), `deliverPrecondition`, gh guard, port/access bounds; every held phase saves its code ("Consumed; no retry") | S + I(sub) + **P (v1–v3 stops)** |

Subcases already proven at the real boundary by earlier tickets (referenced, not re-run here): Builder start/request (09), Question/answer
(10), continuation/scope (11), reviews (12), rounds/gates (13), direct publication + discovery (14 v8), checks (15), readiness conversion
(16), delivery/cleanup with atomic deletion available to the App token (17 v4), recovery (26), partial reviews (28), merge-blocking rules
(39). None of them ran through the production composition; ticket 18's real run is the first that would.

Red → green: the prompt test failed against the original production prompt (`/EXCEPT inside a publication activation/` not matched); the
composed journey failed first on the answer timestamp and the recovery prompt's branch parsing in the doubles (test-side), then passed.

## One-shot real-run recipe (`test/entrypoints/journey18-qualification.ts`)

Namespace `/home/sanmoo/software-factory-test/y5/q18-journey-v4` (v1 held at preflight; v2 and v3 consumed, see below): own `config.yaml` (validated by the production `readConfiguration`),
GitHub access root (`run/`; `credentials/app.pem` = a copy of `y5/credentials/app.pem` taken at the start of EACH phase, after its intent,
and removed at its end, also on failure; a missing source fails loudly `APP_KEY_SOURCE_MISSING` before any effect), storage under an
exclusive flock. Execution root stays `y5`; its inventory is restricted to this storage's Works (supervisor decision), and an
unattributed environment, unknown entry or cache in preparation holds the phase. Production composition; the recipe observes and bounds
ports and wraps every tracker/repository method explicitly. `gh` sits behind a write allow-list guard: GET; the App's token issuance for
exactly installation 177599217 and this repository; comments on the pinned issue (≤ 2); the two draft mutations ONLY on the own PR node
Control linked (pinned in `own-pull-request.json`, ≤ 2); ONE `updateRefs` of exactly the ref, repository node and merged linked head pinned
in `cleanup-armed` (deliver only, removed in `finally`); token self-revocation; anything else exit 97.

**Synthetic issue** (parameter): `ticket.number` is `null`, so every phase refuses `TICKET_NOT_PINNED` until the supervisor pins it. Title
`Factory journey: document the integrated delivery`; body `ticketBody` (docs-only `docs/FACTORY_JOURNEY.md`, a pinned ask_user question
about the third section's title, documented gate). **The answer is a REAL comment** (supervisor decision): `run` stops once the Question
is published and the activation ceased (Slot released) and records `answer.command`
(`gh issue comment <N> --repo Sanmoo/java-springboot-event-sourcing --body "/factory answer <question-id> Use \`## Rollback\` …"`), which the
supervisor posts with the operator's gh account; `resume` waits (≤ 60 min) until the controller ingested it (origin `github-comment`,
author = the pinned operator id; a local answer is reported `not-the-real-comment`). There is no local CLI answer.

```sh
node dist/test/entrypoints/journey18-qualification.js --plan      # inert
node dist/test/entrypoints/journey18-qualification.js preflight
node dist/test/entrypoints/journey18-qualification.js run         # stops at question-published; prints nothing to post, see run-result.answer.command
#   SUPERVISOR (operator's gh account): post run-result.answer.command on the issue
node dist/test/entrypoints/journey18-qualification.js resume      # expected merge-blocked while ruleset 26435808 has `update`
#   OPERATOR decides: stop here, or remove Restrict updates and:
node dist/test/entrypoints/journey18-qualification.js ready       # refused BEFORE its intent while `update` is active (nothing consumed)
#   OPERATOR: approve (required) + merge commit from own account; no bypass, no "Delete branch", auto-delete head branches OFF
node dist/test/entrypoints/journey18-qualification.js deliver     # precondition: own PR merged BY A HUMAN (merged_by recorded) at the linked head
node dist/test/entrypoints/journey18-qualification.js inspect     # works after any phase, held ones included
node dist/test/entrypoints/journey18-qualification.js stop-environment   # only if inspect shows a boot that may still run
```

| Phase | Expected |
| --- | --- |
| preflight | `success`, `restrictUpdates: true`, repository node id and operator id pinned |
| run | `question-published`: Execution initial ended `question`, cessation confirmed, Slot released, Question comment on the issue; `answer.command` recorded (if the Builder never asks: it continues and records the question subcase as NOT exercised) |
| resume | answer ingested from the real comment; recovery `QUESTION_ANSWERED` (verified) → recovery `PUBLICATION_REQUESTED`; own draft PR linked, no `GUEST_EFFECT_OUT_OF_SCOPE`; with `update`: `merge-blocked` (`MERGE_BLOCKED_UPDATE_RESTRICTED`, no draft mutation); without: `ready` |
| ready | ONE mark-ready, confirmed; Work open |
| deliver | delivered; cleanup complete; `status.delivery {delivered 1, complete 1}` |
| inspect | refs: only the own branch removed (main moved only by the human merge); issue closed by `Closes #N`; no token |

## Real run `q18-journey-v2` (issue #7, supervisor-run, consumed) — stopped at not-publishable

preflight ok; `run` published the Question; the supervisor posted the real `/factory answer` from the operator account; `resume` ingested it;
review round 1 Standards and Spec clean; publication `not-publishable` with `VERIFICATION:GATE_NOT_RUN:typecheck-lint`. The Builder had
declared a gate `typecheck-lint` citing `/artifacts/instructions/v2/AGENTS.md#Agent skills` with the command "Not applicable: no typecheck or
lint command is required…" (first `waived`, finally `not-run`); the repository documents no such command.

Gate: `npm run test:ci` on `c344433` + this branch: RESULT PASS, 1345 tests, 1335 pass, 0 fail, 10 skipped, 216.2 s.

Fix (product, TDD): (1) the implementation-mode Builder prompt and the handoff tool description: declare only gates whose exact command the
Ticket or the preserved instructions document, never one to say none exists; (2) the Host handoff validation reads each declared gate's
cited preserved source (fixed Host command through the Builder binding, path re-validated, bounded, no symlink) and refuses a gate whose
command is not an executable command documented there (`HANDOFF_GATE_NOT_DOCUMENTED`, in session, no round used, reason listed); a source
outside `/artifacts/spec|instructions/v<N>/` or unreadable is refused the same way. A REAL documented gate not run stays declarable and Control's
verification stays fail-closed (`GATE_NOT_RUN`). Test: `test/workers/handoff-gate-documented.test.ts` with that exact declaration (red before:
`gateCommandDocumented` absent and the handoff took no source reader). Next: namespace `q18-journey-v3` on a NEW issue the supervisor pins.

## Real run `q18-journey-v3` (issue #10, supervisor-run, consumed) — stopped at the publish-only activation

preflight ok; `run` published Question 1; the supervisor answered from the operator account; `resume` ingested it; the implementation was
verified (HEAD 77bb409 on `factory/10-ae15cdda`); the publish-only activation (Execution 8ee3290b, reused environment, `builder-publish`
grant delivered) then asked Question 2 instead of publishing: `git ls-remote origin` failed — `/workspace/checkout` had no `origin` remote
(the supervisor did not answer it). The host clone sets `origin` once, at the first preparation, inside the guest-writable checkout; a
reused environment reports the RECORDED origin (`checkout.json`) and never re-reads or rewrites the guest's `.git/config` (no host git in
guest-writable trees), so anything a guest session did to that config persists. Ticket 14's real run happened to keep it.

Fix (product, TDD): Control's publication instruction names the CONFIGURED repository URL itself (`git -C … push --force-with-lease=… 
https://github.com/<repo>.git <head>:refs/heads/<branch>`, `git ls-remote https://github.com/<repo>.git`, `gh pr list --repo <repo>`), never
`origin`: the guest's remote configuration (missing, or repointed elsewhere) no longer matters, and the delivered `builder-publish` grant
authenticates github.com HTTPS for that command only (the existing `credential.https://github.com.helper`). Host git still never touches the
guest tree. Tests: `publication-rules` (URL, no `origin` anywhere in the instruction), `publication-flow`, `journey-composed` (the
production-composed publish-only activation's instruction carries the configured URL and a `builder-publish` grant). Note for ticket 21's
`push-policy.ts`: the exact lease form now uses that URL instead of `origin`. The v6 skill pack's `pr` example still shows `origin`; it says
to push "exactly as the request says", and the request is authoritative. Next: namespace `q18-journey-v4` on a NEW issue.

## Real run `q18-journey-v4` (issue #14, supervisor-run with operator authorization) — PASSED

Copied verbatim (secret scan over every file: no `ghs_/ghp_/gho_/ghu_/github_pat_`, JWT, private key or OAuth token material; the recipe's
own storage scan `{ghs: false, privateKey: false}`): `18-real-journey-v4-{preflight-result,run-result,resume-result,ready-result,
deliver-precondition,deliver-result,inspect-result}-2026-11-15.json`, `18-real-journey-v4-gh-trace-2026-11-15.jsonl`.

| Expected (`plan().expected`) | Observed | Verdict |
| --- | --- | --- |
| preflight success, `restrictUpdates: true` | success, reasons `[]`, `restrictUpdates: true`, skill pack `factory-skills-v6`, operator id 1881597 pinned | met |
| run: question-published (initial ended `question`, cessation confirmed, Slot released, comment) | outcome `question-published`; Execution `2d55c2cc` initial, stopped, end `question`, cessation confirmed; question subcase exercised; `answer.command` recorded | met |
| resume: the real comment ingested | `answerIngestion: ingested`, author `{github, 1881597, Sanmoo}`, origin `github-comment` (posted by the supervisor with the operator's account) | met |
| resume: recovery `QUESTION_ANSWERED` verified, publish-only `PUBLICATION_REQUESTED` with `builder-publish` | `3c8b7d3e` recovery completed, rounds r1 review (Standards and Spec complete, no findings), r2/r3 exemptions `unchanged`; verification `verified`, gate `ticket-validation` passed and bound to the final content; `0860b0f6` recovery `PUBLICATION_REQUESTED`, credential `builder-publish` | met (no finding to treat in this run; treatment is proven by `journey-composed` and ticket 13's real run) |
| own draft PR, App bot author, conformant description, no `GUEST_EFFECT_OUT_OF_SCOPE` | `published`: PR #15, head `54b268d`, `factory/14-2ece4778`, author `sanmoo-factory[bot]`, description conformant; impediments `[]` | met |
| with `update`: merge-blocked, no draft mutation | outcome `merge-blocked`: `merge`/confirmed `MERGE_BLOCKED_UPDATE_RESTRICTED` (`update@ruleset:26435808:Repository:Sanmoo/java-springboot-event-sourcing`); no mutation in the resume trace | met |
| operator step | supervisor removed `update` (authorized) | — |
| ready: one mark-ready confirmed | effects `[mark-ready confirmed, revocation revoked]`; Work open | met |
| operator step | approval and merge from the operator account: merge commit `9cf5bb5`, no bypass, no branch deletion | — |
| deliver precondition: merged by a human at the linked head | held `null`; `merged_by {Sanmoo, 1881597, User}` | met |
| deliver: delivered, cleanup complete | `result delivered`; cleanup `complete`: environment, checkout, local-branch, temporaries, remote-branch `removed`; evidence preserved | met |
| inspect: delivery counts, refs, issue, no token | `status.delivery {delivered 1, cleanup complete 1}`; refs vs preflight: only `refs/heads/main` moved (by the human merge; the own branch was created and deleted inside the run); issue #14 `closed/completed`; PR closed, merged, not draft; secret scan clean | met |
| gh guard | 174 requests, 0 refused; writes: 1 question comment, 1 mark-ready, 1 branch deletion, token self-revocations | met |

Durations (controller monotonic): initial 103.4 s, recovery 126.0 s, publish-only 29.3 s; the answer wait and the operator steps between
phases are outside these. Afterwards the supervisor restored `update`; no qemu process was left; the key copy was removed.

**All attempts.** v1: preflight held (the label listed #1 and #7) — recipe precondition, as designed. v2 (#7): `not-publishable`
`GATE_NOT_RUN:typecheck-lint` (invented gate) — fixed by `HANDOFF_GATE_NOT_DOCUMENTED`. v3 (#10): publish-only checkout without `origin` —
fixed by the configured URL in the instruction. v4 (#14): passed.

## Decisions and remaining questions

1. y5 inventory restriction kept (supervisor). 2. `ready` keeps refusing while `update` is active; the operator is asked at that moment.
3. The answer is a real `/factory answer` comment posted by the supervisor with the operator's account. 4. Prompts are per session mode.
5. Remaining: a guest command guard reads command text and can be bypassed by obfuscation; the Control verification is the backstop and
   runs at the discovery after the publication activation (a later out-of-scope change is ticket 16/17 territory: readiness loss, delivery).
6. Consumption: model usage only from the session records; no provider billing hard cap.

## Gate

`npm run test:ci` on `8a91799` + the main ticket 18 commit: **RESULT: PASS** — 1342 tests, 1332 pass, 0 fail, 10 skipped; 197.6 s of 600 s
(load 11.2 → 13.9; lock wait 481.7 s). The run before it failed only on `/tmp` tmpfs quota (EDQUOT, shared machine), not on code.
`journey-composed` is `slow` in `test/tiers.json` (13–32 s). `github-checks-composed` now waits on the runner budget (`until`, ticket 37)
instead of 800 iterations, which were too few at load ~17. The separate guard commit on top fails `publication-boundary` (no Git/gh
shell parser in Workers, ticket 14) and `native-builder-write` (Builder composition) BY DESIGN of that contract: it is not integrated
and is meant to be folded into ticket 21's `push-policy.ts`, which owns that decision.

Final branch `implement/software-factory-mvp-18-final` (one commit on integration `c344433`, without the issue-pin/namespace churn and
without the guest guard commit b857011 — ticket 21's `push-policy.ts` is the single guard): `npm run test:ci` **RESULT: PASS** — 1345 tests,
1335 pass, 0 fail, 10 skipped; 279.9 s of 600 s.
