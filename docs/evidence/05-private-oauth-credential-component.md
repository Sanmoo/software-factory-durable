# Task156 — private Factory OAuth credential seam (not activated)

## Delivered interface and explicit limits

`src/workers/factory-oauth.ts` exports only the deep private `openFactoryOAuth` seam and its trusted composition options. It is **not** exported by Workers/index or used by the existing worker runtime. The legacy API-key/completions route is unchanged. No Host/bootstrap/IPC/session/CLI/wizard branch is added.

Trusted composition supplies an existing canonical Factory root, existing canonical source/GuestWorkRoot/worker-profile exclusions, an existing OWN profile directory, same-process Records, a scope signal, and a **PRIVATE technical future-owner secret-publication observer**. The credential filename is fixed: `<factoryRoot>/credentials/chatgpt.json`; it is never supplied by a model or resolved from home/environment/default auth settings. Root and credentials directory must be current-UID mode0700; credential file must be an existing current-UID regular single-link mode0600 file. All credential ancestors must be canonical and not symlinks. Factory root must not intersect any exclusion. Missing/unsafe paths fail without creation, chmod, repair or fallback. Exclusions must already exist; symlink aliases cannot disguise intersections. These checks assume non-hostile trusted ancestors/same-UID host, **not atomic filesystem confinement** against hostile concurrent replacement.

The selected native `FileAuthStorageBackend` retains its proper-lockfile locking and **in-place writes**. No second lock engine, atomic rename, crash-atomicity, rollback, repair or safe recovery from torn writes is promised. Raw stored shape is checked **inside the native lock before SDK parsing/API-key config resolution**. Only one `openai` OAuth entry with the actual ChatGPT credential fields is accepted; extra providers, API keys, command configs, missing/mixed/malformed/torn data fail closed. Backend failure latches, preventing the native AuthStorage's reload/read fallback from returning an older credential. The wrapper always supplies a read signal and uses `fromStorage`, not the shared file snapshot cache.

Access, refresh and issued client ID register locally with existing Records limits (4096 characters / 128 distinct secrets), including inside the native modify callback **before private persistence**. Existing/current credentials await technical owner ACK before SDK modify-callback use. After commit, the resulting credential awaits the observer before SDK `toAuth` or return; ACK failure latches and denies further use without undoing private rotation. Duplicate registration remains Records' no-op. A returned rotation that cannot register locally (oversize/count limit) fails before persistence/use; because the remote endpoint may already have rotated, this fail-closed case can require future explicit human recovery, not automatic rollback/repair. No credential is written into invocation data, Records events or sessions. The observer is not WorkAdmission, billing permission or a model grant. **Tests use a callback stub: real owner registry/IPC ACK wiring remains OPEN.** Every process will need its own Records registration in the later vertical.

`getAuth()` lazily creates the actual native ModelRuntime with explicit credentials, `modelsPath:null`, explicit OWN-profile `modelsStorePath`, `allowModelNetwork:false`, `refreshOnCreate:false`; checks exact built-in `openai / gpt-6-luna / openai-responses`; and performs only native auth resolution. The actual runtime uses an in-memory models store when `modelsPath:null`, despite the explicit modelsStorePath option; no persistent/default model cache is opened by this helper. It does not expose a native runtime/provider override or run inference. No `registerProvider`, `setRuntimeApiKey`, API-key/completions/Codex fallback, catalog request, login or loopback listener is called. AuthStorage itself has no login/getApiKey orchestration API.

Scope invalidation rejects new reads/refreshes/auth returns. Once native refresh has begun, its native 15-second provider timeout may outlive caller abort so the rotated private token can persist. `settleCredentialWrites()` observes native pending writes; it does not prove network/process cessation, cancel private persistence, or bound a future owner observer that never ACKs. Future owner transport must supply its own bounded failure/lifecycle contract. An already returned transient credential cannot be revoked by this object; later composition must recheck scope before every provider/tool start.

All outward failures are frozen `{code:'FACTORY_OAUTH_UNAVAILABLE'}` objects, with no original Error/cause/stack/body/headers/URLs. Native ChatGPT exchange presence-checks then discards ID token without returning it to the credential seam: **no ID-token registration/interception claim**. Canonical Q8 covers known secrets before controlled use, not universal interception of unknown SDK tokens. Unknown token HTTP-error bodies are contained by the closed auth helper rather than relying on known-secret filtering.

## Selected source provenance (read-only)

Supervisor approved exactly two additional private `package.json` aliases so lazy imports remain literal and architecture-visible:

- `#factory-pi-auth-storage`: `.scratch/factory-development-sdk-v3/sdk/dist/core/auth-storage.js`, with matching `auth-storage.d.ts`.
- `#factory-pi-model-runtime`: `.scratch/factory-development-sdk-v3/sdk/dist/core/model-runtime.js`, with matching `model-runtime.d.ts`.

