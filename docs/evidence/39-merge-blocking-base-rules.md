# Ticket 39 — Base rules that block the merge are a readiness impediment

Branch `implement/software-factory-mvp-39`, rebased on integration `3fa202d`. Finding: ruleset 26435808 (`main`) `update` ("Restrict updates") made
GitHub refuse the human merge of PR #5 ("Cannot update this protected ref"), while tickets 15/16 had read it as `not-check-related` and
converted the PR to ready.

## Composition

- **CodeRepository** Q4B `readPullRequest`: the rules of the base now keep the parameters that can affect a merge (`RuleParameters`):
  `update.update_allows_fetch_and_merge`, `pull_request` (`allowed_merge_methods`, approvals, code owner, last-push approval, thread
  resolution, stale dismissal), `required_deployments.required_deployment_environments`. Absent parameters = GitHub defaults; parameters of
  another shape make only that rule `unparsed`.
- **Rules** `interpretBaseRules` (`src/control/rules/checks.ts`, pure, exported by Control for recipes): each modality gets `merge`
  (`blocking` / `not-blocking` / `human-stage` / `checks` / `unknown`), `reason` and `notes`, with its source. A blocking rule is a checks
  reason of category `merge` (outcome `blocked`; next step names rule + source and asks the operator to adjust the protection; the Factory
  never uses or recommends a bypass). Unknown impact is `indeterminate`.
