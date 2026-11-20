# Credits and licenses — factory-skills-v10

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
- `factory-skills-v4` (4.0.0, ticket 11) = `factory-skills-v3` plus context continuation and authorized scope: `implement` §4 (resume in
  a new session with the replacement reason and recoverable context), §5 (`continue` in the same session), §6 (only concrete scope
  authorizations change the request; later edits are not triggers; a new version is preserved first), §7 (instruction precedence; changed
  instructions never waive policy/gates/limits) and incomplete captures resumed as a new version. v1, v2 and v3 are unchanged.
- `factory-skills-v5` (5.0.0, ticket 13) = `factory-skills-v4` plus repeated review rounds: with `review-rounds=multi` (`implement` §3,
  `prompts/implement.md`) the Builder hands off again after treating the results, with a treatment for every LISTED finding (never a
  placeholder for a reviewer without findings) and the documented gates (run as the last commands in the Factory bash cwd `/workspace`, with
  directory changes inside the command; a declared gate that changes the checkout is not evidence; results are taken by the Factory from
  its own record of the Bash calls and its content snapshots), requires the operator's answered question to not adopt a requirement
  finding, and finishes only after the Factory says no new round is needed. It keeps v4's continuation protocol. v1–v4 are unchanged.
- `factory-skills-v6` (6.0.0, ticket 14) = `factory-skills-v5` plus direct publication when the Factory requests it: `implement` §2 (no
  publication while implementing) and §8 (publish-only activation: unchanged verified commit, explicit lease, own branch only, one draft PR
  or an update of the own PR, never merge/approve/ready), `pr` (short Summary/Validation/Risk body with the Factory marker and the Ticket
  link, no transcripts or local paths as links, and the "Factory publication" procedure) and `prompts/pr.md`. v1–v5 are unchanged.
- `factory-skills-v7` (7.0.0, ticket 34) = `factory-skills-v6` plus the treatment of a finding the reviewed content already satisfies
  (`implement` §3, real run R-CAND qcand34-v6): such a finding is `not-adopted` with a justification and evidence, a requirement finding of
  that kind is a question for the operator first, and `fixed` is never declared without a change after the round. v1–v6 are unchanged.
- `factory-skills-v8` (8.0.0, ticket 46) = `factory-skills-v7` plus the tool limits of the pilot (ticket 35): `implement` §2 and
  `alpine-diagnostics` give build and test commands a generous `bash` timeout (for example 1800 s, above all the first run that downloads
  dependencies), because a command over its timeout ends the activation, and change files over the 8192-byte `edit`/`write` limits with
  `bash`; such a refusal is an ordinary tool error. v1–v7 are unchanged.
- `factory-skills-v9` (9.0.0, ticket 53) = `factory-skills-v8` plus fewer avoidable Questions (pilot 35): `tdd` ("Seams") and
  `implement` §2 count as approved the seams the Ticket names by layer or test style when they match the repository's existing
  architecture, and the seams an answer already given in the Work approved; a Question is only for new or ambiguous seams. `implement`
  §4.5/§5 use the answers already given (the accepted answer and the `answered-questions` of the Factory state summary, ticket 48) and
  never ask them again; §6 detects a Ticket change only by comparing the preserved `title`/`body` (never `updatedAt`, which every
  comment moves), comments never being a scope change, and §1 no longer fetches `updatedAt`. v1–v8 are unchanged.
- `factory-skills-v10` (10.0.0, ticket 44) = `factory-skills-v9` plus the per-repository environment: `implement` §2 and
  `alpine-diagnostics` say that the environment the repository declares in `.factory/environment.yaml` (exact apk versions, images by
  digest) is already installed in the guest; the Builder runs the gates as they are, never reinstalls or swaps a declared package,
  version, runtime or image, may install extras the Ticket needs and records them (package, exact version, why), and reports a blocker
  when the declared environment itself prevents a gate. v1–v9 are unchanged.
- This pack is distributed with the Factory and versioned as a whole; it is never synchronised with a personal profile, registry or installer.
- `factory-skills-v2` (2.0.0) derives from `factory-skills-v1` 1.0.0: `implement` turns blockers into one durable Factory question
  (`ask_user`) and adds section 4 (resume after an answer); the prompt templates point at this version's guest paths. Same
  origins and licenses as v1; v1 is unchanged.
