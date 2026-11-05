# 03 — persistent work environment: PARTIAL checkpoint

Current continuation and all remaining criteria are recorded in **2026-11-05 continuation** below.
The original validation-only blocked checkpoint is preserved as historical evidence.

This is a tested **partial implementation**, not acceptance of ticket 03 or a supported sandbox release.
No ticket acceptance checkbox is complete. The supervisor approved limiting this checkpoint to
`Sandbox.validate` after the prerequisite inspection; lifecycle scaffolding was explicitly excluded.
Integration destination for this task remains `integration/software-factory-mvp`; initial task base is `84647f1`.

## Implemented seam and composition

`createSandbox({ root, guestAssets?: { directory, manifestSha256 } }).validate(configuration)`:

- Configuration validity remains separate from prerequisite checks. Existing strict YAML/configuration behavior is unchanged.
- `guestAssets` is trusted **composition data**, not new YAML fields or a release manifest format.
  Supply an absolute directory and an expected lowercase SHA256 from independently trusted release/composition metadata.
  Never calculate that expected value from the installation's untrusted manifest and treat it as authentication.
- Missing explicit assets block diagnostics. No environment-variable discovery, personal cache, moving tag,
  asset download, SDK initialization, VM boot, image construction or repair is attempted.
- Hash the bounded manifest (at most 1 MiB), then inspect only its upstream integrity metadata projection:
  `version`, `config.arch`, `config.distro`, three asset names and three SHA256 checksums.
  Stream asset hashes with 64 KiB buffers; assets are not loaded wholesale into memory.
- Reject missing/unreadable files, mismatched bytes, malformed JSON, incomplete metadata,
  unsupported manifest version/profile, absolute/traversal paths, symlink components,
  hardlinks, duplicate asset names and nonregular files. Individual asset results remain visible.
  No raw parser diagnostic, asset contents or arbitrary filename is echoed.
- Even successful hashes are only byte integrity **relative to the supplied pin**. They do not establish
  upstream authenticity/signature/provenance, full `BuildConfig` validity, package contents, a correct buildId,
  a distributable release, KVM, guest operation or Docker. `sandbox-release`, `kvm-functional`
  and `docker-runtime` remain unverified.

Asset inspection assumes trusted host composition and stable administrator-managed asset directories.
It is not a filesystem sandbox against a malicious concurrent host writer or mount administrator.
The real guest RealFSProvider confinement boundary is **not implemented or proved** by these path tests.
The existing architecture gate was not changed. No controller/CLI files, scheduler, adapter registry,
parallel domain persistence, start/stop stubs or systemd units were added.

## Actual pinned Gondolin API inspected, without execution

Read the full canonical decisions 19 and 18 and the preserved research report, isolation decision 07,
module-public-interfaces Q5/Q9/Q11/Q13–14, spec 5.4 and 7.1–7.4, PRD and V-02/V-12/V-14.

Commands (bounded at 20–60 seconds) retrieved only small public code/package metadata:

```sh
npm view @earendil-works/gondolin@0.14.0 version dist.integrity dist.tarball --json
npm pack @earendil-works/gondolin@0.14.0 --ignore-scripts --pack-destination /tmp/factory-03-gondolin-api --json
curl -fsSL --max-time 20 https://raw.githubusercontent.com/earendil-works/gondolin/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/src/assets.ts
curl -fsSL --max-time 20 https://raw.githubusercontent.com/earendil-works/gondolin/6b381a9fd1c353e80cc9b4cf35474b6909703a16/host/src/sandbox/server-options.ts
```

Package: 0.14.0, 613,932 compressed bytes; registry integrity:
`sha512-MSw+EGcqFJeyKHdXEfm+nMRr74ytT4x8DGIohav0oPCHeVQAB9AajquM94cv2xqvIU3VDAaZZVC07IXsOY6OVQ==`.
No package dependency was added, no package code imported, and no image downloaded.
The first tar inspection used an incorrect filename and failed harmlessly; extraction then used the
actual npm-pack filename `earendil-works-gondolin-0.14.0.tgz`.

Verified against both pinned source and published declarations:

- `AssetManifest` has `version: 1`, `config: BuildConfig`, optional `buildId`, asset filenames and SHA256 checksums.
  This diagnostic projection deliberately does not certify the entire upstream schema or a Factory release manifest.
