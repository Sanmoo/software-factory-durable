// TEST ONLY. Ticket 33 one-shot real upgrade verification recipe. Import and `--plan` are inert. Every other phase is a REAL local effect that
// the supervisor runs explicitly, in order, once. v1 = the ALREADY BUILT ticket-32 release archive (r32-v2, read only: storage format 1, no
// upgrade tool); v2 = a release built from this CLEAN, freshly compiled checkout with the real pinned guest assets (assets34, read only).
// v1 is installed into a NEW canonical root and its own released Control writes a storage with a pending Question (doubled execution/GitHub:
// no VM, worker, model or network); v2 is extracted NEXT TO v1, then the real v2 CLI checks/refuses/applies the upgrade under the
// canonical-storage flock; the migration is interrupted twice by real SIGKILLs of the v2 upgrade code, the v1 launcher is refused on the
// migrated storage, rollback is refused, resume completes, and v2 starts paused, answers the Question over the real local protocol and stops
// cleanly. Bounds: no network, GitHub, credential, model, VM/QEMU boot, systemd unit, sudo or package installation; nothing outside `base` is written
// (phase tombstones `<base>/intent-<phase>.json`). Configuration authorizes NO repository (no polling target, no token).
// Phases are one-shot: an exclusive intent tombstone precedes each effect; a consumed phase never reruns; nothing is retried or repaired.

const revision = 'r33-v1';
const base = `/home/sanmoo/software-factory-test/${revision}`;
const observations = `${base}/observations`;
const output = `${base}/build`;
const root = `${base}/root`;
const v1 = { release: 'mvp-32.1', build: '/home/sanmoo/software-factory-test/r32-v2/build', archive: 'software-factory-mvp-32.1.tar' } as const;
const v2 = { release: 'mvp-33.1' } as const;
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets34/assets',
  manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const migration = 'factory-storage-1-to-2';
const questionId = '0b9c6a52-3d3e-4c8f-9a51-000000000033';
const phases = ['build', 'install-v1', 'seed-v1', 'extract-v2', 'check-and-refusals', 'interrupted-migration', 'start-v2'] as const;
type Phase = typeof phases[number];
const previous: Record<Phase, Phase | null> = { build: null, 'install-v1': 'build', 'seed-v1': 'install-v1', 'extract-v2': 'seed-v1',
  'check-and-refusals': 'extract-v2', 'interrupted-migration': 'check-and-refusals', 'start-v2': 'interrupted-migration' };
/** One-shot tombstone INSIDE the base (no sibling file): the base itself is created exclusively first, so a consumed build never reruns. */
export function tombstonePath(phase: Phase) { return `${base}/intent-${phase}.json`; }
const configuration = `schemaVersion: 1
operators: [operador]
models:
  builder: { provider: openai, model: gpt-6-luna }
  standards: { provider: openai, model: gpt-6-luna }
  spec: { provider: openai, model: gpt-6-luna }
githubApp: { appId: 1, privateKeyFile: credentials/github-app.pem }
sandbox: { schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1 }
repositories: []
`;

