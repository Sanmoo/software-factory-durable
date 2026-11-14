import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { buildRelease } from '../../src/entrypoints/release-build.js';
import { inventoryTree } from '../../src/entrypoints/release.js';
import { builtRelease, canaryPath, check, id, type Check } from './release-fixture.js';

// I-local (ticket 32): clean and repeated installation from the extracted release, offline diagnostics, foreground/service lock and the
// production composition refusal, all with the release's private Node.
let work: string, root: string, report: Awaited<ReturnType<typeof buildRelease>>, factory: Awaited<ReturnType<typeof builtRelease>>['factory'];
before(async () => ({ work, root, report, factory } = await builtRelease()));
after(async () => { if (work) await rm(work, { recursive: true, force: true }); });

test('extracted release: repeated setup and offline doctor verify integrity with the private Node, preserve everything and never install or escalate', async () => {
  const canaries = join(work, 'canaries');
  const PATH = await canaryPath(canaries);
  const before = JSON.stringify(await inventoryTree(join(root, 'releases'))) + JSON.stringify(await inventoryTree(join(root, 'assets')));
  const config = join(work, 'xdg-plain');
  // XDG_CONFIG_HOME set: a plain setup writes no service definition (registration only on explicit request).
  const first = factory(root, ['setup', '--json'], { PATH, NODE_OPTIONS: '--require /nonexistent-personal-hook.cjs', XDG_CONFIG_HOME: config });
  assert.equal(first.status, 0, first.stderr);
  const prepared = JSON.parse(first.stdout);
  assert.equal(prepared.root, root);
  assert.deepEqual(prepared.created.sort(), ['config.yaml', 'credentials', 'data', 'environments', 'run']);
  const checks: Check[] = prepared.diagnostics.checks;
  for (const name of ['release:integrity', 'release:location', 'release:selected', 'release:node', 'release:assets', 'permissions:releases', 'permissions:assets',
    'guest-assets:manifest', 'guest-assets:kernel', 'guest-assets:initramfs', 'guest-assets:rootfs']) assert.equal(check(checks, name)?.status, 'ok', name);
  assert.equal(check(checks, 'release:qualification')?.status, 'unverified');
  assert.equal(check(checks, 'kvm-functional')?.status, 'unverified');
  assert.equal(prepared.diagnostics.release.release, id);
  assert.equal(prepared.diagnostics.release.manifestSha256, report.manifestSha256);
  assert.equal(prepared.diagnostics.versions.node, '24.21.0');
  await assert.rejects(stat(config), { code: 'ENOENT' });
  // Complete configuration with the release's single supported worker profile, then setup again: nothing created or overwritten.
  const configuration = (await readFile(join(root, 'config.yaml'), 'utf8')).replace('operators: []', 'operators: [operador]')
    .replaceAll('{ provider: null, model: null }', '{ provider: openai, model: gpt-6-luna }').replace('appId: null', 'appId: 123');
  await writeFile(join(root, 'config.yaml'), configuration);
  await writeFile(join(root, 'credentials', 'github-app.pem'), 'synthetic-never-read', { mode: 0o600 });
  await writeFile(join(root, 'data', 'unknown'), 'preserved');
  // Repeated setup: nothing created or overwritten, and no service definition without the explicit request.
  const second = factory(root, ['setup', '--json'], { PATH, XDG_CONFIG_HOME: config });
  assert.equal(second.status, 0, second.stderr);
  const repeated = JSON.parse(second.stdout);
  assert.equal(repeated.service, undefined);
  await assert.rejects(stat(config), { code: 'ENOENT' });
  assert.deepEqual(repeated.created, []);
  assert.equal(repeated.diagnostics.configuration.valid, true, JSON.stringify(repeated.diagnostics.configuration));
  for (const role of ['builder', 'standards', 'spec']) assert.equal(check(repeated.diagnostics.checks, `worker-profile:${role}`)?.status, 'ok', role);
  assert.equal(await readFile(join(root, 'config.yaml'), 'utf8'), configuration);
  assert.equal(await readFile(join(root, 'credentials', 'github-app.pem'), 'utf8'), 'synthetic-never-read');
  assert.equal(await readFile(join(root, 'data', 'unknown'), 'utf8'), 'preserved');
  assert.deepEqual(await readdir(join(root, 'environments')), []);
  assert.deepEqual(await readdir(join(root, 'run')), []);
  assert.doesNotMatch(first.stdout + second.stdout + first.stderr + second.stderr, /synthetic-never-read/);
  await assert.rejects(stat(join(canaries, 'canary')), { code: 'ENOENT' }, 'no installer, package manager, host Node or escalation was invoked');
  assert.equal(JSON.stringify(await inventoryTree(join(root, 'releases'))) + JSON.stringify(await inventoryTree(join(root, 'assets'))), before);
});