- `GuestAssets` uses `kernelPath`, `initrdPath`, `rootfsPath`.
- `loadGuestAssets(assetDir)` uses explicit paths but checks existence rather than hashing;
  `ensureGuestAssets()` can discover personal/default caches or fetch images, so it is not used.
- Actual sandbox options include `rootDiskPath`, `rootDiskFormat`, `rootDiskDeleteOnClose`,
  `memory`, `cpus`, `accel`, `tmpfs`; their existence is documentary evidence, **not an exercised lifecycle**.

## Read-only host prerequisites

Inspection on 2026-11-05, with pinned Node on PATH:

```sh
export PATH=/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin:$PATH
cat /etc/os-release; uname -m; uname -r
command -v qemu-system-x86_64 qemu-img systemctl
ls -l /dev/kvm /dev/fuse
test -r /dev/kvm && test -w /dev/kvm
systemctl --user is-system-running
systemctl --version
df -B1 . /tmp
```

Observed Arch Linux, x86_64, kernel `7.1.9-arch1-2`, systemd `261.2-1-arch`;
`systemctl` found, user manager reports `running`. QEMU and qemu-img were **not found on PATH**.
`/dev/kvm` and `/dev/fuse` exist; current account passes KVM read/write access checks.
This does not establish functional KVM/FUSE or permission/correctness of per-environment supervision.
No Factory release/profile/assets manifest was supplied. At inspection, checkout filesystem had
624,141,971,456 available bytes; `/tmp` is tmpfs, with 7,202,836,480 available bytes.
These are momentary observations, not capacity qualification/reservation or durability evidence.
No host services, units, packages, account memberships or remote resources were changed.

## Validation and red/green

All tests use the approved `Sandbox.validate` seam. Six source-named tests in
`test/sandbox/sandbox-validation.test.ts` use real local temporary files/symlinks/hardlinks;
no filesystem mocks, KVM doubles, systemd doubles, credentials or models.
Fixture kernel/initramfs/rootfs bytes are synthetic, **not bootable VM assets**.
The positive manifest and asset SHA256 literals were obtained independently with `sha256sum`.
Some negative metadata cases deliberately re-pin altered synthetic manifests to reach structural validation;
they are not evidence for authenticity or hashing correctness.

Recorded focused cycles with `npm run build && node --test dist/test/sandbox/sandbox-validation.test.js`
(each command bounded to 45 seconds):

1. RED: missing `guest-assets` diagnostic; GREEN: explicit missing-assets + unverified-release diagnostics.
2. RED: compile rejects missing `guestAssets` composition input; GREEN: pinned-file integrity diagnostics, 2/2 tests.
3. RED: incomplete manifest incorrectly combined with incompatible metadata; GREEN: distinct metadata errors, 3/3 tests.
4. RED: missing arch misclassified as incompatible; GREEN: structural completeness before profile compatibility, 6/6 tests.

Additional regression cases cover corrupted/missing files, trusted pin mismatch, traversal,
absolute paths, symlink parents/files/root, hardlinks, nonregular directories, oversized manifests,
invalid pins, malformed JSON and unsupported version/architecture/distro. Independent real guest
filesystem, SDK VM boot and cgroup cessation boundaries are not substituted into these tests.

Full local gate (120-second command bound): `npm test` passes architecture analysis, ESLint,
TypeScript build and 36/36 tests with no skipped cases; Node test phase approximately 10 seconds.
`npm run typecheck` and `git diff --check` pass.
Both initial `npm ci --ignore-scripts` and final plain `npm ci` installed the pinned development
dependencies successfully; npm reported 5 moderate dependency vulnerabilities (not automatically modified).
Final local gate after plain `npm ci`: 36/36 pass, no skips, test phase 10.37 seconds;
architecture reports 25 modules/61 dependencies with no violations. Typecheck/diff checks pass.
The current integration tip is incorporated only into the exclusively local task branch before return;
no changes are written to integration/main or another writer's worktree.

## Exact missing acceptance criteria and operator prerequisites