export function plan() {
  return { revision, base, observations, output, root, v1, v2, guestAssets, migration, questionId, phases,
    prerequisites: ['the checkout is committed and clean; tsc emitted dist/ from HEAD immediately before', 'private SDK profiles prepared and verified (the build re-verifies them)',
      `${v1.build}/${v1.archive} with its .sha256 sidecar and build-report.json (read only)`, 'the base does not exist (tombstones live inside it)',
      'about 6 GiB free under /home/sanmoo/software-factory-test'],
    effects: [
      `build: tombstone, mkdir base/observations (exclusive); buildRelease ${v2.release} into base/build (assets34 copied after pin verification); archive + sidecar + report`,
      `install-v1: verify the v1 archive (sidecar, build report, listing confined); mkdir root 0700 (exclusive); tar -xpkf; root/factory setup; config.yaml with NO repository and a non-secret placeholder credentials/github-app.pem (never a key, never read: no token is requested); doctor`,
      'seed-v1: under flock of root/data/control.lock: the current Control (doubled execution/GitHub, in-process) produces Work #3 waiting on a published open Question and Work #4, pause, clean stop; that state is re-expressed as format 1 in root/data/control.sqlite (public Pi Durable API); then the REAL v1 controller (root/factory run) serves it: status/question over the real protocol, SIGINT exit 0',
      `extract-v2: verify the v2 archive; tar -xpf --skip-old-files releases assets into root (the launcher is NOT extracted; identical asset files are kept); releases/${v1.release} and assets inventories unchanged`,
      'check-and-refusals: v2 `upgrade check` (UPGRADE_MIGRATION_REQUIRED); while the v1 controller runs: refused by the lock; v1 unpause → v2 check UPGRADE_INCOMPATIBLE (upgrade:pause); v1 pause again; v2 `upgrade apply` without --migrate → UPGRADE_MIGRATION_NOT_REQUESTED; storage/launcher/journal unchanged',
      `interrupted-migration: every dist/src file of the v2 release proven byte-identical to this checkout; the v2 upgrade code SIGKILLed after the journal (storage still format 1); v2 status UPGRADE_INCOMPLETE; v2 resume SIGKILLed after the migration commit; root/factory (guard launcher) starts nothing (UPGRADE_INCOMPLETE); v1 invoked directly refuses before storage (RELEASE_INVALID: not selected); v2 rollback ROLLBACK_FORMAT_UNSUPPORTED; v2 resume UPGRADE_COMPLETED`,
      'start-v2: root/factory doctor (v2 selected); root/factory run (paused); status/list/show/question; answer the pending Question (local CLI); SIGINT; upgrade status shows the recorded clean stop',
    ],
    bounds: { network: 'none (no repository configured: no polling target, no token request, Question desk refused locally)', github: 'none', credentials: 'none (placeholder file only)',
      model: 'none', vm: 'none (paused; no eligible Work)', systemd: 'no unit written or started', diskPeakGiB: 6, retries: 0, timeouts: { buildMinutes: 15, commandSeconds: 120 } },
    expected: [
      'build-result: RELEASE_BUILT, source.dirty false, guestAssets = assets34 pin; manifest metadata.storage {format 2, migratesFrom [1]}',
      'install-v1-result: archive verified; setup created [config.yaml, credentials, data, environments, run]; doctor release mvp-32.1 checks ok, configuration valid',
      'seed-v1-result: seed exit 0 with 2 Works and the Question open/published; v1 run status paused, questions.open 1; v1 exit 0 after SIGINT',
      'extract-v2-result: releases/mvp-33.1 present; v1 tree and assets inventories identical before/after; root/factory still selects v1',
      'check-and-refusals-result: check UPGRADE_MIGRATION_REQUIRED (no blocked check; upgrade:stop unverified: format 1 records no lifecycle); lock refusal exit 73; unpaused → UPGRADE_INCOMPATIBLE [upgrade:pause]; apply without --migrate UPGRADE_MIGRATION_NOT_REQUESTED; preserved digest and launcher unchanged, no data/upgrade',
      'interrupted-migration-result: cut 1 SIGKILL after the guard launcher and journal, journal migrating, storage format 1; status UPGRADE_INCOMPLETE; cut 2 SIGKILL, journal migrated, storage format 2 with the same preserved digest; guarded exit 2 code UPGRADE_INCOMPLETE; v1Refused exit 2 with RELEASE_INVALID; afterV1.report.storage.preserved = afterCut2 and stateDigest unchanged; rollback ROLLBACK_FORMAT_UNSUPPORTED; resume UPGRADE_COMPLETED; launcher = v2 pin; exactly one migration record',
      'start-v2-result: doctor release mvp-33.1, release:selected ok; status paused true, storage.format 2, questions.open 1; question open; answer exit 0; question answered; run exit 0; upgrade status lifecycle.last.end clean',
    ],
  };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    if (/gh[sopu]_[A-Za-z0-9]{20,}|PRIVATE KEY/.test(text)) throw new Error('OBSERVATION_SECRET_SHAPE');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  };
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  return { fs, save, exists };
}

const environment = () => ({ PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C', LC_ALL: 'C', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '' });
async function command(executable: string, args: string[], timeoutMs = 120000) {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(executable, args, { cwd: base, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: environment() });
  return { status: result.status, signal: result.signal, stdout: result.stdout.slice(0, 4 * 1024 * 1024), stderr: result.stderr.slice(0, 65536) };
}
const json = (text: string) => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } };
/** The NEW release's own CLI with its private Node (it is not selected until the upgrade switches the launcher). */
const v2cli = (args: string[], timeoutMs = 300000) => command('/usr/bin/env', ['-u', 'NODE_OPTIONS', '-u', 'NODE_PATH', '-u', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE=1',
  `${root}/releases/${v2.release}/node/bin/node`, `${root}/releases/${v2.release}/dist/src/entrypoints/cli.js`, ...args], timeoutMs);
