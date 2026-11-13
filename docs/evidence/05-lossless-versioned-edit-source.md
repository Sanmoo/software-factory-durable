# 05 — first lossless versioned edit-source capture increment

Scope: Task98 **first source-capture increment only**, based on `31b1a53b84b558583144324a5c02868b116db65a`, in existing `implement/software-factory-mvp-05`. No integration/main merge, native edit adapter/tool enablement, SDK/profile change, bootstrap wiring, mutation helper or full Task98/05 qualification.

## Implementation and boundary

- Existing private Q5 owner accepts closed `edit-source` capture/page/release calls only for its bound builder context. Optional **host-only** `ReadBinding.editSourceMaxBytes` is snapshotted synchronously before any await, must be an integer in `[0,8192]`, and absent means disabled. Zero allows only empty source. It is a technical source-buffer budget, **not** a product budget/reservation. Caller budgets, expected hashes, raw format and unknown operations are rejected.
- Edit-source mode derives strict no-follow FD acquisition from the existing guest read program, retaining its same source FD/stdout loop. It walks existing no-follow directory FDs, opens the existing leaf read-only/no-follow/nonblocking, checks regular FD and proc-resolved allowed root plus parent authorization before the first source byte. It has no mkdir/create/truncate/filesystem-write branch. The only write in the helper is stdout. Legacy read program/behavior is unchanged.
- Existing real Records text capture retains BOM, uses fatal UTF-8 decoding and secret filtering. Owner SHA-256/count covers every original stdout byte and every actual awaited protected text write return **plus finish tail**. Completion count and digest must match before publishing a reference/version. Full bytes beyond the 4096-byte excerpt participate. Images, ASCII binary controls (except TAB/CR/LF), invalid/truncated UTF-8, redaction even at equal UTF-8 byte length, over-cap input, nonzero/null result, stream/result failure and abort produce no source capability/raw fallback. Failed comparison withdraws completion through existing Records abort.
- Opaque UUID versions hold private path/reference/byte-count/digest metadata inside the full-context/phase-bound owner lifetime. No caller expected digest is authority. Up to 32 completed-plus-in-flight source slots bound bookkeeping; independent simultaneous paths retain independent versions. Release revokes only its exact version. Context/phase/boot/invocation/environment/role/path/reference substitution, another owner and released/unknown versions cannot page or release. EOF/owner abort/end clears owner versions. Protected evidence itself remains Records-owned, not deleted by capability release.
- Capture and page are read-only and do not reserve/consume a version for mutation. Future mutation must reserve/consume trusted owner state before dispatch; this increment authorizes **no native filesystem effect** and implements **no complete edit**. Native future buffer delivery must use only the exact completed protected bytes; native BOM/UTF-8 whole-buffer decode remains future work.

## TDD and focused gates

All Node commands used `/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`, with `NODE_OPTIONS` and `NODE_COMPILE_CACHE` unset and `NODE_DISABLE_COMPILE_CACHE=1`; each command had a <=60 second timeout. Compiled tests only; no whole suite/npm test/tsx/prepare:sdk or Task95 mjs rerun.

- Initial RED: new capture test failed (`actual failure`, `expected success`); same run legacy transport tests passed 17/17. Then GREEN 18/18 combined.
- Next focused RED: new ASCII binary-control rejection test failed (unexpected success); added edit-only control-byte rejection. GREEN 12/12.
- Auth/lifecycle test development exposed an invalid test-frame `undefined` field (Protocol JSON schema rejected it); test corrected to omit the field. No production relaxation.
- Final project compile: `node node_modules/typescript/bin/tsc -p tsconfig.json` — exit 0, no diagnostics. TDD compile cycles also succeeded.
- Final focused owner block: `node --test dist/test/sandbox/edit-source.test.js dist/test/sandbox/tool-transport.test.js dist/test/sandbox/write-source-guard.test.js dist/test/sandbox/bash-progress.test.js`:

