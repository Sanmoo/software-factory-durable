# Recovery87 — Task85 native timeout WIP checkpoint only

## Scope and provenance

Native run `d1ba8087-bb45-45d8-8398-dbf75e71318b` timed out after 1,800,000ms; workflow `c424da56` was partial with no successful structured report. This recovery preserves its exact seven dirty tracked files and two new files, adding only this evidence document. No source/test logic was changed by recovery. Task85/increment05 remain partial, NOT complete; this is not Bash acceptance.

Verified starting task HEAD `ac41412e01303b550d9fecaf60f5cf12435b4e0a` (parent `4ba724d7c3e3d91bd22b325f2d22810ce38422a4`). Original destination recorded as `integration/software-factory-mvp@4e085bff4991210021c8e4714c4df89d4992376a`; integration and peers were not touched.

Private preserved snapshot: `/tmp/software-factory-mvp-05-bash-timeout-checkpoint-qdAR5s`. Before any change, HEAD, raw status, binary tracked patch, empty index patch, untracked list, preserved archive, and both new files matched the supplied snapshot. Rechecked source/status/patch after current checks: unchanged.

| Raw artifact | Bytes | SHA256 |
| --- | ---: | --- |
| tracked.patch | 11192 | 026f873c9e5321ddac4fae15fc211be32bde2c89a5642fd03cc4b46f2c07003e |
| staged.patch (empty) | 0 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| status.z | 339 | 769207b7c05d7ff98be2e0080d6fc371af688104ff005ff938697bd8b453726b |
| untracked list | 84 | 39931755e0fb035098f523671a0fd8421bbb53956e34f6e4cdd257f3ad33008d |
| untracked.tar | 20480 | e592c4724951d8760978921322fc64fd228c76eb90b11e6d54c541392b4603f6 |
| failed-native-output.log | 290004 | 75ca05bed3dbe0ccf96261d6a0e5c8611ff669642f5094791098d819724ba544 |
| historical-affected-tests.log | 14380 | a63f6603d5b891b9a38403134bd557f3717bad09d3ce1faf7db9d5197e878d33 |

Verification-path setup correction: the brief called the raw log `raw-failed-native-output.log`; reading that nonexistent filename produced FileNotFoundError, before any changes or validation. Supervisor explicitly supplied the actual `failed-native-output.log` and `preserved-logs.json` paths and authorized continuation. Both actual log sizes/hashes matched. This was not a source mismatch or native runner failure. No historical log commands were replayed.

## Exact preserved file SHA256

```text
5e78c05453ab563064ab64d162712d7cdef7427e8971e04d2deea38f379fc7b8 src/sandbox/bash-tools.ts
282a0740be8076bd1f4bae8ff8f49eb1ad8365a5e9f6cce2d4698b9216fdab31 src/sandbox/read-tools.ts
6662d52b1daf514e3cfb00c8292e8567dcd7f5367a93e22bd9be21e41056fcd1 src/workers/bash.ts
e4351feb6290cf68ea382559a641d2617db4061f95869f199a38bc08439b2c31 src/workers/worker-process.ts
0dc233e0636ff881af554d19668e8f20d677adb8b5e50be13815c34ba00d6abd test/sandbox/adapter-diagnostics-fixture.ts
d482075b76d7debf49272f73ed502924d8c048d1b30c70923bd8b91266c58f4e test/workers/native-builder-bash.test.ts
db1a3edd1afc270a1ce31031bd775cc227385cca203b03d255932097511f09b2 test/workers/worker-bash-process.test.ts
778b5ec6d5d2d0449fc8f3279afb6e9887153790cf923180bf9015e62bf61190 docs/evidence/05-native-builder-filtered-bash.md
2dd9f0f53d9abb19e9975190cbd075aab5240fea8b02853adaa502822fe2580c test/sandbox/bash-progress.test.ts
```

## New current validation — exactly once each

Both commands had a 60-second bound and used explicit Node24, with NODE_OPTIONS/NODE_COMPILE_CACHE unset and NODE_DISABLE_COMPILE_CACHE=1. No SDK preparation or SDK patch was performed.

```sh
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 timeout 60s /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node node_modules/typescript/bin/tsc -p tsconfig.json
```

Exit 0, no output.

```sh
env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 TMPDIR=/tmp timeout 60s /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node --test --test-name-pattern='capture-failure' dist/test/workers/worker-bash-process.test.js
```

Exact output:

```text
✔ new Node24 native Bash/session/host spill: capture-failure (1024.822267ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1776.142872
```

Only one matching test was reported; the other five names were not executed/reported as skipped by this runner. This is not a full suite result.

## Historical validation — not rerun

- Historical 136 affected tests passed in 34,015ms BEFORE the final two completion-correlation patches in read-tools/worker-process and strengthened adversarial progress tests. No final full136 rerun is claimed.
- Historical focused normal-owner/Bash/child/adversarial 28 passed in 7,864ms AFTER those changes. Distinct from current one-test recovery check.
- Historical architecture 134 modules/680 dependencies and lint passes precede final patches. LSP 11 confirmed clean/7 push-only inconclusive is not proof all paths clean. No additional suites, SDK preparation, architecture/lint/LSP reruns were performed here.
- Original evidence/history remains byte-for-byte intact; this chronology qualifies its historical claims without rewriting it.

## Remaining gates and nonclaims

- **UNSATISFIED:** all SDK-internal native host-spill pending bytes hard memory bound. Pi1.5.2 OutputAccumulator.append writes WriteStream without awaiting drain; supported synchronous onData/custom-exec does not expose the stream. Bounded protocol frames/owner Records/windows do not establish upstream boundedness under indefinitely stalled host storage. No SDK fix/fork/alternate accumulator/global stream mutation in recovery.
- Task88 native tool-ID UUID P2 fix is later, NOT implemented here. Appended mkdir/create IDs can exceed native length/punctuation constraints and leave partial mkdir before invalid create; Bash raw native ID shares the seam. Task83 remains reopened pending88; Task85 stays in progress/partial.
- Fixed guest argv `/usr/bin/env -i /bin/bash -c command` addresses merged/omitted empty Gondolin env, but guest executable/image availability remains unqualified. No real GitGrantDelivery.
- Native spill is a 0600 HOST artifact under profile TMPDIR, not a guest path; selective guest copy remains OPEN. Unchanged fatal UTF-8 rejects binary Bash.
- Abort/timeout/capture/transport failures mean effects UNKNOWN, not known non-effect or proven physical cessation.
- Task65 auth/US$10 remains USER PENDING. No real VM/systemd/Factory model/network/OAuth/credentials/GitHub/assets/install/host Docker/sudo/mount/old signals/cleanup/guest-body host execution or integration/push operation occurred. No delegates or alternate executor.

Recovery ends with an ordinary task-branch WIP commit, normal hooks, and no implementation-completion claim. Further feature work and gate resolution require separate authorization.
