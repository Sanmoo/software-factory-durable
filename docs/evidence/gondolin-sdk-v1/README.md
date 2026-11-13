# Gondolin private development profile v1 — preparation only

Task133 adopts exactly the parent's approved nine-file candidate as **inert data**, not as an application runtime binding. `src/sandbox/gondolin-sdk-profile.ts` is the sole closed Sandbox-specific preparer/verifier. It does not import Workers, any Gondolin runtime module, a VM constructor or guest command body. No new public application/model options or SDK import alias are introduced. Existing `prepare:sdk`, build behavior, package imports and installed Gondolin runtime selection are unchanged.

## Provenance and license

- Candidate: `/tmp/software-factory-gondolin-stdin-candidate-tIvRoY`, HEAD `1391f2e49060509096a82f2566339265a0ef4951`.
- SDK code commit: `4a7604870de4d675bcfb487d375b118cf4148836`.
- Original package: `@earendil-works/gondolin@0.14.0`, Apache-2.0. Exact standalone LICENSE copied here and preserved in the staged distribution; SHA256 `a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2`.
- Lock integrity pin: `sha512-MSw+EGcqFJeyKHdXEfm+nMRr74ytT4x8DGIohav0oPCHeVQAB9AajquM94cv2xqvIU3VDAaZZVC07IXsOY6OVQ==`. This checks the lock's registry pin, not a newly downloaded/reconstructed tarball.
- `native-stdin.patch`: exact candidate patch, SHA256 `441621ba414e419cae9715e3ffbfa3059d4048247972515db8db4cf3cfdcca88`. Provenance DATA only, never applied by a custom parser or external command.
- `patch-manifest.data`: exact candidate manifest, SHA256 `2ec5805fbbdc9badcf6e0bd52720e3c5a47e8a927f3b41bbe1e3d7feb448d1c8`. Seven original files modified, two pure helper files added. All nine before/after hashes and after sizes are verified before staging effects.
- `original-133.data`: exact original candidate inventory, SHA256 `03a1fc3d3f7a5d2f90b115f977885682727ca10337d153494cae7d28ad12b66b`. All original133 entries were compared to unchanged installed originals when adopting the data. No snapshot creator or candidate tests were rerun.
- `corrected/**/*.data`: exact nine corrected source/declaration byte sequences, each pinned by that manifest; these inert extensions deliberately prevent vendored runtime modules from entering the authored application module graph.
- `provenance.data`: full installed-distribution inventories, candidate commits and dependency metadata pins, SHA256 `a2159d649ab9ee947ffb87c0f11a046df4653d4bb17b873844af476469137a3d`.

The full installed distribution includes **407 original regular files**, not just the original conservative133 entry closure. Copying it unchanged and replacing/adding only the exact nine pinned files yields **409 regular files**. The full inventory records every directory (including empty directories), regular path, file SHA256, byte size and file mode. Every published/copied distribution directory is additionally required to remain mode0755, behind the private0700 parent; special mode bits are rejected. The complete path/type/size/mode inventory is checked before hashing distribution bytes, so unknown files are not opened and unknown directories are not descended. Its tree SHA256 is over compact JSON followed by one LF, with records sorted by path:

- original tree: `bf0c51fdae63d6772a320625a5554ee39c248b9d3a04a4c21a064db001da8eb8`
- copied tree: `8c99800d083835d740197a86b08ed4f9ea7e91fdc619e2a238433f41d4423430`

Only SDK distribution JS/declarations/maps/README/package/license data were inventoried/copied. No actual guest assets, assets store or root filesystem was accessed.

## Closed preparation contract

The sole destination is `.scratch/factory-development-gondolin-v1/`, profile `factory-development-gondolin-0.14.0-stdin-capacity-v1`, in the canonical current project (or an explicitly supplied project root used for owned fixtures). The destination must be missing or already exactly correct. A new root is owned mode0700; profile.json is mode0600. Known source/evidence paths must be canonical, owned, regular (single-link files), without shared write permissions. Unknown symlinks, unexpected paths, incomplete trees, wrong version/integrity/hash/mode or absent helpers reject. No repair, overwrite of an existing profile, cleanup or fallback occurs. An interrupted first preparation intentionally leaves an incomplete refused root.

