# 05 bounded local slice: normal owner registration

Base: `f0bca242d0a04f06c254399e1407dcaba02ddb26`. This is a useful partial 05 result, not operational worker bootstrap or dispatch acceptance.

## Implemented boundary

- The unchanged three-argument executable reaches `runSandboxAdapter(root, environment, boot)`. There is no fourth live-binding parameter. After existing ownership/supervision/runtime/VM/profile checks, the adapter opens its boot-private Protocol owner endpoint **before** publishing operational evidence.
- Host-side `createSandbox({ root }).executeTool(context, call)` discovers that endpoint from existing owned environment/current boot metadata. It registers its explicitly supplied host invocation, then retains a separate tool projection per invocation. No public administrative Sandbox operation or production test switch was added.
- Protocol handlers receive the expected peer projection from host endpoint composition. Claims in frames or `connect()` inputs do not change that association. Private same-account host filesystem access remains trusted, as approved; this is not OS process-role authentication or protection against compromised host UID.
- Registration selects the bound context and allocates the tool endpoint, signal and Records instance in the owner, not from guest payloads. Records stores output only, never grants authority. Wrong boot/work/environment and reused invocation registration fail closed. Tool channels do not handle administrative registration.
- The existing f0 binding collection now accepts private incremental additions. Host-registration EOF and worker EOF revoke only that binding. Boot stop closes the collection and existing VM; even collection-close failure cannot skip VM close. Existing shutdown deadlines, stdio confinement, fencing and filesystem gates remain unchanged.

## Evidence and TDD

Pinned runtime for every compile/test/gate: `/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`.

Baseline: TypeScript ESM compilation plus existing Protocol/native-owner tests: **6 passed, 0 failed**.

RED: new entrypoint test compiled after correcting fixture argument narrowing; its normal public `executeTool` call returned `failure` rather than `success`, as expected before implementation (**1 failed**). This was an expected behavioral RED, not a runner fault.

GREEN: focused normal-entrypoint test plus affected Protocol, invocation-isolation, read-transport, adapter-diagnostics and native-owner suites: **30 passed, 0 failed**, approximately 3.7 seconds. Compilation succeeded. Architecture: `no dependency violations found (95 modules, 468 dependencies cruised)`. ESLint and `git diff --check` succeeded without output.

One architecture command initially named the nonexistent `bin/dependency-cruise.mjs`; Node failed before loading the runner. Corrected the local executable pathname to existing `bin/dependency-cruiser.mjs`, then the actual architecture runner passed. No bypass, install, replacement runner or hook override.

The new test uses the real three-argument executable, actual local Protocol sockets, private metadata/filesystem and Records. Only VM and manager/proc supervision boundaries are doubled using the existing preload pattern; production receives no test flag or extra argument. Audit asserts exactly one VM creation, two independent host bindings, cross-binding output-reference denial, forged context denial, stale boot rejection at discovery and registration, worker administrative-claim denial, first-binding EOF denial while the other still reads, and VM close only after boot stop. The existing filesystem test additionally retains actual SDK RealFS/RPC coverage. No VM, model, network, systemd operation, OS signal or worker process was launched.

Active LSP probe: seven changed TypeScript paths, zero reported diagnostics; three confirmed clean and four inconclusive push-only responses. Compiler success is the authoritative static validation here.

## Residual risks / deliberately not claimed

- Host inputs are trusted technical projections, not durable admission/reservation authority. Control.dispatch stays closed; future 09 supplies admission and phase authority.
- Worker process launch, protected start receipt integration, actual process membership/cessation, real VM/model handoff and complete 05 remain unimplemented/unqualified.
- Normal registration owns a local Records instance; propagation of transient credential/secret registrations from future host worker activation is not wired by this slice. No credential/model activation is enabled or exercised here.
- No claim of compromised-same-UID isolation: callers able to access private host endpoints are trusted host composition. Worker-facing tool messages cannot promote themselves to that endpoint or its expected-peer projection.
- Binding channels and invocation tombstones live for the boot; no new public disposal or administrative API was invented. Boot close owns cleanup.

Self-review: no scope-widening/domain ledger/new supervisor/public administrative method; finalization still closes the VM if binding close fails. No known blocker to the bounded registration goal. Next work is separately scoped host worker launch/receipt integration, not performed here.
