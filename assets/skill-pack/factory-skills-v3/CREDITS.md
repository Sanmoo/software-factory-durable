# Credits and licenses — factory-skills-v3

- `implement`, `code-review`, `pr`, `tdd` (with `tests.md`, `mocking.md`) and `codebase-design` (with `DEEPENING.md`,
  `DESIGN-IT-TWICE.md`) are copies **adapted by the Software Factory** of Matt Pocock's skills, `mattpocock-skills` 1.3.1
  (<https://github.com/mattpocock/skills>), MIT License, Copyright (c) 2026 Matt Pocock — full text in `LICENSE.mattpocock-skills`.
  Only the Factory integration was changed (ticket preservation, approval via prior authorization, controller-run reviews, no
  sub-agents, no publication); `manifest.json` lists, per file, whether it is verbatim or adapted and the upstream file hash.
- The `pr` Summary section reproduces Dex Horthy's `show-me` skill (Humanlayer); see `skills/pr/CREDITS.md`.
- `alpine-diagnostics` and the two prompt templates are Factory-own.
- `factory-skills-v3` (3.0.0, ticket 12) = `factory-skills-v2` plus the review handoff: with `reviews=factory-handoff` (`implement` §3,
  `prompts/implement.md`) the implementation ends with the `handoff` tool, alone, and the delivered review results are treated before
  finishing; commits use the fixed Factory identity and never a human's. v1 and v2 are unchanged.
- This pack is distributed with the Factory and versioned as a whole; it is never synchronised with a personal profile, registry or installer.
- `factory-skills-v2` (2.0.0) derives from `factory-skills-v1` 1.0.0: `implement` turns blockers into one durable Factory question
  (`ask_user`) and adds section 4 (resume after an answer); the prompt templates point at this version's guest paths. Same
  origins and licenses as v1; v1 is unchanged.
