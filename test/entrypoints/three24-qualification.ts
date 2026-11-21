import { createHash } from 'node:crypto';
import type { ExecutionPorts, ExecutionView, WorkView } from '../../src/control/index.js';
import { readBounded, sessionCommands, snapshotStorage } from './publication14-qualification.js';
import { keySource, requireKeySource } from './humanchanges21-qualification.js';
import { containerWindows, sampleBoot, sampleHost, summarize, type BootSample, type HostSample } from './three24-measure.js';

// TEST ONLY. Ticket 24 one-shot real qualification recipe: THREE real Builders run at once (capacity 3, all three Works in the SAME repository),
// each in its own branch/checkout/workspace/disk/VM, each running a Docker gate whose container name, published port and named volume are
// IDENTICAL in the three Tickets (a shared daemon/host would collide), with the Standards/Spec reviewers inside each Execution's own Slot.
// RAM/CPU/I/O of each Work's own unit (adapter + VMM + workers/reviewers) and of the host, plus the host-side guest storage, are sampled.
// Import and `--plan` are inert. Every other phase is a REAL effect and needs an explicit operator grant: real GitHub (App, read-only
// grants: no push, no PR), three real Gondolin/KVM VMs and the real model (3 Builders + their reviewers). Phases are one-shot: an exclusive
// intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically; every phase stops ALL boots it can
// see in its `finally` and records their cessation.

