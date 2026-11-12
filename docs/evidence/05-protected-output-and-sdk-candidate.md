# 05 — protected output and local SDK candidate (PARTIAL / BLOCKED)

## State and scope

Ticket05 is **not complete** and is not eligible for integration as accepted work. All acceptance checkboxes remain unchecked. This implements an independently usable subset of approved Records Q8/Q11 and investigates an actual SDK incompatibility; it does not create an operational worker or claim that local fixtures prove model/VM boundaries.

Branch: `implement/software-factory-mvp-05`, based on integration `4e085bff4991210021c8e4714c4df89d4992376a`. Initial checkout was clean and equal to integration; ancestry was reconfirmed before committing. No reset/merge commit/force/push or sibling-worktree writes. Child Task50 lookup returned `Task not found`; no task completion was fabricated.

Authorities read: process-resume pointer, AGENTS/tracker/triage, canonical spec (especially 2.3, 5.1/5.3/5.4, 6.1, 12.2), module-public-interfaces Q5–Q8/Q11/Q13, issue19 native-read contract, TDD and implement-spec skills. Existing approved seams avoid a redundant test-interface approval request.

## Implemented Records subset

`createRecords({root})` uses an already-owned private directory, which composition must keep outside every guest mount. It supplies:

- `registerSecret`: bounded, in-memory values only; no discovery or credential reads. Redaction uses the single `█` delimiter. Values containing that delimiter are refused (caller must not use a value whose registration failed); thus a replacement and its adjacent text cannot accidentally synthesize another known secret.
- `openOutput(context)`: bounded UTF-8 byte chunks, stateful redaction across chunk/UTF-8 boundaries, longest matching known secret first, bounded withheld tail and prefix excerpt. Each `write` resolves only with filtered text after writing that filtered data. Invalid UTF-8/oversized input/write/publication errors throw a secret-free stable error and close the capture; no raw fallback.
- `finish`: synchronizes output, then publishes complete metadata via exclusive temporary file, sync, atomic rename and directory sync. Private directories are synchronized in their parents on creation. Missing completion stays partial, not successful. A marked display excerpt and protected reference are returned. This is capture completion, **not command success, worker start, authorization, or cessation**.
- `record`: bounded correlated JSON event publication using the same protected capture. String values/keys are filtered before JSON escaping; collisions with structural/identity metadata fail closed rather than corrupting identities or JSON.
- `read`: bounded **byte** pagination; complete/partial/absent results, strict reference validation, and refusal of corrupt/missing correlation metadata or malformed completion. Consumers must stream-decode byte pages when a UTF-8 sequence crosses page boundaries.

Limits: 64KiB input chunks/pages, 4KiB display prefix, 128 known secrets of at most 4096 UTF-16 code units each. Memory is bounded by those limits and replacement expansion, not total output size. Stream calls must be awaited serially; overlapping calls fail closed. Metadata and text-only output are supported here; no claim of arbitrary binary/image sanitization. No `preserve`/retention/removal implementation is advertised yet.

Filesystem tests cover every split of a multibyte UTF-8 example, overlapping secret values, rotation before use, secret-bearing metadata rejection, invalid UTF-8, private/symlink/traversal rejection, incremental capture exceeding 2MiB, prefix-only truncation, paging, reopening, corruption, metadata-key collisions, replacement-boundary collisions and completion-publication failure. Temporary roots are owned new fixtures only and removed by their tests.

## Actual SDK incompatibility and candidate

The SDK is pinned as a **development-only, unmodified investigation dependency**, not an adopted production runtime/fork:

- npm package `@earendil-works/pi-coding-agent@1.5.2`, author Mario Zechner; package metadata license MIT.
- Lockfile tarball integrity: `sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA==`.
- Upstream source: `dist/core/tools/read.js`, SHA256 `e6159de5e4d94ae22968b6524237ef3d4f0374a107e2321ed5c29e93d66c8efc`.
- Exact unchanged upstream bytes preserved at `test/workers/fixtures/sdk-read-1.5.2-upstream.fixture` with this provenance/attribution, solely for reproducibility of this investigation.

Native `createReadTool` calls `resolveReadPathAsync` before substituted `ReadOperations.access/readFile`. The resolver calls host `node:fs/promises.access` and can select a host-existing Unicode path variant. With an owned synthetic `café.txt` request, creating an owned host `café.txt` sentinel changed the path forwarded to guest operations, despite unchanged input and substituted operations. No personal path/profile/credential was consulted by this reproduction.

Original actual-SDK RED output:

```text
{"sdk":"1.5.2","hostProbes":5,"guestPathKinds":["requested","host-variant"]}
AssertionError: substituted operations must not probe the host filesystem
5 !== 0
```

The supervisor authorized **one local candidate investigation**, not adopting a fork/version change. `05-sdk-read-operations-candidate.patch` changes only native read path resolution: when custom operations are supplied, use the existing syntactic `resolveToCwd`; otherwise keep native `resolveReadPathAsync` unchanged. Native read parsing/pagination/image behavior is untouched. It does not establish guest path/symlink confinement; the adapter still must enforce that.

`test/workers/sdk-read-candidate.test.ts` copies the package into a new private fixture under this worktree, verifies exact upstream version/hash/bytes, runs and checks the original failure, applies the versioned patch **only to the private copy**, and reruns. It verifies that the installed package is still byte-identical afterward. No global package, npm cache, shared/symlinked node_modules or sibling checkout is mutated. The fixture uses only locally installed dependencies and the existing `patch` executable; no network/install/publish occurs during tests.

