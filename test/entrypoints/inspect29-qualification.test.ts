import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecords } from '../../src/records/index.js';
import { remainingMs } from '../runner/budget.js';
import { seedInspectedWork } from '../control/inspection-fixture.js';
import { checks, containedPath, inspectCopy, plan, redact } from './inspect29-qualification.js';
import { symlink, writeFile } from 'node:fs/promises';

// Ticket 29 recipe: import and --plan are inert; the copy-and-inspect path runs here over a TEMPORARY synthetic root (never the real one):
// real storage copy, real Records and session copies, the public Control without run, the read-only socket and the REAL CLI binary.
test('ticket 29 recipe: inert plan, own namespace q29-inspect-v1, copies only, no controller run, no GitHub', () => {
  const recipe = plan();
  assert.equal(recipe.namespace, '/home/sanmoo/software-factory-test/y5/q29-inspect-v2', 'v1 was consumed; v2 is a new namespace');
  assert.deepEqual(recipe.sources, ['q18-journey-v4', 'q25-cancel-v1']);
  assert.ok(recipe.never.some(item => /open or write a source/.test(item)));
  assert.ok(recipe.never.some(item => /start a controller/.test(item)));
});

test('recipe checks flag false zeros, unparsable output, secrets and unexplained logs', () => {
  const ok = { code: 0, bytes: 10, truncated: false, stderr: '', secrets: 0 };
  const passing = checks([{ ...ok, args: ['show', 'w'], json: { chain: {} } }, { ...ok, args: ['history', 'w'], json: { page: { returned: 1 } } },
    { ...ok, args: ['logs', 'w'], json: { listing: { state: 'complete', code: null } } },
    { ...ok, args: ['usage'], json: { works: [{ activities: [{ measurement: 'unavailable', tokens: null, cost: null }] }] } }]);
  assert.ok(passing.every(item => item.ok), JSON.stringify(passing));
  const failing = checks([{ ...ok, args: ['usage'], json: { works: [{ activities: [{ measurement: 'unavailable', tokens: { total: 0 }, cost: null }] }] } },
    { ...ok, args: ['logs', 'w'], json: { listing: { state: 'incomplete', code: null } } }, { ...ok, code: 1, args: ['status'], json: { note: 'ghs_' + 'a'.repeat(30) } }]);
  assert.deepEqual(failing.filter(item => !item.ok).map(item => item.name).sort(), ['chain', 'exit-codes', 'logs-complete', 'logs-explained', 'no-secret', 'usage-never-false-zero']);
});

test('recipe secrets: sk-proj-/sk-ant-/JWT/OAuth/GitHub shapes are found and redacted before anything is kept', () => {
  const samples = ['sk-proj-' + 'A'.repeat(40), 'sk-ant-api03-' + 'b'.repeat(40), 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl',
    '"refresh_token": "abc"', '"access_token":"x"', 'ya29.' + 'c'.repeat(30), 'ghs_' + 'd'.repeat(36), 'github_pat_' + 'e'.repeat(30), 'Bearer ' + 'f'.repeat(30)];
  for (const sample of samples) {
    const result = redact(`before ${sample} after`);
    assert.equal(result.found, 1, sample);
    assert.ok(!result.text.includes(sample) && result.text.includes('[REDACTED]'), sample);
  }
  assert.deepEqual(redact('plain sk-short text'), { text: 'plain sk-short text', found: 0 });
});

test('recipe paths: only normalized paths whose real path stays under root/r are copied, to the same place inside the copy', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'q29-paths-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'r', 'b'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'r', 'b', 's.jsonl'), 'x');
  await writeFile(join(root, 'outside'), 'x');
  await symlink(join(root, 'outside'), join(root, 'r', 'b', 'link.jsonl'));
  const copy = join(root, 'ns', 'copy');
  assert.equal(await containedPath(root, copy, join(root, 'r', 'b', 's.jsonl'), 'r'), 'r/b/s.jsonl');
  for (const bad of [`${root}/r/../../x`, `${root}/r/b/../../outside`, `${root}/r/./b/s.jsonl`, `${root}/outside`, join(root, 'r', 'b', 'link.jsonl'), 'r/b/s.jsonl', `${root}/r/b/missing`]) {
    assert.equal(await containedPath(root, copy, bad, 'r'), null, bad);
  }
});

test('recipe inspectCopy over a temporary root: source untouched; CLI chain shows history, logs pages and measured usage from the copies', { timeout: remainingMs() }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'q29-root-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src-a'), { mode: 0o700 });
  const work = await seedInspectedWork(join(root, 'src-a', 'control.sqlite'), root);
  for (const suffix of ['', '-wal', '-shm']) await chmod(join(root, 'src-a', `control.sqlite${suffix}`), 0o600).catch(() => {});
  const records = await createRecords({ root });
  const output = await records.openOutput({ workId: work, executionId: 'e-1', invocationId: 'i-1', role: 'builder', environmentRef: 'env', bootRef: 'b1', callId: 'c1' });
  await output.write(Buffer.from('x'.repeat(20000))); await output.finish();
  // As on the real q18 tree: ticket 17's preserved-evidence folder beside the captures (a known non-capture).
  const { preserveEvidence } = await import('../../src/records/index.js');
  assert.equal((await preserveEvidence({ root, workId: work, label: 'env-x', stage: async destination => {
    await mkdir(join(destination, 'review', 'r1'), { recursive: true, mode: 0o700 }); await writeFile(join(destination, 'review', 'r1', 'index.json'), '{}', { mode: 0o600 }); } })).status, 'preserved');
  const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
  const before = await sha(join(root, 'src-a', 'control.sqlite'));
  await mkdir(join(root, 'ns'), { mode: 0o700 });
  const observed = await inspectCopy({ root, source: 'src-a', copy: join(root, 'ns', 'src-a'), upgradeId: 'q29-test' });
  assert.equal(await sha(join(root, 'src-a', 'control.sqlite')), before, 'the source storage is never written');
  assert.ok(observed.checks.every(item => item.ok), JSON.stringify(observed.checks));
  const by = (name: string, ...more: string[]) => observed.results.filter(item => item.args[0] === name && more.every(arg => item.args.includes(arg)));
  const usage = by('usage', work)[0]!.json as { works: { total: { tokens: { total: number } | null; measurement: string } }[] };
  assert.deepEqual([usage.works[0]!.total.tokens?.total, usage.works[0]!.total.measurement], [185, 'partial'], 'measured from the COPIED session files through the CLI');
  const logs = by('logs', work, '--limit')[0]!.json as { listing: { state: string; preservedEvidence: number }; captures: unknown[] };
  assert.deepEqual([logs.listing.state, logs.listing.preservedEvidence, logs.captures.length], ['complete', 1, 1]);
  const pages = by('logs', '--read');
  assert.deepEqual(pages.map(item => (item.json as { state: string }).state), ['truncated', 'complete']);
  assert.equal(by('history', '--execution', 'e-1')[0]!.code, 0);
  assert.equal(observed.works[0]!.executions, 4);
  assert.deepEqual([observed.storage.before !== null, observed.storage.before === observed.storage.after], [true, true], 'the inspection wrote nothing to the copy');
});
