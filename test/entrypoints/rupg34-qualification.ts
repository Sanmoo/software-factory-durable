import {
  command,
  compositionMarkers,
  hostEnvironment,
  identityFile,
  installationRoot,
  integrationBranch,
  observationWriter,
  parseShow,
  releaseIdentityFile,
  serviceUnit,
  upgradeFromRelease,
  upgradeNamespace,
  upgradeRelease,
  y5,
  type ReleaseIdentity,
} from './prepilot34-qualification.js';
import { listingViolations } from './release32-qualification.js';

// TEST ONLY. Pre-pilot group R-UPG (ticket 34, before R-CAND v3), authorized by the operator on 2026-11-16. Import and `--plan` are inert.
// R-CAND v2 held at review on mvp-34.2 (a continuation Execution refused the treatment of an earlier round's finding, fixed in b4c5443).
// v3 must run on a release that contains the fix, IN THE SAME R-REL root (pr2 keeps the operator's model login, never copied or touched):
// build the upgrade release (mvp-34.3 in prel34-v3, mvp-34.4 in prel34-v4, mvp-34.5 in prel34-v5) from the CLEAN integration tip with the project's own tooling, verify it, extract it NEXT TO the previous one (launcher and existing
// files kept), let the NEW release's own `upgrade check` / `upgrade apply` select it (the controller is stopped and its storage paused, as the
// product requires), re-verify with the installed launcher's doctor and record the identity R-CAND v3 proves it ran on; finally start the
// service unit ONCE to unpause (the App key is copied for that phase only and removed in its finally) and stop it again.
// Bounds: no VM, model or GitHub write; no sudo, enable or linger. One-shot: an exclusive intent tombstone precedes each effect; a consumed
// phase never reruns; nothing is retried, repaired or rolled back automatically.

const revision = 'prel34-v5';
const base = upgradeNamespace;
const observations = `${base}/observations`;
const output = `${base}/build`;
const root = installationRoot;
const unit = serviceUnit(root);
const release = upgradeRelease;
const previousRelease = upgradeFromRelease;
const keySource = `${y5}/credentials/app.pem`;
const guestAssets = {
  directory: '/home/sanmoo/software-factory-test/assets34/assets',
  manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807',
} as const;
export const phases = ['build', 'verify', 'extract', 'upgrade', 'unpause'] as const;
export type Phase = (typeof phases)[number];
const previous: Record<Phase, Phase | null> = { build: null, verify: 'build', extract: 'verify', upgrade: 'extract', unpause: 'upgrade' };
/** Tombstone INSIDE the base (the base is created exclusively by `build` first): a consumed phase never reruns. */
export function tombstonePath(phase: Phase) {
  return `${base}/intent-${phase}.json`;
}

/** Phase order (pure): each phase once, after its predecessor's result (never after a held one). */
export function phaseGuard(phase: Phase, results: ReadonlySet<string>, intents: ReadonlySet<string>): string | null {
  if (!phases.includes(phase)) return 'UNKNOWN_PHASE';
  if (intents.has(phase)) return 'PHASE_ALREADY_RAN';
  const before = previous[phase];
  if (before && !results.has(before)) return `${before.toUpperCase()}_RESULT_REQUIRED`;
  return null;
}

/** The `upgrade check` verdict that allows `apply` without a migration (pure): compatible, nothing blocked, the target is this release. */
export function applicable(check: { code?: string; checks?: { id: string; status: string }[] } | null): string | null {
  if (!check) return 'CHECK_UNPARSABLE';
  if (check.code === 'UPGRADE_MIGRATION_REQUIRED') return 'MIGRATION_REQUIRED';
  if (check.code !== 'UPGRADE_COMPATIBLE') return `CHECK_${check.code ?? 'UNKNOWN'}`;
  if ((check.checks ?? []).some(item => item.status === 'blocked')) return 'CHECK_BLOCKED';
  return null;
}

