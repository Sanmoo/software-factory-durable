# Ticket06 — native public HTTP(S), local functional partial

## Ownership and scope

Started clean on `implement/software-factory-mvp-06` at `697749f`; `4e085bf`
is an ancestor. Original destination remains `integration/software-factory-mvp`
in the sibling checkout. No reset, peer writes, integration, push or physical
activity. No active Git hooks observed: `core.hooksPath` unset and only sample
hooks in the common Git hooks directory. No hook override used.

Authority: approved issue19 **Rede, certificados e credenciais**, public-interface
Q5/Q9; bounded operational slice `/tmp/software-factory-mvp-next-operational-slices.md`
and capability scout artifact
`b2e60419-43b6-479f-9905-c75500886482/gondolin-network-tls-06-capabilities.md`.
The already-approved seams are the adapter entrypoint/VM boundary (VM double),
the stock root-export SDK HTTP hooks (pure inputs), and `Sandbox.validate`.
No new public API, optional test callback, configuration flag or policy engine.

## Implemented, not qualified

- After existing ownership, supervision, runtime and asset checks, compose stock
  Gondolin **0.14.0** `createHttpHooks`. Omitted domain allowlist permits arbitrary
  public destinations; omitted internal exceptions retain built-in private-IP
  denials. A supported factory `isIpAllowed` exclusion composes *after* those
  denials using Node `BlockList` over the host interface addresses observed at boot.
  Canonical IPv6 and IPv4-mapped IPv6 forms are covered by `BlockList`.
- Enable SDK network mediation, explicit synthetic DNS, disable WebSockets, omit
  SSH, raw TCP mappings and ingress. Omit fetch override at both VM and sandbox
  levels, retaining SDK native guarded DNS/connect and per-redirect processing.
  Existing ingress/SSH socket *paths* are unchanged, not forwarding grants.
- Create `mitm-ca` mode0700 **inside this boot's already-owned runtime directory**;
  explicitly pass `sandbox.mitmCertDir`. Exclusive mkdir fails rather than reuse
  an existing directory/symlink. The SDK can generate CA material only at future
  real activation; no CA is generated in these tests. Existing owned runtime
  removal includes this child directory, subject to unchanged cessation gates.
  No personal/default SDK CA cache, private-key guest mount or key logging.
- `Sandbox.validate` now says network policy is **configured/unverified**, not
  disabled or runtime-qualified. Tool-channel remains blocked on this06 base;
  Docker/TLS remains unverified. Validation itself creates no resources.
- Lifecycle deadlines, ignored guest stdout/stderr, disabled console/debug,
  persistent caches/disk/VFS mounts, ownership/fencing and cessation remain intact.
  Frozen assets, recipe, Docker config, kernel and backend are unchanged.

## Static CA-init pointer — not a runtime certificate proof

Supervisor-provided read-only byte evidence:
`/tmp/software-factory-mvp-06-frozen-init-readonly.json`.
Frozen rootfs SHA256:
`6fb903a7bbdc4ec419e183897e0d5fcff7d5b79db1804e1d877f181cb3db15de`.
Extracted init SHA256:
`21f6462a946bfbeda414f586f7ad855ad7b9b32c04395f0673b430864b5c1900`.
The recorded 376-line init calls `setup_mitm_ca` at339, starts dockerd at367,
and execs sandboxd at375. CA path is `/etc/gondolin/mitm/ca.crt`; system trust
installation/runtime CA bundle and tool environment are present in the static
capture. This run read that existing report only: no asset extraction, modification,
CA generation, guest execution or TLS handshake. Order alone proves neither
successful installation nor daemon/container trust.

## TDD and local evidence

All executable JavaScript commands used absolute
`/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node` (Node24.21.0).
TypeScript emitted NodeNext ESM with `node_modules/typescript/bin/tsc -p tsconfig.json`.
Every command block had a timeout <=60 seconds; no runtime transpiler.

1. Baseline compiled adapter diagnostics + validation: **21 tests, 21 pass, 0 fail**.
2. New network seam test RED: **1 test, 0 pass, 1 fail** (no network-policy audit;
   existing adapter network disabled). Initial fixture type errors were corrected
   before this behavioral RED (protocol spelling, logger types/optional fields).
