# Prerequisite correction discovered during ticket 04 real acceptance

2026-11-05, existing branch `implement/software-factory-mvp-04`, starting at
`71287cf`. Supervisor explicitly approved a focused correction at ticket 02's
host-lock seam and its readiness regression; this is not a GitHub transport fix.
Independent review of the ownership proof is required before integration.

## Actual failure and source of truth

The real controller failed before reading its App key or contacting GitHub under
an isolated, account-owned installation in `/home/sanmoo/software-factory-test`.
The existing `/tmp` controller test passed. A minimal real `flock --exclusive
--nonblock --no-fork <own-lock> node <probe>` reproduced
`CONTROLLER_LOCK_REQUIRED` repeatedly on the authorized home filesystem.

Metadata only: home filesystem is Btrfs; `stat` of the lock reported device **55**,
inode **30531026**. The same no-fork owner PID **1921909** appeared in both
`/proc/locks` and its inherited descriptor's `/proc/self/fdinfo/3` with a whole-file
`FLOCK ADVISORY WRITE`, device **00:1d** (29), same inode. Thus converting the
kernel lock device into a `dev_t` and comparing it to userspace `st_dev` rejected
a genuine owner. No secret content was involved in these probes.

Ranked hypotheses were device representation mismatch, owner-PID mismatch and
missing/racing lock. The metadata discriminated the first from the others.
Public kernel source independently explains the distinction:

- [Linux v6.12 fs/btrfs/inode.c, btrfs_getattr](https://github.com/torvalds/linux/blob/v6.12/fs/btrfs/inode.c): `stat->dev = BTRFS_I(inode)->root->anon_dev`.
- [Linux v6.12 fs/proc/fd.c](https://github.com/torvalds/linux/blob/v6.12/fs/proc/fd.c): fdinfo invokes `show_fd_locks` for that open file.
- [Linux v6.12 fs/locks.c, __show_fd_locks](https://github.com/torvalds/linux/blob/v6.12/fs/locks.c): includes only locks matching the descriptor's `struct file` and owner, then prints their kernel lock status.

The correction matches an actually open descriptor to the configured path using
**both** stat device and inode; its fdinfo must then prove a whole-file advisory
WRITE FLOCK belonging to **this PID**, with matching inode. No Btrfs-only bypass,
PID-only/file-presence success, new lock mechanism, mount change or host permission
change was introduced. Missing/incompatible observations still fail closed.

## TDD and development gate

Seam: real controller CLI ownership/startup (explicitly approved prerequisite).
Added `controller verifies its own flock on configured persistent storage without
accepting another process owner` in `controller-ownership.test.ts`. It uses
`FACTORY_TEST_ROOT` if supplied, otherwise the usual temporary directory. In this
run the variable explicitly selected the authorized home test root, so the
regression exercised the real failing filesystem rather than a substituted
filesystem or mocked proc data.

1. RED: build plus the new test on home failed: controller exited **3** before
   serving, instead of staying alive with an observed status.
2. GREEN: descriptor-backed proof; all **7 ownership tests passed**, including
   canonical aliases, competing owners, direct-owner bypass refusal, crash
   restart and failed-commit behavior. Home controller subsequently served real
   authenticated-doctor requests and stopped cleanly.
3. Initial two parallel full-suite runs each failed **only** the existing ingress
   test's approximately one-second startup poll (62/63); the same ingress test
   passed alone. The added real filesystem/proc startup work exposed its
   scheduling-sensitive readiness bound. With explicit supervisor approval, that
   test now uses a monotonic **5-second** deadline with early spawn/exit/signal
   checks and sanitized readiness diagnostics; it still requires an actual
   socket status/controller identity. No production timeout or semantics changed.
4. Final gate with pinned Node **24.21.0**, npm **11.19.0**:
   `npm ci`; `npm run typecheck`;
   `FACTORY_TEST_ROOT=/home/sanmoo/software-factory-test npm test` **twice**;
   `git diff --check`. Both final full runs passed **63/63**, zero failed/skipped,
   architecture/ESLint/build included (about 28.0s and 22.2s).

`npm ci` reported five moderate vulnerabilities and two dependency install-script
approval warnings; no dependency updates/audit fix were made. Earlier full-suite
failures are retained here, not erased by the green reruns. This establishes a
local prerequisite correction, not a certification of filesystem power-loss
semantics or completion of ticket 04's real GitHub acceptance.