test('foreground run and the explicitly requested user service use the same stable lock; setup registers nothing unless asked', async () => {
  const lock = join(root, 'data', 'control.lock');
  await writeFile(lock, '', { mode: 0o600, flag: 'a' });
  const holder = spawn('flock', ['--exclusive', '--no-fork', lock, 'sleep', '30'], { stdio: 'ignore' });
  const released = new Promise(resolve => holder.once('exit', resolve));
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const second = factory(root, ['run']);
    assert.equal(second.status, 73, second.stderr);
    assert.match(second.stderr, /CONTROLLER_ALREADY_RUNNING/);
  } finally { holder.kill('SIGKILL'); await released; }
  // Production composition from the release: a role without the release worker profile refuses the start before storage (no fallback).
  const current = await readFile(join(root, 'config.yaml'), 'utf8');
  await writeFile(join(root, 'config.yaml'), current.replace('spec: { provider: openai, model: gpt-6-luna }', 'spec: { provider: openai, model: other-model }'));
  try {
    const unsupported = factory(root, ['run']);
    assert.equal(unsupported.status, 2, unsupported.stderr);
    assert.match(unsupported.stderr, /"code":"CONFIGURATION_UNSUPPORTED","reason":"WORKER_PROFILE_UNSUPPORTED","roles":\["spec"\]/);
    await assert.rejects(stat(join(root, 'data', 'control.sqlite')), { code: 'ENOENT' });
  } finally { await writeFile(join(root, 'config.yaml'), current); }
  // The unit goes to an explicit absolute directory (or, without it, the account's standard path, never an environment-selected one: see
  // the setup unit test). Tests always pass the directory so the real account is never touched; HOME/XDG_CONFIG_HOME are decoys.
  const decoys = { HOME: join(work, 'home-decoy'), XDG_CONFIG_HOME: join(work, 'xdg-decoy') };
  const units = join(work, 'units');
  const service = factory(root, ['setup', '--service', '--service-directory', units, '--json'], decoys);
  assert.equal(service.status, 0, service.stderr);
  const result = JSON.parse(service.stdout);
  const unit = join(units, result.service.unit);
  assert.deepEqual({ path: result.service.path, state: result.service.state, registered: result.service.registered }, { path: unit, state: 'created', registered: false });
  for (const decoy of Object.values(decoys)) await assert.rejects(stat(decoy), { code: 'ENOENT' });
  const text = await readFile(unit, 'utf8');
  assert.match(text, new RegExp(`^ExecStart=${root}/factory run$`, 'm'));
  assert.match(text, /^Restart=no$/m);
  assert.match(text, /^NoNewPrivileges=yes$/m);
  assert.doesNotMatch(text, /^(User|Group|AmbientCapabilities|CapabilityBoundingSet|ExecStartPre)=/m);
  assert.doesNotMatch(text, /sudo|--root/);
  // Only absolute canonical directories, and only together with --service.
  assert.equal(factory(root, ['setup', '--service', '--service-directory', 'relative', '--json'], decoys).status, 2);
  assert.equal(factory(root, ['setup', '--service', '--service-directory', `${units}/../units`, '--json'], decoys).status, 2);
  assert.equal(factory(root, ['setup', '--service-directory', units, '--json'], decoys).status, 2);
  // Repeated request with an unsupported model: the definition is preserved and doctor diagnoses the role, never replaces the model.
  const configuration = await readFile(join(root, 'config.yaml'), 'utf8');
  await writeFile(join(root, 'config.yaml'), configuration.replace('builder: { provider: openai, model: gpt-6-luna }', 'builder: { provider: other, model: other-model }'));
  const again = factory(root, ['setup', '--service', '--service-directory', units, '--json'], decoys);
  await writeFile(join(root, 'config.yaml'), configuration);
  const repeated = JSON.parse(again.stdout);
  assert.equal(repeated.service.state, 'preserved');
  assert.equal(check(repeated.diagnostics.checks, 'worker-profile:builder')?.status, 'blocked');
  assert.equal(check(repeated.diagnostics.checks, 'worker-profile:spec')?.status, 'ok');
  await writeFile(unit, '# operator edited\n');
  const conflict = factory(root, ['setup', '--service', '--service-directory', units, '--json'], decoys);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /SERVICE_UNIT_CONFLICT/);
  assert.equal(await readFile(unit, 'utf8'), '# operator edited\n');
  assert.equal(resolve(root), root);
});
