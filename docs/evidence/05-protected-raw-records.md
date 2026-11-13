# 05 — protected raw output Records (Task76)

## Scope

Additive **Records-only source implementation**, based on clean `64a18fd9317df91353325a67b992f4abe67a2ec8`. Integration `4e085bf` was not changed. This is not native image enablement, general binary semantic attachment support, guest/runtime qualification, or whole-05 acceptance. Existing Sandbox image rejection, helper, read transport, Workers/SDK/profile and native read defaults are unchanged. Whole 05 remains open; Task65 user budget authorization remains pending.

## Explicit API and persistence

- Existing `openOutput(context)`, text `write(): Promise<string>`, text completion/excerpt/display, fatal streaming UTF-8 decoder, known-secret replacement and JSONL `record()` stay text-only. No legacy string/union/`any` widening.
- New overload: `openOutput(context, { format: 'raw', maxBytes })`. `maxBytes` is required, finite, positive and a safe integer. This caller-supplied technical capture budget is **not** a global policy cap, reservation, admission authority or MVP waiver.
- Raw `write(): Promise<void>` exposes no bytes/excerpt/display. Successful `finish()` returns `{ version: 2, format: 'raw', reference, bytes }`. Raw capture/completion metadata are discriminated v2; legacy metadata remain v1.
- Raw pages require explicit `read({ format: 'raw', reference, offset, limit })`; replies add `version: 2, format: 'raw'`. An unqualified legacy read of raw output fails protected rather than silently handing binary to a text caller; the converse format mismatch also fails. Clean completed raw bytes, including NUL and invalid UTF-8, are unchanged. Raw partial pages have **no data**. Safe offsets/counts, bounded page limits, exact EOF and capture-budget/metadata checks apply.

## Protection and bounds

The same existing registry registers string values once. Raw matching encodes those values as UTF-8 and compares their **literal bytes**, not base64 or decoded/replacement text. Before any raw append, scan the bounded prior tail plus the current <=65536-byte chunk for every registered pattern. A match invalidates the capture, discards the tail and throws only `PROTECTED_CAPTURE_UNAVAILABLE`; no in-place redaction/image corruption and no successful completion. Raw completion has no text excerpt/display path, base64 or SDK operation.

Retained byte tail is at most longest encoded pattern minus one, copied into its own bounded allocation (not a slice retaining the whole input). The existing 4096 UTF-16-unit/value and 128-value registration limits imply at most 12288 UTF-8 bytes/value and a 12287-byte tail. The scan buffer is therefore at most 65536+12287 bytes. Total received input, including unflushed tail, is checked against the caller budget and safe-integer arithmetic **before concat/append**; appended byte counters are checked before write. No source-total allocation or invented global capacity policy.

Raw captures reuse the existing private owned directory/file operations, bounded metadata parser, abort path, file sync and validated atomic completion rename/parent sync. No alternate binary store, storage engine, generic filter framework, ledger, registry service or Sandbox/SDK import is introduced. Registry values/encoded matcher state and error diagnostics are never serialized.

## Registration/rotation semantics and fences

A genuinely new successful registration is a registry revision change; duplicate registration is a no-op. All active raw captures become failed **synchronously before registration returns or filesystem awaits**. Their tail is discarded and handle/completion withdrawal begins through the same invalidation path. In-progress opening is revision-checked around metadata publication and before returning its channel. In-progress write/finish checks state/revision; completion publication checks before/after rename and after parent sync. Reads are fenced while an active raw finish is being revoked, including a marker already renamed but still syncing. Failed cleanup does not intentionally release the active read fence. No larger matcher window is installed into an already flushed raw stream.

The registry is the existing same-instance registry, not a new cross-process synchronization service. Registration does **not** retrospectively classify already completed captures or erase arbitrary bytes appended before a previously unknown value was registered. Active invalidated captures have no completed reference/result and expose no raw partial pages; already written prefixes were checked against the values known at append time. This temporal limitation must not be described as retroactive secret discovery or durable secure erasure. Re-registration/rotation must precede opening a new capture. No encrypted/compressed/encoded secret discovery is claimed.

## TDD and validation

Used absolute `/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`, cleared `NODE_OPTIONS`/`NODE_COMPILE_CACHE`, set `NODE_DISABLE_COMPILE_CACHE=1`; every compiler/test/gate command bounded by `timeout 60s`. No VM/helper-body execution/eval, HTTP/model/network tests, provider calls, assets/install/profile changes, auth/GitHub/push, cleanup of historical artifacts, hook bypasses, peer integration or delegation.

1. Ran baseline compiler and existing Records tests successfully before production changes.
2. Added raw behavioral tests first. RED compiler reported absent raw overload/read discriminant (`TS2554`, `TS2353`, `TS2339`); emitted runtime tests failed on existing binary rejection/absent budget/rotation behavior. No old test expectation was weakened.
3. Implemented shared capture-mode branches and typed public overloads. An intermediate compile caught TypeScript's asynchronous state narrowing around cleanup; factored cleanup validation into a function instead of casting state/using `any`.
4. Final commands (each with the environment/absolute Node/timeout prefix above):

   ```sh
   node node_modules/typescript/bin/tsc -p tsconfig.json
   node --test dist/test/records/*.test.js
   node node_modules/dependency-cruiser/bin/dependency-cruiser.mjs --config .dependency-cruiser.cjs --output-type err-long .
   node node_modules/eslint/bin/eslint.js . --max-warnings 0
   git diff --check
   ```

   Compiler exit 0. Exact Records summary:

   ```text
   tests 68
   suites 0
   pass 68
   fail 0
   cancelled 0
   skipped 0
   todo 0
   duration_ms 829.935788
   ```

   Architecture: `✔ no dependency violations found (109 modules, 548 dependencies cruised)`.
   ESLint and diff-check exit 0. No suite-wide 153-test loop or SDK build/prepare hook.

New tests use actual new private Records filesystem roots, not an alternate fake store. Cover clean image-like/NUL/invalid UTF-8 bytes, source chunks/pages/EOF, persisted v2 metadata/reopen, every cut of non-ASCII and overlapping registered literals before disk, disk artifact inspection, literal versus base64 distinction, single-byte writes of a maximal encoded secret, page/chunk-spanning literals, caller budget -1/exact/+1 including retained input, safe-integer/runtime input errors, chunk/page limits, empty raw captures, duplicate/new registration, opening revision races, concurrent writes and abort/finish/rotation at output-sync/temporary-sync/parent-sync, and protected write/sync failures. Existing Records text/filter/JSONL/large-output regressions all pass.

Active LSP probe: two changed test files clean; Records has only pre-existing-style findings (deprecated `z.string().uuid()` hint and auxiliary style suggestions including bounded object traversal/flag arguments). No TypeScript errors; full compiler and configured architecture/ESLint are authoritative. Did not broaden scope to rewrite existing traversal/filter/storage semantics in response to advisory style suggestions.

## Self-review / residual risks

No implementation blockers found in the scoped source review. Raw literal matching is exact-value protection, not semantic sanitization. Same-instance fences do not claim cross-process coordination or power-loss/storage-recovery atomicity. No retroactive secret discovery/erasure, total admission/reservation policy, time/resource budget policy, physical guest FD proof, native image delivery/decode-memory bound or real-model qualification is added. Caller-owned `maxBytes` is technical enforcement only. Whole 05 and the separately pending Task65 authorization remain open.
