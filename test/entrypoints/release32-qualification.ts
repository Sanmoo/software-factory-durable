// TEST ONLY. Ticket 32 one-shot real release verification recipe. Import and `--plan` are inert. Every other phase is a REAL local effect
// that the supervisor runs explicitly, in order, once: build the release from this CLEAN, freshly compiled checkout with the REAL pinned guest
// assets (assets34, read-only), verify the archive, extract it into a NEW canonical installation root, run setup twice and doctor offline with
// the release's private Node, and confirm the controller refuses the incomplete generated configuration before storage.
// Bounds: no network, GitHub, credential, model, VM/QEMU boot, systemd unit, sudo or package installation; nothing outside `base` and its
// sibling phase tombstones `<base>.<phase>-intent.json` is written (assets34 and the checkout are only read). Phases are one-shot: an exclusive
// intent tombstone precedes each effect (for build, before the base itself exists); a consumed phase never reruns; nothing is retried or
// repaired automatically. A held phase stops the recipe (build a NEW revision instead).

const revision = 'r32-v2'; // v1 was consumed by the supervisor's real run (2026-11-14).
const base = `/home/sanmoo/software-factory-test/${revision}`;
const observations = `${base}/observations`;
const output = `${base}/build`;
const root = `${base}/root`;
const release = 'mvp-32.1';
const guestAssets = {
  directory: '/home/sanmoo/software-factory-test/assets34/assets',
  manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807',
} as const;
const guestProvenance = '/home/sanmoo/software-factory-test/assets34/provenance.json';
const phases = ['build', 'verify', 'install', 'setup', 'doctor', 'controller-refusal'] as const;
type Phase = (typeof phases)[number];
const previous: Record<Phase, Phase | null> = {
  build: null,
  verify: 'build',
  install: 'verify',
  setup: 'install',
  doctor: 'setup',
  'controller-refusal': 'doctor',
};
/** One-shot tombstone, a SIBLING of the base: consumed even when a failure happens before (or during) the base creation. */
export function tombstonePath(phase: Phase) {
  return `${base}.${phase}-intent.json`;
}

export function plan() {
  return {
    revision,
    base,
    observations,
    output,
    root,
    release,
    guestAssets,
    guestProvenance,
    phases,
    prerequisites: [
      'the checkout is committed and clean (the build refuses a dirty tree in this recipe)',
      'tsc emitted dist/ from HEAD immediately before',
      'private SDK profiles .scratch/factory-development-sdk-v3 and -gondolin-v1 prepared and verified (the build re-verifies them)',
      'neither base nor any <base>.<phase>-intent.json tombstone exists',
    ],
    effects: [
      'build: exclusive tombstone <base>.build-intent.json, then mkdir base/observations (exclusive); buildRelease into base/build: copies of dist/src JS, lockfile runtime closure, private Node 24.21.0, SDK profiles, skill packs; ' +
        'assets34 copied (~860 MB) after pin verification; tar archive + .sha256 + manifest + build report; payload removed',
      'verify: archive SHA-256 against the sidecar and the build report; tar listing confined to factory, releases/<id>/, assets/guest/<sha>/ (no absolute or .. paths)',
      'install: mkdir root 0700 (exclusive); tar -xpkf into root (never overwrites)',
      'setup: root/factory setup --json twice; releases/ and assets/ inventories unchanged; second run creates nothing',
      'doctor: root/factory doctor --json offline (reads guest assets, versions, permissions; never credentials, network or VM)',
      'controller-refusal: root/factory run with the incomplete generated configuration: CONFIGURATION_INVALID before storage (lock acquired by the release launcher)',
    ],
    bounds: {
      network: 'none',
      github: 'none',
      credentials: 'none (credentials/ stays empty)',
      model: 'none',
      vm: 'none',
      systemd: 'no unit written or started',
      diskPeakGiB: 3.5,
      retries: 0,
      timeouts: { buildMinutes: 15, commandSeconds: 120 },
    },
    expected: [
      'build-result: code RELEASE_BUILT, source.dirty false, guestAssets = pinned manifest sha',
      'verify-result: archive sha matches; listing confined; manifest sha = build report',
      'setup-result: first created [config.yaml, credentials, data, environments, run]; second created []; release:integrity/location/selected/node/assets ok; ' +
        'guest-assets:* ok with the real assets; release:qualification unverified; diagnostics code INVALID_CONFIGURATION (generated example is incomplete)',
      'doctor-result: exit 2 INVALID_CONFIGURATION; same release checks; versions.node 24.21.0; host checks (kvm-access, qemu, systemd, storage) as observed',
      'controller-refusal-result: exit 2 with CONFIGURATION_INVALID; data/control.sqlite and run/control.sock absent',
    ],
  };
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
  return { fs, save, exists };
}

async function command(executable: string, args: string[], timeoutMs = 120000) {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(executable, args, {
    cwd: base,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: 'C', LC_ALL: 'C', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '' },
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr.slice(0, 65536) };
}

