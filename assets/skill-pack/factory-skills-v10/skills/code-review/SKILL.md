---
name: code-review
description: "Two-axis self-check (Standards, Spec) of the Builder's changes since the base commit. The authoritative reviews are run by the Factory controller's Standards and Spec reviewers."
---

<!-- Factory adaptation of mattpocock-skills 1.3.1 `code-review` (MIT). Only the review integration changed: no sub-agents, no setup skill. -->

In the Factory, the Standards and Spec reviews are separate workers coordinated by the controller; you never spawn or simulate them.
Use this skill only as a self-check before finishing:

- Diff: `git -C /workspace/checkout diff <base-commit>...HEAD` and `git log <base-commit>..HEAD --oneline`.
- **Spec** axis: compare the diff with the preserved request in `/artifacts/spec/vN/` (Ticket + explicitly referenced documents only).
  Note requirements missing or partial, behaviour not asked for, and requirements that look wrong.
- **Standards** axis: compare with the preserved instructions in `/artifacts/instructions/vN/`. A documented standard can be a hard
  violation; the smell baseline (Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Repeated Switches,
  Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest) is always a judgement call,
  and a documented repository standard overrides it. Skip what tooling already enforces.

Report the two axes separately; do not merge or rerank them. Fix what you agree with; justify what you leave.
