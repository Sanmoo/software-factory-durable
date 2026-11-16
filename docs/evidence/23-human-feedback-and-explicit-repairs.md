# Ticket 23 — Human feedback and explicit repairs in the same cycle

Branch `implement/software-factory-mvp-23`, rebased onto integration `6f8db3d` (tickets 21 and 22 integrated; the ticket 19
budget fix is in integration as `cc7b411`, dropped here). Ticket 25's `resume` is the single command; tests follow ticket 40 (runner-budget waits). Authority: [ticket 23](../../.scratch/software-factory-mvp/issues/23-human-feedback-and-explicit-repairs.md),
spec §§10, 11.3; scenarios V-10/V-11. Reuses ticket 10 (strict `/factory` prefix, operator authorization, answers), 11 (`update-scope` phase
answers, continue/replace session), 13 (review rounds), 14 (publication, update of the same PR), 16 (readiness stays human for review/merge),
19 (corrections budget, charge once at confirmed start, `preserve` for a charged correction), 21 (lease, human commits), 22 (correction,
repair desk, revalidation before admission, repair section, repair queue). No new queue, scheduler, per-event state machine or consumption ACK.

**State: implementation and local suite green (levels R/S/I-local); real run NOT executed** (no GitHub/VM/model/credentials). No checkbox
marked; ticket not resolved. A double does not prove the replaced boundary.

## Design

- **Single durable entry** (`WorkView.feedback`, bounded): every human request — an operator's `CHANGES_REQUESTED` review, an explicit repair from
  `factory repair <work> --reason` or a strict `/factory repair <reason>` comment on the Ticket or on the own PR — is recorded ONCE with identity
  (`review-<id>` / `repair-<request id>`), origin, author (login + id), URL, version (the commit the review was on, or the Factory head at
  acceptance), content (review body + inline comments, or the reason) and its hash; states `pending → in-correction → treated | withdrawn`.
  Not a cursor/transcript reconstruction: the record is the context the Builder receives.
- **One authentication/correlation path** (`rules/feedback.ts` `commentCommand`, `durable/feedback.ts` `ingestComment`): strict prefix, configured
  human operator (pinned id when configured), never App-performed/bot/third party; a repair comment must be unedited and written after the
  Work's admission; answers keep their ticket 10 eligibility. Ticket comments go through the question desk loop (now also for Works with an own
  PR or an open correction), PR conversation comments through the feedback desk; both call the same function. Unauthorized commands leave a
  bounded summary (`feedback.ignored`), never a request.
- **Reviews** (`reviewRequests`, pure): an operator's `CHANGES_REQUESTED` is a trigger whatever commit it was on (a push never removes it; human
  fingerprints exclude the head). A LATER `APPROVED` by the same reviewer, or a dismissal (GitHub reports `DISMISSED`), withdraws only THAT
  request (`APPROVED_LATER`/`DISMISSED`); independent requests stay; `COMMENTED` is prose. Approval never feeds readiness or "human merge
  approval satisfied" (readiness keeps `humanReview: human-stage`).
- **GitHub read** (`code-repository/feedback.ts` `readFeedback`, new reduced purpose `feedback-read {metadata, pull_requests, issues: read}`):
  three complete GET listings of the own PR (reviews, inline review comments, conversation); any item of another PR, malformed item or failed
  listing makes the whole read `unavailable` (nothing concluded, no withdrawal). The feedback desk runs every polling cycle before the dispatcher
  tick, whatever the Work is doing (recording is never delivery).
- **Folding into the correction** (ticket 22's `observeRepair`): commit order decides. Pending requests join the open correction (not charged:
  consolidated, a withdrawn one is dropped and a correction left empty is withdrawn without charge; charged: they enter the SAME correction "for
  its next safe activation"). A correction opened only by human requests has `trigger: human-feedback`. A fresh human request is never blocked by
  an old repeated impediment. On the Work's published own PR only; otherwise they wait.
- **No implicit retry, no injection**: a charged correction whose closure would happen while some of its human reasons were never delivered to
  a STARTED Execution of it is not closed: `continuing` + pending (history `repair-continued`); the dispatcher re-reads PR + feedback, and the
  admission (`REPAIR_REQUESTED`, re-checked in the commit) continues the published basis' session with charge `preserved` (same correction,
  charged once). Withdrawn-before-start requests of a continuation cancel it. Closing a charged correction marks its requests `treated`.
