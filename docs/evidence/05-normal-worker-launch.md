# 05 bounded increment: executable normal owner launch

Base `9e0fd9f080f9fc0790383babe4a1904194f31654`; original integration `4e085bf` untouched.
This supersedes only the **normal-launch wiring** limits in
[the entrypoint checkpoint](05-worker-process-entrypoint.md). It is not whole05,
Control09, Builder/handoff, provider/auth/budget or physical-isolation qualification.

## Implemented path

Explicit Factory-owned `createWorkers({ root, profile, knownSecrets }).activate`
uses the existing Protocol and the existing three-argument adapter's private owner
endpoint. No SDK executes in that caller. Q6 confirmed admission/reservation remains
an explicit **trusted Control caller precondition**, not a Boolean or Records ledger.
Unconfigured activation and production Control.dispatch remain closed.

The owner binds work/environment/boot to its composition, validates the complete
execution/invocation/phase/reviewer context, and claims its technical invocation ID
**before any asynchronous setup**. Failed setup, child error, EOF and changed-context
reuse never remove the invocation tombstone or trigger retry/adoption. These claims
live in the existing boot owner, not a second authority/scheduler/global registry.

The private Host seam reuses the adapter's lossless boot-runtime path and read-only
manager query. Immediately before fork it checks current owned boot/runtime metadata,
MainPID, exact unit/InvocationID/cgroup and namespaces against the existing boot
context. It creates no group/unit/VM. Executable, compiled worker script, Node24,
minimal environment, ignored stdio + private IPC, and non-detached spawn are fixed;
no executable/argv/env bag/callback comes from the caller. Per-invocation private
profile/session/temp/cache directories are allocated inside that boot's private runtime.
Control does not discover or inspect PID/unit/cgroup layout.

Launch payloads are strict and cannot choose tool endpoint, Records root or profile
directory. The owner derives them and registers known secret **values**, including
the explicit API key, in its Records before binding/capture. The child independently
registers them in its own Records before protected output/use. Bootstrap remains
transient private Protocol/IPC memory, never argv, disk, event metadata or native JSONL.
A shared Host-owned strict schema avoids divergent bootstrap parsers without adding
a forbidden architecture edge or moving implementation into neutral contracts.

The child syncs the real protected start receipt **before SDK import, tool connection,
model or tool use**, then publishes its opaque reference separately from completion.
The public result distinguishes request acceptance, `started`, and `completed`.
Receipt correlation includes full supplied context and observed new child PID/birth
clocks; completion must refer to the same receipt. Neither request/spawn/completion
nor PID exit proves authorization, physical cessation or writer quiescence.

Owner-channel EOF/abort revokes only that invocation's tool binding and sends its
fixed child an invocation-local abort; the executable asks its own SDK to abort.
It does not stop the VM or revoke another reviewer. The boot owner retains shutdown.

## TDD and local evidence

All compiler/test/gate commands use explicit
`/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`, unset NODE_OPTIONS
and NODE_COMPILE_CACHE, and set NODE_DISABLE_COMPILE_CACHE=1, with <=60s bounds.
New normal fixtures use owned private `/tmp/nw-` roots; production path limits unchanged.

- Existing pre-change facade/launch-plan/owner-registration baseline: **4 passed**.
- Initial normal-path fixture RED: TS2554 (configuration not supported) and TS2339
  (the closed facade returned never). Runtime RED subsequently exposed missing
  fixture operational trigger, then actual child completion-shape and Records-path
  mismatches; those were corrected against real entrypoint/Records behavior.
- Explicit `node node_modules/typescript/bin/tsc -p tsconfig.json`: passed.
- Focused normal-entrypoint, fixed-child, unconfigured facade, Host-plan,
  owner-registration, invocation-isolation and tool-transport files: **15 passed,
  0 failed, 0 skipped** (final focused run 3542.788674ms).
- Additional affected native-owner/read, Sandbox start/start-diagnostics/stop files:
  **32 passed, 0 failed, 0 skipped**, duration 1932.745739ms.
- Final combined run of those 11 affected files after the final code change:
  `tests 47; suites 0; pass 47; fail 0; cancelled 0; skipped 0; todo 0;
  duration_ms 4320.240528`. Compilation, architecture, changed-file lint and diff
  check all passed in the same <=60s command.
- Dependency cruiser: **no dependency violations found (107 modules, 530 dependencies
  cruised)**. Changed-file ESLint and `git diff --check`: passed silently.
- One initial architecture command misspelled the runner pathname; failed before
  loading, corrected to existing `bin/dependency-cruiser.mjs`. An exploratory schema
  placement in neutral contracts correctly failed the architecture gate; the schema
  was moved to its proper private Host owner. No gate rule or hook was relaxed.
- Active changed-path LSP probes are partly push-only/inconclusive. An introduced
  unchecked JSON parse and non-null assertion were fixed; the remaining auxiliary
  lifecycle string-sort warning is pre-existing, outside this delta. Successful
  explicit compilation is the authoritative typecheck evidence.