| Ticket acceptance criterion | Missing implementation/proof |
| --- | --- |
| 1: full public lifecycle/results | Only validate exists. No prepare/start/observe/stop/remove implementation, opaque persisted environment/boot refs or lifecycle result proof. |
| 2: fixed supported profile | Integrity diagnostics are partial; no built/distributed/qualified Arch x86_64 QEMU/KVM Alpine/Docker profile, pinned release assets/helper/QEMU identities or real boot without fallback. |
| 3: persistent disk/tmpfs | No persistent root disk lifecycle, `rootDiskDeleteOnClose: false`/`tmpfs: {}` execution, or package/cache/Docker/workspace reboot proof. |
| 4: RealFSProvider confinement | Local asset path tests are not guest workspace confinement. Missing real provider/FUSE path, symlink and alias isolation across home/control/records/cache/other Work. |
| 5: systemd supervision | No correlated per-boot systemd group/worker/VMM supervision or owner-independent inventory/stop proof; no independent-environment owner-failure test. |
| 6: graceful/forced cessation | No guest Docker shutdown/sync, bounded graceful-to-forced termination, cgroup cessation evidence or post-forced-stop disk usability check. |
| 7: capacity | Existing root filesystem diagnostic remains partial. No prepare-copy estimate, per-workspace/disk-filesystem preflight, physical/virtual/use observation or no-space lifecycle test. |
| 8: real evidence | No real persistent cycle, owner-failure isolation, multiple environments, KVM, FUSE or cessation proof. V-02, V-12 and V-14 remain pending at their required faithful levels. |

Minimum eventual operator actions, **not executed**:

1. Provide explicit authorization and an isolated disposable real-host test boundary for VM boots,
   per-environment systemd supervision and targeted owner-failure cuts. Current authorization does not cover those operations.
2. Administratively provide release-compatible QEMU/qemu-img and qualified KVM/FUSE/systemd permissions.
   Do not treat read/write `/dev/kvm` or an active user manager as sufficient qualification.
3. Build/provide the actual release profile, manifest, checksums/buildId, explicit artifact paths and trusted
   expected manifest hash, with approved Alpine/Docker vfs contents, pinned helpers and sufficient persistent storage.
   Release packaging is not defined by this diagnostic composition input.
4. Implement the remaining lifecycle against that actual SDK/profile and systemd context, then run real,
   independently recorded V-02/V-12/V-14 subcases including persistence, escape denial, owner loss,
   cross-environment isolation, cessation, forced-disk verification and partial cleanup/capacity behavior.

Until then: preserve this coherent local checkpoint branch, do not resolve ticket 03, and do not
integrate it as proof that dependent operational features are available.

## 2026-11-05 continuation — PARTIAL, not ticket acceptance

Supersedes only the old current-prerequisite list. The validation-only commit was
retained (rebased as `7abfc63`) onto integration prerequisite `b591ec7`. No
control/protocol/CLI02 implementation was replaced. Subsequent explicit authorization
allows real QEMU/KVM, rootless asset construction/downloads, and temporary owned
systemd USER units under `/home/sanmoo/software-factory-test`. No deployment,
host package/service/permission changes, personal cache discovery, credentials or
model calls occurred. The development dispatch gate remains closed.

### Public increment

`Sandbox.prepare({ workId, configuration })` verifies strict effective configuration
and pinned assets, records adapter-owned resource identity before disk effects,
creates private workspace/artifact directories and a **standalone** qcow2 copy using
real qemu-img, then sets exact configured virtual capacity. File/directory fsync
precedes readiness. Source-copy estimate plus the configured free-space floor is
checked before copying. Repetition returns the same opaque reference; incompatible
reuse is refused. Partial preparation remains indeterminate and identifiable; it is
not blindly retried/repaired. This is resource ownership, not another domain store
or scheduler. The single unchanged configuration schema moved to `configuration.ts`.

No public start/observe/stop/remove/tool dispatch or lifecycle stubs were added.
`test/sandbox/sandbox-prepare.test.ts` tests the public seam with real qemu-img on
explicitly synthetic nonbootable raw bytes. It is opt-in because QEMU and authorized
persistent storage are real prerequisites. Successful prepare is not boot readiness.

### Actual profile, sources and build

- Node **24.21.0**, npm **11.19.0**, exact npm Gondolin **0.14.0** with lockfile
  integrity; upstream source **6b381a9fd1c353e80cc9b4cf35474b6909703a16**.
- Arch x86_64, host kernel **7.1.9-arch1-2**, systemd **262.1-1-arch**, QEMU/qemu-img
  **11.1.2**. Each serial VM: **2048 MiB/2 vCPU**, 40 GiB virtual disk, explicit
  paths, rootDiskDeleteOnClose:false and tmpfs:{}. Real guest execution observed
  `-accel kvm`, never TCG.