- **Phase answers** (`repairRequestDecision`/`repairPhase`): `repair` → `accepted` (idle, own PR published), `deferred` (activity, review,
  Question wait, publication under way), `already-covered` (same reason pending — "já atendido"), `not-applied` (closed/old Work, generic reason,
  no own PR). `update-scope` keeps ticket 11's `accepted/deferred/not-applied`. `resume` is ticket 25's single command (after the rebase): an
  active Work answers `already-satisfied: EXECUTION_ACTIVE` (nothing launched, no second Builder); suspension semantics are ticket 25's. No command launches an agent or lifts impediments.
- **Builder prompt** (`feedbackSection` inside ticket 22's `repairSection`): each request with identity/author/URL/commit/submitted-at and its
  content fenced as data; "address it; if already addressed by the current head or not applicable, demonstrate it (commit/file) and change
  nothing; unlike a Factory reviewer finding a human request is NOT yours to decline — disagreement, ambiguity or inability → `ask_user`"; never
  approve/dismiss/resolve reviews. Only tools the Builder session has are named (`ask_user`, `handoff`). A Question keeps the same correction.

## AC → tests

R = pure rules; S = real Control + Pi Durable/SQLite with real 13/14/15/16/22 flows, doubled GitHub/Sandbox/Workers/credentials/clock;
I-local = real adapter/CLI with a stubbed transport or the local world fixture.

| AC | Tests | Level |
| --- | --- | --- |
| 1 single authentication, no prose/bot/third party | `feedback-rules` AC1 (operator vs third party/bot/unknown/COMMENTED; `/factory repair` prefix, bot, via App, edited, predates, missing reason; answers still parse); `feedback-flow` AC1/AC2/AC3/AC5 (noise never triggers, ignored summary) and AC1 comments (PR + Ticket through the same path; edited/third party ignored; re-reads add nothing); `github-feedback-reads` (reduced read, foreign/malformed/failed = unavailable) | R + S + I-local |
| 2 identity/origin/version/content preserved | `feedback-flow` AC1/… (record: author id, URL, version H1, content, state treated, correction id; Builder prompt carries it); `feedback-rules` AC4/AC2 | R + S |
| 3 push does not remove; approval/dismissal removes only its trigger, never merge approval | `feedback-rules` AC3 (older commit, later approval same/other reviewer, earlier approval, COMMENTED, dismissal, head-free fingerprint); `feedback-flow` AC1/… (still CHANGES_REQUESTED after push: treated, no re-charge; later approval changes nothing; readiness human stage) and AC3/AC4 (approval withdraws the review, the explicit repair stays and runs alone) | R + S |
| 4 accumulates during activity, commit order, no injection/charge per event | `feedback-flow` AC4/AC5/AC6/AC7 (review + CLI repair during the repair Execution → same correction continued, charge preserved, consumed 1, 6 activations, nothing delivered to the running worker); AC4 withdrawal before start (no charge) | S |
| 5 already addressed vs disagreement → ask_user | `feedback-rules` AC5 (section text, fenced data, no invented tool) ; `feedback-flow` AC1/… (prompt) | R + S |
| 6 repair/update-scope/resume answers; resume active launches nothing; no command bypasses | `feedback-rules` AC6; `feedback-flow` AC4/… (`deferred`, ticket 25 `resume` → `already-satisfied: EXECUTION_ACTIVE` / `NOTHING_TO_RESUME`) and AC3/AC4 (`already-covered`); `update-scope-cli` (CLI shape, idempotency, `REQUEST_ID_CONFLICT`, offline indeterminate) | R + S + I-local |
| 7 real GitHub/CLI/agent proofs | recipe ready (`feedback23-qualification`), **not run** | — |

Mutations (restored; detected): closure without the undelivered-human check ⇒ `feedback-flow` AC4/… fails; human fingerprint including the head
⇒ `feedback-rules` AC3 fails. TDD honesty: rule/flow tests were written right after each slice, not strictly red-first; the first flow run failed
for real twice (a `??=` on the stored document mutated a detached copy and lost the first request; a continuation flag reset dropped the
publication request) — both fixed in the code, not the tests.

## One-shot real-run recipe (`test/entrypoints/feedback23-qualification.ts`) — not run

Namespace `/home/sanmoo/software-factory-test/y5/q23-feedback-v2` (v1 consumed, see below) (own GitHub access root). Order per phase: key source check (missing =
`APP_KEY_SOURCE_MISSING` before anything) → exclusive namespace mkdir (preflight only) → intent tombstone → key copy (`O_EXCL`, removed in
that phase's `finally`) → effects. `ticket.number` is 0 until the supervisor pins the NEW issue (every phase refuses). `correctionLimit: 3`;
`setDraft` stubbed. Every Control phase observes/stops the boots it started in `finally` and saves `<phase>-cessation.json`. Each human step is
asked with its exact command in `human-step-<k>-requested.json` and waited for ≥ 60 min (then held, consumed, no retry).

Phases: `preflight` (read-only) → `run` (implementation + own draft PR at H1) → `review` (HUMAN 1: `gh pr review <n> --request-changes` ⇒ ONE
correction, repair, leased H1→H2 on the SAME PR, treated; quiet cycles: no re-trigger although GitHub still shows CHANGES_REQUESTED on H1) →
`command` (HUMAN 2: `gh pr comment <n> --body '/factory repair …'` ⇒ correction + repair; HUMAN 3 asked when that repair STARTED: a second
REQUEST_CHANGES ⇒ continuation of the same correction with preserved charge, or one new correction if recorded after the closure — the
observation says which) → `withdraw` (the recipe pauses; HUMAN 4 REQUEST_CHANGES ⇒ pending correction; HUMAN 5 `gh pr review <n> --approve` ⇒
withdrawn without charge; unpause; no activation) → `inspect` (own PR, real reviews/comments payloads for a verbatim fixture, file at head,
session pushes) / `stop-environment`.

Repository setup: none beyond tickets 14–22 (App without bypass; Pull requests/Issues read for `feedback-read`). The operator's approval may
satisfy the approval count of ruleset 26435808; nobody merges.

## Gate

`npm run test:ci` on `84ef010` + this change: **PASS** — static tsc 16.6 s, eslint 9.2 s, depcruise 2.9 s; parallel lane 226 files (N=8), serial
lane 1 file; 1369 tests: 1359 pass, 0 fail, 10 skipped; 216.2 s of 600 s. After the supervisor decisions (fix commit + `nextStep`): **PASS**, 1372
tests, 1362 pass, 0 fail, 10 skipped; 237.6 s of 600 s (a concurrent `test:fast` hit its 180 s ceiling under load 18 from other sessions). New test files are fast and parallel-safe (temporary storage,
doubles, manual clock; the CLI checks extend the existing `update-scope-cli` controller boot): no `test/tiers.json` entry.
`test/sandbox/gondolin.test.ts` stays `skip:true`.

## Supervisor decisions (2026-11-15) applied

1. **resume**: kept minimal here; at the rebase after ticket 25 is integrated it is unified with ticket 25's `resume` (one command; ticket 25
   owns suspension semantics).
2. **Known limitation (MVP)**: "disagreement or inability ⇒ `ask_user`" is enforced by the Builder prompt only, not structurally. A Builder that
   finishes without a change "demonstrating" the request closes the correction (request treated); the operator can submit a NEW review (new
   identity ⇒ new correction). No per-request treatment in the ticket 13 handoff.
3. **Edited reviews** after recording are ignored (content preserved as recorded), consistent with ticket 10's edited comments.
4. **Repair without an own PR** stays refused (`REPAIR_REQUIRES_OWN_PULL_REQUEST`); the receipt's new `nextStep` points the operator to
   `factory update-scope <work> --reason <text>` (`repairNextStep`; test `feedback-rules` AC6). Every repair receipt now carries `nextStep`.
5. **ensureBudget** (ticket 19): reproduced RED against the real Pi Durable/SQLite store (`test/control/budget-legacy.test.ts`: the first grant
   on a Work without a budget record was lost — granted 0, no grant history) and fixed in the separate commit `fix(budget): …` at the bottom of
   this branch (assign, then read the stored record back; same in `applyRecoveryRequest`). The correction and recovery charges were not affected
   in practice (their exhaustion check re-reads `work.budget`); their tests guard the created record anyway.

## Independent review (2026-11-15) — fixes

- **MED continuation loop**: a charged correction is continued for undelivered human requests ONCE per new published basis
  (`correction.continuedBasis`); a not-publishable/blocked/diverged/base-changed closure closes it. Test `feedback-flow` "review fixes: … NOT
  publishable …" (no `repair-continued`, one `correction-closed`, no extra activation over 6 cycles).
- **MED silent loss**: `closeCorrection` treats only the requests delivered to a STARTED Execution of the charged correction; every other one
  returns to `pending` (same test: the undelivered request stays pending).
- **MED internal correction**: human reasons folded into an internal correction make it `human-feedback` (`adoptHuman`), so the dispatcher's
  repair path delivers them. Test "review fixes: … INTERNAL correction …".
- **Waiting note**: pending requests without a published own PR (and no correction) get the NON-blocking `feedback.waiting` next step (set and
  cleared on change, no history growth); they fold into a correction on the next published basis. Deliberately not an impediment: it would also
  block a legitimate implementation/scope activation of that Work.
- **LOW**: `/factory repair` is read on the Ticket of every open Work that has run at least once (a merely admitted Work reads no comments; the command stays eligible; cursor advances) and refused with the `update-scope` next step when there is
  no own PR. Operator `/factory repair` comments are answered on the Ticket by a controller reply (marker `software-factory:reply:<id>`; intent in
  the acceptance commit, attempt/observation, discovery via `findReply` after an unknown outcome, never a blind republication; the operator's text
  is never echoed). Test "review fixes: `/factory repair` on the Ticket …" (unknown outcome → discovered, exactly one reply). Reviews submitted
  before the Work's admission are ignored (`REVIEW_PREDATES_WORK`). Settled identities are tombstoned (`feedback.settled`, bounded 500) so an
  evicted record of a still-live CHANGES_REQUESTED is never re-recorded/re-charged.
- **Authorization limitation (reviews)**: GitHub reports no `performed_via_github_app` for reviews, so a review authorizes only when its author is
  a `User` whose id is PINNED in `operators` (`{ login, id }`); a login-only operator never authorizes a review (`AUTHOR_NOT_PINNED_OPERATOR`).
  Production configurations must pin operator ids for review triggers. Tests `feedback-rules` AC1 (login-only, reused login, non-User).
- **Recipe**: boots whose start is uncertain (failure/throw) are tracked by environment and observed/stopped in `finally` (the environment's
  published boot); the withdraw phase unpauses in `finally` and records it (`withdraw-unpause.json`).
- Mutations (restored; each detected by one test): treating undelivered requests; no adoption of an internal correction; continuing after a
  non-published closure.
- **Overlap with ticket 22's review fixes**: `src/control/rules/repair.ts` only gains `observationDriven`, the head-free human `fingerprint`, the
  fresh-human exception in `repairDecision`'s repeated branch and two `describe` entries; `src/control/durable/repair.ts` (`observeRepair`)
  carries the fold, closure/continuation bound, `adoptHuman`, `noteWaiting` and the desk-pass condition. Conflicts there are expected at the rebase.
- **AC7 (real proof) is pending**: the recipe is kept and will be run after integration (explicit operator authorization per run).
- Gate after the review fixes: `npm run test:ci` **PASS** — 1397 tests, 1387 pass, 0 fail, 10 skipped; 204.6 s of 600 s (lock wait 1140 s apart).
  `test:fast` repeatedly hit its 180 s ceiling under load ~19 from other sessions (no assertion failed; the affected suites pass in isolation).
- Gate after the rebase onto `172b027`: `npm run test:ci` **PASS** — 1497 tests, 1487 pass, 0 fail, 10 skipped; 196.7 s of 600 s.
- Gate after the rebase onto integration `6f8db3d` (ticket 22 integrated): `npm run test:ci` **PASS** — 1501 tests, 1491 pass, 0 fail, 10 skipped; 213.8 s.

## Real run q23-feedback-v1 (issue #38) — held in `run`; fix

The Builder preserved the repository instructions under `/artifacts/instructions/v1/` and then called `read` on
`/artifacts/instructions/v1/AGENTS.md`: `READ_PATH_DENIED`. It took the bare code for an inaccessible source and asked Question 7a17f543
(correct per the skill's blocker rule). **Root cause: not a regression of the allowlist.** The Builder's `read` has served only its own skill
pack files and copies of its own Bash output since `5be2ba4`/`f6afc8f` (tickets 05/10/12, asserted by `builder-pack-read`: "nothing else under
/artifacts becomes readable"); earlier Builders read preserved files with `bash cat` (the `read` calls of preserved instructions in the ticket 22
evidence are the reviewers', whose read covers `/artifacts`). The gap was the bare denial code. Fix (separate commit, integration affected):
for a Builder, `READ_PATH_DENIED` now says to use bash for `/workspace/checkout` and `/artifacts` files and that it is not a missing source nor
a blocker (`builderPathDeniedMessage`, same code prefix, policy unchanged); red test with the exact path in `builder-pack-read`. The recipe
namespace moves to `q23-feedback-v2`, issue 0 (re-pin before running).

## Real run q23-feedback-v2 (issue #42, PR #43) — `command` held; analysis, product fix, offline score

Phases `preflight`, `run`, `review` exit 0. Human steps 1–3 were executed once each from the operator account (05:48 REQUEST_CHANGES; 06:05
`/factory repair` comment; 06:09 second REQUEST_CHANGES during the repair). `command` ended HELD (`PHASE_NOT_AS_EXPECTED`) — `withdraw` was not
run; `inspect` ran. Saved results are copied as `23-real-feedback-v2-*-2026-11-16.json`.

**What happened in `command`.** The explicit repair opened correction 2 (`human-feedback`, charged once, `corrections` consumed 2 in total). The
step-3 review was recorded at 09:11:12, DURING that repair (started 09:09:41, ended 09:11:58), and was not delivered to it. The reviewers of round
r7 then ran. Spec reported a finding: the earlier operator-requested `## Review notes` section "exceeds the Ticket", because the preserved request
`spec/v3` held the Ticket and only the LATEST repair. The Builder followed the human-request rule (AC5): it did not decline either request and
asked Question d9224307 (`QUESTION_PENDING`). The v2 oracle treated any `QUESTION_PENDING` as an end, so the phase stopped there.

**Verdict.** Two causes:
1. **Product gap (fixed with a red test).** The reviewers never received the operator requests this Work had accepted, so an earlier human request
   looked out of scope to a later Spec round. `planReviews` now takes `operatorRequests`: every `treated`/`in-correction` request, with its id,
   author and fenced content as data. The note says they are part of the authorized request, a change that implements one is in scope (never a
   finding for exceeding the Ticket), each must be addressed, and a real contradiction is still a finding. Red test: `feedback-flow` AC1 asserts
   the repair round's Spec prompt carries the request and the first implementation's does not.
2. **Recipe oracle (fixed).** A Builder Question is legitimate (AC5). The recipe now surfaces it once in `operator-question-requested-<n>.json`,
   with the exact `/factory answer` command, and waits ≥ 60 min. It allows ONE question-resumed implementation per phase and counts it in the
   expected activations.

**Offline score** (`verdictV2`, `23-real-feedback-v2-verdict-2026-11-16.json`, from the saved results only): 6/6 proven, namely:
- `review`: ONE `HUMAN_CHANGES_REQUESTED` correction, published and charged; the request is treated and not re-charged after the push.
- `command`: the `/factory repair` comment was recorded (operator, `github-comment`), and the controller's reply was published on issue #42.
- `command`: correction 2 is `human-feedback` and was charged once.
- `command`: the step-3 review was recorded during the activity and not injected (one Builder activation in the phase).

**Not proven by v2:**
- the continuation of the SAME correction for the during-activity review (the phase stopped at the Question);
- `withdraw` (steps 4/5).

The withdraw path is proven at flow level only (S, real Control/SQLite, doubled GitHub). Its real boundary differs from what v2 exercised: an
APPROVE review submitted from the operator account, its observation by `feedback-read` as a later APPROVED review of the same reviewer id, and a
correction withdrawn without charge while paused. None of that is in the v2 evidence (v2 shows only CHANGES_REQUESTED reads). **A real v3 is
needed** for the withdrawal and the continuation. The recipe namespace is now `q23-feedback-v3`, issue 0; re-pin before running. PR #43/issue #42
are left to the supervisor.
- Gate after the v2 fixes: `npm run test:ci` **PASS** — 1524 tests, 1514 pass, 0 fail, 10 skipped; 277.3 s.
