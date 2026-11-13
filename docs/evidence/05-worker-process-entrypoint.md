# 05 bounded increment: executable worker and SDK/host separation

Based on P2 fix `87bf1b4902c6cbb6be5b999ed1297e42cbef6c78`. Original integration
`4e085bf` is untouched. This supersedes only the missing-executable/SDK-in-caller
limits of the earlier closed launch-plan checkpoint, not its operational holds.

## Implemented

- Fixed compiled `src/entrypoints/worker.js` receives one transient inherited Node
  IPC bootstrap (5-second receive deadline). It has no SDK or Sandbox implementation
  imports, profile discovery, arbitrary executable/argv, callback or runtime test flag.
- Workers validates a strict versioned, at-most-64-KiB accepted JSON bootstrap,
  reviewer context, explicit profile/model projection, private owned canonical
  Records/profile/session/temp/cache directories, Node24 and the same minimal env
  projection as the existing closed Host plan. No personal environment is inherited.
  Node IPC deserializes before the application size check; this is an accepted-message
  bound on a private trusted-parent channel, not an OS-level inbound allocation cap.
- Each worker creates its own Records owner and registers transient known secrets
  and its synthetic API key before protected output/use. The fixture independently
  registers the same synthetic secrets in the distinct existing tool-owner Records.
  Bootstrap/keys are not written to argv, files, receipts or diagnostics.
- Protected start publication/sync completes **before dynamic native SDK import**,
  owner tool connection, model creation or tools. Failure returns only an allowlisted
  error code. The receipt distinguishes supplied role/boot/invocation context from
  observed PID/parent PID/uid/executable/Node version/process time origin/local clock.
  It records the explicitly selected profile and validated private profile directory.
- The native session body now lives in Workers-private `worker-session.ts`, not the
  host facade. A concrete Workers Protocol projection speaks the existing bound
  `execute-tool`/`tool-result` endpoint using Sandbox **types only**. Native read,
  pagination, pinned SDK and native session format are unchanged.
- `createWorkers().activate` always fails `WORKER_EXECUTION_NOT_ENABLED`, for missing
  or supplied contexts. No in-process SDK compatibility fallback remains. Prior direct
  SDK-body tests are honestly named private component tests, not host activation proof.

## TDD and local evidence

Pre-change explicit tsc + native-owner component baseline: 3 passed, 0 failed.
The first closed-facade RED failed compilation against the old required caller SDK
options. Actual child RED failed because the compiled worker entrypoint did not exist
(`ERR_MODULE_NOT_FOUND`). A subsequent environment alignment RED failed with child
exit 1 against the existing Host-plan environment; accepting/validating that exact
minimal projection and its private temp/cache directories made it green.

Using `/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`, with NODE_OPTIONS
and NODE_COMPILE_CACHE unset, NODE_DISABLE_COMPILE_CACHE=1 and short fixture TMPDIR:

- Explicit `node_modules/typescript/bin/tsc -p tsconfig.json`: exit 0.
- Compiled Workers tests plus existing owner-registration, tool-transport and
  invocation-isolation tests: **19 passed, 0 failed, 0 skipped**.
  Exact final summary: `tests 19; suites 0; pass 19; fail 0; cancelled 0;
  skipped 0; todo 0; duration_ms 7203.007795`.
- The new fixture forks the **actual compiled entrypoint** in new ordinary Node24
  processes. Only provider HTTP and the existing fixture's external guest exec are
  substituted; fetch never forwards to network. Protocol/Records/FS/native SDK,
  native read and native JSONL remain real.
- Success: exactly 2 provider requests, 1 guest capture, pagination after 5000 lines;
  fragmented synthetic guest secret **and API key** are filtered before native SDK
  persistence. Native SessionManager reopens the filtered tool result. Receipt PID
  differs from parent and equals the new child PID; supplied role/profile and local
  birth/clock observations are correlated without stronger physical claims.
- Real critical Records metadata collision in a separate new child: protected start
  fails, zero provider requests, no extra guest calls and no additional SDK session.
  Unknown fields, wrong version, oversize input, Builder role and secret-bearing
  systemPrompt also fail closed without provider/tool activity.
- Dependency cruiser: no violations, 104 modules / 506 dependencies. Changed-file
  ESLint and `git diff --check`: exit 0. Active LSP probes had some inconclusive
  push-only responses; successful explicit compilation is the typecheck evidence.
  Two auxiliary entrypoint findings were fixed and its re-probe has no findings.

## Exact remaining limits

**Operational host activation/MainTask64 and whole05 are still incomplete.** The
new executable/separation process slice is implemented, not another plan-only
checkpoint. Normal owner launch is still explicitly closed: no spawn is wired
from the existing owner's `launch-worker` request, no persisted Control admission/
reservation binding or real credential bootstrap/owner registration is enabled.
`Control.dispatch` is unchanged and closed. No public Sandbox admin API was added.

The fixture explicitly registers synthetic secrets in both owners; this does not
qualify real credential delivery/rotation. Task65 budget/auth remains pending user,
without inferred authority. Offline openai-completions is not qualification of
openai/gpt-6-luna/openai-responses, OAuth, real auth or USD10 protection.

No actual VM/systemd/model/network/DNS/credentials/install/GitHub operations occurred.
There is no proof of real cgroups, namespaces, inherited-FD isolation, global writer
cessation, reviewer quiescence, Builder handoff or full supervision. Receipt, SDK
return and PID exit confer no authorization and prove no such facts. Existing owner
EOF/abort isolation tests still pass; reviewer failure never gains VM-stop authority.
Native images remain unsupported/open; SDK provenance/read patch pins are unchanged.
