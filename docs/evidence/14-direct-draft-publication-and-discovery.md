# Ticket 14 — Direct draft publication and discovery of the own PR

Branch `implement/software-factory-mvp-14`, rebased on integration `d4483d1` (tickets 01–13, 19, 20, 32). Ticket 13's
`ExecutionView.review.verification` and the final capture's `summary.content` are consumed with their real types; the flow and composition
tests produce them through ticket 13's REAL review rounds (scripted Builder captures + scripted reviewers), no storage seed.

## Composition

- Contracts: `BuilderGrantPurpose = 'builder-start' | 'builder-publish'`; `BuilderCredentialContext.purpose` (Control's choice, default
  `builder-start`); `publicationMarkerPrefix` (`<!-- software-factory:work:<work-id> -->`, first body line).
- GitHub (`src/platform/github`): `builder-publish` = Metadata R, Contents W, Pull requests W, Issues R for the Work's own repository only,
  never Workflows; `publication-read` = Metadata/Contents/Pull requests/Administration R for discovery. `appIdentity(scope)` pins the
  Factory App bot (`GET /app` slug, then `GET /users/<slug>[bot]` with an installation token). The controller's only write stays the Question
  comment: **no push gateway, no PR creation by the controller** (static gate `test/architecture/publication-boundary.test.ts`).
- CodeRepository `findPublication` (contract: "refs e candidatos ao PR próprio"): candidates carry `headSha`, `baseRef`, `draft`, bounded
  `body`; `branches` = known own branch tips (complete `matching-refs` listing; failure = `unknown`); with `refs: true` every branch/tag tip
  (bounded, never partial); with `base` whether it requires pull requests with no App bypass (ruleset `current_user_can_bypass: never`, or
  classic required reviews without App bypass allowances).
- Control (`rules/publication.ts`, `durable/publication.ts`; hooks in `dispatch.ts`/`execution.ts`):
  1. After a completed implementation Execution ceased, the tick records the **publication basis**: `awaiting-discovery` only when ticket 13's
     verification is `verified` and the final capture is committed (clean tree, HEAD holds it); otherwise `not-publishable` with reasons.
     `completed` is never success by itself. A later verified basis is evaluated again even after a publication (it may update the own PR).
  2. **Discovery** (safe read, also while paused, never during an activity; at most 4 per tick; one Work's failure is recorded and does not
     stop the others): own = Work marker + the PINNED App bot (login and id) + own branch/repository/base. Exactly one own draft PR at the
     verified head with a conformant description → `published`. Complete absence, verified head never attempted, complete refs snapshot and a
     base requiring PRs without App bypass → `requested` (lease expectation + refs snapshot recorded). A linked own PR at an earlier Factory
     head → `requested` as an UPDATE of that PR (lease on its head). Before any attempt an unknown associated PR is `held` (re-read; ticket 07
     operator path); after an attempt it blocks. Several own candidates, unknown own-branch change, any other branch/tag changed during the
     window (`UNEXPECTED_REF_CHANGE`), an own PR not acceptable (other head, not draft, `DESCRIPTION_NONCONFORMANT`, closed/merged), an
     unprotected base, or absence after an attempt → `blocked` + `PUBLICATION_BLOCKED`. Incomplete read or unknown App identity → nothing decided.
  3. **Publish-only activation** through the queue: `resume.reason = PUBLICATION_REQUESTED`, `request.publication` = {basis, verified head,
     branch, base, marker, expectedRemote, pullRequest (update target or null)}, re-checked in the admission commit (an attempted head is
     refused); grant purpose `builder-publish` (activation/renewal refuse any other); phaseId `builder-publication`; ALWAYS a new session
     (`Factory publication instruction (publish-only session …)`), no `handoff`, no `edit` tool (policies recorded without it). The attempt is
     recorded at the ACTIVATION commit (before any launch or receipt): a lost receipt/crash never leads to a second activation; only a
     discovery after cessation decides. Bash/write remain, but no other content is ever accepted (verified head + refs check).
- Skill pack `factory-skills-v6` = v5 (ticket 13) + `implement` §2/§8 (publish-only activation), `pr` (short Summary/Validation/Risk body,
  marker, Ticket link, no transcripts/local links, "Factory publication" procedure incl. update of the own PR) and `prompts/pr.md`;
  `continuation: true`, newest registered entry, so ticket 32's production composition derives it. v1–v5 untouched. Production composes
  `factoryApp: () => github.appIdentity(...)` and the real `createBuilderCredentials` (publish purpose honoured).

## AC → tests (evidence level)

R = rules; S = real Control + SQLite with doubled boundaries; I-local = real adapters/issuer over the world fixture; static = source scan.

