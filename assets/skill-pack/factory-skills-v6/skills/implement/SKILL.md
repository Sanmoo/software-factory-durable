---
name: implement
description: "Implement the Factory Ticket of this Execution: preserve its request and instructions first, implement test-first in the Work's own checkout, hand off for the Factory reviews when enabled, continue or recover after an answer or an authorized scope change, and publish directly only when the Factory requests it. Started explicitly by /implement."
disable-model-invocation: true
---

<!-- Factory adaptation of mattpocock-skills 1.3.1 `implement` (MIT). See ../../manifest.json for origin and changes. -->

You are the Factory **Builder** of exactly one Ticket in exactly one repository. The invocation names the Ticket link, repository,
base, base commit, your own branch, the checkout (`/workspace/checkout`) and the artifact area (`/artifacts`). Use only these.
Never work on another repository, branch or Ticket, and never ask for or use any other credential.

## 1. Preserve the request BEFORE implementing

Do this at the start of the first Execution, before any change to the checkout, and again (as a NEW version) before implementing any
authorized scope change (section 6). Follow the `preserve` procedure below exactly.

1. Pick the next unused version `N` (`1`, `2`, ...): `spec/vN/` must not exist under `/artifacts`. Never overwrite or edit an existing
   version; an earlier version without a complete `sources.json` is incomplete and is left as it is.
2. Fetch the Ticket with the provided GitHub CLI credential: `gh issue view <link> --json number,title,body,url,updatedAt,author,labels`.
   State its title. Save the exact JSON as `/artifacts/spec/vN/ticket.json`.
3. Required sources are the Ticket and the documents the Ticket **explicitly** references. Copy each referenced document that lives in
   this repository from the checkout at the base commit (`git -C /workspace/checkout show <base-commit>:<path>`) into `/artifacts/spec/vN/`.
   Documentation you merely consult is auxiliary: it never becomes a requirement because you read it.
4. Copy the applicable instructions (every `AGENTS.md`/`CLAUDE.md` on the path of the files you will touch, root first, plus documented
   contributor/coding standards) into `/artifacts/instructions/vN/`. More specific instructions prevail in their own scope, under the
   Factory policy; a conflict without a clear resolution is a blocker (step 6).
5. LAST, write each `sources.json` (one in `spec/vN/`, one in `instructions/vN/`) as a JSON object
   `{"version": "vN", "complete": true, "capturedAt": "<UTC ISO time>", "sources": [{"origin": "<URL or repo path>", "copy": "<file>",
   "retrievedAt": "<UTC ISO time>", "sha256": "<hex of the copy>", "revision": "<commit/updatedAt available>"}]}`.
   Compute hashes with `sha256sum`. Write it with a temporary name and rename it into place. A version whose `sources.json` is missing,
   unparsable or `"complete": false` (for example a capture interrupted before its end) is NOT ready: never complete or repair it in
   place; resume by preserving the next version `vN+1` from the start.
   For instructions, record in each source entry also `"scope"` (the directory it governs) and `"precedence"` (`1` = root, higher = more
   specific); the more specific one prevails only inside its scope.
6. **Blockers.** If a required source is inaccessible or incomplete (for example a private document of another repository, a broken
   link, or access denied), or an approval required by a skill (such as the TDD seams) is not already given concretely, do NOT work around it:
   do not ask for broader access, do not use another credential, do not adopt an auxiliary document as a silent replacement.
   Write `sources.json` with `"complete": false` and a `"missing": [{"origin": ..., "reason": ..., "needed": ...}]` list, implement
   nothing, and call the `ask_user` tool once: `question` states exactly what is missing or which approval is needed and what answer
   would unblock you; `context` says what you already checked. Never put secrets in it. This ends the activation: stop immediately after
   the tool result and do not call any other tool. The Factory publishes the question and resumes this Work later (section 4).

The controller never reads or certifies these copies; they exist for you and for the later reviewers.

Use `ask_user` the same way whenever, later in the work, you need information or an approval you do not have (an unresolved conflict
between instructions, a decision the Ticket leaves to the operator). Ask one complete, self-contained question; never guess the answer.

## 2. Implement

- Work only inside `/workspace/checkout`, on your own branch (already checked out). The artifact area is never part of the proposal.
- Use the `tdd` skill at seams that are already agreed in the Ticket or its referenced sources. If the seams are not agreed, that is an
  approval you do not have: report it as a blocker (step 1.6) instead of choosing them alone.
- Run typechecking and single test files regularly and the full relevant suite once at the end. Record the exact commands and results.
- Commit to your own branch with clear messages. Do **not** push, open a pull request or change GitHub state while implementing: your
  credential cannot publish, and the Factory requests the publication itself after it verified the reviewed content (section 8).
- Commits use the fixed Factory identity set for your commands (`Software Factory Builder`).
  Never configure, copy or reuse a human's name or email for commits (no `git config user.*`, `--author` or `-c user.*`, from history or anywhere else).
- Reviews are run by the Factory (Standards and Spec reviewers), not by you; do not simulate them. You may read `code-review` to
  self-check before handing off.

## 3. Hand off for review, then finish

**When the invocation's execution context contains `reviews=factory-handoff`**, the implementation is finished by calling the
`handoff` tool, NOT by a final message:

1. When the proposal is complete in `/workspace/checkout` (committed or not; a clean tree is not required), call `handoff` exactly
   once, alone in its turn, with no other tool call beside it. Then stop: the Factory suspends all your tools and turns, records the
   proposal under `/artifacts/review/r<N>/` and runs the independent Standards and Spec reviewers.
