# Task105 — private development SDK v3 / fixed lexical Builder Write

Parent's explicit adoption decision was read in full from
`/tmp/software-factory-mvp-05-sdk-v3-lexical-adoption-decision.md`, along with full
candidate99 and review101 reports. Base: `4113261a64733b08536b15c5c683aae28c22da9a`.
This is application/preparation composition, not another queue algorithm change.
Integration destination remains `integration/software-factory-mvp` (`4e085bf`),
not main; no integration/merge or tracker operation was performed.

## Composition and provenance

- Canonical owner-only0700 root: `.scratch/factory-development-sdk-v3`.
  Profile: `factory-development-pi-1.5.2-read-async-bash-lexical-v3`.
  Runtime aliases and strict Host bootstrap ID select v3; no v1/v2 fallback.
  Old evidence documents are unchanged. The current integration mjs is renamed
  from v2 to v3 and now verifies v3 inventory, metadata and all copied entries.
- Exactly six reviewed SDK targets are added to the prior read + four async Bash
  corrections: `dist/core/tools/{edit,write,file-mutation-queue}.{js,d.ts}`.
  Adopted patch SHA256:
  `e3e88f8e6a53c9b58164c85c9866cfcf5a31b9fd415fdad7ce136976d8fd96d0`.
  Candidate manifest SHA256:
  `923d916bae558e6d21978593b2effb716dec80398bb5b0a66271fefcfc0f42a2`.
  Candidate private commit: `1fcc89adde20d7a7f56384e86e457315a2ee2639`.
  No new SDK source correction or candidate harness was adopted.
- Preparation checks SDK1.5.2/package lock integrity/full upstream tree SHA256,
  exact patch bytes, ten added before/after hashes and the existing read hash.
  Standard offline `git apply --check`/`git apply` only. Whole copied inventory
  and every unchanged byte are checked on first preparation and reuse.
  Unknown entries, unsafe links, hardlinks and missing metadata fail without
  repair. Newly generated v3 root is ignored by Git, like v1/v2.
- Independent test computes whole copied SDK tree SHA256
  `c64ed4dde34103f3829ffe3edb5de6a6bd886a6dab22e589f1cd8f2968713816`
  (same sorted directory/file/symlink serialization as upstream preparer), and
  asserts exactly eleven changed regular files. MIME facade remains SHA256
  `514aaf1a9e0ba039af4a07b1dfed53f9e6935ced7b1cd70a08b3fdc0ab46a669`.
- Builder Write supplies literal `mutationQueueMode: 'lexical'` at construction
  through a narrow intersection over upstream `Parameters<typeof createWriteTool>`.
  No `any`, cast bridge, model/context/env mode selector, version check or fallback.
  Both operations still route to the owner. Native schema/queue/callback ownership,
  formatting, session and owner intent/completion/UNKNOWN behavior stay unchanged.
  Native Edit is copied in the SDK ONLY; it is not enabled in Factory tools.
- Package metadata still declares MIT and has no standalone LICENSE; this records
  provenance facts, not standalone-distribution or complete SDK-build qualification.

## TDD and focused evidence

All Node commands used absolute
`/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`, with
`env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1`.
Each shell invocation was limited to <=60 seconds. No entire npm test/tsx run.

1. Existing native Builder Write baseline: **5 pass, 0 fail** (826.353398ms).
2. NEW actual Factory adapter test, before app/profile fix:
   `--test --test-name-pattern='fixed lexical' dist/test/workers/native-builder-write.test.js`:
   **0 pass, 1 fail** (744.416799ms), actual `EACCES` in v2 native
   `getMutationQueueKey`/host `realpath` before callbacks. This is the intended RED.
3. After composition, native Builder Write: **6 pass, 0 fail** (866.769413ms).
   The new test owns a short0700 `/tmp/w105-*` directory, puts a host sentinel
   beneath an owned mode000 directory, and first verifies genuine non-root
   `realpath` EACCES. Actual legacy native Write with both custom ops still fails
   before callbacks. Actual Factory Builder adapter succeeds with only guest
   callbacks, even with model `host-realpath` or an unknown model mode and invalid
   context mode; schema has no mode field. Host sentinel is unchanged. The
   ToolProjection is deliberately doubled because this host fixture is outside
   guest-root authority: **callback-routing/no-host-probe proof, NOT owner confinement**.
   Finally restores permissions and cleans only the newly owned fixture.
4. `--test test/workers/sdk-v3-integration.test.mjs`: **11 pass, 0 fail**
   (13789.646975ms). Includes v3 profile idempotence/no-repair drift/unsafe-link/
   hardlink/missing-metadata checks, native drain/abort/error preservation, actual
   new Node24 session JSONL/reopen and independent whole-tree/eleven-file proof.