3. GREEN after composition: **1 test, 1 pass, 0 fail**. During implementation an
   ordinary ENOENT exposed that `privateDirectory` validates rather than creates;
   explicit exclusive mkdir corrected it, without changing lifecycle helpers.
4. Updated diagnostic RED: **1 test, 0 pass, 1 fail**, old disabled/blocked text.
5. Post-change compiled affected group: **22 tests, 22 pass, 0 fail, 0 skipped**.
   Commands: absolute Node + `node_modules/typescript/bin/tsc -p tsconfig.json`,
   then absolute Node + `--test dist/test/sandbox/sandbox-adapter-diagnostics.test.js dist/test/sandbox/sandbox-validation.test.js`.
6. Architecture: absolute Node +
   `node_modules/dependency-cruiser/bin/dependency-cruiser.mjs --config .dependency-cruiser.cjs --output-type err-long .`:
   **no dependency violations found (77 modules, 349 dependencies cruised)**.
   Absolute Node + `node_modules/eslint/bin/eslint.js . --max-warnings 0`: exit0.
   An initial wrong dependency-cruiser filename (`dependency-cruise.mjs`) failed
   MODULE_NOT_FOUND; corrected using installed `.bin` symlink target, no install.
7. Active LSP probe of five changed TS files: zero diagnostics, three confirmed
   clean/two inconclusive; compiled tsc, not that silence, is typecheck evidence.
   `git diff --check`: exit0.
8. Final compiled affected + lifecycle regression block: **73 tests, 73 pass,
   0 fail, 0 cancelled, 0 skipped**, duration6048.52042ms. Absolute Node + tsc,
   then absolute Node + `--test dist/test/sandbox/sandbox-adapter-diagnostics.test.js dist/test/sandbox/sandbox-validation.test.js dist/test/sandbox/sandbox-start.test.js dist/test/sandbox/sandbox-start-diagnostics.test.js dist/test/sandbox/sandbox-stop.test.js dist/test/sandbox/sandbox-remove.test.js`.

The new pure-hook assertions accept HTTP/HTTPS requests for unrelated arbitrary
public hostnames and a permitted public IP, deny built-in private/link-local/CGNAT/
loopback/ULA/mapped-private inputs, deny known host public IPv4/IPv6/mappedIPv4,
and deny the same public hostname when a later input becomes private. These are
policy-call proofs, **not real rebinding/redirect/DNS/connect tests**. The fixture
uses the real hook factory, doubles VM creation, forbids fetch and VMM process
spawning (the existing fake systemctl child remains), and checks the private CA directory is still empty. Existing real
SDK filesystem RPC, lifecycle/finalization, startup diagnostics, bounded output
and validation tests remain green. No full142/153 gate rerun or physical test.

## Residual risks and next gates — ticket06 remains open/partial

- Built-in vendor IP ranges do not enumerate every special/reserved range. The
  exclusion is a boot-time local-interface snapshot, not every external/public
  host alias, NAT/public endpoint, newly assigned address or Other Work endpoint.
  **No universal public-host/Other Work isolation guarantee.** Installation-owned
  destination inventory/exclusions need explicit resolution before such a claim;
  no permissive exception or manual all-public-domain allowlist was added.
- Real DNS/connect/redirect enforcement, TLS guest tools, daemon registry flows,
  CA permissions/material lifecycle and per-boot replacement trust require a
  separately authorized physical plan. Configured SDK options are not acceptance.
- Frozen Docker `bridge:none`, forwarding/iptables/masquerade/userland-proxy off
  leaves Docker-local bridge/NAT/DNS/ports/Ryuk unproved. No host networking,
  insecure TLS, Ryuk disablement or profile/asset mutation was used as a workaround.
- Container application truststores remain explicit per project/runtime via its
  supported Testcontainers/Compose/API/build configuration; guest CA injection
  alone does not configure them. Guest-only traffic does not imply public TLS.
- Preserve original06 remaining gates: normal tool-channel integration, locked
  dependencies/images/subcases, representative real Docker suite, persistence,
  isolation/cleanup and runtime evidence. Prior03 grants are spent; this partial
  grants no network, VM, credentials, Docker host, pull/install/mount or pilot work.
  No AC06 checkbox closes and no merge eligibility is claimed.