- Registry fetched explicitly from immutable source commit above at
  `https://raw.githubusercontent.com/earendil-works/gondolin/6b381a9fd1c353e80cc9b4cf35474b6909703a16/builtin-image-registry.json`.
  Selected **alpine-base:0.4.0 x86_64**, not latest; buildId
  **f59d9a69-1f62-57e0-a392-6800d3dd021d**. Archive URL:
  `https://github.com/earendil-works/gondolin/releases/download/image-alpine-base--0.4.0/gondolin-image-alpine-base-0.4.0-x86_64.tar.gz`.
  SHA256 **45cc0dd93181380b2c4b0bc2ea7496c961f39f8259122cd519f9efecf14fcaeb**
  verified before extraction. Its authenticated manifest SHA256 is
  **7b56e7234722541172922626b0d136b5924ae847ce39dcbd09cbe3079e091340**;
  not an untrusted self-pin. Guest Alpine **3.23.7**, kernel **6.18.58-0-virt**.
- **Actual rootless native SDK build succeeded**: getDefaultBuildConfig plus
  git/github-cli/docker; Alpine3.23.7 at `https://dl-cdn.alpinelinux.org/alpine`;
  work/output/cache/tmp all explicit under ticket03. Helper registry URL uses the
  same immutable commit and `builtin-sandbox-helper-registry.json`. No OCI,
  forced-container build, postBuild chroot, host Docker daemon or host installation.
  SDK also fetched its build-time libkrunfw v5.2.1 artifact, not a runtime fallback.
- Built manifest SHA256 **8ed20af25142e25d852deb000c12dcf26beadd802db6576f0790d440132a40e2**,
  buildId **5f358cb8-3857-5e6f-9b92-60f2a0ba69dd**, kernel **6.18.60-0-virt**.
  **This custom image did not reach guest readiness within 60 seconds in the
  real test. Build success does not qualify image/packages/Docker.** Its failed
  disk is retained; downloadable-image success is not a silent replacement.
- Full resolved build config and **113** source/cache hashes (APK archives/indexes,
  helper manifests, build/probe scripts) remain in `ticket03/build/build-config.json`
  and `ticket03/logs/source-sha256.txt` under the authorized root. Inventory SHA256:
  **8b1ca1f16b7d2f17d4f7f8caa1f72636b3ad06a4c0d0f3f7a0e540001c272d99**.
  Alpine indexes are time-specific inputs, not a reproducible signed-release claim.
  No assets or credentials entered Git.

### Real boundary observations and limitations

Owned transient user unit `factory-ticket03-persistence-20261105b` ran public
prepare with pinned bootable assets, then its trusted driver composed actual SDK
options. **Two distinct SDK session IDs/new boots** preserved identical markers in
/root, /tmp and RealFS workspace. Recorded QEMU argv and guest df show KVM and
38.1G ext4 on /dev/vda after resize. The initial unit without suffix b inspected
the lazy VM PID before start, failed before boot, and is not counted as proof.

Committed **external SDK seam** probe `test/sandbox/gondolin.test.ts` repeats this
cycle and performs real qemu-img check between/after closes. That test plus public
prepare test passed **2/2** in `factory-ticket03-real-tests-20261105`. This is NOT
a public Sandbox lifecycle proof: those methods remain absent. The same SDK test
against newly built assets failed at readiness in
`factory-ticket03-built-tests-20261105`, separately recorded. Networking was disabled;
no HTTP/TLS, Docker daemon/vfs, container, GitHub, secret or model proof. RealFS
ordinary persistence is not path/symlink/alias escape isolation proof.

All five test units were identified before effects in
`ticket03/logs/resource-inventory.txt`: the initial failed probe, successful b probe,
`factory-ticket03-build-20261105`, real-tests and built-tests units. RuntimeMaxSec=180,
KillMode=control-group; VM units had TimeoutStopSec=15. Final host observations show
empty ControlGroup and inactive/dead or failed states for every owned unit; a
targeted /proc scan found **zero own QEMU processes**. This is real test-unit
cessation evidence, not a product observer or owner-crash reconciliation proof.
No PID-null/exit-code-only cessation inference. No existing resource was stopped.

### Validation/reproduction