5. `--test dist/test/workers/native-builder-write.test.js dist/test/workers/worker-write-process.test.js dist/test/entrypoints/normal-builder.test.js`:
   **13 pass, 0 fail** (5666.037834ms). Includes native same-key queue ownership,
   fixed-mode source assertions, separate actual native Node write/session failure
   cases and public normal Builder activation -> same Q5 owner -> new Node24 ->
   session result. External VM/manager/HTTP fixtures remain doubles, not kernel
   guest-helper or hardware/VM proof.
6. `--test dist/test/workers/native-bom-read.test.js dist/test/workers/native-image-read.test.js dist/test/workers/native-owner-read.test.js dist/test/workers/native-builder-bash.test.js dist/test/sandbox/write-source-guard.test.js dist/test/entrypoints/normal-bash.test.js dist/test/entrypoints/normal-worker.test.js`:
   **60 pass, 0 fail** (6851.956177ms). Current v3 BOM/UTF8/pagination, PNG/image
   and explicit budget, native Bash actual host spill/1MiB readFullOutput,
   Source static guard and normal owner/read/Bash regressions. Guest Python BODY
   is not executed on the host; only its captured SOURCE is parsed.
7. Native Builder + profile drift focused check:
   **8 pass, 0 fail** (6453.020004ms). Final post-self-review focused reruns:
   native Builder **7 pass, 0 fail** (847.029414ms); v3 mjs **11 pass, 0 fail**
   (14020.815327ms), now including a pinned whole-result-tree hash assertion and
   both known and unknown model-mode injection attempts. Final compiler,
   changed-path ESLint and diff checks exit0.
8. `node node_modules/typescript/bin/tsc -p tsconfig.json`: exit0.
   `node node_modules/.bin/depcruise --config .dependency-cruiser.cjs --output-type err-long .`:
   `no dependency violations found (138 modules, 718 dependencies cruised)`.
   Changed-path ESLint `--max-warnings 0` and `git diff --check`: exit0.
   One architecture attempt used the wrong filename `dependency-cruise.mjs` and
   failed MODULE_NOT_FOUND; corrected to existing `.bin/depcruise` above.
9. Active changed-path LSP primary check, nine files, 5000ms/file:
   `clean=9, findings=0`, no warning/error diagnostics. An initial shorter probe
   had one timeout and advisory auxiliary ast-grep findings on inherited constructs
   (JSON.parse intentionally throws closed, string sorts, CLI console output).
   No blanket all-analyzer-clean claim.

## Preservation and scope limits

Independent recursive mode/uid/byte/link snapshots before and after matched for
both old private profiles, installed SDK, and both immutable candidates. All
2218 pinned files across19 candidate dependency roots match before/after maps.
Whole-tree snapshot SHA256 values (snapshot serialization, not preparer's digest):

| Preserved root | SHA256 |
| --- | --- |
| `.scratch/factory-development-sdk` (v1) | `f9f2dc9d4af4aa3c2432d6a17b3b4addf77c8c6a1992d86a9eb9e6d3219b5b0f` |
| `.scratch/factory-development-sdk-v2` | `bf47dd85b386867ff9991a2fd359150f96494eecabf61bbdb3dad5286231f127` |
| installed SDK | `f2ff450621f6bb47e0c5761fd99ebd9ac17c50282b088b38edaef4acb17f8680` |
| queue candidate aRF1gV | `8e618f38027d534e8a19c6719a74a56319c522fe2d64c641a4fa77e2178b1e55` |
| drain candidate mHov7O | `86671d70cfdaead1bf42a73345ca2e2742fa9b36c8103becc114b475e2f1e3c7` |

No installed/global/cache/dependency/candidate edits, install/upgrade, Protocol
source/tests/flow/wire/cap changes, native default Host write/edit backend calls,
model API/auth/OAuth/network/VM/unit activity, host `/workspace`/`/artifacts`
creation/mounts or candidate99 seven-case rerun. No new Edit/general Builder read,
Source mutation capability, bootstrap budget or physical grant.

Lexical normalized keys are cooperative process-local serialization, not authority,
alias/hardlink identity, global writer identity, CAS or cross-worker exclusion.
Native Edit integrity/enablement, whole symlink parity, BMP, selective guest copy,
Q10/19/20, physical cessation and whole05/85 remain open. Source98 remains
capture-only; Protocol103/104 independent review is not claimed here. Actual
Factory auth/budget65 remains unanswered. Next gate is one app/prep integration
review, not a re-review of the candidate queue algorithm.
