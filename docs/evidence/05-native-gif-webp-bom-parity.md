# Task80 — bounded native GIF/WebP and selective file BOM parity

Scope: increment on `f8774e463465f348d2e9daeaf2a774c78e54fc02`, not completion of whole 05. Original integration `4e085bf` and private SDK pins/facade/patches remain unchanged.

## Implementation

- Existing coarse GIF87a/GIF89a and RIFF/WEBP prefix routing now selects the SAME capped protected raw Records path as PNG/JPEG. No new magic algorithm, BMP handling, Host conversion/decoder, temporary image file, or source recapture. Workers accepts native byte-detector GIF/WebP results and leaves actual native decode/auto-resize enabled.
- Same independently snapshotted Host `imageSourceMaxBytes` contract; no configured cap still denies images. Model arguments cannot enable/raise the cap. Raw literal UTF-8 secret matching, completed-only publication, byte-exact pagination and failures are unchanged.
- Additive explicit Records `{ format: 'text', preserveBOM: true }` overload selects `ignoreBOM: true` on the SAME fatal UTF-8 decoder/filter. The option is validated and snapshotted before capture awaits. Only owner FILE captures opt in. Default openOutput signature, default BOM consumption, text return types, version-1 metadata and record/event behavior stay unchanged. Workers already streams native Buffers without byte-page re-decoding; no replacement reader engine was added.

## TDD and runtime proof

Before edits: compiler and 27 focused existing native image/owner tests passed. RED: extended GIF/WebP tests failed `READ_BINARY_UNSUPPORTED`, image/session assertions failed, and all five new native BOM comparisons failed. RED summary: 45 tests, 24 pass, 21 fail. Those failures reached the actual native SDK; no decoder/model-loop stub was added.

Synthetic local fixtures: a constructed 1x1 GIF and a 1x1 WebP encoded once locally from the existing PNG using pinned Photon. GIF comments and valid extended WebP XMP chunks carry test metadata, with source headers/lengths/padding maintained. No fetched assets or executable guest body on Host.

Actual native GIF/WebP image blocks survive byte-exact >50000-byte protected transport, renamed `.txt` paths, irrelevant image offset/limit arguments, explicit TEST cap minus-one/exact/plus-one, native JSONL and SessionManager reopen. Every byte split of ASCII/non-ASCII literal secret metadata fails before source completion/SDK publication and never writes the literal secret to controlled disk. Truncated GIF/WebP reach native image processing but fail rather than being accepted as image success.

Four added fresh Node24 fixed-worker runs cover clean and blocked GIF/WebP: distinct observed child PID receipts, actual native image JSONL/session reopen, two observed HTTP requests for clean images, only first HTTP request and interrupted session for secret metadata. External VM and HTTP are the only substituted boundaries; HTTP never forwards to real fetch.

BOM tests compare real protected native reads against real native default file operations on an already-filtered oracle file. Streaming, whole-buffer unusual/fractional/negative ranges, offsets, CRLF, one-byte fragmented BOM/multibyte/known-secret input and a UTF-8 character crossing the 24576-byte transport page all match. An actual provider loop/native JSONL/reopen also retains BOM while redacting the known secret. Direct Records tests cover every byte split in both default and opt-in modes, identical legacy metadata keys, completion byte counts, persisted/read bytes and fatal invalid UTF-8.

## Validation

All Node commands use absolute `/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`, `timeout 60s`, unset `NODE_OPTIONS`/`NODE_COMPILE_CACHE`, and `NODE_DISABLE_COMPILE_CACHE=1`.

- `node node_modules/typescript/bin/tsc -p tsconfig.json`: exit 0.
- `node dist/src/workers/sdk-profile.js`: exit 0; original profile hashes unchanged.
- `node --test dist/test/records/*.test.js dist/test/sandbox/tool-transport.test.js dist/test/sandbox/invocation-isolation.test.js dist/test/sandbox/owner-registration.test.js`:
  ```text
  tests 90
  suites 0
  pass 90
  fail 0
  cancelled 0
  skipped 0
  todo 0
  duration_ms 995.620584
  ```
- `node --test dist/test/workers/native-owner-read.test.js dist/test/workers/native-image-read.test.js dist/test/workers/native-bom-read.test.js dist/test/workers/worker-image-process.test.js dist/test/workers/worker-process.test.js dist/test/workers/host-activation.test.js dist/test/workers/host-launch-plan.test.js dist/test/workers/sdk-profile.test.js`:
  ```text
  tests 79
  suites 0
  pass 79
  fail 0
  cancelled 0
  skipped 0
  todo 0
  duration_ms 14393.346839
  ```
- Configured dependency-cruiser and ESLint pass without rule exceptions; git diff whitespace checks pass. Active LSP probe: 7 files confirmed clean, 3 push-only/inconclusive, no reported diagnostics; compiler is authoritative supplemental evidence, not an assertion that inconclusive files were LSP-clean.

## Self-review and residual risks

No scoped blockers. Self-review fixed an outdated prompt after extending the existing BOM session test; HTTP fixture expectations were extended to GIF/WebP, not used to replace native processing.

- BMP remains OPEN, including native format parity; no broad `BM` detector or text false-positive behavior change.
- Source-byte cap is NOT decoded pixel/WASM/decompression memory protection, total production source time, concurrency reservation or hardware qualification. Whole 05/09/19 remains incomplete; Task65 remains user-pending.
- Literal known UTF-8 matching does not protect encoded/compressed/encrypted/semantic variants. Existing same-instance registry and post-completion registration limits remain.
- Frozen guest runtime/helper prerequisites and real resource containment remain unqualified. Guest helper body/argv/hash, source cap authority, SDK pins/drift fences are unchanged.
- No actual Factory models, real network/DNS, OAuth/credentials, GitHub, fetched assets/rootfs, installs, Docker/sudo/mount, new delegation, peer integration, suite-wide loop, hook override or push.
