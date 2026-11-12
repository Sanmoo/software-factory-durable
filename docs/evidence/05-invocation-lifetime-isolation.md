# 05 — local invocation lifetime isolation only

Base: `333d4ad806653bbfc9129d0ff1f95b43ee3544aa`. This is the first small local slice of the operational-bootstrap plan, not completion of 05 or operational qualification.

## Change

The private Sandbox owner can collect independent host-authorized read bindings over its existing GuestOwner VM boundary. Each binding keeps its own context snapshot, abort signal, capture ownership and transport lifetime. Closing the collection starts closure of every binding and is idempotent. The adapter uses that collection for its existing optional binding and no longer connects invocation EOF/abort to `terminate`. Boot SIGTERM/SIGINT still enter the existing shutdown/finalization path, which starts binding closure without delaying the guest finalization command on draining a possibly unresponsive read, and awaits binding cleanup in the adapter finally block. No finalization shell, FS provider, startup fences, CLI arguments or stdout policy changed.

## Fresh local evidence

All executions used absolute `/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node`, ordinary commands bounded to 60 seconds. No VM, model, DNS/network, systemd or host Docker operation was performed.

- Baseline: `node node_modules/typescript/bin/tsc -p tsconfig.json` and `node --test dist/test/sandbox/tool-transport.test.js`: compile exit 0; 8 tests, 8 pass, 0 fail.
- RED: new `test/sandbox/invocation-isolation.test.ts` written before the collection implementation; compile exited 2 with `TS2724: '"../../src/sandbox/read-tools.js"' has no exported member named 'serveReadToolBindings'. Did you mean 'serveReadTools'?`. This was a missing implementation/export RED, **not** a behavioral regression assertion or native runner failure.
- GREEN: compile exit 0; `node --test dist/test/sandbox/invocation-isolation.test.js dist/test/sandbox/tool-transport.test.js`: 9 tests, 9 pass, 0 fail, 0 cancelled, duration 230.317063 ms.
- Affected native projection only: `node --test --test-name-pattern='Q5 owner capture' dist/test/workers/native-owner-read.test.js`: 1 test, 1 pass, 0 fail, duration 903.43484 ms. No other worker/model-loop cases executed.
- `node node_modules/dependency-cruiser/bin/dependency-cruiser.mjs --config .dependency-cruiser.cjs --output-type err-long .`: `✔ no dependency violations found (93 modules, 448 dependencies cruised)`.
- `node node_modules/eslint/bin/eslint.js . --max-warnings 0`: exit 0, no output.
- `git diff --check`: exit 0, no output.

The new focused test runs abort and peer-EOF cases with two different host-authorized reviewer contexts sharing exactly one external VM double per case. It observes the Standards pending read's abort signal, denial of subsequent Standards calls, forged Spec invocation denial, successful Spec capture and page content from the same double, zero VM-close requests, and explicit idempotent all-binding cleanup. Real Protocol transport, Records and the public Q5 Sandbox projection are used; only the external guest boundary is doubled. The zero-close counter observes that boundary, not actual systemd boot-stop behavior.

## Unimplemented next steps / residual risks

The adapter executable still takes the same three arguments and does not obtain a normal-path binding registration endpoint; its optional injected binding remains single-invocation. The private collection test is not proof of two host workers launched through the normal adapter executable. Each Sandbox projection remains invocation-scoped. Host worker launch, expected-peer registration/authority plumbing, durable admission/reservations/start-receipt observation, true supervised cessation and reviewer-to-Builder handoff remain unimplemented. Builder operations, image/binary reads and full SDK/profile/model/native VM qualification remain outside this slice. Boot signal/finalization behavior was preserved by inspection, not requalified with physical execution. Self-review retained the existing nonblocking invocation-close ordering on boot stop so draining an unresponsive read does not delay the finalization attempt. No integration, push, peer-worktree changes or gate bypass occurred.