```text
ℹ tests 56
ℹ suites 0
ℹ pass 56
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The 26 new tests use real Protocol/Records and external VM doubles. They cover BOM/CRLF/multibyte/excerpt overflow, retained finish tail, split/equal-length/beyond-excerpt redaction, malformed UTF-8, images despite enabled legacy image budget, binary controls, byte budget/snapshot/optional policy, zero/8192/over-cap, roles/full context/phase/ref/path/owner, independent concurrent captures, release/replay, slot limit/release, partial results and cancel/EOF/end. Guest helper tests parse its source AST only and check authorization order/read-only opens/stdout-only writes; they **never execute its body on the host**.

- Native compatibility block: `node --test dist/test/workers/native-bom-read.test.js dist/test/workers/native-builder-write.test.js dist/test/workers/native-builder-bash.test.js`:

```text
ℹ tests 19
ℹ pass 18
ℹ fail 1
✖ native tail and 1MiB structured readFullOutput use REAL protected HOST spill, not guest paths
  Error: BASH_EFFECTS_OR_CAPTURE_UNKNOWN
```

This existing failure was independently reproduced using **HEAD baseline versions of both modified runtime modules**. A bounded Node script transpiled `git show HEAD:src/sandbox/{read-tools,tool-binding}.ts` into the already-owned generated `dist` modules, ran only `--test-name-pattern 'native tail and 1MiB' dist/test/workers/native-builder-bash.test.js`, then restored current compiled bytes in `finally`:

```text
ℹ tests 1
ℹ pass 0
ℹ fail 1
Error: BASH_EFFECTS_OR_CAPTURE_UNKNOWN
BASELINE_EXIT=1
RESTORED current compiled read-tools/tool-binding bytes in finally.
```

This establishes baseline reproducibility, not a diagnosis or fix of the Bash failure. The native BOM tests (5), write tests (5) and other Bash cases (8) passed. Do not report a fully green compatibility suite.

- Legacy image gate: `node --test --test-name-pattern 'explicit host image budget delivers real native PNG' dist/test/workers/native-image-read.test.js` — tests 1, pass 1, fail 0.
- Changed-path dependency gate: `node node_modules/dependency-cruiser/bin/dependency-cruiser.mjs --config .dependency-cruiser.cjs --output-type err-long src/sandbox/read-tools.ts src/sandbox/tool-binding.ts test/sandbox/edit-source.test.ts` — `✔ no dependency violations found (18 modules, 34 dependencies cruised)`. An earlier invocation used the nonexistent singular `dependency-cruise.mjs` filename and failed MODULE_NOT_FOUND; corrected gate passed.
- Changed-path ESLint: `node node_modules/eslint/bin/eslint.js src/sandbox/read-tools.ts src/sandbox/tool-binding.ts test/sandbox/edit-source.test.ts --max-warnings 0` — exit 0, no output.
- `git diff --check` — exit 0, no output.
- Active changed-path LSP probe: three files checked, no TypeScript diagnostics; auxiliary ast-grep style warnings/hints (non-null assertions, unknown boundary argument, runtime typeof, existing Promise.all cleanup) are advisory, not correctness findings.

## Self-review and residual limits

Self-review found no blockers in the capture-only vertical. Confirmed no second read loop/storage engine, unchanged legacy dispatch and read program, all actual protected appends included, no cap on partial capture, bounded independent owner state and no native/SDK/write enablement. Binary-control omission was fixed during TDD; the malformed auth test-frame was corrected rather than weakening Protocol.

Trusted guest interpreter/kernel/proc/mount behavior remains a prerequisite. Tests use doubles and source AST, not a real guest. No coherent filesystem snapshot, atomic CAS, continuous-root membership, concurrent guest-writer exclusion or guest cessation is claimed. All symlinks are denied, including in-root links. Source budget and 32-slot bookkeeping are technical local bounds, not hardware/RSS/product admission guarantees. Existing Protocol bounded backlog failure behavior remains unchanged. The baseline 1MiB native Bash failure is unresolved and out of this increment. Future native adapter, same-mutation-FD comparison/reservation/consumption, SDK queue host-realpath seam, replacement transport and complete Task98/05 qualification remain open.
