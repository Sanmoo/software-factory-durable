# Ticket 14 — Direct draft publication and discovery of the own PR

Branch `implement/software-factory-mvp-14`, rebased on integration `9f75f22` (tickets 01–12, 19, 20, 32). **Ticket 13 is not integrated
yet**: this branch consumes its record `ExecutionView.review.verification` and the final capture `handoff.summary.content` structurally
(`src/control/rules/publication.ts`), and the local flow tests SEED that record into the real SQLite storage between two owner runs. The
real run requires 13 (the recipe refuses without `factory-skills-v5`).

## Composition

- Contracts: `BuilderGrantPurpose = 'builder-start' | 'builder-publish'`; `BuilderCredentialContext.purpose` (Control's choice, default
  `builder-start`); `publicationMarkerPrefix` (`<!-- software-factory:work:<work-id> -->`, first body line).
- GitHub (`src/platform/github`): `builder-publish` = Metadata R, Contents W, Pull requests W, Issues R for the Work's own repository only,
  never Workflows; `publication-read` = Metadata/Contents/Pull requests R for discovery. The controller's only write stays the Question
  comment: **no push gateway, no PR creation by the controller** (static gate `test/architecture/publication-boundary.test.ts`).
- CodeRepository `findPublication`: candidates now carry `headSha`, `baseRef`, `draft` and a bounded `body`; `branches` reports each known own
  branch tip from a complete `git/matching-refs` listing (`absent` only from a complete read; failure = `unknown`).
- Control (new modules `rules/publication.ts`, `durable/publication.ts`; hooks in `dispatch.ts`/`execution.ts`):
  1. After a completed implementation Execution ceased, the tick records the **publication basis**: `awaiting-discovery` only when ticket 13's
     verification is `verified` and the final capture is committed (clean tree, HEAD holds it); otherwise `not-publishable` with reasons
     (`REVIEW_VERIFICATION_ABSENT`, `REVIEW_NOT_VERIFIED`, `VERIFIED_CONTENT_NOT_COMMITTED`…). `completed` is never success by itself.
  2. **Discovery** (safe read, also while paused, never during an activity): own = Work marker + App bot author + own branch/repository/base.
     Exactly one own draft PR at the verified head → `published` (Work.pullRequest set; Ticket/Work stay open). Complete absence and **no
     earlier publication attempt** → `requested` with the observed lease expectation (`absent`, or the verified commit already on the branch).
     Several own candidates, an unknown associated PR, an unknown branch change, an own PR not acceptable (other head, not draft, closed/merged)
     or absence after an attempt → `blocked` + `PUBLICATION_BLOCKED` impediment. Incomplete read → nothing decided (re-read next cycle).
  3. **Publication activation** through the queue: `resume.reason = PUBLICATION_REQUESTED`, `request.publication` = {basis, verified head,
     branch, base, marker, expectedRemote}, re-checked in the admission commit; grant purpose `builder-publish` (activation/renewal refuse any
     other); phaseId `builder-publication`; `publish` message to the SAME compatible session, else a replacement "Factory publication
     instruction" with its reason. The Builder pushes with `--force-with-lease=refs/heads/<branch>:<expected>` and runs `gh pr create --draft`
     itself. Its start (`Confirmar início`) moves the publication to `awaiting-discovery`: it is never requested again, and nothing else is
     admitted (`PUBLICATION_DISCOVERY_PENDING`) until a discovery decides.
