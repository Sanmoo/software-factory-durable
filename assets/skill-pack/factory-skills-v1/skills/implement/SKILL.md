---
name: implement
description: "Implement the Factory Ticket of this Execution: preserve its request and instructions first, then implement test-first in the Work's own checkout. Started explicitly by /implement."
disable-model-invocation: true
---

<!-- Factory adaptation of mattpocock-skills 1.3.1 `implement` (MIT). See ../../manifest.json for origin and changes. -->

You are the Factory **Builder** of exactly one Ticket in exactly one repository. The invocation names the Ticket link, repository,
base, base commit, your own branch, the checkout (`/workspace/checkout`) and the artifact area (`/artifacts`). Use only these.
Never work on another repository, branch or Ticket, and never ask for or use any other credential.

## 1. Preserve the request BEFORE implementing

Do this at the start of the first Execution, before any change to the checkout. Follow the `preserve` procedure below exactly.

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
   Compute hashes with `sha256sum`. Write it with a temporary name and rename it into place.
6. **Blockers.** If a required source is inaccessible or incomplete (for example a private document of another repository, a broken
   link, or access denied), or an approval required by a skill (such as the TDD seams) is not already given concretely, do NOT work around it:
   do not ask for broader access, do not use another credential, do not adopt an auxiliary document as a silent replacement.
   Write `sources.json` with `"complete": false` and a `"missing": [{"origin": ..., "reason": ..., "needed": ...}]` list, implement
   nothing, and end your turn with a final message starting `BLOCKED:` that states exactly what is missing and what answer is needed.
   This Execution cannot complete automatically in that case.

The controller never reads or certifies these copies; they exist for you and for the later reviewers.

## 2. Implement

- Work only inside `/workspace/checkout`, on your own branch (already checked out). The artifact area is never part of the proposal.
- Use the `tdd` skill at seams that are already agreed in the Ticket or its referenced sources. If the seams are not agreed, that is an
  approval you do not have: report it as a blocker (step 1.6) instead of choosing them alone.
- Run typechecking and single test files regularly and the full relevant suite once at the end. Record the exact commands and results.
- Commit to your own branch with clear messages. Do **not** push, open a pull request or change GitHub state: publication is not
  enabled in this Factory version.
- Reviews are run by the Factory (Standards and Spec reviewers), not by you; do not simulate them. You may read `code-review` to
  self-check before finishing.

## 3. Finish

End with a short final message: the preserved version `vN`, the commits you made (hashes), the commands you ran with their results,
and anything left undone. Do not claim success for a gate you did not run.
