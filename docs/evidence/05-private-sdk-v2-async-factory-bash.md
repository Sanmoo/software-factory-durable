# Task95 — private development SDK v2 / awaited Factory Bash

Scope: one writer on existing `implement/software-factory-mvp-05`, clean base
`be7a164f7d14d0db4e8277c4523228e850667546`. Parent adoption decision read in full
from `/tmp/software-factory-mvp-05-sdk-drain-adoption-decision.md`. No candidate
algorithm reimplementation/re-review or outside seven-scenario rerun. No merge,
tracker closure, dependency installation, real VM, model/API/auth or network access.
Original integration destination remains `integration/software-factory-mvp`, not main.

## Integration

- New canonical owner-only `.scratch/factory-development-sdk-v2` (0700), profile
  `factory-development-pi-1.5.2-read-async-bash-v2`. V1 is preserved byte-for-byte.
- Runtime import aliases use v2; default TypeScript alias still uses original
  upstream declarations. Factory Bash privately extends only its operations
  options with optional typed `onDataAsync`; runtime function guard precedes
  tool RPC/guest effects. There is no synchronous fallback.
- Existing client and worker projection handlers await each already Records-filtered
  <=24576-byte progress chunk before consuming another frame. Native schema,
  accumulator, formatting, session machinery and owner intent/completion/UNKNOWN
  handling remain native/existing. Only the comment in owner bash-tools changed.
- Preparer pins original package/version/integrity/full tree, the old read correction,
  the extracted four-file patch and each before/after hash. Standard `git apply
  --check` precedes reproducible private application; no custom patch engine.
  Entire copied tree is verified, not only changed files. Reuse requires matching
  files/metadata and refuses unexpected files, hardlinks, unsafe symlinks or missing
  metadata without repairing the tree. Git is an offline development preparation
  prerequisite; worker execution does not run the preparer.
- SDK-only extraction contains four JS/dts files, not either candidate harness.
  No installed/shared/cache/global SDK or immutable candidate bytes were changed.
- Package MIT license metadata is preserved; upstream standalone LICENSE is absent.
  No invented license text or distribution qualification is asserted.

## Commands and evidence

All Node invocations used absolute
`/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node` with NODE_OPTIONS
and NODE_COMPILE_CACHE unset and NODE_DISABLE_COMPILE_CACHE=1. Each command had
<=60s budget. New tests use only new owned temporary fixtures; stream interception
is test-only and restored in finally. Fixed guest helper source is never host-run.

Baseline focused compiled profile test: 1/1 passed. Baseline native Bash complete
block: 1/1 passed. New RED command (without force-exit):

`node --test --test-name-pattern='profile v2|stream release' test/workers/sdk-v2-integration.test.mjs`