Before either native import, the module checks exact alias runtime/type selections and canonical runtime resolutions; existing profile identity/selection fields against `sdkProfile`; and current-UID regular single-link selected files against literal baseline byte counts/SHA256 below. Baselines were measured once as data against the adopted unpatched files and installed same-version originals (matching). No SDK/profile/dependency bytes changed, no preparation/install executed. An earlier supervisor reference to an existing standalone read-only verifier was inaccurate: only the mutating `prepareDevelopmentSdk` existed. It is **not invoked**. This new private check attests only the four selected OAuth seam files, **not the full adopted tree or transitive runtime/dependency integrity**.

| File under selected `sdk/dist/core/` | Bytes | SHA256 |
|---|---:|---|
| auth-storage.js | 16884 | 85c773c95be71695a27f5ed2f9f5bfaedc6c2ab3fe1fa7fcdf09707a3a73ce48 |
| auth-storage.d.ts | 3379 | 6197ffc082ffe1ef47894168fea1a575175743eaaa078bb4664ea310115dc9a6 |
| model-runtime.js | 37444 | b17018cb70007a194f10b2aaf5ec3631329db20cf853ddc9ce4088e6b4373ab1 |
| model-runtime.d.ts | 10000 | 9afd3e379b8fa12030075dbc6c983cc8652bd7c3a41ccd7e4d9e10b8c5017758 |

## Finite evidence / reproduction

Tests use only fresh own short0700 fixture roots and synthetic auth files, real Records and the actual adopted native store/runtime/OAuth refresh implementation. Before native evaluation, CLOSED fake fetch accepts only the exact token endpoint in memory; all other URLs are denied/counted. Inert socket/listen/DNS/process-spawn/native-addon sentinels and credential-path guards are installed first. No HTTP server, real login/refresh/provider request, personal auth path (even metadata), browser, VM/Gondolin evaluation or guest execution was admitted. Fake transport responses, observer ACKs and byte-drift reads are doubles; native locking, private writes, auth orchestration and Records are real.

Genuine RED→GREEN recorded for initial store seam (1 fail → 1 pass), native auth helper (1 pass/1 fail → 2 pass), current-credential pre-callback ACK (2 pass/1 fail → 3 pass), symlink-disguised exclusion (15 pass/1 fail → 16 pass), and selected-source drift guard (16 pass/1 fail → 17 pass). Later coverage assertions extended existing behavior. No setup/compiler failure was counted as RED. There was no pre-existing component test or baseline coverage (module did not exist). An earlier intermediate 12-test run measured 94.20% lines / 95.92% branches; final focused coverage is reported in the task result, not whole-repository coverage.

Use absolute Node24.21.0 with `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1`, and a <=60-second shell timeout:

```
/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node node_modules/typescript/bin/tsc -p tsconfig.json
/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node --test --test-timeout=10000 --experimental-test-coverage --test-coverage-include='dist/src/workers/factory-oauth.js' dist/test/workers/factory-oauth.test.js
/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node node_modules/eslint/bin/eslint.js src/workers/factory-oauth.ts test/workers/factory-oauth.test.ts --max-warnings 0
/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node node_modules/dependency-cruiser/bin/dependency-cruiser.mjs --config .dependency-cruiser.cjs --output-type err-long src/workers/factory-oauth.ts test/workers/factory-oauth.test.ts
```

No tsx/runtime TS, full build/npmtest/clean, preparation, package install, broad Records reruns, candidate requalification or VM tests are necessary/admitted. Mode/hardlink/symlink/missing/torn/shape/cap/ACK/abort/concurrent refresh/unknown-body/registry epoch/selection drift negatives are covered. Foreign-UID fixtures and hostile same-UID races were not exercised; UID predicates are enforced but are not independently privileged-fixture evidence.

## Explicit future holds

User chose their own ChatGPT OAuth Factory-private account and US$10 **estimated local reservation**, not a provider-enforced hard billing cap. This module is not authorization to open the real credential file or perform live qualification.

Still OPEN: human-reviewed login/wizard and installation ID; real owner secret-registration ACK transport before SDK use; per-process registry registration; durable start receipt before OAuth/model work; strict typed profile/bootstrap branch; private Worker phasing; bounded actual model-call/output-token/continuation controls and approved physical fixture; entitlement/tariff/account evidence; native session/tool/continuation execution and physical cessation evidence. Metadata lookup is not entitlement or billing proof. The existing VM unconditional skip remains untouched.

Source-only next-plan hints, not implemented controls: native agent-session declarations expose `readonly agent: Agent` and a deep `markRuntimeStreamFunction` function; native source refers to `this.agent.streamFunction`; pi-ai stream options expose `maxTokens`. This task does not establish a public root setter/export, actual per-call enforcement or a provider-call counter. Do not invent setters or call-count guarantees from these hints.