The actual normal-path test forks the ordinary adapter executable with its existing
three arguments. Only the **external** VM/manager/proc observations and provider HTTP
are substituted. A test-only `cp.spawn` boundary permits only the exact NEW fixed
Node worker and adds an offline provider preload; VMM/unexpected spawns stay forbidden.
No production test switch or injected launch callback exists.

The real public activation succeeds through that owner into a separate child, makes
exactly two offline provider requests and one guest read, paginates beyond 5000 lines,
and reopens native SDK JSONL containing filtered tool results. Fragmented synthetic
API-key and guest-secret canaries are absent from JSONL/provider input/diagnostics.
At each provider request the complete protected receipt already exists. Observed
receipt PID differs from the owner PID. Duplicate/changed-execution activation is
rejected before another fork. A second actual normal child has a real critical
Records metadata collision: no start receipt, model request or guest tool, and its
failed invocation cannot be reused. The separate executable regression sends abort
after protected start and verifies zero provider/tool calls. Existing pending-read
EOF/abort and independent-reviewer tests remain green.

## Residual limits and review

The test's group/manager/proc observations are **external doubles**, not physical
systemd/cgroup/namespace/FD qualification. There was no actual VM, systemd operation,
model, network, OAuth, credential, install, GitHub, mount, Docker-host, old-process
signal, peer/integration write or push. The provider preload never forwards fetch.
No claim of compromised-same-UID isolation: the approved private Host account and
its endpoints are trusted. Process bootstraps have an accepted-message 64KiB bound,
not a pre-deserialization OS allocation bound.

Still held: whole05/Builder/images/handoff, real credential acquisition/rotation,
Task65 auth/USD10, proper09 scheduling/admission/reconciliation, native-image support,
real provider/model compatibility, real FD/group/isolation/cessation proof and release
qualification. This increment creates **source functionality** for properly admitted
trusted callers, not permission to run production agents or admit work now.

Self-review fixed the post-bootstrap abort listener, completion/receipt correlation,
pre-fork revalidation ordering and sanitized private JSON parsing. No known blocker
to this bounded normal-path flow; asynchronous loss remains explicitly uncertain
and requires external reconciliation, not blind replay.

## Task71 P1 correction: escaped secrets in public SDK inputs

The later static review identified a blocking P1 in the child input guard: searching
JSON-encoded public payloads for unencoded secret values missed newline, quote and
backslash characters. This corrects that finding; the historical normal-launch
results above alone did not establish rejection of these inputs.

The child now recursively checks the **original parsed string values** of the
prompt and complete public profile (including nested provider/model arrays) against
both `knownSecrets` and the explicit API key. The private API-key field itself is
excluded from the public projection. This local traversal is bounded by the existing
strict bootstrap schema, not a generic input framework. Matches reject with
`WORKER_BOOTSTRAP_INVALID`; prompt/profile semantics are not rewritten. Rejection
precedes protected start publication, tool connection, SDK import and session creation.
Records registration/filtering remains unchanged.

Inspected `createWorkers` public configuration, Host `workerLaunchSchema`, and
`launchWorker` bootstrap construction: they have no duplicated secret-string guard.
Normal activation still reaches the same fixed child entrypoint/guard; no alternative
production SDK activation or compatibility fallback was added. The private SDK
component seam remains for component tests, not a public Host activation path.

TDD used the same explicit Node24 executable, environment clearing and <=60s command
bounds recorded above, without install, clean/reset, rule changes or hook bypass:

- Existing fixed-child baseline: `tests 1; pass 1; fail 0; duration_ms 3143.953017`.
- RED: 18 new real NEW Node worker child cases: newline/quote/backslash ×
  prompt/systemPrompt/nested `provider.models[0].name` × known secret/explicit API key
  (the latter not duplicated in `knownSecrets`). All 18 failed on the retained guard;
  children published starts and added native sessions instead of rejecting.
  Exact runner summary: `tests 19; suites 0; pass 0; fail 19; cancelled 0;
  skipped 0; todo 0; duration_ms 19054.814024` (includes the failed parent test).
- GREEN after the guard fix: `tests 19; suites 0; pass 19; fail 0; cancelled 0;
  skipped 0; todo 0; duration_ms 5175.82674`.
- Final affected regression after strengthening existing-session byte comparisons:
  the same 11-file / 47-original-test scope plus 18 cases: `tests 65; suites 0;
  pass 65; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 6297.346952`.
  Each rejection asserts exactly the sanitized invalid-bootstrap error, zero provider
  requests, unchanged guest-call count, unchanged evidence entries (no start), no new
  native session and unchanged existing session bytes. The child helper also checks
  empty stdout/stderr. Existing actual public owner launch/native SDK/filtered JSONL
  and receipt-before-provider regressions remain intact.
- Explicit TypeScript compilation passed. Architecture: `no dependency violations
  found (107 modules, 530 dependencies cruised)`. Full ESLint `--max-warnings 0` and
  `git diff --check` passed silently. Active changed-path LSP returned no diagnostics:
  one confirmed clean, one inconclusive push-only result; compilation is authoritative.

This closes only the escaped-secret input P1. Existing operational/physical isolation,
real model/network/credentials, image/binary handling and Task65 user-grant limits
above remain unchanged; no new grant, whole05 qualification or production run is claimed.
