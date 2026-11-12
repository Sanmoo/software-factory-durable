# 05 — bounded Records review-fix increment

Scope: the four concrete Records findings in `review-05-records-and-sdk-candidate.md`, plus its adjacent post-rename completion failure. Base: `7ac284c6b3ff3d7d2cbb91062bb1379ab9656782`. This is **not ticket05 completion, SDK adoption, or integration authority**.

## Changes and public-boundary regression evidence

- **P1, resulting-key collisions:** redaction checks every resulting object key against already-produced keys before opening a capture. Two secret keys, a secret key plus literal `█`, and collisions nested inside an array all reject with `PROTECTED_CAPTURE_UNAVAILABLE`; the root stays empty. No silent overwrite or substitute event format.
- **P1, concurrent finalization invalidation:** finalization revalidates open state before publication, around rename/directory synchronization, and before returning success. An invalidated capture cannot be changed back to closed. Failure removes its completion marker; publication rolls back its own renamed marker and exclusive temporary file. Failure never awaits its own `finish`, and cleanup is nonrecursive and confined to that capture's completion artifacts/handle. Deterministic external-filesystem pauses cover overlapping **write and finish**, both during completion temporary-file sync and during parent-directory sync after rename. After invalidation and after resumed finalization, reads are partial, finish rejects, and no completion/temp marker remains.
- **Adjacent same-path failure:** a filesystem-boundary fault verifies `complete.json` already exists after rename, then throws specifically from the parent directory's `sync`. Finish rejects and subsequent read is partial; the completion marker is removed.
- **P2, metadata reads:** capture and completion JSON share one descriptor-based reader using `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, regular-file/current-UID/private-mode checks, and a 64 KiB size limit. The actual read buffer is capped at 64 KiB + one overflow byte even if the inode grows after stat. Both metadata files reject oversized valid JSON padded with whitespace, external-to-capture symlinks containing otherwise valid metadata, public modes, and FIFOs. FIFO tests use only a new owned child process with a 1.5-second timeout, so an old blocking-open regression cannot hang the test runner. UID checks are implemented; no chown/privileged ownership fixture was attempted.
- **P2, event preflight:** before Zod recursion, redaction, stringify, or encoding, a bounded snapshot walks at most 8,192 nodes, depth 32 (root depth zero), and 64 KiB cumulative UTF-8 string/key bytes. Individual strings are length-checked before byte counting; arrays are length-checked before traversal. Objects are traversed without a caller-sized `Object.entries`/keys array. Cycles, accessors, proxies, nonplain objects, and non-JSON values are refused rather than executing caller code. Snapshot/schema/redaction/serialization allocations therefore operate on bounded data, excluding the caller's already-existing input. The final 64 KiB encoded-record check remains. Tests cover huge strings, multibyte byte overflow below the character bound, huge arrays and wide objects, excessive depth, cycles, and proxy traps; later getter sentinels are never visited. Large output still uses the existing streaming API, not `record`.

Q8 signatures, correlation, known-secret policy, UTF-8 streaming, pagination and excerpt behavior remain unchanged. Native SDK candidate, package pins/dependencies and ToolTransport were not edited.

## TDD and gates

All command processes were bounded to <=60 seconds. Explicit runtime:

```sh
export PATH=/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin:$PATH
unset NODE_OPTIONS NODE_COMPILE_CACHE
export NODE_DISABLE_COMPILE_CACHE=1
# Subsequent regression/gate runs use the authorized short fixture root:
export TMPDIR=/home/sanmoo/software-factory-test
node --version
# v24.21.0
```

The initial baseline/RED runs used fresh owned default-temp fixtures; these were removed by their tests. No historical logs or artifacts were cleaned or rewritten.

1. **Before modification:** `node node_modules/typescript/bin/tsc -p tsconfig.json && node --test dist/test/records/*.test.js` — existing Records baseline:

   ```text
   ℹ tests 11
   ℹ suites 0
   ℹ pass 11
   ℹ fail 0
   ℹ cancelled 0
   ℹ skipped 0
   ℹ todo 0
   ```

2. **True RED:** compile, then `node --test dist/test/records/review-fixes.test.js` against unchanged production code. Initial 18 regressions produced:

   ```text
   ℹ tests 18
   ℹ suites 0
   ℹ pass 3
   ℹ fail 15
   ℹ cancelled 0
   ℹ skipped 0
   ℹ todo 0
   ```

   The failures were all three key-collision cases (missing rejection), all four initial event-budget cases (later getter visited), both initial overlapping-call publication cases (missing rejection), post-rename parent sync (actual complete, expected partial), both FIFO reads (owned child timeout), and completion oversize/symlink/public-mode cases (missing rejection). Capture oversize/symlink/public-mode cases already passed and remain compatibility coverage. Full transient output: `/tmp/records-review-red.txt`.

3. **Initial GREEN:** same 18 regressions after implementation: 18 tests, 18 pass, zero fail/cancel/skip/todo. Subsequently strengthened coverage with wide objects, UTF-8 byte budget, post-rename invalidation pauses, and proxy refusal. The proxy case independently went RED before its guard: `node --test --test-name-pattern='executable object traps' dist/test/records/review-fixes.test.js` — 1 test, 0 pass, 1 fail, `Missing expected rejection.`

4. **Final affected gates**, after self-review/type cleanup:

   ```sh
   node node_modules/typescript/bin/tsc -p tsconfig.json
   node --test dist/test/records/*.test.js dist/test/workers/sdk-read-candidate.test.js
   node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
   node node_modules/dependency-cruiser/bin/dependency-cruiser.mjs --config .dependency-cruiser.cjs --output-type err-long .
   node node_modules/eslint/bin/eslint.js . --max-warnings 0
   git diff --check
   ```

   Exact final test/gate summary:

   ```text
   ℹ tests 35
   ℹ suites 0
   ℹ pass 35
   ℹ fail 0
   ℹ cancelled 0
   ℹ skipped 0
   ℹ todo 0
   ℹ duration_ms 2821.082578

   ✔ no dependency violations found (86 modules, 408 dependencies cruised)
   ```

   Compilation, no-emit typecheck, ESLint and diff whitespace check returned zero with no diagnostics/output. The 35 tests comprise 11 pre-existing Records tests, 23 new Records regressions, and the unchanged actual-SDK candidate regression. Final transient test output: `/tmp/records-review-final-tests.txt`.

   One ordinary gate setup correction: the first direct architecture command misspelled the installed binary as `dependency-cruise.mjs` and returned `MODULE_NOT_FOUND`; corrected to `dependency-cruiser.mjs` above, which passed. No dependency installation or alternate runtime was used.

5. Active LSP/auxiliary probe on the three changed TypeScript paths first reported the snapshot visitor's direct `unknown` return annotation. Self-review replaced it with the named `JsonEvent` type. Reprobe: zero diagnostics, two paths confirmed clean and one push-only/silent-on-clean path inconclusive. This is **not** an all-files clean LSP certificate; compiler/architecture/ESLint gates above are the reproducible checks.

## Boundaries and remaining limits

- No full 153-case rerun and no default `npm test` rerun. The previously documented default parallel readiness failure and old logs remain unchanged, not converted into a green claim.
- These are ordinary local filesystem/error-injection tests, not crash/power-loss qualification. Rollback itself depends on the host filesystem accepting removal; no claim of recovery under arbitrary persistent I/O/permission failure or adversarial concurrent mutation by the trusted root owner. No new domain journal, authority, or framework was introduced.
- Preflight intentionally limits structured event receipts more conservatively than raw serialized byte size alone; callers with large/deep/wide data must use streaming output. Known-secret filtering is not universal discovery of unknown credentials.
- No VM/model/GitHub/network/credential/image/container/mount/install/physical run. All spent03 grants remain spent. Candidate compatibility coverage does not authorize adopting its SDK patch.
- Ticket05 still needs its remaining worker/integration and approved native-SDK/model proof; real model calls remain held under the existing authority boundary. This slice does not claim complete05 or merge readiness.
- Integration checkout remained at `4e085bff4991210021c8e4714c4df89d4992376a`, an ancestor of this worktree. No integration/peer writes, merge, reset, push, or tracker closure.