The only allowed escaping symlink is the exact `node_modules` usage link to this project's canonical installed `node_modules`; its owner, literal target and resolved target are verified. Direct cbor2, ssh2, undici and installed Linux krun-runner package metadata hashes plus their lock version/integrity pins are checked. Only their package metadata is read, never runner binaries/assets or dependency code. Nothing is installed, executed or written at the target. This link supports **future read-only usage**, not kernel-enforced read-only access or a complete dependency-code audit. The original source tree is checked again after copying. Existing correct profiles are verified without rewriting any byte or metadata.

`verifyDevelopmentGondolinSdk()` is preparation-free and fails closed. **Any future runtime consumer must call it successfully before effects**; ignoring an unavailable feature by passing opt-in to the installed legacy SDK is forbidden. No such runtime consumer or switch is implemented here. Local ownership/canonical checks are not a defense against a hostile concurrent same-UID writer replacing files between awaits; they do not create a global transaction or ongoing runtime integrity monitor.

## Commands and validation

Use Node24.21.0 with NODE_OPTIONS and NODE_COMPILE_CACHE unset and NODE_DISABLE_COMPILE_CACHE=1; each executed command was bounded to60s. Do not use the full app build/test or Pi SDK preparation for this profile.

```sh
NODE=/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 "$NODE" node_modules/typescript/bin/tsc -p tsconfig.json
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 "$NODE" --test dist/test/sandbox/gondolin-sdk-profile.test.js
# Explicit, separate from prepare:sdk/build (npm script prepare:gondolin-sdk points here):
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 "$NODE" dist/src/sandbox/gondolin-sdk-profile.js
```

TDD: the first compiled test run against an unavailable-profile stub produced tests4/pass1/fail3; the valid preparation/idempotency test and helper test reached `GONDOLIN_PROFILE_UNAVAILABLE`. This is new preparer functionality RED, not a new native SDK algorithm failure. The other failing test exposed a fixture-only non-recursive directory removal, corrected before GREEN. Final focused output:

```text
✔ Gondolin private preparation verifies exact copy/license and never rewrites an existing valid profile (1114.328924ms)
✔ source wrong version/hash and missing or changed corrected helper fail before root creation (165.851658ms)
✔ root symlink, incomplete root, wrong mode and unexpected entries are refused without repair (962.787415ms)
✔ copied helper absence and source or dependency-link symlink escape fail closed (756.547628ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3062.534585
```

Fixtures are new short `/tmp/gdp-*` owned0700 roots, removed only in their own finally blocks; SDK bytes are DATA, not executed. Coverage includes exact valid prepare/verify, no-rewrite mtimes, copied drift preservation, wrong source version/hash/lock integrity, missing/changed corrected helper, root symlink/mode/incompleteness/unexpected entry, changed dependency link, absent staged helper and source-file symlink.

App `tsc -p tsconfig.json` passed silently. Focused compiled architecture gate:18 tests/18 passed/0 failed, duration_ms15841.39299. Explicit dependency-cruiser binary: `✔ no dependency violations found (151 modules, 792 dependencies cruised)`. Changed-file ESLint passed silently. Current-path LSP was actively probed, including after final code changes. Final result:2 files checked, no reported TypeScript errors/warnings,9 auxiliary ast-grep hints (eight correctly parenthesized awaited member reads and one intentionally unknown JSON-serialization parameter). Reviewed and retained; not a blanket diagnostic-clean claim. Earlier auxiliary parse/sort/console suggestions were addressed with explicit parse failure, string comparator and CLI stdout.

The real new ignored worktree-local root was prepared once after an explicit absence check, without SDK evaluation. Subsequent verifier and idempotent preparer checks printed:

```text
actual new profile verify+idempotency: PASS; root0700; original407/copied409; adopted9; profile bytes+mtime unchanged
```

Both staged profile.json and SDK package.json matched the new private gitignore rule. No older private profile was prepared, tested, imported or changed.

## Limits retained

**NO RUNTIME SWITCH; no VM/socket/guest/physical-cessation qualification; no whole05 acceptance.** The candidate's owned in-memory Duplex proof is not a real socket/guest. Known bridge close retains pending36/session1 until separate local cancellation/disconnect and is not automatic VM termination. Logical queue counters are not RSS bounds; arbitrary pending producer interruption is not guaranteed. Source snapshot/final secret guard and owner integration remain separate; user119 whole-copy approval does not settle Task65 auth-budget. Existing host TCB, frozen VM image and lifecycle caps are untouched. No credentials, models, network, installs, guest commands or runtime imports were used. Parent-owned independent review of this new profile preparation is still required before any future binding decision.