- **Readiness** (`src/control/rules/readiness.ts`): category `merge` → area `merge`, **confirmed**, code `MERGE_BLOCKED_<reason>`, subject
  `<rule>@ruleset:<id>:<sourceType>:<source>`. Never `ready`; after a Factory-placed ready it is ticket 16's confirmed loss
  (`READINESS_LOST:MERGE_BLOCKED_UPDATE_RESTRICTED`, back to draft only over the Factory's own ready). The merge interpretation is part of
  `requirementsIdentity` (a parameter change is a new basis). `mergeable_state` is still never read (conflict comes only from `mergeable`).

| Rule | Interpretation | Condition |
| --- | --- | --- |
| `update` | blocking `UPDATE_RESTRICTED` | always; `update_allows_fetch_and_merge: true` only permits a fork's upstream sync (note), never the PR merge |
| `merge_queue` | blocking `MERGE_QUEUE_NOT_SUPPORTED` | merge-group checks are not read (ticket 15 limitation) |
| `required_deployments` | blocking `DEPLOYMENTS_REQUIRED` / not-blocking | non-empty / empty environments; missing parameters → indeterminate |
| `required_signatures` | blocking `SIGNED_COMMITS_REQUIRED` | the Factory neither signs nor verifies the commits a merge brings |
| `required_linear_history` | blocking `LINEAR_HISTORY_NO_ALLOWED_METHOD` / not-blocking (`MERGE_ONLY_BY:…`) / unknown `MERGE_METHODS_UNKNOWN` | allowed methods (∩ over `pull_request` rules) without / with squash or rebase / not restricted by rules (repo settings unread) |
| `pull_request` | human stage (notes: approvals, code owner, last push, thread resolution, `MERGE_ONLY_BY`) | blocking `NO_ALLOWED_MERGE_METHOD` when the intersection of allowed methods is empty |
| `copilot_code_review` | human stage | — |
| `required_status_checks` | ticket 15 requirements | — |
| `creation`, `deletion`, `non_fast_forward`, `branch_name_pattern`, `tag_name_pattern` | not-blocking `DOES_NOT_AFFECT_PULL_REQUEST_MERGE` | — |
| `commit_message_pattern`, `commit_author_email_pattern`, `committer_email_pattern`, `file_path_restriction`, `max_file_path_length`, `file_extension_restriction`, `max_file_size` | indeterminate `MERGE_IMPACT_NOT_EVALUATED` | the PR's commits/files are not evaluated against them |
| `workflows`, `code_scanning`, unknown, unparsed | indeterminate `RULE_NOT_INTERPRETABLE` | unchanged from ticket 15 |

## AC → tests

| AC | Tests | Level |
| --- | --- | --- |
| 1 modalities with source and reason; unknown indeterminate | `control/mergeblock-rules` AC1 ×3; `entrypoints/github-mergeblock-reads` AC1/AC5, AC1; `control/checks-rules` AC2/AC6 (updated: `merge_queue` now blocking) | R + I(sub) |
| 2 never ready; explained impediment, operator step, no bypass | `mergeblock-rules` AC2; `control/readiness-flow` ticket 39 AC2/AC3 | R + S |
| 3 loss after a Factory ready → ticket 16 rule | `mergeblock-rules` AC3; `readiness-flow` ticket 39 AC2/AC3 (Factory ready → `update` re-enabled → convert-to-draft confirmed; human ready untouched) | R + S |
| 4 `mergeable_state: blocked` neither conflict nor failed check | `mergeblock-rules` AC4; `github-mergeblock-reads` AC1/AC5 (verbatim PR #5 payload, `blocked`) | R + I(sub) |
| 5 real payload fixtures + real GET-only read | `fixtures/github-rules-main-26435808.json` = the VERBATIM `rules/branches/main` value of the real q39 preflight (replaces the earlier reconstruction); `github-mergeblock-reads` parses it; real read: run `q39-mergeblock-v1` below (**P**) | I(sub) + P |

Red → green: the new tests failed to compile against the pre-change sources (15 TS errors: missing `interpretBaseRules`, `parameters`,
`merge`); behavioural red was not run separately.

## One-shot real-run recipe (`test/entrypoints/mergeblock39-qualification.ts`)

`--plan` inert. Namespace `/home/sanmoo/software-factory-test/y5/q39-mergeblock-v1` (own GitHub access root with a key copy, removed at the
end). Phases once each (wx tombstones, phase guard: `evaluate` only after a successful `preflight`), ticket 15's GET-only gh guard tracing
every request. No Control/storage/Work. `preflight`: raw GETs of the repository, `branches/main`, `rules/branches/main`, `rulesets/26435808`
and `pulls/5`. `evaluate`: real `readPullRequest` of the closed PR #5 (only to collect the base requirements), `interpretBaseRules` over its
parsed rules, and a labelled counterfactual `evaluateChecks` as if open. Success = ruleset 26435808 has `pull_request`, `non_fast_forward`,
`deletion`, `update` and `update` is `blocking`. A missing App key source (`y5/credentials/app.pem`) now fails loudly with
`APP_KEY_SOURCE_MISSING: <path> …` before any effect (no directory, intent or GitHub call).

## Operator decisions (supervisor, 2026-11-15)

Accepted both strict choices: `update` is ALWAYS merge-blocking (also with `update_allows_fetch_and_merge`); rule types whose merge impact is
not evaluated (commit/file patterns) make readiness indeterminate. The real read-only run was authorized.

## Real run `q39-mergeblock-v1` (2026-11-15, operator-authorized, run by the supervisor; consumed) — PASSED

Raw results copied (secret scan over all files: no `ghs_/ghp_/gho_/ghu_/github_pat_`, JWT or private-key material):
`39-real-mergeblock-{preflight,evaluate}-{intent,result}-2026-11-15.json`, `39-real-mergeblock-gh-trace-2026-11-15.jsonl`.

| Expected | Observed | Verdict |
| --- | --- | --- |
| Active rules of main include ruleset 26435808 `pull_request`, `non_fast_forward`, `deletion`, `update` | all four, ruleset `mastra-factory-proof-main-review`, enforcement `active`, `current_user_can_bypass: never` for the App; `update` sent WITHOUT parameters (default: no fetch-and-merge); `pull_request`: 1 approval, `dismiss_stale_reviews_on_push: true`, methods merge/squash/rebase, plus keys the adapter ignores (`required_reviewers`, `require_extra_approval_for_unattributed_changes`) | **met** |
| interpretBaseRules: update merge-blocking, pull_request human stage, non_fast_forward/deletion not-blocking, with source | `update` blocking `UPDATE_RESTRICTED`; `pull_request` human-stage `HUMAN_REVIEW_STAGE` (`APPROVALS:1`); `non_fast_forward`, `deletion` not-blocking; all `ruleset:26435808:Repository:Sanmoo/java-springboot-event-sourcing`; verdict `success`, reasons `[]` | **met** |
| Counterfactual open: blocked with merge reason; no conflict from mergeable_state | outcome `blocked`, reasons `[merge:UPDATE_RESTRICTED:update@…]`; conflict `unknown` (PR #5 is merged, `mergeable: null`, `mergeable_state: unknown` — not derived from mergeable_state) | **met** |
| GET only | 16 requests, all GET, all allowed (`getOnly: true`) | **met** |

Other facts: repository merge settings (`allow_*_merge`) are not returned to the App (null) — the recipe's evidence of why Control does not
use them; classic protection `enabled: false`, status checks `off`.

Run history (honest): two earlier `preflight` starts failed BEFORE any effect (no intent tombstone, no GitHub call) because the supervisor
had removed `y5/credentials/app.pem` at the end of the previous wave; the empty namespace directories they left were removed, the key was
restored for the run and removed again afterwards. The recipe's new `APP_KEY_SOURCE_MISSING` check makes that case explicit.

## Gate

`npm run test:ci` (after the real run, rebased on `3fa202d`): **RESULT: PASS** — 1317 tests, 1307 pass, 0 fail, 10 skipped; 196.5 s of 600 s (load 5.5 → 13.0).

`npm run test:ci` (first gate, on `9ca7bfa`): **RESULT: PASS** — 1316 tests, 1306 pass, 0 fail, 10 skipped; 230.8 s of 600 s (load 14.9 → 13.3). (Real run: see above.)

## Limitations

- Classic branch protection's `lock_branch`, signatures and linear history are not read (only its required status checks summary).
- Repository merge settings (`allow_squash_merge`, …) are read only as evidence by the recipe; Control does not use them (`MERGE_METHODS_UNKNOWN`).
- Bypass actors are not read: a rule that blocks anyone without bypass is blocking regardless of who has bypass.
