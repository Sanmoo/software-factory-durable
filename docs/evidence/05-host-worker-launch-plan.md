# 05 bounded LOCAL slice: correlated host worker launch plan (NOT execution)

Base: `cc95ade8bca176ad782104278ea7d216d5f0dfa3`. Original integration
`4e085bf` is not modified. This is a partial engineering checkpoint, not 05
acceptance or an operational Worker activation.

## Implemented boundary

The normal three-argument adapter passes its **already gated** Q9 technical boot
identity to its existing private boot-owner endpoint: work/environment/boot,
manager unit and InvocationID, cgroup and namespace identities, and private boot
runtime directory. No alternative supervisor/group or public Sandbox method was
introduced. Host imports no Workers, Control, Protocol or Sandbox implementation.

The closed technical `launch-worker` request at that endpoint accepts only a
strict reviewer invocation binding. Cross-work/environment/boot input is refused;
extra fields (including API keys, arbitrary argv or environment) are refused.
Even a matching request returns `WORKER_EXECUTION_NOT_ENABLED`. It neither reserves
an invocation nor records a start receipt, and cannot grant admission/Slots.

Host's non-executable plan describes the fixed release-relative `worker.js`
target, absolute Node 24 executable from this release process, explicit minimal
environment (no inherited NODE_OPTIONS/HOME/provider variables), non-detached
inheritance of the existing boot group and a closed three-ignored-streams + IPC
FD projection. **The target is reserved and does not yet exist.** No plan is
spawned; plan fields are not proof of actual FD isolation or cgroup membership.
Only technical data crosses this boundary. There is no credential bootstrap yet.

## Local evidence

Agreed seam from launch context: closed Host technical plan and existing normal
boot-owner Protocol endpoint, with only external manager/VM doubles. The new
plan test first failed compilation with TS2307 for the missing Host module.
Existing owner/native SDK baseline: 4 tests passed before source changes.

Using `/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`:

- `node_modules/typescript/bin/tsc -p tsconfig.json`: exit 0.
- Final combined compiled host-plan, normal owner-registration, tool-transport,
  native-owner-read, invocation-isolation, adapter-diagnostics and guest-profile
  tests: 33 passed, 0 failed, 0 skipped, 3582.58281 ms. EOF/abort still affect only
  their invocation; normal bootstrap still uses exactly three arguments and the
  existing single VM. Worker tool endpoints also refuse launch administration.
- Dependency cruiser: no violations, 95 modules / 477 dependencies.
- ESLint on all seven changed TypeScript files: exit 0, no output.
- LSP: four files confirmed clean, three inconclusive (push-only server). This is
  not a clean certificate; successful compilation is the typecheck evidence.

One attempted dependency-cruiser command used nonexistent
`bin/dependency-cruise.mjs` and failed MODULE_NOT_FOUND; rerunning the installed
`bin/dependency-cruiser.mjs` succeeded. No whole-suite loop was run. The ordinary
new adapter Node test processes use existing external doubles; no actual manager,
VM, network, model, credential or OS signal was invoked.

## Precise remaining limits / next slice

- `Workers.activate` is **unchanged**: its current development SDK body is still
  caller-side. This checkpoint does NOT meet the requested SDK separation or
  actual fixed-entrypoint activation. There is no in-process fallback added.
- Implement the private fixed worker executable and transient, strictly validated
  bootstrap next; wire Workers host activation to the existing owner request,
  replacing (not retaining as fallback) the caller-side SDK path. The reserved
  target alone is not an implemented entrypoint.
- Propagate known secrets transiently to the distinct owner Records instance and
  register them before any capture; no real credential path is enabled here.
- Verify process identity/group/namespace after launch and publish/sync the
  protected complete start receipt before SDK/model/tool activity. Send/spawn
  success must not count as start. This plan creates no receipt.
- Control's persisted admission/reservation and controller-run dispatch binding
  remain preconditions for execution, not authority inferred from this plan.
  `Control.dispatch` remains closed; 09 is not implemented.
- No writer cessation, roles/Builder quiescence, real handoff, cost/auth/OAuth,
  images, physical cgroups or release operational qualification is demonstrated.
  SDK completion, PID absence and process exit are not physical cessation proof.

There is no newly discovered contract-authority gap: the remaining work is
unimplemented engineering under Q9/Q13/protocol15, deliberately excluded from
this bounded plan/source-correlation checkpoint.
