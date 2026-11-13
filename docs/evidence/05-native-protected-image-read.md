# Task78 — protected native PNG/JPEG read increment

## Scope and composition

Built on unchanged Records commit `6fac9583f7d598366cf376d426e8a6f2b9467a2c`. This is a narrow local development-profile PNG/JPEG increment, not closure of 05/09/19, Task65 budget authorization, general binary attachments/OCR, all-native-format parity, or hardware/guest qualification.

Trusted Host invocation input may supply optional `imageSourceMaxBytes`, a positive safe integer. `createWorkers.activate` carries it through the existing strict Host launch/bootstrap schema; the owner independently validates and snapshots it on its role/invocation-bound binding. It is not a native read argument, ToolContext claim, model-chosen cap, global reservation, or default. Absent configuration preserves existing image denial. No product byte number is invented: all numeric image budgets in tests are explicit TEST budgets derived from fixture sizes.

The existing coarse PNG/JPEG/GIF/WebP prefix checks only route capture format: PNG/JPEG candidates with a Host budget use existing protected raw Records; GIF/WebP remain denied by existing checks. No BMP detector or new MIME classifier is introduced. Workers alone call the existing native byte detector on at most 4100 bytes of the completed filtered capture; only PNG/JPEG proceed. The unchanged native SDK performs decode, normalization, auto-resize (enabled), tool image blocks, provider-loop integration and native session persistence.

The same guest helper body, argv, opened-FD guard, streaming/backpressure, context checks, completion and same-invocation reference membership remain in use. Helper SHA256 is unchanged: `91ebe599ffc7cc420982070810d098af184a6d3ebc89f433de11b1545604503b`. Nothing executes the guest helper body on the Host; the preexisting regression uses Python AST parsing only.

## Byte protection and transport

The owner initially opens the legacy text capture before guest activity, preserving structural-metadata failure ordering. A qualifying prefix switches to raw by aborting the still-empty text channel and opening existing Records raw mode with the independently bound cap. Both the held prefix and all subsequent chunks pass the same registry's literal UTF-8 byte matcher before append. No base64 is generated before complete filtered publication. Raw failures, rotation, nonzero guest exit, stream errors and revocation cannot publish a reference or fall back to text/raw partial content.

Successful transport explicitly identifies `format`, `encoding: base64` and, for raw, the owner cap. Raw pages require explicit `format: raw`; default text pages cannot consume them. Frames carry at most 24576 source bytes / 32768 base64 characters. Safe-integer counts/offsets, canonical base64, consistent reference/format/cap/size and bounded monotonic progress are checked. Out-of-range raw offsets fail closed. Workers obtain the full byte-exact image Buffer from that same completed capture, not a second path read. Only raw images within the owner cap bypass the old 50000-byte text unusual-range fallback cap. Native omission, classifier rejection, decode errors and missing image blocks are failures, not image success.

## Pinned Factory-owned facade

`#factory-image-mime` statically resolves to Factory's `.scratch/factory-development-sdk/image-mime.js`, with a Workers declaration alias. Exact facade bytes:

```js
export { detectSupportedImageMimeType } from "./sdk/dist/utils/mime.js";
```

including one final newline, SHA256 `514aaf1a9e0ba039af4a07b1dfed53f9e6935ced7b1cd70a08b3fdc0ab46a669`. Provenance: `@earendil-works/pi-coding-agent@1.5.2/dist/utils/mime.js#detectSupportedImageMimeType`, already exported internally upstream. The existing pinned full upstream tree also authenticates that file. Preparation is idempotent and rejects facade-byte/ownership/type/mode drift without overwriting it. The facade is outside the copied SDK tree: no SDK index/source export mutation, global/shared package mutation, cache trick, computed import, temporary image file, alternate decoder or additional SDK bugfix patch. Existing version, integrity, upstream/tree/read-operations patch/result hashes and `profile.json` bytes remain unchanged. Facade provenance/hash are separately recorded in Factory source and here.

## TDD and local evidence

Baseline compiler and 21 existing native-owner/transport/profile tests passed before production changes. New native-image RED first failed compilation (`Expected 2 arguments, but got 3`) and execution (`READ_BINARY_UNSUPPORTED`). The passing implementation was then tested against actual native decode: an invalid inline PNG fixture was correctly omitted; it was replaced with clean locally generated fixtures, not an SDK bypass. Synthetic red 1x1 PNG/JPEG fixtures were generated locally with the installed pinned Photon dependency; no assets were fetched. A synthetic wide PNG also proves actual native resize, not merely retained source base64.

