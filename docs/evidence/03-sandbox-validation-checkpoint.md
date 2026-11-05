# 03 — persistent work environment: BLOCKED checkpoint

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