const root = '/home/sanmoo/software-factory-test/y5';
// v2: v1 (issues #21-#23) was consumed HELD — #23 asked because `./mvnw` does not exist (the repository is Gradle-based); see the evidence.
// v4: v3 (issues #44-#46) was consumed HELD — see the evidence: #46 the wrapper's 10 s download timeout, #45 a misattributed
// `git config` exit, #44 two repository ITs failing. v2 (#39-#41): the guest has no Java. v1 (#21-#23): no ./mvnw.
const observations = `${root}/q24-three-v4`;
const revision = 'q24-three-v4';
const phases = ['preflight', 'run', 'inspect', 'stop-environment'] as const;
type Phase = (typeof phases)[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const repositoryId = 1256893534;
/**
 * The THREE new synthetic issues the supervisor creates after the operator's authorization (title/body below, label `ready-for-agent`, no
 * other open issue with that label, no associated PR). Numbers MUST be pinned in a reviewed commit before preflight: any 0 refuses every phase.
 * All three in the same repository (the spec requires at least two in one repository; a second repository is NOT needed for this recipe —
 * "different repositories proceed in parallel" stays covered at host-checkout level; see the evidence).
 */
export const tickets = [
  { key: 'A', number: 0, title: 'Factory qualification q24: three simultaneous Builders (A)' },
  { key: 'B', number: 0, title: 'Factory qualification q24: three simultaneous Builders (B)' },
  { key: 'C', number: 0, title: 'Factory qualification q24: three simultaneous Builders (C)' },
] as const;
type Key = (typeof tickets)[number]['key'];
const pinned = (list: readonly { number: number }[] = tickets) =>
  list.length === 3 && list.every(item => Number.isSafeInteger(item.number) && item.number > 0) && new Set(list.map(item => item.number)).size === 3;
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
/**
 * Smallest faithful guest for 3 simultaneous VMs on this host (8 CPUs, ~15.7 GiB RAM): 2 GiB / 2 vCPU each (6 GiB guest memory, 6 vCPU in
 * total) instead of the 4 GiB of the single-VM recipes (3 x 4 GiB = 12 GiB would leave no room for host, adapters, workers and reviewers).
 * Disk stays 40 GiB virtual (qcow2, allocated on demand; each boot still requires 40 + 4 GiB free). The free-memory floor is explicit.
 */
const configuration = {
  schemaVersion: 1,
  profile: 'gondolin-qemu-alpine-dev-v1',
  memoryMiB: 2048,
  vcpus: 2,
  diskGiB: 40,
  shutdownGraceSeconds: 30,
  minFreeSpaceGiB: 4,
  minFreeMemoryMiB: 1024,
} as const;
const capacity = 3;
const guestAssets = {
  directory: '/home/sanmoo/software-factory-test/assets34/assets',
  manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807',
} as const;
/** Host preconditions checked by preflight BEFORE any VM (observations, not reservations). */
export const hostRequirements = {
  minMemAvailableMiB: capacity * configuration.memoryMiB + 3 * 1024,
  minStorageGiB: capacity * (configuration.diskGiB + configuration.minFreeSpaceGiB),
  minCpus: capacity * configuration.vcpus,
  note: 'guest memory + ~1 GiB per Work for adapter/workers/reviewers; each boot re-checks memory and disk itself',
} as const;
const runDeadlineMs = 100 * 60 * 1000;
/** All three Builders must have started within this window (checkouts, three boots, activation). */
const startWindowMs = 25 * 60 * 1000;
/** Bound on the controller's own stop after the run (then every recorded boot is stopped anyway). */
const controlStopMs = 5 * 60 * 1000;
const sampleEveryMs = 15_000;
const storageEveryMs = 60_000;
const pollingSeconds = 60;
const rounds = { max: 2 } as const;
const maxGuardRefusals = 6;
const sdkProfileId = 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const;
const model = { auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const prompts = {
  builder:
    'You are the Software Factory Builder. Follow the Factory skill pack exactly. Work only in /workspace/checkout and /artifacts. Never push, open pull ' +
    'requests, change GitHub state, request broader access or use another credential. Report blockers instead of working around them. Run the documented ' +
    'validation command exactly as written (do not rename containers, ports or volumes, do not skip Docker) and report its real result.',
  standards:
    'You are the Software Factory Standards reviewer. You only read; you never change anything. Judge against the preserved instructions, keep ' +
    'documented rules distinct from heuristics. Your final message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
  spec:
    'You are the Software Factory Spec reviewer. You only read; you never change anything. Judge against the preserved request only. Your final ' +
    'message is ONLY the JSON verdict object you are asked for, with no prose before or after.',
};
const reviewer = { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5 * 1024 * 1024 };
const skillPack = 'factory-skills-v6' as const;

/**
 * Docker gate of one Ticket: the SAME container name, published guest port and named volume in all three Tickets; the volume carries the
 * Ticket's own key, so reading another Work's value (a shared daemon/volume) fails. The container is held ~60 s so the three windows overlap;
 * the Builder prints its window. Only own resources are removed (`rm -f` of its own name, its own volume); never prune or global cleanup.
 */
export const gateCommand = (key: Key) =>
  [
    'cd /workspace/checkout',
    `test -f docs/FACTORY_Q24_${key}.md`,
    'test "$(docker info --format \'{{.Driver}}\')" = vfs',
    'docker volume create q24-shared >/dev/null',
    `docker run -d --name q24-fixed -p 18080:8080 -v q24-shared:/data node:22-alpine node -e 'const fs=require("fs");fs.writeFileSync("/data/who","${key}");` +
      `require("http").createServer((q,s)=>s.end(fs.readFileSync("/data/who","utf8"))).listen(8080)' >/dev/null`,
    `echo "Q24_WINDOW_START ${key} $(date +%s)"`,
    'for i in $(seq 1 60); do wget -qO- http://127.0.0.1:18080/ >/dev/null 2>&1 && break; sleep 1; done',
    'sleep 60',
    `test "$(wget -qO- http://127.0.0.1:18080/)" = ${key}`,
    `test "$(docker run --rm -v q24-shared:/data node:22-alpine cat /data/who)" = ${key}`,
    `echo "Q24_WINDOW_END ${key} $(date +%s)"`,
  ].join(' && ') + '; status=$?; docker rm -f q24-fixed >/dev/null 2>&1; docker volume rm q24-shared >/dev/null 2>&1; exit $status';
/**
 * The repository's REAL suite (supervisor decisions 3/v3), run so the guest profile can execute it. The README documents `./gradlew test`
 * with JDK 25 and Docker for Testcontainers; gondolin-qemu-alpine-dev-v1 has NO Java (v2: exit 1, JAVA_HOME unset), so the wrapper runs
 * inside a pinned JDK 25 image of the guest's OWN Docker: `--network host` (the guest's mediated egress and its published container
 * ports), the guest daemon socket (Testcontainers + Ryuk, never the host socket), the per-boot Gondolin CA added to the JDK truststore
 * (`USE_SYSTEM_CA_CERTS`: layered TLS, never a bypass) and a named volume for the Gradle home. Image reachability and duration are proved
 * by the run itself (not checked offline): a pull or time-out is a recorded finding, never retried.
 */
const gradleDistribution = 'https://services.gradle.org/distributions/gradle-9.5.1-bin.zip';
/** Gradle wrapper layout (PathAssembler): `wrapper/dists/<name>/<base-36 of the unsigned MD5 of the distribution URL>`. */
export function wrapperDistDirectory(url: string): string {
  const name = url.slice(url.lastIndexOf('/') + 1).replace(/\.zip$/, '');
  return `wrapper/dists/${name}/${BigInt(`0x${createHash('md5').update(url).digest('hex')}`).toString(36)}`;
}
/**
 * v4: the guest pre-provisions the wrapper's distribution ONCE with a long single-attempt download (busybox wget, the guest's mediated
 * HTTPS) and verifies it against the published SHA-256 before the README command runs; the wrapper then finds the zip and never meets its
 * own 10 s `networkTimeout` (v3 #46). The Gradle home is a guest directory bound into the container. No retry anywhere.
 */
export const suiteCommand: string | null = (() => {
  const dist = `/var/cache/q24-gradle/${wrapperDistDirectory(gradleDistribution)}`;
  const zip = 'gradle-9.5.1-bin.zip';
  return (
    `mkdir -p ${dist} && cd ${dist} && { test -f ${zip} || { wget -T 600 -O ${zip}.part ${gradleDistribution} && wget -T 60 -O ${zip}.sha256 ${gradleDistribution}.sha256 && ` +
    `echo "$(cat ${zip}.sha256)  ${zip}.part" | sha256sum -c - && mv ${zip}.part ${zip}; }; } && ` +
    'cd /workspace/checkout && docker run --rm --network host -e USE_SYSTEM_CA_CERTS=1 ' +
    '-v /etc/gondolin/mitm/ca.crt:/certificates/gondolin-mitm.crt:ro -v /run/docker.sock:/var/run/docker.sock -v /var/cache/q24-gradle:/root/.gradle ' +
    '-v "$PWD":/w -w /w eclipse-temurin:25-jdk ./gradlew --no-daemon test'
  );
})();
const jvmTools = new Set(['./gradlew', 'gradlew', 'gradle', 'java', 'javac', 'mvn', './mvnw', 'mvnw']);
/**
 * Pure: a gate the guest profile can execute. JVM/build tools are never run directly in the guest (it has no Java); they may only be the
 * command of a `docker run` whose image is pinned to an explicit version tag or digest (never untagged or `latest`).
 */
export function profileGateViolations(command: string): string[] {
  const violations: string[] = [];
  for (const segment of command
    .split(/&&|;|\|\|/)
    .map(item => item.trim())
    .filter(Boolean)) {
    const words = segment.split(/\s+/);
    if (words[0] === 'docker' && words[1] === 'run') {
      let index = 2;
      while (index < words.length && words[index]!.startsWith('-')) index += ['-v', '-e', '-w', '--network', '--name', '-p'].includes(words[index]!) ? 2 : 1;
      const image = words[index] ?? '';
      if (!/(:[0-9][\w.-]*|@sha256:[0-9a-f]{64})$/.test(image) || /:latest$/.test(image)) violations.push(`IMAGE_NOT_PINNED:${image}`);
      continue;
    }
    if (jvmTools.has(words[0]!)) violations.push(`JVM_TOOL_OUTSIDE_CONTAINER:${words[0]}`);
  }
  return violations;
}
/** Proposed body of each NEW issue (documentation only, plus the collision fixture and the repository's real suite). */
export const ticketBody = (key: Key) =>
  [
    `Add a short documentation page \`docs/FACTORY_Q24_${key}.md\`. This exact upper-case file name was decided by the operator.`,
    '',
    'Required content:',
    `1. A \`# Factory q24 ${key}\` title and one paragraph explaining that this file exists only to exercise three simultaneous Software Factory Builders.`,
    '2. A `## Docker` section stating that the validation below runs a container with a fixed name, port and volume.',
    '',
    'Documentation only: the operator explicitly approves that no tests, seams or code changes are needed. Do not create or edit other files. Commit the change on your branch.',
    '',
    'Validation (documented gate; the bash tool always runs in `/workspace`, so declare cwd `/workspace` and keep the directory change inside the command; it must exit 0; ' +
      'run it exactly as written, it takes about two minutes and needs Docker in your VM):',
    `\`${gateCommand(key)}\``,
    ...(suiteCommand
      ? [
          '',
          "Then run the repository's own test suite exactly as written (real Testcontainers/Docker in your VM; never disable Ryuk, skip tests or change TLS); it must exit 0:",
          `\`${suiteCommand}\``,
        ]
      : []),
  ].join('\n');

export function plan() {
  return {
    revision,
    root,
    observations,
    phases,
    repository: { ...repository, repositoryId },
    capacity,
    tickets: tickets.map(item => ({ ...item, body: ticketBody(item.key), label: repository.label })),
    pinned: pinned(),
    suite: {
      command: suiteCommand,
      pinned: suiteCommand !== null,
      note: 'pinned (exact) by the supervisor before the issues are created; the issue bodies include it only then',
    },
    configuration,
    hostRequirements,
    guestAssets,
    skillPack,
    requires: [
      'ticket 24 integrated in the composed revision (fill-every-free-Slot dispatch, boot memory precondition)',
      `${keySource} present (copied O_EXCL into the namespace; missing = loud refusal before any effect)`,
      'the supervisor created the THREE new issues (titles/bodies above, label ready-for-agent) and pinned their numbers in a reviewed commit',
      'no other open issue carries the label',
      'no pull request associated with any of the three issues',
      'operator first-login store under root/credentials (model OAuth)',
      `host: MemAvailable >= ${hostRequirements.minMemAvailableMiB} MiB, >= ${hostRequirements.minStorageGiB} GiB free under ${root}, >= ${hostRequirements.minCpus} CPUs, /dev/kvm, systemd user manager, no other VM of the Factory running`,
    ],
    decisions: [
      'supervisor 1: Control.run() clean-stop semantics unchanged (ticket 33): an earlier Execution with unconfirmed cessation is unsettled activity that blocks upgrades separately',
      'operator 2: 3 VMs x 2048 MiB / 2 vCPU, all in the same repository; "different repositories in parallel" stays proven locally only (gap)',
      `supervisor 3: the real suite \`${suiteCommand ?? '<pinned suite command>'}\` in addition to the collision fixture; a guest OOM is a recorded finding, never a retry`,
      'supervisor 4: the boot memory precondition sums the guest limits of boots admitted earlier in the same dispatch pass',
      "the supervisor creates the three issues and pins their numbers; every human/admin step is the supervisor's",
    ],
    model: {
      provider: 'openai',
      model: 'gpt-6-luna',
      auth: 'factory-oauth',
      providerRetries: 0,
      sdkRetries: 0,
      builders: 'exactly 3 implementation activations (one per Work, builder-initial), at once',
      reviewersPerBuilder: `standards + spec, at most ${rounds.max} rounds each`,
      never: ['publication activation (dispatch is paused once the three Builders started)', 'any repair/continuation activation'],
    },
    github: {
      app: githubApp,
      accessRoot: `${observations} (own namespace: credentials/ copy of ${keySource}, run/); never y5/run`,
      writes: [
        'App: access_tokens issuance POSTs and DELETE /installation/token revocations only',
        'controller: none (read-only purposes)',
        'Builder: none (builder-start: metadata/contents/issues read; never builder-publish)',
      ],
    },
    effects: [
      'preflight: key source check and host preconditions (memory/disk/CPU, /dev/kvm, systemd user manager, NO active factory-sandbox unit or qemu process — refused ' +
        'with their names) BEFORE anything is consumed; then EXCLUSIVE namespace mkdir, intent tombstone, credentials/run dirs and the key copy; read-only GitHub: label lists exactly the three pinned ' +
        'issues (titles exact), none has an associated PR or a factory/<n>- branch; host requirements observed (meminfo, statfs, CPUs)',
      `run: host preconditions re-checked BEFORE the intent (refusal consumes nothing); new storage; capacity ${capacity}; ONE polling cycle admits the three Works and ONE dispatch pass reserves three Executions; 3 checkouts from the shared bare cache ` +
        '(fetch -> clone sequenced per repository), 3 new VMs; dispatch paused as soon as the three Builders started (no publication/repair activations); reviews inside each ' +
        `Execution; samples every ${sampleEveryMs / 1000} s (each boot's own unit cgroup + host) and the guest storage every ${storageEveryMs / 1000} s; ends when the three Executions ended ` +
        'and released their Slots after confirmed cessation (or held/deadline); finally stops every own boot still active and records cessation',
      'inspect: storage copy (Control view: Executions, branches, environments, boots, Slots, queue, history); worker session JSONL read-only (bounded): Docker windows and commands; ' +
        'Sandbox.inspectCheckout of each checkout (own branch, own origin, no shared Git metadata)',
      'stop-environment: every boot of the three Works that may still run: public Sandbox.stop of that exact boot, cessation recorded',
    ],
    guards: [
      'one-shot intent tombstones and phase order',
      'prepare once per pinned Work (3 in total)',
      'one Builder per Work (builder-initial only), reviewers only of that Execution, distinct rounds',
      `guard refusals are known pre-launch refusals (WORKER_LAUNCH_INVALID); more than ${maxGuardRefusals} stop the run`,
      'grants: builder-start for the pinned Works only; builder-publish always refused',
      'no remove/cleanup, no retry',
    ],
    expected: [
      'one dispatch pass: the three executions reserved within the first cycle (history execution-reserved before any execution-ended); slots {capacity 3, held 3} while running',
      'three distinct environments, boots, branches factory/<n>-<work8>, checkouts with origin github.com/Sanmoo/java-springboot-event-sourcing and no shared Git metadata',
      "each Builder's Docker gate exits 0 with its OWN key; the three container windows overlap (containerWindows.overlapAll)",
      `each Builder runs \`${suiteCommand ?? '<pinned suite command>'}\` with exit 0 (real Testcontainers/Ryuk in its own guest); an OOM or a failure is recorded as a finding, never retried`,
      "reviewers activated on their own Execution's boot only (maxWorkersAtOnce <= 3 per unit), never a fourth Slot",
      'no failure of one Work ends another; every Slot released only after confirmed cessation',
      'registry: per-boot peak memory, CPU seconds, I/O bytes, RSS per process class; host MemAvailable/load/pressure; guest storage allocation; configuration recorded; ' +
        'no figure is a reservation, ceiling or SLA',
    ],
  };
}

/** Phase order: each phase once, after a successful preflight; inspect/stop only after a run was attempted. Unpinned issues refuse everything. */
export function phaseGuard(
  phase: Phase,
  results: Partial<Record<Phase, { status?: unknown } | null>>,
  intents: ReadonlySet<string>,
  numbers: readonly { number: number }[] = tickets,
  suite: string | null = suiteCommand,
): string | null {
  if (!pinned(numbers)) return 'TICKETS_NOT_PINNED';
  if (!suite) return 'SUITE_COMMAND_NOT_PINNED';
  if (profileGateViolations(suite).length) return `SUITE_NOT_EXECUTABLE_IN_GUEST:${profileGateViolations(suite).join(',')}`;
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  if (phase !== 'preflight' && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  if ((phase === 'inspect' || phase === 'stop-environment') && !intents.has('run-intent')) return 'RUN_REQUIRED';
  return null;
}

export type HostFacts = {
  memAvailableBytes: number | null;
  storageAvailableBytes: number | null;
  cpus: number;
  kvm: boolean;
  /** systemd user manager SystemState (`running`/`degraded` usable); null = not reachable. */ systemdUser: string | null;
  /** Active `factory-sandbox-*` units (names); null = unknown. */ activeUnits: string[] | null;
  /** Live qemu-system processes of any user; null = unknown. */ qemuProcesses: number | null;
};
/** Host preconditions (observations), checked BEFORE the phase consumes anything: unknown is never enough; active units are named. */
export function hostPrecondition(host: HostFacts) {
  const reasons: string[] = [];
  if (host.memAvailableBytes === null || host.memAvailableBytes < hostRequirements.minMemAvailableMiB * 1048576) reasons.push('HOST_MEMORY_BELOW_REQUIREMENT');
  if (host.storageAvailableBytes === null || host.storageAvailableBytes < hostRequirements.minStorageGiB * 1073741824)
    reasons.push('HOST_STORAGE_BELOW_REQUIREMENT');
  if (host.cpus < hostRequirements.minCpus) reasons.push('HOST_CPUS_BELOW_REQUIREMENT');
  if (!host.kvm) reasons.push('KVM_UNAVAILABLE');
  if (host.systemdUser !== 'running' && host.systemdUser !== 'degraded') reasons.push(`SYSTEMD_USER_MANAGER_UNAVAILABLE:${host.systemdUser ?? 'unreachable'}`);
  if (host.activeUnits === null) reasons.push('FACTORY_UNITS_UNKNOWN');
  else if (host.activeUnits.length) reasons.push(`FACTORY_UNITS_ACTIVE:${host.activeUnits.slice(0, 8).join(',')}`);
  if (host.qemuProcesses === null) reasons.push('QEMU_PROCESSES_UNKNOWN');
  else if (host.qemuProcesses > 0) reasons.push(`QEMU_PROCESSES_ACTIVE:${host.qemuProcesses}`);
  return { ok: reasons.length === 0, reasons };
}

/** Activation guard: exactly one implementation Builder per pinned Work, then that Execution's reviewers in distinct rounds. */
export function activationGuard(maxRounds: number = rounds.max) {
  const builders = new Map<string, string>();
  const seen = new Map<string, Set<number>>();
  return (context: { role: string; workId: string; executionId: string; phaseId: string }, allowedWork: boolean, review?: { round: number }) => {
    if (!allowedWork) return false;
    if (context.role === 'builder') {
      if (builders.has(context.workId) || builders.size >= capacity || context.phaseId !== 'builder-initial') return false;
      builders.set(context.workId, context.executionId);
      return true;
    }
    if (!['standards', 'spec'].includes(context.role) || builders.get(context.workId) !== context.executionId || !review) return false;
    const key = `${context.executionId}/${context.role}`;
    const used = seen.get(key) ?? new Set<number>();
    if (used.has(review.round) || used.size >= maxRounds) return false;
    used.add(review.round);
    seen.set(key, used);
    return true;
  };
}

/** The run's end: every pinned Work's Execution left its activity (ended with its Slot released, or held/released), or nothing can change. */
export function runSettled(works: readonly Pick<WorkView, 'ticket' | 'execution'>[], numbers: readonly number[] = tickets.map(item => item.number)) {
  const mine = numbers.map(number => works.find(work => work.ticket.number === number));
  const done = (execution: ExecutionView | null | undefined) =>
    Boolean(execution && (execution.state === 'held' || execution.state === 'released' || (execution.state === 'ended' && !execution.slot.held)));
  const allDone = mine.every(work => done(work?.execution));
  const success =
    allDone &&
    mine.every(work => work!.execution!.state === 'ended' && work!.execution!.end?.outcome === 'completed' && work!.execution!.end.cessation === 'confirmed');
  // A Builder Question is legitimate model behaviour (the Slot is freed after cessation); this recipe records it as a finding and holds, never retries.
  const findings = mine.flatMap((work, index) => (work?.execution?.end?.outcome === 'question' ? [`QUESTION_ASKED:${numbers[index]}`] : []));
  return { done: allDone, success, findings };
}
/**
 * A Work that can no longer start in this run (its Execution left without a start receipt, or nothing started within the window): the run
 * stops with that reason instead of letting the queue re-dispatch around it.
 */
export function neverStarted(
  works: readonly Pick<WorkView, 'ticket' | 'execution'>[],
  elapsedMs: number,
  windowMs = startWindowMs,
  numbers: readonly number[] = tickets.map(item => item.number),
): string | null {
  for (const number of numbers) {
    const execution = works.find(work => work.ticket.number === number)?.execution;
    if (execution && execution.start == null && ['held', 'ended', 'released'].includes(execution.state))
      return `WORK_NEVER_STARTED:${number}:${execution.held?.code ?? execution.end?.code ?? execution.state}`;
  }
  if (elapsedMs > windowMs) {
    const missing = numbers.filter(number => works.find(work => work.ticket.number === number)?.execution?.start == null);
    if (missing.length) return `WORK_NEVER_STARTED:${missing.join('+')}:START_WINDOW_ELAPSED`;
  }
  return null;
}
/** All three started (the moment dispatch is paused): never before, so the first pass is the one observed. */
export const threeStarted = (works: readonly Pick<WorkView, 'ticket' | 'execution'>[], numbers: readonly number[] = tickets.map(item => item.number)) =>
  numbers.every(number => works.find(work => work.ticket.number === number)?.execution?.start != null);

/** Pure verdict over the stored Control view (inspect). */
export function verdict(
  works: readonly WorkView[],
  windows: ReturnType<typeof containerWindows>,
  evidence: { passes: Record<string, string | null>; summary: readonly { boot: string; samples: number }[] },
  numbers: readonly number[] = tickets.map(item => item.number),
) {
  const mine = numbers.map(number => works.find(work => work.ticket.number === number));
  const executions = mine.map(work => work?.execution ?? null);
  const checks: { name: string; ok: boolean; observed: string }[] = [];
  const check = (name: string, ok: boolean, observed: string) => checks.push({ name, ok, observed });
  const distinct = (pick: (execution: ExecutionView) => string | null | undefined) =>
    new Set(executions.map(execution => (execution ? (pick(execution) ?? null) : null)).filter(Boolean)).size === 3;
  check('three-executions', executions.every(Boolean), executions.map(item => item?.state ?? 'none').join(','));
  check(
    'own-environment-boot-branch',
    distinct(item => item.dispatch.environment) && distinct(item => item.dispatch.boot) && distinct(item => item.request.branch),
    executions.map(item => `${item?.request.branch ?? '?'}@${item?.dispatch.boot ?? '?'}`).join(' '),
  );
  const reservedAt = executions.map(item => (item ? Date.parse(item.slot.reservedAt) : NaN));
  const firstEnd = Math.min(...executions.map(item => (item?.end ? Date.parse(item.end.at) : Infinity)));
  // OBSERVED, not inferred: the dispatch pass identity each boot's Sandbox.start received (logged by the recipe), keyed by environment.
  const passes = executions.map(item => (item?.dispatch.environment ? (evidence.passes[item.dispatch.environment] ?? null) : null));
  check(
    'one-pass-reservation',
    passes.every(Boolean) && new Set(passes).size === 1 && reservedAt.every(Number.isFinite) && Math.max(...reservedAt) < firstEnd,
    `passes ${passes.map(item => item?.slice(0, 8) ?? 'none').join(',')}; spread ${Math.max(...reservedAt) - Math.min(...reservedAt)} ms`,
  );
  const measured = executions.map(item => evidence.summary.find(entry => entry.boot === item?.dispatch.boot)?.samples ?? 0);
  check(
    'resources-measured',
    measured.every(count => count > 0),
    measured.join(','),
  );
  check(
    'completed-with-cessation',
    executions.every(item => item?.state === 'ended' && item.end?.outcome === 'completed' && item.end.cessation === 'confirmed' && !item.slot.held),
    executions.map(item => `${item?.end?.outcome ?? '?'}:${item?.end?.cessation ?? '?'}`).join(','),
  );
  check('containers-overlapped', windows.overlapAll, JSON.stringify(windows.windows));
  return { passed: checks.every(item => item.ok), checks };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  };
  const exists = (name: string) =>
    fs.access(`${observations}/${name}.json`).then(
      () => true,
      () => false,
    );
  const load = (name: string) =>
    fs.readFile(`${observations}/${name}.json`, 'utf8').then(
      text => JSON.parse(text) as { status?: unknown } & Record<string, unknown>,
      () => null,
    );
  return { fs, save, exists, load };
}

async function compose() {
  const { createGitHubAccess, createBuilderCredentials, createRepositoryFetchCredentials } = await import('../../src/platform/github/index.js');
  const { createIssueTracker } = await import('../../src/issue-tracker/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  const github = createGitHubAccess({ root: observations, ...githubApp });
  const tracker = createIssueTracker({ github, scopes: [repository], dependencyScopes: [] });
  return { github, tracker, codeRepository: createCodeRepository({ github }), createBuilderCredentials, createRepositoryFetchCredentials };
}
const numbers = () => tickets.map(item => item.number) as number[];
const worksOf = (list: unknown): WorkView[] => ((list as { kind?: string; works?: WorkView[] }).kind === 'list' ? (list as { works: WorkView[] }).works : []);

type BootTarget = { environment: string; boot: string; ticket: number | null; executionId: string | null; needsStop: boolean };
/** Boots of the pinned Works as the stored view records them. */
async function bootsOf(works: readonly WorkView[]): Promise<BootTarget[]> {
  const { needsStop } = await import('./builder09-qualification.js');
  return works
    .filter(item => numbers().includes(item.ticket.number))
    .flatMap(work =>
      [...work.previousExecutions, ...(work.execution ? [work.execution] : [])].flatMap(execution =>
        execution.dispatch.environment && execution.dispatch.boot
          ? [
              {
                environment: execution.dispatch.environment,
                boot: execution.dispatch.boot,
                ticket: work.ticket.number,
                executionId: execution.executionId,
                needsStop: needsStop(execution),
              },
            ]
          : [],
      ),
    );
}
/** Pure: boots the recipe itself saw started (its own start log), the fallback when the Control view cannot be read. */
export function startedBoots(events: readonly unknown[]): BootTarget[] {
  const seen = new Map<string, BootTarget>();
  for (const event of events as { call?: string; environment?: unknown; result?: { status?: string; boot?: unknown; code?: string } }[]) {
    const boot = event.result?.boot;
    if (event.call === 'start' && typeof event.environment === 'string' && typeof boot === 'string')
      seen.set(boot, { environment: event.environment, boot, ticket: null, executionId: null, needsStop: true });
  }
  return [...seen.values()];
}
/** Every listed boot that may still run is stopped (exact boot, public Sandbox.stop); each observation, result and cessation is returned. */
async function stopAll(targets: readonly BootTarget[], reason: string) {
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const sandbox = createSandbox({ root, guestAssets });
  const records: unknown[] = [];
  for (const target of targets) {
    const environment = target.environment as never,
      boot = target.boot as never;
    const before = await sandbox.observe({ environment, boot }).catch(() => null);
    const result = before?.condition === 'active' || target.needsStop ? await sandbox.stop({ environment, boot, reason }).catch(() => null) : null;
    const after = result ? await sandbox.observe({ environment, boot }).catch(() => null) : before;
    records.push({ ...target, before: before?.condition ?? 'unobservable', result, cessationConfirmed: after?.cessationConfirmed ?? false });
  }
  return records;
}

/** Read-only host facts for the preconditions: capacity, /dev/kvm, systemd user manager, own active units, live qemu processes. */
async function observeHost(): Promise<{ facts: HostFacts; raw: unknown }> {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { execFile } = await import('node:child_process');
  const { observeHostCapacity } = await import('../../src/sandbox/index.js');
  const { listActiveSandboxUnits } = await import('../../src/platform/host/index.js');
  const host = await observeHostCapacity(root);
  const kvm = await fs.access('/dev/kvm', constants.R_OK | constants.W_OK).then(
    () => true,
    () => false,
  );
  const systemdUser = await new Promise<string | null>(resolve =>
    execFile('systemctl', ['--user', 'show', '--property=SystemState', '--value'], { timeout: 5000 }, (error, stdout) =>
      resolve(error ? null : String(stdout).trim().slice(0, 32) || null),
    ),
  );
  const units = await listActiveSandboxUnits();
  let qemu: number | null = 0;
  try {
    for (const pid of (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      const comm = await fs.readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '');
      if (/^qemu-system/.test(comm)) qemu++;
    }
  } catch {
    qemu = null;
  }
  const facts: HostFacts = {
    memAvailableBytes: host.memory ? Number(host.memory.availableBytes) : null,
    storageAvailableBytes: host.storage ? Number(host.storage.availableBytes) : null,
    cpus: host.cpus,
    kvm,
    systemdUser,
    activeUnits: units ?? null,
    qemuProcesses: qemu,
  };
  return { facts, raw: host };
}

async function runControl(save: (name: string, data: unknown) => Promise<void>) {
  const { github, tracker, codeRepository, createBuilderCredentials, createRepositoryFetchCredentials } = await compose();
  const { createSandbox } = await import('../../src/sandbox/index.js');
  const { createWorkers, builderSkillPacks } = await import('../../src/workers/index.js');
  const { openControl } = await import('../../src/control/index.js');
  const pack = builderSkillPacks[skillPack];
  const sandbox = createSandbox({
    root,
    guestAssets,
    repositoryFetch: createRepositoryFetchCredentials({ github, repositories: [repository] }),
    artifactSeeds: [{ name: pack.seedName, directory: pack.directory }],
  });
  const workers = createWorkers({
    root,
    knownSecrets: [],
    profile: { id: sdkProfileId, systemPrompt: prompts.builder, ...model },
    profiles: {
      builder: { id: sdkProfileId, systemPrompt: prompts.builder, ...model },
      standards: { id: sdkProfileId, systemPrompt: prompts.standards, ...model },
      spec: { id: sdkProfileId, systemPrompt: prompts.spec, ...model },
    },
  });
  const builderCredentials = createBuilderCredentials({ github, repositories: [repository] });
  const events: unknown[] = [];
  const log = (entry: Record<string, unknown>) => {
    events.push({ at: new Date().toISOString(), monotonicMs: Math.round(performance.now()), ...entry });
  };
  const guard = activationGuard();
  const prepared = new Set<string>();
  let refusals = 0;
  const stop = new AbortController();
  let control!: Awaited<ReturnType<typeof openControl>>;
  const pinnedWork = async (workId: string) => {
    const shown = await control.inspect({ kind: 'show', work_id: workId });
    return 'work' in shown && numbers().includes(shown.work.ticket.number) && shown.work.ticket.repositoryId === repositoryId;
  };
  const ports: ExecutionPorts = {
    configuration,
    capacity,
    builder: { skillPack, modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    reviews: { reviewer, rounds },
    credentials: {
      async issue(context) {
        const allowed = (context.purpose ?? 'builder-start') === 'builder-start' && (await pinnedWork(context.workId));
        log({ call: 'issue', workId: context.workId, purpose: context.purpose ?? 'builder-start', allowed });
        if (!allowed) throw Object.assign(new Error('RECIPE_GRANT_GUARD'), { outcome: 'known-rejected' });
        const grant = await builderCredentials.issue(context);
        log({ call: 'issued', workId: context.workId, metadata: grant.metadata });
        return grant;
      },
      async revoke(grant) {
        const result = await builderCredentials.revoke(grant);
        log({ call: 'revoked', kind: result.kind });
        return result;
      },
    },
    sandbox: {
      async prepare(input) {
        log({ call: 'prepare', workId: input.workId, checkout: input.checkout });
        if (prepared.has(input.workId) || prepared.size >= capacity || !(await pinnedWork(input.workId)))
          return { status: 'failure', code: 'RECIPE_ONE_SHOT_GUARD' };
        prepared.add(input.workId);
        const result = await sandbox.prepare(input);
        log({ call: 'prepare-result', workId: input.workId, result });
        return result;
      },
      // The dispatch pass identity is LOGGED per environment: the verdict observes one pass instead of inferring it from timestamps.
      async start(input) {
        log({ call: 'start-requested', environment: input.environment, pass: input.pass ?? null });
        const result = await sandbox.start(input);
        log({ call: 'start', environment: input.environment, pass: input.pass ?? null, result });
        return result;
      },
      async stop(input) {
        const result = await sandbox.stop(input);
        log({ call: 'stop', input, result });
        return result;
      },
      async observeProposal(input) {
        const result = await sandbox.observeProposal(input);
        log({ call: 'observe-proposal', round: input.round, result });
        return result;
      },
      async verifyPreservedSource(input) {
        return sandbox.verifyPreservedSource(input);
      },
    },
    workers: {
      async deliver(worker, directive) {
        const result = await workers.deliver(worker, directive);
        log({ call: 'deliver', kind: directive.kind, result });
        return result;
      },
      async observe(input) {
        return workers.observe(input);
      },
      async activate(invocation, delivery, activationEvents) {
        log({ call: 'activate', context: invocation.context, review: invocation.review ?? null, promptHead: invocation.prompt.split('\n')[0]!.slice(0, 160) });
        // A guard refusal is a KNOWN pre-launch refusal (never started, reservation released); bounded, never retried.
        if (!guard(invocation.context, await pinnedWork(invocation.context.workId), invocation.review)) {
          if (++refusals > maxGuardRefusals) stop.abort();
          throw new Error('WORKER_LAUNCH_INVALID');
        }
        const handle = await workers.activate(invocation, delivery, activationEvents);
        const role = invocation.context.role;
        void handle.completed.then(
          done =>
            log({ call: 'completed', role, workId: invocation.context.workId, status: done.status, ...(done.status === 'failure' ? { code: done.code } : {}) }),
          () => log({ call: 'completion-uncertain', role, workId: invocation.context.workId }),
        );
        return handle;
      },
    },
  };
  control = await openControl({
    storagePath: `${observations}/control.sqlite`,
    runtimeInventory: 'empty',
    access: { tracker, repository: codeRepository, repositories: [repository], dependencyRepositories: [] },
    polling: { intervalSeconds: pollingSeconds },
    execution: ports,
  });
  const running = control.run(stop.signal);
  const samples: BootSample[] = [];
  const hosts: HostSample[] = [];
  const storage: unknown[] = [];
  const slots: unknown[] = [];
  const deadline = Date.now() + runDeadlineMs;
  let paused = false;
  let lastStorage = 0;
  let outcome: ReturnType<typeof runSettled> = { done: false, success: false, findings: [] };
  let stopReason: string | null = null;
  const startedMs = Date.now();
  try {
    while (Date.now() < deadline && !stop.signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, sampleEveryMs));
      const list = await control.inspect({ kind: 'list' });
      const works = worksOf(list);
      slots.push({
        at: new Date().toISOString(),
        slots: (list as { slots?: unknown }).slots ?? null,
        queues: (list as { queues?: unknown }).queues ?? null,
        states: works.map(work => ({ ticket: work.ticket.number, state: work.execution?.state ?? null, phase: work.execution?.dispatch.phase ?? null })),
      });
      hosts.push(await sampleHost());
      const active = works.filter(work => numbers().includes(work.ticket.number) && work.execution?.dispatch.boot && work.execution.state !== 'released');
      for (const work of active) samples.push(await sampleBoot({ boot: work.execution!.dispatch.boot! }));
      if (Date.now() - lastStorage >= storageEveryMs) {
        lastStorage = Date.now();
        for (const work of active)
          storage.push({
            at: new Date().toISOString(),
            ticket: work.ticket.number,
            observation: await sandbox.observe({ environment: work.execution!.dispatch.environment as never }).catch(() => null),
          });
      }
      // No publication/repair activation in this recipe: new dispatch is paused once the three Builders are started (activities continue).
      if (!paused && threeStarted(works)) {
        paused = true;
        log({ call: 'pause', receipt: await control.accept({ request_id: `${revision}-pause`, operation: 'pause', origin: 'local-cli' }) });
      }
      if (!paused && (stopReason = neverStarted(works, Date.now() - startedMs))) break;
      outcome = runSettled(works);
      if (outcome.done) break;
    }
  } finally {
    const final = await control.inspect({ kind: 'list' }).catch(() => null);
    const status = await control.inspect({ kind: 'status' }).catch(() => null);
    stop.abort();
    // Bounded: a controller that does not stop in time never keeps the boots alive; they are stopped below anyway.
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      running.catch(() => ({ kind: 'failed' })),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ kind: 'stop-timeout', afterMs: controlStopMs }), controlStopMs);
      }),
    ]).finally(() => clearTimeout(timer));
    // The stored view names the boots; when it could not be read, the recipe's own start log does (never "nothing to stop").
    const fromView = final ? await bootsOf(worksOf(final)).catch(() => []) : [];
    const targets = [...fromView, ...startedBoots(events).filter(item => !fromView.some(known => known.boot === item.boot))];
    const cessation = await stopAll(targets, 'q24 run finally: stop of own boot').catch(error => [{ failed: String(error).slice(0, 128) }]);
    await save('run-cessation', { at: new Date().toISOString(), viewReadable: final !== null, cessation });
    const passes = Object.fromEntries(
      (events as { call?: string; environment?: string; pass?: string | null }[])
        .filter(item => item.call === 'start-requested' && item.environment)
        .map(item => [item.environment!, item.pass ?? null]),
    );
    await save('run-result', {
      status: outcome.success && !stopReason ? 'success' : 'held',
      stopReason,
      findings: outcome.findings,
      outcome: result,
      final,
      controlStatus: status,
      events,
      passes,
      deadlineReached: Date.now() >= deadline,
      registry: {
        configuration,
        capacity,
        hostRequirements,
        summary: summarize(samples),
        samples,
        hosts,
        storage,
        slots,
        note: 'Measured values of THIS run on THIS host; guest limits are virtual (not reservations); no ceiling or SLA is derived.',
      },
    });
  }
  if (stopReason) throw new Error(stopReason);
  if (outcome.findings.length) throw new Error(outcome.findings.join(';'));
  if (!outcome.success) throw new Error('PHASE_NOT_AS_EXPECTED');
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  if (!pinned()) throw new Error('TICKETS_NOT_PINNED');
  if (!suiteCommand) throw new Error('SUITE_COMMAND_NOT_PINNED');
  if (profileGateViolations(suiteCommand).length) throw new Error('SUITE_NOT_EXECUTABLE_IN_GUEST');
  const { fs, save, exists, load } = await io();
  const results: Partial<Record<Phase, { status?: unknown } | null>> = {};
  for (const item of phases) results[item] = await load(`${item}-result`);
  const intents = new Set(
    (await Promise.all(phases.map(async item => ((await exists(`${item}-intent`)) ? `${item}-intent` : null)))).filter((item): item is string => item !== null),
  );
  const refused = phaseGuard(phase, results, intents);
  if (refused) throw new Error(refused);
  // Host preconditions BEFORE anything is consumed (no namespace, no intent): a transient low reading or a running VM refuses, loudly, with names.
  let host: Awaited<ReturnType<typeof observeHost>> | null = null;
  if (phase === 'preflight' || phase === 'run') {
    if (phase === 'preflight') await requireKeySource(path => fs.access(path));
    host = await observeHost();
    const precondition = hostPrecondition(host.facts);
    if (!precondition.ok) throw new Error(`HOST_PRECONDITION:${precondition.reasons.join(';')}`.slice(0, 512));
  }
  if (phase === 'preflight') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  // The intent tombstone precedes every effect of the phase, including the credentials directory and the key copy.
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const { constants } = await import('node:fs');
      await fs.mkdir(`${observations}/credentials`, { mode: 0o700 });
      await fs.mkdir(`${observations}/run`, { mode: 0o700 });
      await fs.copyFile(keySource, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
      await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
      const { github, tracker, codeRepository } = await compose();
      const listing = await tracker.listCandidates(repository);
      const listed = listing.kind === 'observed' ? listing.candidates.map(item => item.number).sort((a, b) => a - b) : [];
      if (
        listing.kind !== 'observed' ||
        listing.repositoryId !== repositoryId ||
        JSON.stringify(listed) !== JSON.stringify([...numbers()].sort((a, b) => a - b))
      ) {
        await save('preflight-held', { listing });
        throw new Error('PRECONDITION_HELD');
      }
      const titles: Record<number, unknown> = {};
      for (const item of tickets) {
        const raw = await github.read(repository, 'tracker-read', session => session.get(`/repos/${repository.repository}/issues/${item.number}`));
        titles[item.number] = raw.ok && raw.value && typeof raw.value === 'object' ? (raw.value as { title?: unknown }).title : undefined;
      }
      const publication = await codeRepository.findPublication({ repo: repository, issueNumbers: numbers(), knownBranches: [], refs: true });
      const refs = publication.kind === 'observed' && publication.refs?.state === 'complete' ? publication.refs.refs : null;
      const associated = numbers().map(number => (publication.kind === 'observed' ? publication.issues[String(number)] : undefined));
      const factoryBranches = refs ? Object.keys(refs).filter(ref => numbers().some(number => ref.startsWith(`refs/heads/factory/${number}-`))) : null;
      if (
        tickets.some(item => titles[item.number] !== item.title) ||
        !refs ||
        factoryBranches?.length ||
        associated.some(item => item?.completeness !== 'complete' || item.candidates.length)
      ) {
        await save('preflight-held', { titles, publication, factoryBranches });
        throw new Error('PRECONDITION_HELD');
      }
      await save('preflight-result', {
        status: 'success',
        host,
        listed,
        titles,
        base: refs[`refs/heads/${repository.base}`] ?? null,
        associatedPullRequests: 0,
      });
      return;
    }
    if (phase === 'run') {
      await save('run-host', { at: new Date().toISOString(), host });
      await runControl(save);
      return;
    }
    // inspect / stop-environment: a private COPY of the storage (the original is never written).
    const { openControl } = await import('../../src/control/index.js');
    const copy = await snapshotStorage(observations, `${observations}/${phase}-storage-copy`);
    const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
    const list = await stored.inspect({ kind: 'list' });
    const halted = new AbortController();
    halted.abort();
    await stored.run(halted.signal);
    const works = worksOf(list).filter(work => numbers().includes(work.ticket.number));
    if (phase === 'stop-environment') {
      const runEvents = ((await load('run-result')) as { events?: unknown[] } | null)?.events ?? [];
      const fromView = await bootsOf(works);
      await save('stop-environment-result', {
        cessation: await stopAll(
          [...fromView, ...startedBoots(runEvents).filter(item => !fromView.some(known => known.boot === item.boot))],
          'q24 explicit stop of own boot',
        ),
      });
      return;
    }
    const { workerRuntimeDirectory } = await import('../../src/platform/host/index.js');
    const { inspectEnvironment } = await import('./builder09-qualification.js');
    const texts: Record<string, string> = {};
    const sessions: Record<string, unknown>[] = [];
    const checkouts: Record<string, unknown> = {};
    for (const work of works) {
      const key = tickets.find(item => item.number === work.ticket.number)!.key;
      texts[key] = '';
      const execution = work.execution;
      if (!execution?.dispatch.boot || !execution.dispatch.environment) continue;
      // Read-only, Factory-owned bare copy of the checkout (no host git in the guest-written tree), with its own private scratch.
      const scratch = `${observations}/inspect-scratch-${key}`;
      await fs.mkdir(scratch, { mode: 0o700 });
      checkouts[key] = await inspectEnvironment(`${root}/environments/${execution.dispatch.environment}`, scratch, repository.base).catch((error: unknown) => ({
        failed: String(error).slice(0, 128),
      }));
      const runtime = workerRuntimeDirectory(root, execution.dispatch.boot);
      for (const launch of (await fs.readdir(runtime).catch(() => []))
        .filter(name => name.startsWith('w-'))
        .sort()
        .slice(0, 16)) {
        const directory = `${runtime}/${launch}/profile/sessions`;
        for (const file of (await fs.readdir(directory, { recursive: true }).catch(() => [])).filter(name => String(name).endsWith('.jsonl')).slice(0, 4)) {
          const read = await readBounded(`${directory}/${file}`, 8 * 1024 * 1024);
          if (!('text' in read)) {
            sessions.push({ key, launch, file: String(file), ...read });
            continue;
          }
          texts[key] += read.text;
          sessions.push({
            key,
            launch,
            file: String(file),
            calls: sessionCommands(read.text).filter(call => call.name === 'bash'),
            tokenPattern: /gh[pousr]_[A-Za-z0-9_]{20,}|PRIVATE KEY/.test(read.text),
          });
        }
      }
    }
    const windows = containerWindows(texts);
    const run = (await load('run-result')) as { passes?: Record<string, string | null>; registry?: { summary?: { boot: string; samples: number }[] } } | null;
    await save('inspect-result', {
      verdict: verdict(works, windows, { passes: run?.passes ?? {}, summary: run?.registry?.summary ?? [] }),
      windows,
      works: works.map(work => ({
        ticket: work.ticket.number,
        work_id: work.work_id,
        branch: work.branch,
        queue: work.queue,
        impediments: work.impediments,
        execution: work.execution,
        history: work.history.filter(item => item.origin === 'controller-dispatch'),
      })),
      checkouts,
      sessions,
      slots: (list as { slots?: unknown }).slots ?? null,
    });
  } catch (error) {
    await save(`${phase}-held`, {
      phase,
      status: 'held',
      code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN',
      note: 'Consumed; no retry.',
    }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  } finally {
    // The namespace's key copy is removed when the last GitHub phase ends (run; inspect makes no GitHub call) or when preflight was held.
    if (phase === 'run' || (phase === 'preflight' && !(await exists('preflight-result'))))
      await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true }).catch(() => {});
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') {
    console.log(JSON.stringify(plan(), null, 2));
    return;
  }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        message.startsWith('APP_KEY_SOURCE_MISSING') ||
          message.startsWith('HOST_PRECONDITION:') ||
          message === 'TICKETS_NOT_PINNED' ||
          message === 'SUITE_COMMAND_NOT_PINNED'
          ? message
          : `Qualification held; no retry. (${message.slice(0, 128)})`,
      );
      process.exit(1);
    },
  );
}
