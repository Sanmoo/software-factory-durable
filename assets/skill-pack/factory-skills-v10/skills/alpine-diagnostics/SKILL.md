---
name: alpine-diagnostics
description: "Preparing and diagnosing the Factory guest (Alpine Linux, musl, Docker with the vfs driver, mediated HTTPS). Use when a build, test, package or container step fails in the sandbox."
---

<!-- Factory-own skill (no upstream). -->

The Builder runs in a Factory microVM: **Alpine Linux 3.23 (musl)**, its own Docker daemon (`vfs` storage driver, socket only inside the
guest), public HTTPS mediated by the Factory (a per-boot CA is installed in the guest trust store), no inbound access, no SSH, no host or
private networks. Your Work's files are `/workspace` (checkout in `/workspace/checkout`) and `/artifacts`; nothing else persists for the
Work except the guest disk.

**The repository's declared environment is already installed.** Every repository declares its stack in `.factory/environment.yaml`
(Alpine packages with exact versions, container images pinned by digest). The Factory prepared this guest with exactly that before
you started, from the release's Alpine mirror; nothing in it needs installing. Never reinstall, upgrade, downgrade, remove or replace a
declared package, version or image, and never swap the declared stack for another one (another JDK, a container image instead of the
declared runtime): if the declared environment is what blocks a gate, report it as a blocker with the evidence.

Diagnose before changing anything:

- Packages: `apk info -vv | head`, `apk search <name>`; `apk info -e <declared package>` confirms a declared one. Install an EXTRA with
  `apk add <pkg>` only when the Ticket's build needs something the declaration does not provide, and record it (package, exact
  version from `apk info -v`, and why) in your final message.
- musl vs glibc: prebuilt glibc binaries may fail with "not found"; prefer Alpine packages or musl builds (`*-alpine` container images).
- Java/Maven/Gradle: `java -version`, `mvn -v`; caches live under `/root/.m2` / `/root/.gradle` and persist across boots.
- Node: `node -v`, `npm -v`; Python: `python3 -V`, `uv --version`.
- Docker/Testcontainers: `docker info --format '{{.Driver}}'` must be `vfs`; containers cannot reach public networks by NAT; published
  ports work through the userland proxy. Use `docker ps`, `docker logs <id>`; clean up only your own containers.
- TLS: never disable verification (`-k`, `--insecure`, `NODE_TLS_REJECT_UNAUTHORIZED=0`); the guest trust store already trusts the
  mediation CA (`/etc/gondolin/mitm/ca.crt`); containers need it explicitly when they make HTTPS calls.
- Disk/memory: `df -h /`, `free -m`. Report resource exhaustion instead of deleting things you do not own.
- Timeouts: builds and tests (`./gradlew test`, `mvn verify`, `npm ci`) take minutes, far more on the first run that downloads the
  dependencies and the Gradle/Maven distribution. Give them a generous `bash` `timeout` (for example `timeout: 1800` seconds), never a
  short one such as 120: a command that exceeds its timeout ends the activation, because the Factory cannot confirm that it stopped.
- Large files: `edit` changes only plain UTF-8 text files of at most 8192 bytes and `write` accepts at most 8192 characters; change a
  larger file with `bash` (an in-place `python3` or `sed` patch, or a heredoc written in parts, each command under 16 KiB).

Record every diagnostic command and its result in your final message.
