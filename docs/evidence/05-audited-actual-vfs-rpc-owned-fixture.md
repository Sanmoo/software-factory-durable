# Task140: closed audited Host JS VFS/RPC on newly owned fixtures

## Authority and limits

Executed only under `/tmp/software-factory-mvp-05-vfs-owned-fixture-activation-decision.md`, fully read first, followed by parent `/tmp/software-factory-vfs-activation-closure/manifest.json` and both complete minimal-leaf/expanded-local-barrel audit reports (c8c8e28a and 7873a418). Their static audit alone did not grant execution. AGENTS and issue-tracker instructions read before evidence. Started clean on `implement/software-factory-mvp-05` at `428f21ef93af5c931892916e924fa1c471457ad4`; no branch/integration/rebase/push or SDK/production edits.

This renews **actual Host JavaScript RealFSProvider + FsRpcService component behavior only**, through the existing application `createWorkspaceProvider` wrapper. It does not establish real Guest/FUSE/KVM/FD cessation, race-free membership/CAS, durability, OS read-only barriers, NativeBuilderRead/reviewer visibility, whole05 or MVP completion. The unconditional `test/sandbox/gondolin.test.ts` VM skip remains unchanged.

## Fixed source authority

`test/sandbox/fixtures/audited-vfs-manifest.ts` is DATA, not copied SDK code. It pins the exact parent-approved canonical node_modules source root, version0.14.0,22 raw byte hashes/sizes/formats:

-19 eager executable modules,2 data-only package-format metadata files;
-1 statically audited deferred `module_hooks.js`, hashed as DATA but always denied resolution/load;
- aggregate before and after: `3d2afe41db74a1b9db24305d69b160003b6e95cab6c790601156cea89b1bc54a`.

Every process asserts public `Module.registerHooks` is a function **before** SDK evaluation. No shim fallback assignment is introduced. Before any SDK import/require the exact22 pins must be canonical regular single-link files, current UID, mode0644, matching hashes/lengths, and the two package types/version must match. No tree enumeration, source autodiscovery, npm dependency, SDK modification, alternate source copy or generic caller-supplied allowlist.

Only canonical file-URL entries `dist/src/vfs/rpc-service.js` and vendored `lib/internal/vfs/providers/real.js` are allowed from the exact fixture origin. All other SDK edges require the audited exact parent + literal specifier + resolved URL. The unavoidable local VFS barrel is allowed only by those edges. Original shim-generated absolute internal/vfs paths retain the CALLER parent; S-object aliases do not load libraries. Builtins are parent-specific audited eager edges (bare names resolve to node:); no SDK fs/promises edge. Unknown/direct-external/encoded/root/staged/VM/SSH/undici/assets/deferred-hook edges fail closed. A redirected non-SDK alias resolving into SDK also fails closed. Cached CJS requires from the fixture do not grant an absolute-path/dependency edge:3 such checks reject after the approved modules have loaded, without additional loads.

Default other fixtures and Workers remain SDK-deny-all; Workers explicitly cannot request the VFS graph. Existing closed Unix argument reconstruction and inert sentinels are preserved. No TCP port was bound even for negatives. No actual manager command, shell/Python helper body, host signal, VM/assets/guest service was executed. Fake asset files contain fixture strings only.

## Observed native versus doubled boundaries

| Component | Observation |
|---|---|
| SDK modules | Exact19 hash-listed eager modules observed by load hooks; no other SDK module loaded |
| Actual provider |2 instances constructed by the actual adapter's application wrapper; prototype/instance identity equals the leaf export; rootPath equals the existing canonical workspace/artifacts directory |
| Actual RPC |2 actual FsRpcService instances, each receiving one real wrapped provider; constructor identity equals the actual ESM export |
| Direct provider handles |3 opens per mount: owned create/write, reopen/read, in-root symlink read; each closed in finally |
| Actual RPC requests |12 per mount (24 total); lookup/open/read/write/release success, malformed traversal and forged-parent ancestor metadata/open/rename/unlink denial |
| Denial assertions |15 per mount (30 total):8 direct async/sync checks +7 RPC errors; these count assertions/API requests, **not OS syscalls** |
| SDK global hooks |0 observed attempted Module.registerHooks calls; registerHooks identity, Module._stat property descriptor, public fs read/helper references, process.cwd/chdir descriptors unchanged across evaluation and separately across constructors/probes/close |
| Test guard | One explicit authorized registerHooks registration; observer rejects any later registration before forwarding |
| VM / manager / proc / cgroup / guest commands | Explicit doubles; guest shell/Python bodies are inert DATA; no native VM constructor/create or execution |