Pinned Node PATH throughout. Red: typecheck failed because prepare was absent.
Green: real public prepare test passed. Final architecture/typecheck pass.
`npm test` twice: **50 pass/1 fail/2 opt-in skips**, unchanged ticket02
`controller-ingress.test.ts:43` readiness assertion. Bounded b591ec7 baseline from
git archive under the test root passes ingress in isolation (no installation).
Full suite `node --test --test-concurrency=1 'dist/test/**/*.test.js'` passes
**51/51**, two explicit real-test skips; this does not make the default parallel
gate green. Supervisor explicitly permits coherent partial checkpoint commit;
ticket04 owns prerequisite readiness/host-lock correction, not duplicated here.

Repeat real tests only in an explicitly newly owned transient systemd USER unit,
new inventory identity, WorkingDirectory=this task worktree, RuntimeMaxSec=180,
KillMode=control-group, TimeoutStopSec=15 and pinned Node PATH. Pass these explicit
values through systemd-run --setenv (no default personal SDK cache discovery):

```text
FACTORY_SANDBOX_TEST_ROOT=/home/sanmoo/software-factory-test/ticket03
FACTORY_SANDBOX_REAL_ASSETS=/home/sanmoo/software-factory-test/ticket03/assets
FACTORY_SANDBOX_MANIFEST_SHA256=7b56e7234722541172922626b0d136b5924ae847ce39dcbd09cbe3079e091340
TMPDIR=/home/sanmoo/software-factory-test/ticket03/tmp
XDG_CACHE_HOME=/home/sanmoo/software-factory-test/ticket03/cache
GONDOLIN_SESSIONS_DIR=/home/sanmoo/software-factory-test/ticket03/sessions
node --test dist/test/sandbox/gondolin.test.js dist/test/sandbox/sandbox-prepare.test.js
```

Complete stdout/stderr retained in ticket03/logs: prepare-red.txt, full-gate.txt,
full-gate-retry.txt, full-suite-serial.txt, real-tests.txt, built-tests.txt, build.txt,
persistence-b.txt, baseline-ingress.txt, final-units.txt. Exact build/probe drivers
remain under ticket03/build with source inventory hashes.

### All eight acceptance criteria remain incomplete — exact remaining work

1. **Public lifecycle:** validate+prepare implemented; implement/publicly test real
   start, authorized tools, observe, stop, remove with typed outcomes/references and
   resource reconciliation. No lifecycle stubs.
2. **Profile:** real pinned downloadable KVM boot/hash proof exists; diagnose custom
   image failure, finish explicit release manifest/compatibility/qualification.
   No supported release asserted.
3. **Persistence:** disk,/root,/tmp,RealFS workspace survived two boots; prove expected
   package/cache/Docker data persistence on qualified custom assets, not only files.
4. **RealFS isolation:** actual guest path/symlink/alias escapes toward home,
   controller, records, Git cache and another Work remain untested. Hash/path
   integrity inspection and ordinary workspace writes do not satisfy this.
5. **Supervision:** real temporary user cgroups worked; implement persisted adapter/
   worker/subprocess identities and host observe/stop after owner death, plus
   noninterference with a second environment.
6. **Stop:** clean SDK close and disk-container checks only. Implement daemon/
   container shutdown/sync, graceful deadline then targeted force, independent
   cessation and filesystem checks before reusing forcibly stopped disks.
7. **Storage:** prepare copy estimate/floor and exact virtual size exist; add public
   effective/physical/virtual/workspace/free observations, preboot checks, pressure/
   failure tests, no-cleanup/no-live-kill behavior. No reservation promise.
8. **Real proofs:** serial KVM persistence and actual build demonstrated; full public
   lifecycle, owner-death recovery and two-environment isolation remain unproved.
   No substitutes counted as boundary proof.

Final inventory: **3,187,781,632 physical bytes** across the exclusive root (below
80GiB; includes other authorized ticket artifacts), zero active owned VMs. Preserved
successful environment at
`ticket03/runtime/environments/env-50ba694d7c2a015c9216d74521b67ab2c7d1df7a8f1b67ae3e310166cf09878c/`;
failed custom disk at `ticket03/gondolin-persistence-EH32Oz/`. Archives, built assets,
caches, logs/drivers and bounded baseline snapshot remain under ticket03. No
credentials were read/copied/used. Next: incorporate reviewed prerequisite gate fix,
diagnose custom-image boot and implement persisted systemd adapter start/observe/stop,
then failure/isolation proofs. Ticket remains **unresolved**.