/** A test child run with a release's private Node under the canonical-storage flock, as the production owner is. */
const locked = (release: string, script: string, args: string[]) => command('flock', ['--exclusive', '--nonblock', '--no-fork', `${root}/data/control.lock`,
  `${root}/releases/${release}/node/bin/node`, script, ...args], 300000);

/** Runs `root/factory run` (whichever release it selects), calls `during` once its socket answers, then SIGINT; returns its exit. */
async function runController(during: (factory: (args: string[]) => ReturnType<typeof command>) => Promise<unknown>) {
  const { spawn } = await import('node:child_process');
  const child = spawn(`${root}/factory`, ['run'], { cwd: base, stdio: ['ignore', 'pipe', 'pipe'], env: environment() });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-65536); });
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const factory = (args: string[]) => command(`${root}/factory`, args, 120000);
  let observed: unknown = null;
  try {
    let ready = false;
    for (let i = 0; i < 300 && !ready; i++) {
      if ((await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 200))]))) break;
      ready = (await factory(['status', '--json'])).status === 0;
    }
    observed = ready ? await during(factory) : { notReady: true };
  } finally { child.kill('SIGINT'); }
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  const end = await exited;
  clearTimeout(timer);
  return { observed, end, stderr };
}

/** Listing rule: only the launcher, the release tree and the guest assets; never absolute paths or parent references. */
export function listingViolations(listing: string[], id: string, assets: string) {
  return listing.filter(path => !(path === 'factory' || path === 'releases/' || path === 'assets/' || path === 'assets/guest/' ||
    path.startsWith(`releases/${id}/`) || path === `releases/${id}` || path.startsWith(`assets/guest/${assets}/`) || path === `assets/guest/${assets}`) ||
    path.startsWith('/') || path.split('/').includes('..')).slice(0, 32);
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, exists } = await io();
  if (phase === 'build') {
    await fs.mkdir(base, { mode: 0o700 }); // EXCLUSIVE: an existing base means the build was consumed
    await fs.writeFile(tombstonePath(phase), JSON.stringify({ revision, phase, at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.mkdir(observations, { mode: 0o700 });
  } else {
    const before = previous[phase];
    if (before && !(await exists(`${before}-result`))) throw new Error('PREVIOUS_PHASE_REQUIRED');
    await fs.writeFile(tombstonePath(phase), JSON.stringify({ revision, phase, at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  try {
    const { createHash } = await import('node:crypto');
    const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
    const { fileURLToPath } = await import('node:url');
    const dist = fileURLToPath(new URL('.', import.meta.url));
    if (phase === 'build') {
      const { applicationRoot } = await import('../../src/entrypoints/release.js');
      const status = await command('git', ['-C', applicationRoot(), 'status', '--porcelain', '--untracked-files=normal']);
      if (status.status !== 0 || status.stdout.trim() !== '') { await save('build-held', { reason: 'SOURCE_NOT_CLEAN', status: status.stdout.slice(0, 4096) }); throw new Error('SOURCE_NOT_CLEAN'); }
      const { buildRelease } = await import('../../src/entrypoints/release-build.js');
      const started = Date.now();
      const report = await buildRelease({ release: v2.release, output, guestAssets });
      if (report.source.dirty) throw new Error('SOURCE_NOT_CLEAN');
      const manifest = JSON.parse(await fs.readFile(`${output}/release-manifest.json`, 'utf8')) as { metadata: { storage?: unknown } };
      await save('build-result', { status: 'success', report, storage: manifest.metadata.storage ?? null, durationMs: Date.now() - started });
      return;
    }
    const verifyArchive = async (directory: string, name: string, id: string) => {
      const { createReadStream } = await import('node:fs');
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(`${directory}/${name}`, { highWaterMark: 1024 * 1024 })) digest.update(chunk as Buffer);
      const archiveSha256 = digest.digest('hex');
      const report = JSON.parse(await fs.readFile(`${directory}/build-report.json`, 'utf8')) as { archiveSha256: string; manifestSha256: string; release: string };
      const listing = (await command('tar', ['-tf', `${directory}/${name}`], 600000)).stdout.split('\n').filter(Boolean);
      const result = { archiveSha256, sidecarMatches: await fs.readFile(`${directory}/${name}.sha256`, 'utf8') === `${archiveSha256}  ${name}\n`,
        reportMatches: archiveSha256 === report.archiveSha256 && report.release === id, entries: listing.length, violations: listingViolations(listing, id, guestAssets.manifestSha256) };
      if (!result.sidecarMatches || !result.reportMatches || result.violations.length) { await save(`${phase}-archive-held`, result); throw new Error('ARCHIVE_UNVERIFIED'); }
      return result;
    };
    const { inventoryTree } = await import('../../src/entrypoints/release.js');
    const tree = async (path: string) => sha(JSON.stringify(await inventoryTree(path)));
    const launcher = async () => sha(await fs.readFile(`${root}/factory`));
    const upgradeStatus = async () => { const result = await v2cli(['upgrade', 'status']); return { ...result, report: json(result.stdout) }; };
    if (phase === 'install-v1') {
      const archive = await verifyArchive(v1.build, v1.archive, v1.release);
      await fs.mkdir(root, { mode: 0o700 }); // EXCLUSIVE fresh installation root
      const extracted = await command('tar', ['-xpkf', `${v1.build}/${v1.archive}`, '-C', root], 600000);
      if (extracted.status !== 0) { await save('install-v1-held', { archive, extracted }); throw new Error('EXTRACTION_FAILED'); }
      const setup = await command(`${root}/factory`, ['setup', '--json']);
      await fs.writeFile(`${root}/config.yaml`, configuration, { mode: 0o600 });
      await fs.writeFile(`${root}/credentials/github-app.pem`, 'placeholder: not a key; no token is ever requested by this recipe\n', { mode: 0o600, flag: 'wx' });
      const doctor = await command(`${root}/factory`, ['doctor', '--json']);
      await save('install-v1-result', { status: 'observed', archive, setup, doctor: { status: doctor.status, report: json(doctor.stdout) }, launcherSha256: await launcher() });
      return;
    }
    if (phase === 'seed-v1') {
      const seed = await locked(v1.release, `${dist}release33-seed-child.js`, [`${root}/run`, `${root}/data/control.sqlite`]);
      if (seed.status !== 0) { await save('seed-v1-held', { seed }); throw new Error('SEED_FAILED'); }
      const run = await runController(async factory => ({ status: json((await factory(['status', '--json'])).stdout),
        question: json((await factory(['question', questionId, '--json'])).stdout) }));
      await save('seed-v1-result', { status: 'observed', seed: { status: seed.status, report: json(seed.stdout) }, v1run: run });
      return;
    }
    if (phase === 'extract-v2') {
      const archive = await verifyArchive(output, `software-factory-${v2.release}.tar`, v2.release);
      const before = { v1: await tree(`${root}/releases/${v1.release}`), assets: await tree(`${root}/assets`), launcher: await launcher() };
      const extracted = await command('tar', ['-xpf', `${output}/software-factory-${v2.release}.tar`, '-C', root, '--skip-old-files', 'releases', 'assets'], 600000);
      const after = { v1: await tree(`${root}/releases/${v1.release}`), assets: await tree(`${root}/assets`), launcher: await launcher() };
      await save('extract-v2-result', { status: extracted.status === 0 ? 'success' : 'failure', archive, extracted, before, after, releases: (await fs.readdir(`${root}/releases`)).sort() });
      if (extracted.status !== 0) throw new Error('EXTRACTION_FAILED');
      return;
    }
    if (phase === 'check-and-refusals') {
      const check = await v2cli(['upgrade', 'check']);
      const whileRunning = await runController(async () => v2cli(['upgrade', 'check']));
      const unpaused = await runController(async factory => factory(['unpause']));
      const unpausedCheck = await v2cli(['upgrade', 'check']);
      const repaused = await runController(async factory => factory(['pause']));
      const before = { status: await upgradeStatus(), launcher: await launcher() };
      const notRequested = await v2cli(['upgrade', 'apply']);
      const after = { status: await upgradeStatus(), launcher: await launcher(), journal: await fs.lstat(`${root}/data/upgrade`).then(() => true, () => false) };
      await save('check-and-refusals-result', { status: 'observed', check: { status: check.status, report: json(check.stdout) }, whileRunning, unpaused, unpausedCheck: { status: unpausedCheck.status, report: json(unpausedCheck.stdout) },
        repaused, notRequested: { status: notRequested.status, report: json(notRequested.stdout) }, before, after });
      return;
    }
    if (phase === 'interrupted-migration') {
      const release = `${root}/releases/${v2.release}`;
      // The cut child runs THIS checkout's dist/src; it must be byte-identical to the JavaScript the new release distributes.
      const manifest = JSON.parse(await fs.readFile(`${release}/release-manifest.json`, 'utf8')) as { files: [string, string, number, number?, string?][] };
      const shipped = manifest.files.filter(entry => entry[1] === 'f' && entry[0].startsWith('dist/src/'));
      const differing = [];
      for (const entry of shipped) if (sha(await fs.readFile(`${dist}../../src/${entry[0].slice('dist/src/'.length)}`).catch(() => Buffer.from(''))) !== entry[4]) differing.push(entry[0]);
      if (shipped.length === 0 || differing.length) { await save('interrupted-migration-held', { reason: 'CHECKOUT_DIFFERS_FROM_RELEASE', differing: differing.slice(0, 32) }); throw new Error('CHECKOUT_DIFFERS_FROM_RELEASE'); }
      const cut1 = await locked(v2.release, `${dist}release33-cut-child.js`, [root, release, 'journal', 'apply', migration]);
      const afterCut1 = await upgradeStatus();
      const cut2 = await locked(v2.release, `${dist}release33-cut-child.js`, [root, release, 'migrated', 'resume']);
      const afterCut2 = await upgradeStatus();
      // The installation launcher is the guard during the upgrade: it starts nothing (v1 cannot run, inspect or unpause).
      const guarded = await command(`${root}/factory`, ['run'], 120000);
      // v1 invoked directly (bypassing the launcher) refuses before its storage: it is not the selected release.
      const v1Refused = await command('/usr/bin/env', ['-u', 'NODE_OPTIONS', '-u', 'NODE_PATH', '-u', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE=1',
        `${root}/releases/${v1.release}/node/bin/node`, `${root}/releases/${v1.release}/dist/src/entrypoints/cli.js`, 'run'], 120000);
      const afterV1 = await upgradeStatus();
      const rollback = await v2cli(['upgrade', 'rollback']);
      const resume = await v2cli(['upgrade', 'resume']);
      await save('interrupted-migration-result', { status: 'observed', cut1: { status: cut1.status, signal: cut1.signal, stderr: cut1.stderr }, afterCut1,
        cut2: { status: cut2.status, signal: cut2.signal, stderr: cut2.stderr }, afterCut2, guarded: { status: guarded.status, code: json(guarded.stderr.trim().split('\n').at(-1) ?? '')?.code ?? null, stderr: guarded.stderr },
        v1Refused: { status: v1Refused.status, codes: v1Refused.stderr.split('\n').map(line => json(line)?.code).filter(Boolean), stderr: v1Refused.stderr }, afterV1, rollback: { status: rollback.status, report: json(rollback.stdout) },
        resume: { status: resume.status, report: json(resume.stdout) }, launcherSha256: await launcher() });
      return;
    }
    const doctor = await command(`${root}/factory`, ['doctor', '--json']);
    const run = await runController(async factory => {
      const status = json((await factory(['status', '--json'])).stdout);
      const list = json((await factory(['list', '--json'])).stdout);
      const works = ((list?.payload ?? list) as { works?: { work_id: string }[] } | null)?.works ?? [];
      const shows = [];
      for (const work of works) shows.push(json((await factory(['show', work.work_id, '--json'])).stdout));
      const question = json((await factory(['question', questionId, '--json'])).stdout);
      const answer = await factory(['answer', questionId, 'Use docs/factory-upgrade.md']);
      const answered = json((await factory(['question', questionId, '--json'])).stdout);
      return { status, list, shows, question, answer, answered };
    });
    await save('start-v2-result', { status: 'observed', doctor: { status: doctor.status, report: json(doctor.stdout) }, run, after: await upgradeStatus() });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), () => { console.error('Qualification held; no retry.'); process.exit(1); });
}