- Skill pack `factory-skills-v6` (v1–v4 untouched; `continuation: true`, so ticket 32's production composition derives it): `implement` §2/§8,
  `pr` with the short Summary/Validation/Risk body, marker, Ticket link, no transcripts/local links, and the "Factory publication" procedure.
  At the rebase on 13, v6 is re-derived from 13's v5 with the same textual changes.

## AC → tests (evidence level)

| AC | Tests | Level |
| --- | --- | --- |
| 1 direct publication, restricted App, no gateway, /pr ≠ publication | `github-publication` AC1 (start grant 403, publish grant creates ref/PR at the fixture), `publication-commits` AC1/AC5, `publication-flow` AC1…, `publication-boundary`, `publication-rules` AC1/AC5, `skill-pack-v6` | R + S + I-local (fixture); real: recipe |
| 2 unambiguous association; draft after reviews; Ticket not closed | `publication-rules` AC2 (verified basis, ownership), `publication-flow` AC1… and AC2 (not verified → nothing, no write grant) | R + S |
| 3 short description, details separate, no local links | `publication-rules` AC3 (`descriptionCheck`), `skill-pack-v6` | R (shape check only) ; real: recipe |
| 4 absence → request; branch name ≠ authorship; unknown PR not adopted | `publication-rules` AC4/AC6, `publication-flow` AC1… and AC4 (unknown PR / unknown commit block, nothing requested) | R + S |
| 5 normal records keep refs/evidence; no intent/ACK/wrapper/parser | `publication-commits` (request.publication with the lease), `publication-flow` AC1… (record), `publication-boundary`, recipe `sessionCommands` | R + S + static |
| 6 lost result discovered before repeating; ambiguity blocks | `publication-flow` AC6 (worker failure + owner restart → linked, no repeat; nothing visible → `PUBLICATION_OUTCOME_UNCONFIRMED`; two own PRs; incomplete reads), `github-publication` AC6, `publication-rules` | R + S + I-local |
| 7 real agent + real GitHub | `publication14-qualification.ts` (recipe), `publication14-qualification.test.ts` (inert/guards) | pending authorized real run |

Red→green: adapter test red against the previous adapter (3/3 fail) then green; flow tests red with `dispatch.ts`/`execution.ts` reverted
(5/5 fail) then green; rules/commit tests written before their implementation slices were wired.

## One-shot real-run recipe (`test/entrypoints/publication14-qualification.ts`)

Prerequisites (operator): ticket 13 integrated and this branch rebased on it; issue #3 of `Sanmoo/java-springboot-event-sourcing` carries
`ticketBody` of the recipe and the label `ready-for-agent`, with **no associated pull request**; the App installation grants Contents RW and
Pull requests RW; `main` is protected with no bypass for the App (Contents W does not separate push from merge).

Run (compiled, from the repository root, Node command of the gate):
`node dist/test/entrypoints/publication14-qualification.js --plan` (inert), then each phase exactly once, in order:
`preflight`, `run`, `discover`, `inspect` (and `stop-environment` only if `inspect` shows a boot that may still run).

- `preflight`: read-only; label lists exactly #3; no associated PR; records the tip of `main`.
- `run`: new storage `…/y5/q14-publication-v6`; implementation Execution (13 rounds ≤ 4); discovery → `requested`; ONE publication activation.
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

1. Own-PR authorship is "Bot author + marker + own branch/repo/base"; the App's bot user id is not pinned (the pulls REST payload has no
   `performed_via_github_app`). Pinning the login/id from configuration would tighten it.
2. After a publication attempt, an empty discovery blocks (`PUBLICATION_OUTCOME_UNCONFIRMED`) instead of re-requesting; recovery is an
   explicit operator decision (ticket 26).
3. Once a PR is linked, `questionDestination` routes new Questions to the PR surface, which is still refused (`QUESTION_DESTINATION_NOT_ENABLED`)
   until the PR comment surface exists.
4. A publication activation keeps the handoff tool (session compatibility); if the Builder hands off anyway, 13's review machinery runs.
5. An I-local composition test (real adapters over the world fixture + Control) needs ticket 13's verification produced by real rounds;
   it is added after the rebase on 13, together with replacing the storage seed of the flow tests.

## Gate totals (after the rebase on `9f75f22`)

`tsc -p tsconfig.json` rc=0; `eslint . --max-warnings 0` rc=0; dependency-cruiser: no violations (337 modules, 2019 dependencies);
every compiled `dist/test/**/*.test.js` run one file at a time with `--experimental-test-module-mocks --test --test-concurrency=1`:
158 files, 1015 pass, 0 fail, 10 skipped (`test/sandbox/gondolin.test.ts` stays `skip: true`).
