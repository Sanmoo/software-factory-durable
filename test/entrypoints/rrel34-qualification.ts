import {
  candidateNamespace,
  command,
  compositionMarkers,
  releaseIdentityFile as identityFile,
  installationRoot,
  integrationBranch,
  mountsBelow,
  observationWriter,
  parseShow,
  release,
  releaseNamespace,
  serviceDirectory,
  serviceUnit,
  type ReleaseIdentity,
} from './prepilot34-qualification.js';
import { listingViolations } from './release32-qualification.js';

// TEST ONLY. Pre-pilot group R-REL (ticket 34: V-16.b, V-16.d), authorized by the operator on 2026-11-16. Import and `--plan` are inert.
// Every other phase is a REAL local effect the supervisor runs explicitly, in order, once: build the candidate release from the CLEAN
// integration commit with the project's own tooling (ticket 32/33 `buildRelease`), verify the archive, extract it into a NEW canonical root,
// `setup --service` (writes the controller's systemd USER unit definition, never enabled), doctor, register the unit (daemon-reload) and
// start it ONCE to show it runs the same launcher (refused before storage: the configuration is still incomplete), and record the release
// identity R-CAND must prove it ran on. `uninstall-service` and `remove-root` remove ONLY what this recipe installed, after R-CAND.
// Bounds: no network, GitHub, credential, model or VM; no sudo, `enable`, linger or package installation. One-shot: an exclusive intent
// tombstone precedes each effect; a consumed phase never reruns; nothing is retried or repaired automatically.

const revision = 'prel34-v2';
const base = releaseNamespace;
const observations = `${base}/observations`;
const output = `${base}/build`;
const root = installationRoot;
const unit = serviceUnit(root);
const unitPath = `${serviceDirectory}/${unit}`;
const guestAssets = {
  directory: '/home/sanmoo/software-factory-test/assets34/assets',
  manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807',
} as const;
export const phases = ['build', 'verify', 'install', 'setup', 'doctor', 'service', 'uninstall-service', 'remove-root'] as const;
export type Phase = (typeof phases)[number];
const previous: Record<Phase, Phase | null> = {
  build: null,
  verify: 'build',
  install: 'verify',
  setup: 'install',
  doctor: 'setup',
  service: 'doctor',
  'uninstall-service': 'service',
  'remove-root': 'uninstall-service',
};
/** Tombstone INSIDE the base (the base is created exclusively by `build` first): a consumed phase never reruns. */
export function tombstonePath(phase: Phase) {
  return `${base}/intent-${phase}.json`;
}

/** Phase order (pure): each phase once, after its predecessor's result (never after a held one). */
export function phaseGuard(phase: Phase, results: ReadonlySet<string>, intents: ReadonlySet<string>): string | null {
  if (!phases.includes(phase)) return 'UNKNOWN_PHASE';
  if (phase === 'build') return intents.has('build') ? 'PHASE_ALREADY_RAN' : null;
  if (intents.has(phase)) return 'PHASE_ALREADY_RAN';
  const before = previous[phase];
  if (before && !results.has(before)) return `${before.toUpperCase().replaceAll('-', '_')}_RESULT_REQUIRED`;
  if (phase === 'remove-root' && !results.has('cand-finished')) return 'CANDIDATE_EVIDENCE_NOT_KEPT';
  return null;
}