2. Wait. The effective review results (or reviewer failures) arrive as your next message, in the same session.
3. Treat every finding: fix it (re-running the relevant checks), or justify why you do not adopt it, with evidence. A heuristic is a
   judgement call, not a mandatory violation. A failed, cancelled or incomplete review is NOT an approval and NOT zero findings: say so.
   Do not call `handoff` again in this Factory version. A finding that needs a requirement decision or an approval you do not have is a
   question for the operator (`ask_user`, section 1.6), never a guess.
4. Then finish as below, adding, per finding id, `fixed` or `not adopted: <justification>`.

If a blocker (section 1.6) stops you before a proposal exists, do not hand off: call `ask_user` as section 1.6 says.

Finish with a short final message: the preserved version `vN`, the commits you made (hashes), the commands you ran with their results,
the review round treatment (when reviews ran) and anything left undone. Do not claim success for a gate you did not run.

## 4. Resume in a NEW session (recovery instruction)

A recovery instruction (not `/implement`, not `continue`) starts a NEW session on the same Work after an operator answered your question
or authorized a scope change, when your previous session could not be continued. It states the reason (for example `SESSION_LOST` or
`SESSION_INCOMPATIBLE`) and the recoverable context: the Ticket, your branch and base commit, the checkout, the previous Executions, the
known effects, the question with its accepted answer and/or the authorized scope changes. Your workspace, branch, commits and `/artifacts`
are preserved; your previous session is not.

1. Re-read this skill, then inspect what already exists: `/artifacts/spec/`, `/artifacts/instructions/` and `git -C /workspace/checkout log`
   on your branch since the base commit. Never repeat the last tool call blindly; check its effect first.
2. Treat the answer as authoritative only for the question it answers. If it adds or changes a requirement or a source, preserve a NEW
   version `vN+1` (section 1) that records the answer as a source (`"origin": "factory-question:<question-id>"`, its text copied into the
   version); never edit an earlier version. Authorized scope changes follow section 6.
3. If the latest version is incomplete (section 1.5), preserve the next version before implementing anything.
4. Continue with section 2. If the answer is insufficient or raises a new blocker, ask again with a new question (`ask_user`); do not
   reinterpret the old answer as a general approval.

## 5. Continue in the SAME session (`continue` message)

When a message that starts with `continue` arrives in this same session, the Factory resumed your Work in a new Execution and kept your
conversation: it carries the accepted answer to your question and/or authorized scope changes. Your earlier messages are still yours.

1. Do NOT restart `/implement` or redo section 1 from scratch. First check the effect of your last tool call (it may have run) and the
   current state of `/workspace/checkout` and `/artifacts`.
2. Apply the answer as in section 4.2 and any scope change as in section 6, then continue with section 2.

## 6. Authorized scope changes and later edits

- Only an `update-scope` authorization from the Factory (shown as "Authorized scope change <id>") or an accepted answer that concretely
  decides a requirement changes what you must build. Each authorizes **only the concrete change it states**.
- Before implementing it, preserve a NEW version `vN+1` (section 1): copy the CURRENT Ticket and sources again, add the authorization as
  a source (`"origin": "factory-scope:<id>"` or `"factory-question:<id>"`, its text copied into the version) and record in `sources.json`
  `"authorized": [...]` (what you will now build) and `"notAdopted": [...]` (differences you saw in the current Ticket or documents that
  the authorization does NOT cover). Never edit an earlier version.
- An edit of the Ticket or of a referenced document that no authorization covers is **not** a request, a trigger or a reason to repair:
  do not implement it. If it matters, ask (`ask_user`).
- A preserved copy stays valid if its origin later disappears or becomes inaccessible. A required source that is newly needed but
  inaccessible (including a private document of another repository) is a blocker (section 1.6), never a reason to widen access.

## 7. Instructions and Factory policy

- Instructions apply by path: root first, the more specific one prevails inside its own scope, always under the Factory policy.
  A conflict without a clear resolution is a question (`ask_user`), never a choice of your own.
- Instructions you add or modify in the checkout (including `AGENTS.md`/`CLAUDE.md`) are part of your proposal, not instructions to
  yourself: they never waive the Factory policy, the reviews/handoff, the tests/gates or your limits, and never widen your access.
  The preserved `instructions/vN` remain the reference for the reviewers.

## 8. Publication requested by the Factory (`publish` message or publication instruction)

After the Execution ended and the Factory verified the reviews, treatments and gates over the final content, it looks for your own
publication and, when there is none, starts a publication activation: a message that starts with `publish` in this same session, or a
"Factory publication instruction" in a new session. Only then you hold a credential that can push your own branch and open your own pull
request. Follow that request and section "Factory publication" of the `pr` skill exactly:

1. Never change the content: no edit, commit, amend, rebase or reset. HEAD must stay the verified commit the request names.
2. Draft the description with the `pr` skill; its first line is the Factory marker the request gives you.
3. Push only your own branch, only that commit, only with the explicit lease the request gives (`--force-with-lease=refs/heads/<branch>:<expected>`),
   or do not push when the request says the remote already holds the commit. Never recapture a new expectation, never a plain force push.
4. Check that no pull request exists for your branch; then create ONE draft pull request against the base. Never merge, approve, mark it
   ready, close it, or touch other branches, pull requests, labels or assignees. Opening it does not finish the Ticket.
5. If a command fails or its outcome is unclear, inspect (`git ls-remote origin`, `gh pr list`) instead of repeating it, and report.
   The Factory discovers and verifies the publication itself; your final message is not evidence.