All validation used absolute `/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`, unset `NODE_OPTIONS`/`NODE_COMPILE_CACHE`, `NODE_DISABLE_COMPILE_CACHE=1`, and per-command `timeout 60s`.

- `node node_modules/typescript/bin/tsc -p tsconfig.json`: exit 0.
- `node dist/src/workers/sdk-profile.js`: exit 0; original pinned profile hashes unchanged.
- `node --test dist/test/records/*.test.js dist/test/sandbox/tool-transport.test.js dist/test/sandbox/invocation-isolation.test.js dist/test/sandbox/owner-registration.test.js`:

  ```text
  tests 89
  suites 0
  pass 89
  fail 0
  cancelled 0
  skipped 0
  todo 0
  duration_ms 890.816395
  ```

- `node --test dist/test/workers/native-owner-read.test.js dist/test/workers/native-image-read.test.js dist/test/workers/worker-image-process.test.js dist/test/workers/worker-process.test.js dist/test/workers/host-activation.test.js dist/test/workers/host-launch-plan.test.js dist/test/workers/sdk-profile.test.js`:

  ```text
  tests 54
  suites 0
  pass 54
  fail 0
  cancelled 0
  skipped 0
  todo 0
  duration_ms 9190.921565
  ```

The new image tests verify renamed-extension PNG and JPEG, >50000-byte clean images with explicit source TEST budget -1/exact/+1, byte-exact paged capture/full-buffer/native block, independent invocation references, explicit raw paging, EOF/unsafe and beyond-EOF offsets, model inability to select/raise cap, native classifier/decode omission rejection, real resize, and unchanged UTF-8/page/BOM/redaction/text fallback behavior. ASCII and non-ASCII literal metadata are split at every secret byte position for both PNG and JPEG; failed image captures have no completed publication or literal source secret on controlled disk.

Actual new Node24 processes run the fixed worker entrypoint and existing bootstrap with the real SDK, Records, Protocol, native read and SessionManager. External VM and HTTP boundaries alone are substituted. Clean PNG/standards and JPEG/spec both produce an actual native image block, reach the next vision-model test request (`input: ['text', 'image']`), persist native JSONL and survive SessionManager reopen. Distinct observed child PID/Node24 receipts are verified. Contaminated non-ASCII metadata in both formats yields interrupted sessions, no native image/session secret and exactly one HTTP-boundary request (no model next turn). HTTP preloads never forward any URL to real fetch.

Architecture initially caught a prohibited runtime Sandbox import during schema reuse; it was removed, preserving the existing Workers type-only boundary and its separately validated transport schema. No architecture rule was changed or bypassed. Final dependency-cruiser and ESLint gates pass. Active LSP probe found no TypeScript errors; some push-only files were inconclusive and auxiliary AST findings concerned the existing intentional fail-closed JSON.parse calls in SDK preparation. Full compiler and configured gates remain authoritative.

## Residual risks / non-claims

- Source-byte cap is NOT a decoded-pixel/WASM/decompression-memory hard bound. Native decode runs before resize limits; original buffers, chunks/concat, transfer copies and base64 can coexist. Hardware/group resource qualification, concurrency/reservation policy, text source/time bounds and overall budgets remain open. Task65 remains user-pending.
- Literal registered UTF-8 byte matching does not promise protection against compressed, encrypted, encoded or semantic variants. Registry fences remain same-instance, not cross-process; completed captures are not retrospectively reclassified after new secret registration. Existing Records limitations are unchanged.
- Legacy Records consumes a leading UTF-8 BOM; this increment preserves that behavior, not upstream BOM parity. Existing text pagination/redaction and the unusual-range whole-buffer cap remain intact; no other source/duration constraints are waived.
- GIF/WebP/BMP and arbitrary binary semantics are OPEN/unqualified. No universal image parity or attachment/OCR claim.
- Same-FD guest helper prerequisites, trusted kernel/proc/mount/interpreter profile, native dependencies and worker resource containment remain unqualified on the frozen real runtime. No VM/Host-helper execution, network/DNS/real model, systemd, OAuth, personal profile/credential, GitHub/assets/install, Docker/sudo/mount, peer integration, push or suite-wide loop was used.
