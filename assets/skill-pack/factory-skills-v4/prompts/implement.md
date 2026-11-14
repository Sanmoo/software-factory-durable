---
description: "Factory Builder start: preserve the Ticket request, then implement it in the Work's own checkout."
argument-hint: "<ticket-link> key=value..."
---
Start the Factory `implement` skill now for Ticket $1.

Execution context (from the Factory, authoritative): ${@:2}

Read `/artifacts/factory/skill-pack/factory-skills-v4/skills/implement/SKILL.md` with the read tool and follow it exactly,
starting with section 1 (preserve the request) before any change. If the execution context contains
`reviews=factory-handoff`, you finish the implementation by calling the `handoff` tool (section 3), not with a final message. Skills of this pack live under
`/artifacts/factory/skill-pack/factory-skills-v4/skills/`.
Authorized scope changes that follow the execution context are part of this request: preserve a version that records them before
implementing (section 6). Later edits of the Ticket or its links are not authorizations.