export function plan() {
  return {
    revision,
    group: 'R-REL',
    obligations: ['V-16.b', 'V-16.d'],
    base,
    observations,
    output,
    root,
    release,
    guestAssets,
    phases,
    identityFile,
    rootPathNote: 'root is a 38-byte sibling of y5/ (not under it): the guest session socket <root>/r/<22>/s/<41> must fit the 107-byte sun_path',
    prerequisites: [
      `the checkout is the CLEAN tip of ${integrationBranch} (build refuses otherwise) and contains every composition marker`,
      'tsc emitted dist/ from HEAD immediately before (npm run build); private SDK profiles .scratch/factory-development-sdk-v3 and -gondolin-v1 prepared',
      `neither ${base} nor ${root} nor ${unitPath} exists`,
      'about 6 GiB free under /home/sanmoo/software-factory-test',
    ],
    hostEffects: {
      paths: [
        `${base}/ (observations + build: archive ~1.7 GiB, payload removed after archiving)`,
        `${root}/ (installation root 0700: launcher, releases/${release}, assets/guest/<sha>, ` +
          'config.yaml, credentials/ (empty here), data/, environments/, run/)',
        `${unitPath} (0600, written by the release's own \`setup --service\`; its directory is created only if absent and recorded)`,
      ],
      systemdUser: [
        `systemctl --user daemon-reload (registers ${unit}; never enabled: UnitFileState stays disabled, no WantedBy link, no linger)`,
        `systemctl --user start ${unit} ONCE (service phase): ExecStart=${root}/factory run; expected exit 2 CONFIGURATION_INVALID before storage`,
        `systemctl --user reset-failed ${unit}`,
        `journal: the unit's start/exit lines (read back with journalctl --user -u ${unit})`,
      ],
      removal: [
        `uninstall-service: unlink ${unitPath} only if byte-identical to what setup wrote, daemon-reload, reset-failed, rmdir of the unit directory ancestors ONLY if setup created them and they are empty`,
        `remove-root: rm -r --one-file-system ${root} only after uninstall-service, only if it is the same inode install created, no mount at or below it and no active factory-sandbox-* unit; the R-CAND namespace ${candidateNamespace} (outside root) must hold verdict-result.json, or abandoned.json written by the supervisor`,
      ],
      never: [
        'sudo or system units',
        'systemctl enable / loginctl enable-linger',
        'any path outside base, root, the unit file and its recorded created directories',
        'network, GitHub, credentials, model, VM boot',
      ],
    },
    effects: [
      'build: mkdir base (exclusive), tombstone, observations; source checks (clean, HEAD = integration tip, markers are ancestors); buildRelease into base/build (assets34 copied after pin verification)',
      'verify: archive SHA-256 against the sidecar and the build report; tar listing confined (launcher, releases/<id>/, assets/guest/<sha>/); manifest sha = report',
      `install: mkdir ${root} 0700 (exclusive); tar -xpkf; installed manifest sha = report; release identity written to ${identityFile}`,
      `setup: ${root}/factory setup --service --json twice (created, then preserved); unit text = the product definition; no unit started`,
      `doctor: ${root}/factory doctor --json (offline: release integrity/location/selection/node/assets; configuration still incomplete)`,
      `service: daemon-reload; LoadState loaded, UnitFileState disabled; start once; wait (<= 60 s) until inactive/failed; ExecMainStatus 2 and CONFIGURATION_INVALID in the journal; data/control.sqlite and run/control.sock absent; reset-failed`,
      'uninstall-service / remove-root: see hostEffects.removal (after R-CAND)',
    ],
    bounds: {
      network: 'none',
      github: 'none',
      credentials: 'none',
      model: 'none',
      vm: 'none',
      retries: 0,
      diskPeakGiB: 4,
      memoryMiB: 1024,
      wallMinutes: { build: 5, verify: 2, install: 2, setup: 1, doctor: 1, service: 1 },
    },
    expected: [
      'build-result RELEASE_BUILT, source = integration tip, dirty false, every marker an ancestor',
      'verify-result: sidecar/report/manifest match, 0 violations',
      'install-result + release-identity.json (commit, archiveSha256, manifestSha256, guest assets pin, lockfile, node, markers)',
      `setup-result: first service.state created at ${unitPath}, second preserved; text identical to serviceDefinition(root)`,
      'doctor-result: release:* ok, configuration INVALID (incomplete template)',
      'service-result: refused before storage under systemd (V-16.d service mode; the full service run is R-CAND)',
    ],
  };
}

