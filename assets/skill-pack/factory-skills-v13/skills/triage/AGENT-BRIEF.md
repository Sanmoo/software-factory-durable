# Writing the brief of a Verdict

<!-- Factory adaptation of mattpocock-skills 1.3.1 `triage/AGENT-BRIEF.md` (MIT). See ../../manifest.json for origin and changes. -->

The brief is the part of a `ready-for-agent` Verdict that says what to build. The Builder works from the Ticket as published: the
body, the comments and your Verdict among them. It starts in a fresh checkout, possibly days later, and explores the code itself.
Text a person writes on the Ticket prevails over your Verdict, so write the brief to be confirmed or refined, not argued with.

A Verdict has two parts with different rules. The **evidence** records what you observed and may cite a file path and a literal
excerpt, pinned to the commit you read. The **brief** is behavioural, without file paths or line numbers.

## Principles

### Durability over precision

The Ticket may wait before the Builder starts, and the code changes in the meantime. Write the brief so that it stays true when
files are renamed, moved or refactored.

- **Do** describe interfaces, types and behavioural contracts.
- **Do** name the types, function signatures or configuration shapes the Builder should look for or change.
- **Don't** reference file paths or line numbers in the brief: they go stale. They belong to the evidence.
- **Don't** assume the current implementation structure will remain.

### Behavioural, not procedural

Describe **what** the system should do, not **how** to implement it. The Builder makes its own implementation decisions.

- **Good:** "The `SkillConfig` type accepts an optional `schedule` field of type `CronExpression`."
- **Bad:** "Open the skill types file and add a schedule field on line 42."

### Complete acceptance criteria

The Builder needs to know when it is done. Every brief has concrete, testable acceptance criteria, each one verifiable on its own.
For a defect, they include how the correction is verified.

- **Good:** "A description over 1024 characters is cut at the last word boundary before 1024 and ends with `...`."
- **Bad:** "Truncation should work correctly."

### Explicit scope boundaries

State what is out of scope, so that the Builder does not widen the work to adjacent behaviour.

### Nothing the Builder cannot open

Every source the brief depends on is in the Ticket or behind a link the Builder reaches. Otherwise transcribe the approved content
into the Verdict. For an enhancement, reference the approved specification and the human record of its approval.

## Template

Write the headings in the language of the Ticket.

```markdown
## Verdict: ready-for-agent

**Category:** bug / enhancement
**Why:** one or two sentences on why this outcome applies.

### Observed

- What you read, with path and literal excerpt at commit `<sha>` when it helps.

### Inferred

- What you conclude from it.

### Brief

**Summary:** one line on what needs to happen.

**Current behavior:**
What happens now. For a defect, the divergence from the expected behaviour and its reference.

**Desired behavior:**
What should happen once the work is complete, including edge cases and error conditions.

**Key interfaces:**

- `TypeName`: what needs to change and why
- `functionName()`: what it returns now and what it should return

**Acceptance criteria:**

- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2

**Out of scope:**

- What should NOT be changed in this Ticket
```

For `ready-for-human`, keep the same structure and replace the acceptance criteria by the indispensable human action and the
evidence of the restriction. For `needs-info`, replace the brief by what is established so far and the specific questions. For
`wontfix`, replace it by the proof: where the existing behaviour lives, or the explicit decision that applies.

## A bad brief

```markdown
**Summary:** Fix the triage bug

The triage thing is broken. The function around line 150 of the main handler has the issue.
```

It has no category, no current and desired behaviour, no acceptance criteria and no scope boundary, and it leans on a line number
that will go stale.