| AC / review finding | Tests | Level |
| --- | --- | --- |
| 1 direct publication, restricted App, no gateway, /pr ≠ publication | `github-publication` AC1, `publication-composition` (Builder writes refs/PR with ITS grant; controller writes nothing), `publication-commits` AC1/AC5, `publication-boundary`, `skill-pack-v6` | R + S + I-local + static |
| 2 unambiguous association; draft after reviews; Ticket open | `publication-rules` AC2, `publication-flow` (real 13 verification; failed gate / uncommitted / no reviews → nothing, no write grant) | R + S + I-local |
| 3 description | `publication-rules` AC3 + `DESCRIPTION_NONCONFORMANT` blocks linking as published | R |
| 4 absence → request; branch name ≠ authorship; unknown PR not adopted | `publication-rules`, `publication-flow` AC4 (held + operator path, unknown branch change) | R + S |
| 5 normal records keep refs/evidence; no wrapper/parser | `publication-commits`, `publication-flow` (request.publication, refsBefore, attempts), `publication-boundary` (broadened heuristic), recipe `sessionCommands` | R + S + static |
| 6 lost result discovered; ambiguity blocks | `publication-flow` AC6 (failure + restart; nothing visible; two own PRs; incomplete reads), `github-publication` AC6 | R + S + I-local |
| HIGH 1 publish-only | `publication-flow` HIGH 1 (no handoff/edit/continuation, reviewers only for the implementation) | S |
| HIGH 2 attempt before launch | `publication-commits` (attempt at activation commit; refused activation is not an attempt), `publication-flow` HIGH 2 (lost receipt → never a second activation) | S |
| MED 3 pinned App identity | `publication-rules` (other bot, login/id, unknown identity), `github-publication` MED 3, composition | R + I-local |
| MED 4 refs + base protection | `publication-rules` MED 4, `publication-flow` MED 4 (unprotected base, tag pushed), `github-publication` MED 4 | R + S + I-local |
| MED 5 recipe grant guard | `publication14-qualification.test` | R |
| MED 6 attempts bound to the head; update of the own PR | `publication-rules` MED 6, `publication-flow` MED 6 (scope update → second verified basis updates PR #4 once) | R + S |
| 7 real run | recipe ready; not run | — |

Red→green: the original slices (adapter 3/3, flow 5/5 red before wiring). Review fixes: with the review tests and the pre-review `src`,
rules 7/9, commits 1/2 and flow 5/8 fail; all green after the fixes.

## One-shot real-run recipe (`test/entrypoints/publication14-qualification.ts`)

Prerequisites (operator): issue #3 of `Sanmoo/java-springboot-event-sourcing` carries
`ticketBody` of the recipe and the label `ready-for-agent`, with **no associated pull request**; the App installation grants Contents RW and
Pull requests RW; `main` is protected with no bypass for the App (Contents W does not separate push from merge).

Run (compiled, from the repository root, Node command of the gate):
`node dist/test/entrypoints/publication14-qualification.js --plan` (inert), then each phase exactly once, in order:
`preflight`, `run`, `discover`, `inspect` (and `stop-environment` only if `inspect` shows a boot that may still run).

- `preflight`: read-only; v5/v6 registered and loadable, v6 newest and continuation-capable; label lists exactly #3; no associated PR; every
  branch/tag tip recorded and no `factory/3-` branch; `main` requires PRs with no App bypass; the App bot identity pinned.
- `run`: new storage `…/y5/q14-publication-v6`; implementation Execution (13 rounds ≤ 4); discovery → `requested`; ONE publish-only activation.
  From that activation on, the recipe makes own-branch discovery reads fail (**provoked lost result**). Stops when the publication Execution
  ended and its boot stopped (or hold/block/`not-publishable`, or 80 min).
- `discover`: new owner on the SAME storage; no prepare/activation/grant allowed; must link the own PR. Stops at `published`/`blocked` or 10 min.
- `inspect`: on an exclusive storage copy; bare-copy checkout inspection (never host git on the guest tree); PR body; session tool calls
  with bash texts (tokens masked); read-only GitHub: own PR, own branch, main tip vs preflight, issue state.

**Exact GitHub effects/bounds**: Builder (guest, direct, `builder-publish` grant, ≤ 2 issuances): 1 `git push` creating
`refs/heads/factory/3-<work8>` at the verified commit with an empty lease, and 1 **draft** PR to `main` (marker first line, `Closes #3`).
App: access-token POSTs and `DELETE /installation/token` revocations. Controller: reads only, plus at most one Question comment on #3 if the
Builder asks (the run then stops). Never: merge, approval, ready, push to `main`/other branches, labels/assignees, closing issue/PR, branch
deletion. The PR and branch remain after the run (cleanup is a later ticket; the operator may close them manually).

Expected observations: listed in `plan().expected` (verification `verified`; first discovery `absent`/branch absent; publication Execution
with `builder-publish`, `publish` or replacement prompt, lease and `gh pr create --draft` in its bash records; end of `run` with the
publication `awaiting-discovery` and `pullRequest: null`; after `discover`: `published`, draft PR at the verified head, no new Execution,
issue open, `main` unchanged).

## Open design questions

1. Base protection is read and REQUIRED before any publication request (review MED 4). The spec says the Factory does not certify or
   monitor the team's merge barriers; this check is a precondition of publication only, never a certification (decision for the operator).
2. After a publication attempt, an empty discovery blocks (`PUBLICATION_OUTCOME_UNCONFIRMED`); recovery is an explicit operator decision
   (ticket 26, which will also compose its receipt discovery with the activation-time attempt record).
3. Once a PR is linked, new Questions route to the PR surface, which is still refused (`QUESTION_DESTINATION_NOT_ENABLED`).
4. The publish-only session still has `write`/`bash` (always part of the Builder tool set); content changes are never accepted (verified
   head + refs window), but the guest checkout may diverge from the verified commit after such an activation.
5. Unexpected ref changes during the window cannot be attributed (a human push at the same time also blocks): explicit operator decision.

## Gate totals (review fixes, after the rebase on `d4483d1`)

`tsc -p tsconfig.json` rc=0; `eslint . --max-warnings 0` rc=0; dependency-cruiser: no violations (352 modules, 2139 dependencies);
every compiled `dist/test/**/*.test.js` run one file at a time with `--experimental-test-module-mocks --test --test-concurrency=1`:
170 files, 1067 pass, 0 fail, 10 skipped. `workers/sdk-profile.test.js` hit its known inner 15 s timeout under load in the full run and
passed alone (1/1). `test/sandbox/gondolin.test.ts` stays `skip: true`.