async function exists(path: string) {
  const fs = await import('node:fs/promises');
  return fs.lstat(path).then(
    () => true,
    () => false,
  );
}

async function state() {
  const fs = await import('node:fs/promises');
  const names = await fs.readdir(observations).catch(() => [] as string[]);
  const results = new Set(names.filter(name => name.endsWith('-result.json')).map(name => name.slice(0, -'-result.json'.length)));
  // R-CAND keeps its evidence OUTSIDE root; remove-root waits for its verdict (or an explicit held stop) to exist.
  if ((await exists(`${candidateNamespace}/verdict-result.json`)) || (await exists(`${candidateNamespace}/abandoned.json`))) results.add('cand-finished');
  const intents = new Set((await fs.readdir(base).catch(() => [] as string[])).filter(name => /^intent-.+\.json$/.test(name)).map(name => name.slice(7, -5)));
  return { results, intents };
}

const systemctl = (...args: string[]) => command('systemctl', ['--user', ...args], { timeoutMs: 60_000 });
const show = async (...properties: string[]) => parseShow((await systemctl('show', unit, ...properties.map(item => `-p${item}`))).stdout);

export async function runPhase(phase: Phase) {
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  if (phase === 'build') {
    await fs.mkdir(base, { mode: 0o700 }); // EXCLUSIVE: an existing base means the build was consumed
  } else {
    const { results, intents } = await state();
    const blocked = phaseGuard(phase, results, intents);
    if (blocked) throw new Error(blocked);
  }
  await fs.writeFile(tombstonePath(phase), JSON.stringify({ revision, phase, at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  if (phase === 'build') await fs.mkdir(observations, { mode: 0o700 });
  const save = observationWriter(observations, () => ({ revision, phase }));
  try {
    if (phase === 'build') {
      const { applicationRoot } = await import('../../src/entrypoints/release.js');
      const project = applicationRoot();
      const git = async (...args: string[]) => (await command('git', ['-C', project, ...args])).stdout.trim();
      const status = await git('status', '--porcelain', '--untracked-files=normal');
      const head = await git('rev-parse', 'HEAD');
      const tip = await git('rev-parse', `refs/heads/${integrationBranch}`);
      const markers = Object.fromEntries(
        await Promise.all(
          Object.entries(compositionMarkers).map(async ([name, commit]) => [
            name,
            (await command('git', ['-C', project, 'merge-base', '--is-ancestor', commit, head])).status === 0,
          ]),
        ),
      ) as ReleaseIdentity['markers'];
      const reasons = [
        ...(status ? ['SOURCE_NOT_CLEAN'] : []),
        ...(head !== tip ? ['HEAD_IS_NOT_THE_INTEGRATION_TIP'] : []),
        ...Object.entries(markers)
          .filter(([, ok]) => !ok)
          .map(([name]) => `MARKER_NOT_ANCESTOR:${name}`),
      ];
      if (reasons.length) {
        await save('build-held', { reasons, head, tip, status: status.slice(0, 4096), markers });
        throw new Error(reasons[0]);
      }
      const { buildRelease } = await import('../../src/entrypoints/release-build.js');
      const started = Date.now();
      const report = await buildRelease({ release, output, guestAssets });
      if (report.source.dirty || report.source.commit !== head) throw new Error('BUILT_SOURCE_MISMATCH');
      await save('build-result', {
        status: 'success',
        report,
        durationMs: Date.now() - started,
        head,
        branch: integrationBranch,
        markers,
        lockfileSha256: sha(await fs.readFile(`${project}/package-lock.json`)),
        outputs: await fs.readdir(output),
      });
      return;
    }
    const build = JSON.parse(await fs.readFile(`${observations}/build-result.json`, 'utf8')) as {
      report: { archive: string; archiveSha256: string; manifestSha256: string; release: string; source: { commit: string; commitTime: string } };
      markers: ReleaseIdentity['markers'];
      lockfileSha256: string;
      branch: string;
    };
    const archive = `${output}/${build.report.archive}`;
    if (phase === 'verify') {
      const { createReadStream } = await import('node:fs');
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(archive, { highWaterMark: 1024 * 1024 })) digest.update(chunk as Buffer);
      const archiveSha256 = digest.digest('hex');
      const sidecar = await fs.readFile(`${archive}.sha256`, 'utf8');
      const listing = (await command('tar', ['-tf', archive], { timeoutMs: 600_000 })).stdout.split('\n').filter(Boolean);
      const violations = listingViolations(listing, build.report.release, guestAssets.manifestSha256);
      const manifestSha256 = sha(await fs.readFile(`${output}/release-manifest.json`));
      const result = {
        archiveSha256,
        sidecarMatches: sidecar === `${archiveSha256}  ${build.report.archive}\n`,
        reportMatches: archiveSha256 === build.report.archiveSha256,
        manifestSha256,
        manifestMatches: manifestSha256 === build.report.manifestSha256,
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
      const extracted = await command('tar', ['-xpkf', archive, '-C', root], { timeoutMs: 600_000 });
      if (extracted.status !== 0) {
        await save('install-held', { extracted });
        throw new Error('EXTRACTION_FAILED');
      }
      const installed = sha(await fs.readFile(`${root}/releases/${release}/release-manifest.json`));
      const manifest = JSON.parse(await fs.readFile(`${root}/releases/${release}/release-manifest.json`, 'utf8')) as { node?: { version?: string } };
      const info = await fs.stat(root);
      const identity: ReleaseIdentity = {
        release,
        commit: build.report.source.commit,
        commitTime: build.report.source.commitTime,
        branch: build.branch,
        dirty: false,
        archive: build.report.archive,
        archiveSha256: build.report.archiveSha256,
        manifestSha256: build.report.manifestSha256,
        guestAssets: { manifestSha256: guestAssets.manifestSha256 },
        lockfileSha256: build.lockfileSha256,
        node: manifest.node?.version ?? 'unknown',
        markers: build.markers,
        root,
        unit,
        builtAt: new Date().toISOString(),
      };
      if (installed !== identity.manifestSha256) {
        await save('install-held', { installed, expected: identity.manifestSha256 });
        throw new Error('INSTALLED_MANIFEST_MISMATCH');
      }
      await fs.writeFile(identityFile, JSON.stringify(identity, null, 1) + '\n', { flag: 'wx', mode: 0o600 });
      await save('install-result', { status: 'success', identity, rootInode: { dev: info.dev, ino: info.ino }, top: (await fs.readdir(root)).sort() });
      return;
    }
    const factory = (...args: string[]) => command(`${root}/factory`, args, { cwd: root });
    if (phase === 'setup') {
      if (await exists(unitPath)) {
        await save('setup-held', { reason: 'SERVICE_UNIT_PREEXISTS', unitPath });
        throw new Error('SERVICE_UNIT_PREEXISTS');
      }
      // Directories the product's setup may create (mkdir -p of the standard unit directory): recorded so uninstall removes only those.
      const ancestors = ['/home/sanmoo/.config', '/home/sanmoo/.config/systemd', serviceDirectory];
      const absentBefore = (await Promise.all(ancestors.map(async path => [path, !(await exists(path))] as const)))
        .filter(([, absent]) => absent)
        .map(([path]) => path);
      const { serviceDefinition, standardServiceDirectory } = await import('../../src/entrypoints/setup.js');
      const expected = serviceDefinition(root);
      const first = await factory('setup', '--service', '--json');
      const second = await factory('setup', '--service', '--json');
      const text = await fs.readFile(unitPath, 'utf8').catch(() => null);
      const parse = (stdout: string) => {
        try {
          return JSON.parse(stdout) as { service?: { unit: string; path: string; state: string }; created?: string[] };
        } catch {
          return null;
        }
      };
      const result = {
        first: { status: first.status, json: parse(first.stdout), stderr: first.stderr },
        second: { status: second.status, json: parse(second.stdout), stderr: second.stderr },
        unit,
        unitPath,
        unitSha256: text === null ? null : sha(text),
        unitMatchesDefinition: text === expected.text && expected.unit === unit,
        standardDirectoryMatches: standardServiceDirectory() === serviceDirectory,
        createdDirectories: absentBefore,
      };
      const ok =
        first.status === 0 &&
        second.status === 0 &&
        result.first.json?.service?.state === 'created' &&
        result.second.json?.service?.state === 'preserved' &&
        result.unitMatchesDefinition &&
        result.standardDirectoryMatches;
      await save(ok ? 'setup-result' : 'setup-held', { status: ok ? 'success' : 'held', ...result });
      if (!ok) throw new Error('SETUP_NOT_AS_EXPECTED');
      return;
    }
    if (phase === 'doctor') {
      const doctor = await factory('doctor', '--json');
      let report: { checks?: { id: string; status: string }[]; release?: { manifestSha256?: string } } | null = null;
      try {
        report = JSON.parse(doctor.stdout);
      } catch {
        /* recorded raw */
      }
      const releaseChecks = (report?.checks ?? []).filter(check => check.id.startsWith('release:') && check.id !== 'release:qualification');
      const ok =
        releaseChecks.length > 0 && releaseChecks.every(check => check.status === 'ok') && report?.release?.manifestSha256 === build.report.manifestSha256;
      await save(ok ? 'doctor-result' : 'doctor-held', { status: ok ? 'success' : 'held', doctor: { status: doctor.status, stderr: doctor.stderr }, report });
      if (!ok) throw new Error('RELEASE_NOT_VERIFIED_BY_DOCTOR');
      return;
    }
    if (phase === 'service') {
      const reload = await systemctl('daemon-reload');
      const loaded = await show('LoadState', 'FragmentPath', 'UnitFileState', 'ActiveState');
      if (loaded.LoadState !== 'loaded' || loaded.FragmentPath !== unitPath || loaded.ActiveState !== 'inactive') {
        await save('service-held', { reason: 'UNIT_NOT_LOADED_AS_WRITTEN', reload, loaded });
        throw new Error('UNIT_NOT_LOADED_AS_WRITTEN');
      }
      const start = await systemctl('start', unit);
      const deadline = Date.now() + 60_000;
      let after = await show('ActiveState', 'SubState', 'Result', 'ExecMainStatus', 'ExecMainCode', 'InvocationID', 'MainPID');
      while (!['inactive', 'failed'].includes(after.ActiveState ?? '') && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 1000));
        after = await show('ActiveState', 'SubState', 'Result', 'ExecMainStatus', 'ExecMainCode', 'InvocationID', 'MainPID');
      }
      let stopped = null;
      if (!['inactive', 'failed'].includes(after.ActiveState ?? '')) stopped = await systemctl('stop', unit); // never leave it running
      // A fresh unit name (hash of the new root) started once: every journal line of the unit belongs to this start.
      const journal = await command('journalctl', ['--user', '-u', unit, '-o', 'cat', '--no-pager', '-n', '80']);
      const storageAbsent = !(await exists(`${root}/data/control.sqlite`));
      const socketAbsent = !(await exists(`${root}/run/control.sock`));
      const reset = await systemctl('reset-failed', unit);
      const ok =
        stopped === null &&
        after.ExecMainStatus === '2' &&
        journal.stdout.includes('CONFIGURATION_INVALID') &&
        storageAbsent &&
        socketAbsent &&
        loaded.UnitFileState !== 'enabled';
      await save(ok ? 'service-result' : 'service-held', {
        status: ok ? 'success' : 'held',
        reload: reload.status,
        loaded,
        start: { status: start.status, stderr: start.stderr },
        after,
        stopped,
        journal: journal.stdout.split('\n').slice(-80),
        storageAbsent,
        socketAbsent,
        reset: reset.status,
        meaning:
          'the systemd user unit written by setup --service runs the same launcher and is refused before storage while the configuration is incomplete; R-CAND runs it fully',
      });
      if (!ok) throw new Error('SERVICE_NOT_AS_EXPECTED');
      return;
    }
    const sandboxes = async () =>
      (await systemctl('list-units', '--all', '--plain', '--no-legend', 'factory-sandbox-*')).stdout
        .split('\n')
        .map(line => line.trim().split(/\s+/))
        .filter(fields => fields[0]?.startsWith('factory-sandbox-') && fields[2] !== 'inactive')
        .map(fields => fields.slice(0, 4).join(' '));
    if (phase === 'uninstall-service') {
      const setup = JSON.parse(await fs.readFile(`${observations}/setup-result.json`, 'utf8')) as { unitSha256: string; createdDirectories: string[] };
      const active = await show('ActiveState', 'LoadState');
      const running = await sandboxes();
      const text = await fs.readFile(unitPath).catch(() => null);
      const reasons = [
        ...(['active', 'activating', 'deactivating', 'reloading'].includes(active.ActiveState ?? '') ? ['UNIT_ACTIVE'] : []),
        ...(running.length ? ['SANDBOX_UNITS_ACTIVE'] : []),
        ...(text === null ? ['UNIT_FILE_ABSENT'] : sha(text) !== setup.unitSha256 ? ['UNIT_FILE_CHANGED'] : []),
      ];
      if (reasons.length) {
        await save('uninstall-service-held', { reasons, active, running });
        throw new Error(reasons[0]);
      }
      await fs.unlink(unitPath);
      const reload = await systemctl('daemon-reload');
      const reset = await systemctl('reset-failed', unit);
      const removedDirectories: string[] = [];
      for (const directory of [...setup.createdDirectories].sort((a, b) => b.length - a.length)) {
        if (
          await fs.rmdir(directory).then(
            () => true,
            () => false,
          )
        )
          removedDirectories.push(directory);
      }
      const gone = await show('LoadState');
      await save('uninstall-service-result', {
        status: gone.LoadState === 'not-found' ? 'success' : 'observed',
        removed: unitPath,
        reload: reload.status,
        reset: reset.status,
        removedDirectories,
        keptDirectories: setup.createdDirectories.filter(item => !removedDirectories.includes(item)),
        after: gone,
      });
      return;
    }
    // remove-root
    const install = JSON.parse(await fs.readFile(`${observations}/install-result.json`, 'utf8')) as { rootInode: { dev: number; ino: number } };
    const info = await fs.lstat(root);
    const mounts = mountsBelow(await fs.readFile('/proc/self/mountinfo', 'utf8'), root);
    const running = await sandboxes();
    const reasons = [
      ...(info.isSymbolicLink() || !info.isDirectory() || info.dev !== install.rootInode.dev || info.ino !== install.rootInode.ino
        ? ['ROOT_NOT_THE_INSTALLED_ONE']
        : []),
      ...(mounts.length ? ['MOUNT_BELOW_ROOT'] : []),
      ...(running.length ? ['SANDBOX_UNITS_ACTIVE'] : []),
    ];
    if (reasons.length) {
      await save('remove-root-held', { reasons, mounts, running });
      throw new Error(reasons[0]);
    }
    const top = (await fs.readdir(root)).sort();
    const writable = await command('chmod', ['-R', 'u+w', '--', root], { timeoutMs: 600_000 });
    const removed = await command('rm', ['-rf', '--one-file-system', '--preserve-root=all', '--', root], { timeoutMs: 600_000 });
    await save('remove-root-result', {
      status: removed.status === 0 && !(await exists(root)) ? 'success' : 'held',
      top,
      chmod: writable.status,
      rm: { status: removed.status, stderr: removed.stderr },
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
    (error: unknown) => {
      console.error(`Qualification held; no retry. (${error instanceof Error ? error.message.slice(0, 160) : 'UNKNOWN'})`);
      process.exit(1);
    },
  );
}
