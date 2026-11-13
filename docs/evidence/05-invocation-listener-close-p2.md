# Task74 — invocation-local listener cleanup (P2 only)

Base `2021c77e4c7d4d1651530d0037fb2c6cf9d1bbf6`; original integration `4e085bf` untouched.
This addresses the listener-lifetime finding in the normal owner-launch review,
not guest-writer cessation, whole05, Control admission, or new authority.

## Change

`serveReadTools` now closes its own Protocol listener and peers when its combined
invocation lifetime aborts (including tool-peer EOF). Its cleanup promise is
published before synchronous revocation, making explicit close and abort-driven
close reentrant/idempotent. Cleanup awaits that binding's actual active callbacks,
including when server closure fails. After asynchronous listen setup it checks for
an already-aborted signal, covering revocation before or during listen/chmod.
Existing collection add's post-await abort check still closes/rejects an aborted
setup. No VM/collection/other reviewer is closed by invocation loss.

Owner-registration invocation claims and Sandbox context tombstones remain
unchanged: no retry/adoption or deletion on failure/EOF. The collection still
retains closed software handles until boot close; they no longer own listening
sockets. No guest-FD helper or cessation assertion was added.

## Behavioral regressions

- The ordinary public activation fixture closes a completed activation, checks
  its socket disappears, then uses an actual Unix connection attempt to verify
  attachment fails with ENOENT. It also checks the actual failed-start child's
  listener closes. One separate Spec binding successfully reads before closure,
  after completed-activation closure, and after failed start in the same boot.
  Polling uses lstat, not probe peers whose EOF might cause the cleanup being
  tested. Existing once-only invocation rejection remains asserted.
- The critical Records failure now collides with only `failed-start`, not the
  structural key `version`, so the fixture does not globally deny Spec captures.
- Focused tests cover already-aborted setup, abort during listen/add awaits,
  repeated close, and close waiting for an actual callback after transport abort.
  Existing abort/EOF isolation, no-VM-close, forged context denial and native SDK
  regressions remain. Post-revocation assertions accept the newly closed transport
  rather than requiring a stale-context response from a listener that must close.
- The fixed-child pending-abort test now gets a distinct live nativeOwner binding:
  its preceding completed child's EOF correctly closes the old listener. This
  preserves pending abort during SDK setup (STALE_TOOL_CONTEXT, zero provider/
  guest calls), rather than silently substituting a connection-failure test.

## Local TDD and validation

All commands were bounded to <=60s and used the absolute executable
`/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`. Final compiler,
focused suite and static commands cleared NODE_OPTIONS/NODE_COMPILE_CACHE and set
NODE_DISABLE_COMPILE_CACHE=1. No SDK installation/preparation or full 153-test loop.

- Baseline compile and three focused existing files: `tests 10; pass 10; fail 0;
  cancelled 0; skipped 0; todo 0; duration_ms 2130.885301`.
- Behavioral RED before implementation: actual public normal activation failed
  with `invocation listener still accepts connections: /tmp/nw-.../r/.../b1`;
  `tests 1; pass 0; fail 1; duration_ms 3228.702928`.
- Initial extra setup-race RED failed the socket assertion but hit the 60s bound
  because the new failing-test path had not registered direct-owner cleanup.
  Registered cleanup before the assertion; no production workaround or rule bypass.
- Intermediate GREEN work exposed expected stale-response assertions and the
  fixed-child reuse of the now-closed listener; adjusted fixtures as above, not
  production worker behavior. One preliminary scope command used nonexistent
  Host test paths and ran only 64 tests; final explicit paths corrected below.
- Final compilation: `node node_modules/typescript/bin/tsc -p tsconfig.json`, exit 0.
- Final focused command (absolute Node as above):

  ```sh
  node --test dist/test/entrypoints/normal-worker.test.js \
    dist/test/workers/worker-process.test.js \
    dist/test/workers/host-activation.test.js \
    dist/test/workers/host-launch-plan.test.js \
    dist/test/sandbox/owner-registration.test.js \
    dist/test/sandbox/invocation-isolation.test.js \
    dist/test/sandbox/tool-transport.test.js \
    dist/test/workers/native-owner-read.test.js \
    dist/test/sandbox/sandbox-start.test.js \
    dist/test/sandbox/sandbox-start-diagnostics.test.js \
    dist/test/sandbox/sandbox-stop.test.js
  ```

  Exact summary: `tests 67; suites 0; pass 67; fail 0; cancelled 0; skipped 0;
  todo 0; duration_ms 6241.596237` (previous 65-case scope plus two new cases).
- Architecture: `node node_modules/dependency-cruiser/bin/dependency-cruiser.mjs
  --config .dependency-cruiser.cjs --output-type err-long .`:
  `✔ no dependency violations found (107 modules, 534 dependencies cruised)`.
- Full ESLint: `node node_modules/eslint/bin/eslint.js . --max-warnings 0`, exit 0,
  no output. `git diff --check`: exit 0, no output.
- Active changed-path LSP: 7 checked, 6 clean, one auxiliary ast-grep warning
  about Promise.allSettled([...active]) allegedly having a single promise.
  This is a dynamically sized Set of real callbacks, not a single promise;
  retained the existing multi-callback drain. Compilation/lint authoritative.

## Self-review and residual limits

No blocker found in this direct P2 scope. Per-binding cleanup is software resource
cleanup only: an uncooperative guest operation can still delay callback drain.
Activation handle close, AbortSignal, listener close, Records completion and child
exit do not prove guest writer cessation or release of guest FDs. No real VM,
unit, model/network, credentials, OAuth, profile keys, GitHub, assets, host Docker,
mounts or cleanup of prior runs was used. No changes to hooks, architecture rules,
review chains, services, admission or integration branch. GuestFD work remains for
a different writer after this committed result.