/** Listing rule: only the launcher, the release tree and the guest assets; never absolute paths or parent references. */
export function listingViolations(listing: string[], id: string, assets: string) {
  return listing
    .filter(
      path =>
        !(
          path === 'factory' ||
          path === 'releases/' ||
          path === 'assets/' ||
          path === 'assets/guest/' ||
          path.startsWith(`releases/${id}/`) ||
          path === `releases/${id}` ||
          path.startsWith(`assets/guest/${assets}/`) ||
          path === `assets/guest/${assets}`
        ) ||
        path.startsWith('/') ||
        path.split('/').includes('..'),
    )
    .slice(0, 32);
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, exists } = await io();
  if (phase === 'build') {
    // Tombstone first, outside the base: no partial failure leaves a resumable base without a consumed phase.
    await fs.writeFile(tombstonePath(phase), JSON.stringify({ revision, phase, at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.mkdir(base, { mode: 0o700 });
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE
  } else {
    const before = previous[phase];
    if (before && !(await exists(`${before}-result`))) throw new Error('PREVIOUS_PHASE_REQUIRED');
    await fs.writeFile(tombstonePath(phase), JSON.stringify({ revision, phase, at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  try {
    const { createHash } = await import('node:crypto');
    const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
    if (phase === 'build') {
      const { applicationRoot } = await import('../../src/entrypoints/release.js');
      const status = await command('git', ['-C', applicationRoot(), 'status', '--porcelain', '--untracked-files=normal']);
      if (status.status !== 0 || status.stdout.trim() !== '') {
        await save('build-held', { reason: 'SOURCE_NOT_CLEAN', status: status.stdout.slice(0, 4096) });
        throw new Error('SOURCE_NOT_CLEAN');
      }
      const { buildRelease } = await import('../../src/entrypoints/release-build.js');
      const started = Date.now();
      const report = await buildRelease({ release, output, guestAssets });
      if (report.source.dirty) throw new Error('SOURCE_NOT_CLEAN');
      await save('build-result', {
        status: 'success',
        report,
        durationMs: Date.now() - started,
        guestProvenanceSha256: sha(await fs.readFile(guestProvenance)),
        outputs: await fs.readdir(output),
      });
      return;
    }
    const report = JSON.parse(await fs.readFile(`${output}/build-report.json`, 'utf8')) as {
      archive: string;
      archiveSha256: string;
      manifestSha256: string;
      release: string;
    };
    const archive = `${output}/${report.archive}`;
    if (phase === 'verify') {
      const { createReadStream } = await import('node:fs');
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(archive, { highWaterMark: 1024 * 1024 })) digest.update(chunk as Buffer);
      const archiveSha256 = digest.digest('hex');
      const sidecar = await fs.readFile(`${archive}.sha256`, 'utf8');
      const listing = (await command('tar', ['-tf', archive], 600000)).stdout.split('\n').filter(Boolean);
      const violations = listingViolations(listing, report.release, guestAssets.manifestSha256);
      const manifestSha256 = sha(await fs.readFile(`${output}/release-manifest.json`));
      const result = {
        archiveSha256,
        sidecarMatches: sidecar === `${archiveSha256}  ${report.archive}\n`,
        reportMatches: archiveSha256 === report.archiveSha256,
        manifestSha256,
        manifestMatches: manifestSha256 === report.manifestSha256,
        entries: listing.length,
        violations,
      };
      if (!result.sidecarMatches || !result.reportMatches || !result.manifestMatches || violations.length) {
        await save('verify-held', result);
        throw new Error('ARCHIVE_UNVERIFIED');
      }
      await save('verify-result', { status: 'success', ...result });
      return;
    }
    if (phase === 'install') {
      await fs.mkdir(root, { mode: 0o700 }); // EXCLUSIVE fresh installation root
      const extracted = await command('tar', ['-xpkf', archive, '-C', root], 600000);
      await save('install-result', { status: extracted.status === 0 ? 'success' : 'failure', extracted, top: (await fs.readdir(root)).sort() });
      if (extracted.status !== 0) throw new Error('EXTRACTION_FAILED');
      return;
    }
    const { inventoryTree } = await import('../../src/entrypoints/release.js');
    const trees = async () => sha(JSON.stringify(await inventoryTree(`${root}/releases`)) + JSON.stringify(await inventoryTree(`${root}/assets`)));
    if (phase === 'setup') {
      const treesBefore = await trees();
      const first = await command(`${root}/factory`, ['setup', '--json']);
      const second = await command(`${root}/factory`, ['setup', '--json']);
      await save('setup-result', {
        status: 'observed',
        first,
        second,
        treesBefore,
        treesAfter: await trees(),
        environments: await fs.readdir(`${root}/environments`),
        credentials: await fs.readdir(`${root}/credentials`),
      });
      return;
    }
    if (phase === 'doctor') {
      const doctor = await command(`${root}/factory`, ['doctor', '--json']);
      await save('doctor-result', { status: 'observed', doctor });
      return;
    }
    const refused = await command(`${root}/factory`, ['run'], 60000);
    const absent = async (path: string) =>
      fs.lstat(path).then(
        () => false,
        () => true,
      );
    await save('controller-refusal-result', {
      status: 'observed',
      refused,
      storageAbsent: await absent(`${root}/data/control.sqlite`),
      socketAbsent: await absent(`${root}/run/control.sock`),
    });
  } catch (error) {
    await save(`${phase}-held`, {
      phase,
      status: 'held',
      code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN',
      note: 'Consumed; no retry.',
    }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
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
    () => {
      console.error('Qualification held; no retry.');
      process.exit(1);
    },
  );
}