Candidate observations:

```text
{"sdk":"1.5.2","hostProbes":0,"guestPathKinds":["requested","requested"]}
PASS custom operations: zero host probes; stable requested path; guest errors; native pagination/image; default host behavior unchanged
PASS filtered bytes reach native SessionManager JSONL and reopened context without raw secret
```

`node:fs/promises.access` is counted during native tool execution. Custom guest-operation fixtures test sentinel absent/present, denial propagation, native text pagination and PNG output. Native-default host read is separately verified to remain unchanged. The guest backend itself is **synthetic**, not Gondolin execution.

The final fixture also manually composes real Records output with actual SDK `SessionManager.create/appendMessage/open`, using explicit protected directories and native JSONL v3. A split synthetic token is filtered **before** appending the tool result, and is absent from both the JSONL bytes and reopened native context. This proves that particular persistence ordering is feasible; it is **not** `createAgentSession` activation, a streamed model response, supervised tool execution, or complete worker output interception.

## RED → GREEN and validation

Environment:

```sh
export PATH=/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin:$PATH
unset NODE_OPTIONS NODE_COMPILE_CACHE
export NODE_DISABLE_COMPILE_CACHE=1 TMPDIR=/home/sanmoo/software-factory-test
export FACTORY_SANDBOX_TEST_ROOT=/home/sanmoo/software-factory-test/product-local-clYJQT
```

All ordinary commands were bounded to at most 60 seconds. Dependencies installed offline with scripts disabled. Initial existing protocol baseline: 3 tests / 3 pass / 0 fail. Vertical RED stages included missing Records module/record operation, wrong prefix excerpt after truncation, secret-bearing metadata accepted, corrupt correlation metadata accepted, upstream SDK host probes, and the then-absent native-session evidence assertion. Each relevant test was run before its implementation; the resulting focused suite is 12 pass / 0 fail.

Final complete local coverage is retained in [05-local-gate.txt](05-local-gate.txt): `npm run check:architecture && npm run build`, followed by three bounded **serial** `node --test --test-concurrency=1` blocks covering every test file. Architecture/protocol/records/workers: 33/33 pass (18.713s); entrypoints: 25/25 pass (21.543s); sandbox: 95 tests, 94 pass / 1 unconditional VM skip (20.643s). Aggregate: **153 tests, 152 pass, 0 fail, 1 skip**. This includes the candidate's intentionally checked upstream rejection. The unconditional historical Gondolin skip remains unchanged; no VM was started or existing service/process signaled. No asset/image/history was deleted.

Validation limitations are preserved, not hidden: a default parallel `npm test` attempt failed the existing controller-ingress startup readiness assertion (`assert.ok(status?.controller_run_id)`, roughly 1s readiness loop) under concurrent load: 153 tests / 151 pass / 1 fail / 1 skip. See [05-local-gate-parallel-failed.txt](05-local-gate-parallel-failed.txt). No timeout/test assertion was relaxed or unrelated source changed; the same entrypoints group subsequently passed serially. A monolithic serial architecture/build/test command then hit the 60s per-command cap before completing; its partial output is [05-local-gate-serial-timeout.txt](05-local-gate-serial-timeout.txt). No surviving test process was observed afterward. This motivated the final bounded blocks. Do **not** describe the final evidence as a clean invocation of default `npm test` or conceal the load-sensitive readiness failure; interrupted ordinary fixture cleanup is not a claim that historical resources were removed.

Active LSP probe on all seven changed TypeScript paths reported 6 clean/1 findings, 0 unavailable/inconclusive. Two auxiliary AST warnings in Records: a false-positive redundant-state warning (`records` is also used by `record` to call `openOutput`) and a private helper boolean-mode style warning. `tsc` and ESLint/dependency-cruiser are the concrete passing gates, not an inference from an empty diagnostic cache.

## Remaining work and precise decisions

1. **SDK adoption/compatibility decision:** parent review must choose whether to adopt the narrowly demonstrated fix (or a supported upstream release with equivalent behavior) before operational native read. This patch is a candidate only; no shipping SDK bytes are patched. Do not silently replace native read or permit host probes.
2. **Missing local implementation, not a design ambiguity:** Workers activation/host supervision integration, durable reservation/start receipt ordering, existing-owner tool transport and `Sandbox.executeTool`, role/phase projection, native session/profile/loader integration, filtered selective guest artifact copy, and EOF/abort/supervised-stop composition remain unimplemented. The Records API is not evidence that these exist. Q5 already authorizes this work and 05 owns that seam; 06 must not infer an available runtime `ToolEnvironment` from this partial.
3. **Real model boundary remains HELD:** historical `gpt-6-luna`/OAuth and USD10 are not validated as supported or as aggregate accounting/enforcement. Smallest external input is an explicitly supported provider/model + Factory-only credential delivery mechanism + verifiable aggregate spend/accounting/cap mechanism and a narrowly authorized real-call plan. No credential value belongs in prompts, argv, source, receipts or this report. A subscription is not assumed free or capped.
4. **Physical evidence:** no new VM/process-owner signal/network/Dockerhost/pull grant exists; none was spent. Once local wiring and the SDK decision are ready, the owner must authorize the concrete real SDK/model/tool composition and any required physical VM proof. SDK return/abort cannot certify cessation.

No complete05 claim, no model or cost observation, no worker receipt, no tool execution in an actual guest, no operational confinement claim and no integration merge are implied by the local green suite.
