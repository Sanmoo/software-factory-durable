import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { ended } from '../runner/budget.js';

// Ticket 37 (approved). P2: modes that only vary the requested edit share ONE adapter→owner boot, one activation (new worker Node) each.
// P3: the three "Edit disabled" activations (no budget, Standards, Spec) are one test over one boot. Modes that leave uncertainty,
// revoke or cut the owner's channel (and `invalid`, which never launches) keep their own boot.
const shared = ['complete', 'mismatch', 'no-match', 'empty', 'budget'];
const disabledModes = ['absent', 'standards', 'spec'];
const isolated = ['invalid', 'uncertain', 'persist', 'cancel', 'eof', 'secret'];

type Chain = { root: string; code: number | null; output: string; audit: string[] };
const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

async function chain(modes: string): Promise<Chain> {
  const root = await mkdtemp('/tmp/ne-');
  roots.push(root);
  const environment = `env-${createHash('sha256').update('producer-ordering-work').digest('hex')}`;
  const child = fork(fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)), [root, environment, `boot-${randomUUID()}`], {
    execArgv: ['--experimental-test-module-mocks', '--import', fileURLToPath(new URL('../sandbox/adapter-diagnostics-fixture.js', import.meta.url))],
    env: { ...process.env, ADAPTER_DIAGNOSTIC_FIXTURE_MODE: 'normal-worker', TASK114_EDIT: modes, NODE_DISABLE_COMPILE_CACHE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true,
  });
  let output = ''; child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
  // No fixed 15 s per-test timeout (expired at ci load 18): the chain's own end, bounded by the runner budget.
  const { code } = await ended(child, () => { try { return readFileSync(join(root, 'audit'), 'utf8').trim().split('\n').slice(-3).join(' | '); } catch { return 'no audit yet'; } });
  return { root, code, output, audit: existsSync(join(root, 'audit')) ? (await readFile(join(root, 'audit'), 'utf8')).trim().split('\n') : [] };
}
const chains = new Map<string, Promise<Chain>>();
const once = (modes: string[]) => { const key = modes.join(','); if (!chains.has(key)) chains.set(key, chain(key)); return chains.get(key)!; };

/** One mode's lines (and its edit-result file) within a shared boot, or the whole boot of an isolated mode. */
async function activation(mode: string, run: Chain, batched: boolean) {
  if (!batched) {
    assert.equal(run.code, 0, run.output + '\n' + run.audit.join('\n'));
    return { audit: run.audit, result: join(run.root, 'edit-result') };
  }
  const error = join(run.root, `mode-error-${mode}`);
  assert.equal(existsSync(error), false, existsSync(error) ? readFileSync(error, 'utf8') : '');
  const begin = run.audit.indexOf(`mode-begin:${mode}`), end = run.audit.indexOf(`mode-end:${mode}`);
  assert.ok(begin >= 0 && end > begin, run.output);
  return { audit: run.audit.slice(begin + 1, end), result: join(run.root, `edit-result-${mode}`) };
}

async function check(mode: string, run: Chain, batched: boolean) {
  const { audit, result } = await activation(mode, run, batched);
  const disabled = ['absent', 'invalid', 'standards', 'spec'].includes(mode);
  const critical = ['uncertain', 'persist', 'budget', 'cancel', 'eof', 'secret'].includes(mode);
  assert.equal(audit.filter(x => x === 'worker-spawn').length, mode === 'invalid' ? 0 : 1, mode);
  assert.equal(audit.filter(x => x.includes('"kind":"provider-request"')).length, mode === 'invalid' ? 0 : disabled || critical ? 1 : ['mismatch', 'no-match'].includes(mode) ? 3 : 2, mode);
  assert.equal(audit.filter(x => x.includes('"kind":"provider-validated"')).length, audit.filter(x => x.includes('"kind":"provider-request"')).length, mode);
  assert.equal(audit.filter(x => x === 'edit-create').length, disabled || critical ? 0 : 1, mode);
  assert.equal(audit.filter(x => x === 'edit-commit').length, disabled || ['budget', 'cancel', 'eof', 'empty', 'secret'].includes(mode) ? 0 : mode === 'mismatch' ? 2 : 1, mode);
  if (!disabled && !['budget', 'cancel', 'eof', 'empty', 'secret'].includes(mode)) assert.equal(await readFile(result, 'utf8'), '﻿new\r\nsafe █\r\n', mode);
  assert.equal(audit.filter(x => x === 'edit-capture').length, disabled ? 0 : ['mismatch', 'no-match'].includes(mode) ? 2 : 1, mode);
  if (mode === 'persist') assert.ok(audit.includes('edit-result-evidence-failed'));
  assert.ok(audit.includes('normal-edit-passed'), mode);
  assert.doesNotMatch(run.output, /synthetic-secret|synthetic-key/);
}

for (const mode of [...shared, ...isolated]) {
  test(`normal public Host -> owner -> new Node native Edit: ${mode}`, async () => {
    const batched = shared.includes(mode);
    await check(mode, await (batched ? once(shared) : chain(mode)), batched);
  });
}

test(`normal public Host -> owner -> new Node native Edit disabled (${disabledModes.join(', ')}): only Read/Write tools, no capture or commit`, async () => {
  const run = await once(disabledModes);
  for (const mode of disabledModes) await check(mode, run, true);
});

test('each shared Edit boot ends cleanly, once, after one new worker Node per activation', async () => {
  for (const modes of [shared, disabledModes]) {
    const run = await once(modes);
    assert.equal(run.code, 0, run.output);
    assert.equal(run.audit.filter(line => line === 'close').length, 1);
    assert.ok(run.audit.indexOf('close') > run.audit.indexOf(`mode-end:${modes.at(-1)}`));
    assert.equal(run.audit.filter(line => line === 'worker-spawn').length, modes.length);
  }
});