Import observation and constructor/FS-operation observation are separate phases, with baselines after each phase's explicit test instrumentation. The observer compares safe property descriptors and never invokes private APIs. Its negative test proves attempted registration is blocked and changed references detected, not repaired/blessed. A byte-mismatch negative substitutes DATA returned by the test fs reader, never writes the SDK and never evaluates source.

Each test owns one newly created current-UID canonical0700 root. Workspace, artifacts and protected home/control/git-cache/other-work canaries are siblings beneath it. The ancestor symlink resolves only to those new sibling canaries; all actual provider filesystem targets stay within this owned root. The wrapper, not raw lexical-only RealFS lstat/readlink, is tested. Canary bytes remain unchanged. Each RPC and direct handle closes before parent finally removes only its own new root. No old profile/root/candidate/signal cleanup.

## TDD and validation

Baseline compiled Node24 group:18 tests,17 pass,0 fail,1 actual-VFS skip. New source gate initially RED:

```text
test/sandbox/audited-vfs-guard.test.ts(5,39): error TS2307: Cannot find module './audited-vfs-guard.js' or its corresponding type declarations.
```

This is a missing-feature source gate, not an executed unsafe SDK bug claim. Closed guard implemented next; inert pre-evaluation negatives passed before the first actual graph evaluation. The first owned actual component activation was run while the old consumer skip still existed and passed status0, audit:

```text
vfs-probe
vfs-confined
guest-exec
close
```

Only then was that consumer's actual-VFS skip removed. Exact current compiled focused actual-VFS result:

```text
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Commands use prefix `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node` (no tsx/runtimeTS/Node26/npm build/SDK prepare). Each command bounded60s:

1. `node_modules/typescript/bin/tsc -p tsconfig.json` — exit0, no diagnostics.
2. `--test --test-name-pattern='actual SDK filesystem RPC' dist/test/sandbox/sandbox-adapter-diagnostics.test.js` — focused result above.
3. `--test dist/test/sandbox/audited-vfs-guard.test.js dist/test/sandbox/adapter-fixture-network-guard.test.js dist/test/sandbox/sandbox-adapter-diagnostics.test.js dist/test/sandbox/owner-registration.test.js dist/test/workers/public-bash-copy.test.js` —28 pass,0 fail,0 skipped; includes all5 current145 public-copy modes. Guard diagnostics: `approved=16; rejected=79; zeroUnderlyingForRejected=0; nativeDispatch=0 (inert sentinels only)` and `rejected=21; underlying sentinel calls=0; SDK evaluations=0`.
4. Changed-file ESLint with `--max-warnings 0` — exit0, no output.
5. Explicit `node_modules/dependency-cruiser/bin/dependency-cruiser.mjs --config .dependency-cruiser.cjs --output-type err-long` on changed TS paths — no dependency violations (final gate:70 modules,312 dependencies).
6. Changed-path active LSP:8 files checked in the final gate,0 diagnostics; compiler remains independent proof, not inferred from silence.
7. Final builtin-only source-DATA validation via compiled guard: `Final exact22 source-DATA aggregate: 3d2afe41db74a1b9db24305d69b160003b6e95cab6c790601156cea89b1bc54a`. `git diff --check` passed; diff for `src` and `test/sandbox/gondolin.test.ts` empty.

## Residual risks / preserved historical caveats

- Original raw RealFS lstat/readlink lexical checks and separate-syscall TOCTOU remain unchanged. Trusted same-UID namespace and Node/kernel/builtins are TCB; no hostile same-UID race, arbitrary host path or root confinement theorem.
- Hash/metadata validation is not atomic against concurrent hostile mutation; the fixed root pins intentionally fail closed outside this exact audited installation.
- Deferred global hook installation remains forbidden, including mount/unmount and VirtualFileSystem/create/constructors; streams/watchers/content populators are never instantiated.
- Task137's original unobserved promisify-channel historical0 metric limitation remains a limitation. Current clean leaf proof does not retroactively turn that older metric into complete observation.
- Normal Node experimental module-mock/deprecation warnings occur. No root SDK/real VM qualification,145 source change,146 review replacement or task closure is inferred. A fresh review of this new140 fixture remains required.
