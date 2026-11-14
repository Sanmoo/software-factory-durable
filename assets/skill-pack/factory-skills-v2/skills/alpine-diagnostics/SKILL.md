---
name: alpine-diagnostics
description: "Preparing and diagnosing the Factory guest (Alpine Linux, musl, Docker with the vfs driver, mediated HTTPS). Use when a build, test, package or container step fails in the sandbox."
---

<!-- Factory-own skill (no upstream). -->

The Builder runs in a Factory microVM: **Alpine Linux 3.23 (musl)**, its own Docker daemon (`vfs` storage driver, socket only inside the
guest), public HTTPS mediated by the Factory (a per-boot CA is installed in the guest trust store), no inbound access, no SSH, no host or
private networks. Your Work's files are `/workspace` (checkout in `/workspace/checkout`) and `/artifacts`; nothing else persists for the
Work except the guest disk.

Diagnose before changing anything:

- Packages: `apk info -vv | head`, `apk search <name>`; install with `apk add <pkg>` only when the Ticket's build needs it, and record it.
- musl vs glibc: prebuilt glibc binaries may fail with "not found"; prefer Alpine packages or musl builds (`*-alpine` container images).
- Java/Maven/Gradle: `java -version`, `mvn -v`; caches live under `/root/.m2` / `/root/.gradle` and persist across boots.
- Node: `node -v`, `npm -v`; Python: `python3 -V`, `uv --version`.
- Docker/Testcontainers: `docker info --format '{{.Driver}}'` must be `vfs`; containers cannot reach public networks by NAT; published
  ports work through the userland proxy. Use `docker ps`, `docker logs <id>`; clean up only your own containers.
- TLS: never disable verification (`-k`, `--insecure`, `NODE_TLS_REJECT_UNAUTHORIZED=0`); the guest trust store already trusts the
  mediation CA (`/etc/gondolin/mitm/ca.crt`); containers need it explicitly when they make HTTPS calls.
- Disk/memory: `df -h /`, `free -m`. Report resource exhaustion instead of deleting things you do not own.

Record every diagnostic command and its result in your final message.