export function plan() {
  return {
    revision,
    group: 'R-UPG',
    base,
    observations,
    output,
    root,
    unit,
    release,
    previousRelease,
    guestAssets,
    phases,
    identityFile,
    releaseIdentityFile,
    prerequisites: [
      `the checkout is the CLEAN tip of ${integrationBranch} (build refuses otherwise) and contains every composition marker (incl. continuation-findings)`,
      'tsc emitted dist/ from HEAD immediately before; private SDK profiles prepared IN THIS checkout (npm run prepare:sdk), never copied',
      `${root} is the R-REL root running ${previousRelease} (${releaseIdentityFile}); its controller unit ${unit} is inactive and its storage paused; no Work of it can act`,
      `${base} does not exist; about 4 GiB free under /home/sanmoo/software-factory-test`,
    ],
    hostEffects: [
      `${base}/ (observations + build: archive ~1.7 GiB)`,
      `${root}/releases/${release}/ and assets/guest/<sha>/ (tar --skip-old-files: existing files, the launcher and releases/${previousRelease} kept)`,
      `the NEW release's \`upgrade check\` and \`upgrade apply\` (canonical-storage flock; the product switches the launcher selection)`,
      `${identityFile} (O_EXCL)`,
      `unpause: ${root}/credentials/app.pem copied O_EXCL from ${keySource} and removed in finally; systemctl --user start/stop ${unit} (never enable); \`factory unpause\``,
    ],
    never: [
      'the model login (credentials/chatgpt.json) read, copied or changed',
      'a migration, rollback or resume',
      'sudo, system units, enable, linger',
      'a VM, a model call, any GitHub write',
    ],
    expected: [
      'build-result: source = integration tip, dirty false, every marker an ancestor',
      'verify-result: sidecar/report/manifest match, 0 violations',
      `extract-result: releases/${release} present; releases/${previousRelease} tree and the launcher unchanged`,
      `upgrade-result: check UPGRADE_COMPATIBLE (nothing blocked), apply UPGRADE_COMPLETED, doctor through ${root}/factory: release ${release} selected, release:* ok; identity written`,
      'unpause-result: the service ran the selected release, paused false, unit stopped, key removed',
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
  const intents = new Set((await fs.readdir(base).catch(() => [] as string[])).filter(name => /^intent-.+\.json$/.test(name)).map(name => name.slice(7, -5)));
  return { results, intents };
}

const systemctl = (...args: string[]) => command('systemctl', ['--user', ...args], { timeoutMs: 60_000 });
const show = async (...properties: string[]) => parseShow((await systemctl('show', unit, ...properties.map(item => `-p${item}`))).stdout);
const json = (text: string) => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
};

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
  const newCli = (args: string[], timeoutMs = 300_000) =>
    command(`${root}/releases/${release}/node/bin/node`, [`${root}/releases/${release}/dist/src/entrypoints/cli.js`, ...args], {
      cwd: root,
      timeoutMs,
      env: { ...hostEnvironment(), NODE_DISABLE_COMPILE_CACHE: '1' },
    });
  const factory = (...args: string[]) => command(`${root}/factory`, args, { cwd: root, timeoutMs: 120_000 });
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
    const { inventoryTree } = await import('../../src/entrypoints/release.js');
    const tree = async (path: string) => sha(JSON.stringify(await inventoryTree(path)));
    const launcher = async () => sha(await fs.readFile(`${root}/factory`));
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
    const controller = await show('ActiveState', 'LoadState');
    if (['active', 'activating', 'deactivating', 'reloading'].includes(controller.ActiveState ?? '')) {
      await save(`${phase}-held`, { reason: 'CONTROLLER_ACTIVE', controller });
      throw new Error('CONTROLLER_ACTIVE');
    }
    if (phase === 'extract') {
      if (await exists(`${root}/releases/${release}`)) {
        await save('extract-held', { reason: 'RELEASE_ALREADY_PRESENT' });
        throw new Error('RELEASE_ALREADY_PRESENT');
      }
      const before = { previous: await tree(`${root}/releases/${previousRelease}`), launcher: await launcher() };
      const extracted = await command('tar', ['-xpf', archive, '-C', root, '--skip-old-files', 'releases', 'assets'], { timeoutMs: 600_000 });
      const after = { previous: await tree(`${root}/releases/${previousRelease}`), launcher: await launcher() };
      const installed = sha(await fs.readFile(`${root}/releases/${release}/release-manifest.json`).catch(() => Buffer.from('')));
      const ok =
        extracted.status === 0 && before.previous === after.previous && before.launcher === after.launcher && installed === build.report.manifestSha256;
      await save(ok ? 'extract-result' : 'extract-held', {
        status: ok ? 'success' : 'held',
        extracted: { status: extracted.status, stderr: extracted.stderr },
        before,
        after,
        installed,
        releases: (await fs.readdir(`${root}/releases`)).sort(),
      });
      if (!ok) throw new Error('EXTRACTION_NOT_AS_EXPECTED');
      return;
    }
    if (phase === 'upgrade') {
      const check = await newCli(['upgrade', 'check']);
      const checkReport = json(check.stdout) as { code?: string; checks?: { id: string; status: string }[] } | null;
      const refused = applicable(checkReport);
      if (refused) {
        await save('upgrade-held', { reason: refused, check: { status: check.status, report: checkReport, stderr: check.stderr } });
        throw new Error(refused);
      }
      const apply = await newCli(['upgrade', 'apply']);
      const applyReport = json(apply.stdout) as { code?: string } | null;
      const doctor = await factory('doctor', '--json');
      const report = json(doctor.stdout) as { checks?: { id: string; status: string }[]; release?: { manifestSha256?: string; release?: string } } | null;
      const releaseChecks = (report?.checks ?? []).filter(item => item.id.startsWith('release:') && item.id !== 'release:qualification');
      const installed = sha(await fs.readFile(`${root}/releases/${release}/release-manifest.json`));
      const ok =
        apply.status === 0 &&
        applyReport?.code === 'UPGRADE_COMPLETED' &&
        releaseChecks.length > 0 &&
        releaseChecks.every(item => item.status === 'ok') &&
        report?.release?.manifestSha256 === build.report.manifestSha256 &&
        installed === build.report.manifestSha256;
      if (!ok) {
        await save('upgrade-held', {
          reason: 'UPGRADE_NOT_COMPLETED',
          check: checkReport,
          apply: { status: apply.status, report: applyReport, stderr: apply.stderr },
          doctor: report,
        });
        throw new Error('UPGRADE_NOT_COMPLETED');
      }
      const manifest = JSON.parse(await fs.readFile(`${root}/releases/${release}/release-manifest.json`, 'utf8')) as { node?: { version?: string } };
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
      await fs.writeFile(identityFile, JSON.stringify(identity, null, 1) + '\n', { flag: 'wx', mode: 0o600 });
      await save('upgrade-result', { status: 'success', check: checkReport, apply: applyReport, doctor: report, identity, launcherSha256: await launcher() });
      return;
    }
    // unpause: the selected release's service, once; the App key only for this phase.
    const key = `${root}/credentials/app.pem`;
    await fs.copyFile(keySource, key, (await import('node:fs')).constants.COPYFILE_EXCL);
    await fs.chmod(key, 0o600);
    let stopped = null;
    try {
      const start = await systemctl('start', unit);
      let status = null;
      for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
        const ran = await factory('status', '--json');
        if (ran.status === 0) {
          status = json(ran.stdout);
          break;
        }
        await new Promise(done => setTimeout(done, 2000));
      }
      const unpause = status ? await factory('unpause', '--json') : null;
      const after = status ? (json((await factory('status', '--json')).stdout) as { paused?: boolean } | null) : null;
      const pid = (await show('MainPID')).MainPID ?? '0';
      const exe = await fs.readlink(`/proc/${pid}/exe`).catch(() => null);
      stopped = await systemctl('stop', unit);
      const ok = start.status === 0 && unpause?.status === 0 && after?.paused === false && stopped.status === 0;
      await save(ok ? 'unpause-result' : 'unpause-held', {
        status: ok ? 'success' : 'held',
        start: { status: start.status, stderr: start.stderr },
        before: status,
        unpause: unpause ? { status: unpause.status, stdout: unpause.stdout } : null,
        after,
        exe,
        stopped: stopped.status,
        final: await show('ActiveState'),
      });
      if (!ok) throw new Error('UNPAUSE_NOT_AS_EXPECTED');
    } finally {
      if (stopped === null) await systemctl('stop', unit);
      await fs.unlink(key).catch(() => {});
    }
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