```text
✖ new private development profile v2 preserves prior read correction and MIME facade (1.640511ms)
✖ Factory native async Bash + real Protocol/Records: held private stream release (53.155026ms)
ℹ tests 2
ℹ suites 0
ℹ pass 0
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 781.411925

✖ failing tests:

test at test/workers/sdk-v2-integration.test.mjs:16:1
✖ new private development profile v2 preserves prior read correction and MIME facade (1.640511ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'factory-development-pi-1.5.2-read-operations-v1'
  - 'factory-development-pi-1.5.2-read-async-bash-v2'
  
      at TestContext.<anonymous> (file:///home/sanmoo/dev/github.com/Sanmoo/software-factory-durable/.worktrees/software-factory-mvp-05/test/workers/sdk-v2-integration.test.mjs:17:10)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'factory-development-pi-1.5.2-read-operations-v1',
    expected: 'factory-development-pi-1.5.2-read-async-bash-v2',
    operator: 'strictEqual',
    diff: 'simple'
  }

test at test/workers/sdk-v2-integration.test.mjs:26:3
✖ Factory native async Bash + real Protocol/Records: held private stream release (53.155026ms)
  AssertionError [ERR_ASSERTION]: no further native admission while drain held
  
  5 !== 4
  
      at TestContext.<anonymous> (file:///home/sanmoo/dev/github.com/Sanmoo/software-factory-durable/.worktrees/software-factory-mvp-05/test/workers/sdk-v2-integration.test.mjs:75:14)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 5,
    expected: 4,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

The profile mismatch and continued native admission under held drain were genuine
new integration failures against compiled be7a164. An earlier broad RED attempt
reached its 60s budget because its failing test interception/cleanup threw; the
harness was corrected before recording the bounded RED above. One diagnostic
force-exit RED run was not used as GREEN evidence.

Compilation: initial pinned `tsc -p tsconfig.json` rejected the bootstrap schema's
remaining literal v1 ID (two assignment errors); fixed schema and all three normal
fixtures. The next project tsc passed. This is one successful project compilation,
not a claim that there was only one invocation. Compiled preparer then succeeded.
After an existing temp-failure expectation was corrected, only that test was
transpiled with pinned TypeScript (ESNext output), not another project compilation.
The first test-only transpilation used NodeNext without package context and emitted
CJS; its failed ESM run was corrected, not counted as a gate pass.

New GREEN command:
`node --test test/workers/sdk-v2-integration.test.mjs`

```text
✔ new private development profile v2 preserves prior read correction and MIME facade (2973.767684ms)
✔ v2 preparation refuses unexpected bytes, unsafe links and missing metadata without repair (5369.268593ms)
✔ Factory rejects actual unpatched native SDK before any tool RPC or guest effect (673.344263ms)
✔ Factory native async Bash + real Protocol/Records: held private stream release (62.411408ms)
ℹ source=88032, native max pending=24548; release
✔ Factory native async Bash + real Protocol/Records: held private stream abort (17.751856ms)
ℹ source=88032, native max pending=24548; abort
✔ Factory native async Bash + real Protocol/Records: held private stream stream-error (11.161936ms)
ℹ source=88032, native max pending=24548; stream-error
✔ Factory native async Bash + real Protocol/Records: held private stream protocol-overflow (26.000354ms)
ℹ source=880032, native max pending=24548; overflow FAILS CLOSED, not lossless transport flow
✔ new Node24 v2 worker projection/session JSONL: held native stream release (885.171353ms)
ℹ held native writes=3, pending=24548, bytesWritten=0; source=88032 bytes (< protocol cap); outcome=completed
✔ new Node24 v2 worker projection/session JSONL: held native stream abort (875.292836ms)
ℹ held native writes=3, pending=24548, bytesWritten=0; source=88032 bytes (< protocol cap); outcome=interrupted
✔ new Node24 v2 worker projection/session JSONL: held native stream stream-error (902.689157ms)
ℹ held native writes=3, pending=24548, bytesWritten=0; source=88032 bytes (< protocol cap); outcome=interrupted
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12524.813424
```

This proves private v2 preparation/idempotence/drift refusal, actual original SDK
missing-capability rejection with zero RPC, actual private native SDK + real
Protocol/Records with held OWN WriteStream, and a new real Node24 worker using the
current worker projection and new native session JSONL. Exact filtered spill bytes
are checked after release; abort and native stream error interrupt, suppress the
next provider turn, and do not become success. Later local invocation is revoked.

Focused compiled affected existing blocks:
`node --test dist/test/workers/sdk-profile.test.js dist/test/entrypoints/normal-bash.test.js dist/test/workers/worker-bash-process.test.js`

```text
✔ public normal Builder Bash -> SAME owner VM -> new Node24 -> filtered native host spill/JSONL/reopen (2417.323638ms)
✔ private pinned SDK preparation is idempotent and refuses drift without overwriting it (7659.39089ms)
✔ new Node24 native Bash/session/host spill: complete (1359.833685ms)
✔ new Node24 native Bash/session/host spill: binary (1046.669212ms)
✔ new Node24 native Bash/session/host spill: capture-failure (1149.936532ms)
✔ new Node24 native Bash/session/host spill: transport-loss (1072.526243ms)
✔ new Node24 native Bash/session/host spill: temp-failure (985.871853ms)
✔ new Node24 native Bash/session/host spill: session-failure (1072.396108ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7732.36625
```

The public normal-owner test uses normal owner registration/Host launch, SAME VM
instance double, manager double and offline HTTP double, actual new Node/session
JSONL/reopen. It is a separate proof level from local held-stream admission.
Existing temp-failure expected fatal worker exit under the old SDK. The adopted
native SDK catches open errors, so that one expectation now requires the common
interrupted session/error tool-result path (no second provider turn), not exit1.
Session-file failure still requires fatal worker failure. The first focused run
exposed this stale expectation (7/8), before correction (8/8).

Focused read/image/BOM regression command:
`node --test --test-name-pattern='Q5 owner|preserved file BOM|configured image budget|explicit host image budget' dist/test/workers/native-owner-read.test.js dist/test/workers/native-image-read.test.js`

```text
✔ explicit host image budget delivers real native PNG image block from completed protected capture (86.4872ms)
✔ configured image budget retains file BOM and preserves UTF8/page/redaction and whole-buffer fallback cap (181.018723ms)
✔ Q5 owner capture reaches native SDK pagination, beyond the old 16K wrapper, with split secrets filtered (179.650491ms)
✔ Workers-private SDK component uses real provider loop and native JSONL with preserved file BOM and only filtered guest tool content (150.67132ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1130.327789
```

Architecture: pinned Node running
`node_modules/dependency-cruiser/bin/dependency-cruiser.mjs --config .dependency-cruiser.cjs --output-type err-long .`
reported `no dependency violations found (137 modules, 706 dependencies cruised)`.
An initial mistyped binary path failed MODULE_NOT_FOUND; no install was attempted.
Pinned ESLint of changed TS and both new mjs files with `--max-warnings 0`: exit0,
no output. `git diff --check`: exit0, no output. No npm test/full suite was run.

Active LSP probe: 11 changed TS paths checked, no primary TypeScript errors; two
existing Zod deprecation hints. Auxiliary AST-grep findings include pre-existing
JSON.parse throwing calls (intentional fail-close in preparer), string sorts,
existing CLI console and unrelated legacy hints. Runtime function guard is required
at this SDK capability boundary. Package JSON clean. Both mjs files have no reported
errors but their push-only LSP cannot attest clean (inconclusive even after 5s);
ESLint and actual Node execution cover them. Do not interpret empty LSP output as
proof of clean.

## Hashes and preservation

```text
PASS preserved full regular-file bytes/directory/link inventory .scratch/factory-development-sdk 1369 entries
PASS preserved full regular-file bytes/directory/link inventory /tmp/software-factory-mvp-05-sdk-drain-candidate-mHov7O 119 entries
PASS preserved full regular-file bytes/directory/link inventory node_modules/@earendil-works/pi-coding-agent 1366 entries
PASS reproducible SDK-only extraction; four runtime/declaration files, no harness files
PATCHED dist/core/tools/bash.d.ts 78d2558fa0d81296004aed0b0c939b6c44a14a60e792eb363d08a2e4a6a5726b ab7d399fecde1446eb92c231a4a83567e658b0e580caff939d259b3fa4572f24
PATCHED dist/core/tools/bash.js afc4f829b3da2e7d8cc31296ccceb26bbc8e35018eb3f352791b651866cc2040 2a6f7dc6b16357e8927a8f82cd895a9f6c96d98401eddf1e925cd74a64094e9d
PATCHED dist/core/tools/output-accumulator.d.ts 363987be1771e96d16805df4e13300ced5e701375ed9e156f7562141e0c0a2e2 febeb4e32a161e5af81cb5c3484861f972f58339923abe23a0959720e14f2006
PATCHED dist/core/tools/output-accumulator.js 5416cd0ef5a8edc984093ed67053ae27ebfc7ed42699c452daddf94dd6217858 6ce6e014c2fd47f094626cf9ba0860403db9b49b4333486e9394c8eaeea05ae5
PATCHED dist/core/tools/read.js e6159de5e4d94ae22968b6524237ef3d4f0374a107e2321ed5c29e93d66c8efc 06867a067ebbadca2e06f75ccb4e682cd7e37b9683d41a71562f770b3105a209
PASS upstream/v2 complete tree parity except exact five pinned corrected files; 1361 unchanged entries
CANDIDATE manifest.json b6aaa5391d251867e41e8fc80973a1da79c7df3e38cdd18d11e705d939809b69
CANDIDATE candidate.patch fd85bbd3c22fff3cb90dd990cb2608f18884d15dcd3820fb2f790b6e42a4dd01
SHA256 package.json 3f686300605487280a0b67bbdadcff7aceb7a79f3f947f013583bf924746c492
SHA256 package-lock.json de1b76b7c26de69d087075260c2f409edd3544f2d113ad8faa5a593ae2ae4587
SHA256 docs/evidence/05-sdk-read-operations-candidate.patch 5e45a7c2953db293a14db0138bb31f8ac9e95eb13512afd42f1f49b77c98e066
SHA256 docs/evidence/05-sdk-async-bash-v2.patch 1ee38f2bdb71480b5b6206e72dbed32ac9214acbe0afe9b7e5137ea8f63cdc1e
SHA256 .scratch/factory-development-sdk-v2/profile.json e7779cddb6aab0683ee1be24e7266c1edcd5a74818442cf4e02a0e0436b19404
SHA256 .scratch/factory-development-sdk-v2/image-mime.js 514aaf1a9e0ba039af4a07b1dfed53f9e6935ced7b1cd70a08b3fdc0ab46a669
PASS new root canonical owned0700
LICENSE metadata MIT; standalone LICENSE absent; no distribution qualification
```

Upstream version 1.5.2 integrity:
`sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA==`.
Original full-tree SHA256:
`7d0961cce25f6c802b22aaa028206cd610de386442d2e6b732d71367ef006391`.
The preparer independently checks the original full tree on each invocation. Manual
before/after inventory covers regular bytes/directories/link text of the installed
SDK, V1 root and candidate, without traversing candidate dependency read links or
session/cache directories. Existing package-lock is unchanged. The copied SDK has
exactly five changed files: four adopted candidate files plus prior read fix;
all remaining entries match upstream. MIME facade bytes/hash are unchanged.

## Bound and residual holds

Observed held native writable queue: 24548 bytes across three writes, no bytes
physically written while corked; no further native admission until drain release.
Test admission ceiling is HWM16384 + one application chunk24576 = 40960 bytes.
Native's own accumulator raw/tail bounds remain native. These are local-stage
bounds, not arbitrary-total pipeline/RSS/kernel/hardware bounds.

Protocol remains UNCHANGED: 64KiB frame maximum, pending inbound budget
4*64KiB=256KiB, FAIL-CLOSED on overflow; it does NOT pause/resume the socket.
The lossless local-stage fixtures have 88032 source bytes with bounded wire frames
below that budget. The held 880032-byte overflow fixture fails closed instead of
success after release and revokes the local invocation. This is NOT lossless
arbitrarily slow-sink end-to-end backpressure. No transport redesign was performed.

Real guest/model/physical FD cessation and release qualification remain unproven.
Whole85/05, native edit, full symlink compatibility, BMP, selective guest copy,
Q10/19/20, grants/authorizations and physical-FD cessation remain OPEN. Task65 human
authority/USD10 choices remain pending. No old resource cleanup/signals, integration
merge, tracker closure, credential/model API/OAuth access or real VM was performed.
