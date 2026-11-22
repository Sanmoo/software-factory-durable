import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { composeProductionExecution } from '../../src/entrypoints/controller/composition.js';
import { recordWorkerLaunch } from '../../src/platform/host/index.js';
import type { GitHubAccess } from '../../src/platform/github/index.js';

// Ticket 17: the production composition hands Control the REAL Sandbox removal and the Sandbox export -> Records preservation chain
// (records area = the installation root, never mounted). Exercised on a synthetic environment tree; no VM, GitHub or model.
const effective = {
  models: {
    builder: { provider: 'openai', model: 'gpt-6-luna' },
    standards: { provider: 'openai', model: 'gpt-6-luna' },
    spec: { provider: 'openai', model: 'gpt-6-luna' },
  },
  repositories: [{ repository: 'acme/project', installationId: 2, workflows: false }],
  concurrency: 1,
  sandbox: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' },
};
const github = { appId: 1 } as unknown as GitHubAccess;
const guestAssets = { directory: '/release/guest', manifestSha256: 'a'.repeat(64) };

test("production composition preserves an own environment's evidence into <root>/<work>/evidence and composes the Sandbox removal", async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-delivery-composition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const composed = await composeProductionExecution({ root, effective, guestAssets, github });
  assert.equal(composed.status, 'composed');
  if (composed.status !== 'composed') return;
  const cleanup = composed.ports.cleanup!;
  assert.equal(typeof cleanup.remove, 'function');
  assert.equal(cleanup.retrySeconds, 86400, 'pending cleanup retried daily (plus each controller boot)');
  const workId = 'work-composition';
  const environment = `env-${createHash('sha256').update(workId).digest('hex')}` as never;
  assert.deepEqual(
    await cleanup.preserve({ workId, environment }),
    { status: 'absent' },
    'no artifacts tree: nothing to preserve, never a fabricated reference',
  );
  await mkdir(join(root, 'environments', environment, 'artifacts', 'review', 'r1'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'environments', environment, 'artifacts', 'review', 'r1', 'index.json'), '{"round":1}', { mode: 0o600 });
  const preserved = await cleanup.preserve({ workId, environment });
  assert.equal(preserved.status, 'preserved');
  if (preserved.status !== 'preserved') return;
  assert.deepEqual([preserved.reference.files, preserved.reference.bytes], [1, 11]);
  assert.equal(await readFile(join(root, workId, 'evidence', preserved.reference.id, 'files', 'review', 'r1', 'index.json'), 'utf8'), '{"round":1}');
  const removal = await cleanup.remove({
    environment,
    cleanup: { workId: 'other-work', workDisposition: 'delivered', confirmed: true, evidencePreserved: true },
  });
  assert.notEqual(removal.status, 'success', 'the Sandbox never removes an environment it cannot prove belongs to that Work');
});

test('ticket 30: production composition copies a recorded Builder session out of its runtime tree (hash-verified) and composes retention from `retentionDays`', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'factory-retention-composition-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const composed = await composeProductionExecution({ root, effective: { ...effective, retentionDays: 9 }, guestAssets, github });
  assert.equal(composed.status, 'composed');
  if (composed.status !== 'composed') return;
  const cleanup = composed.ports.cleanup!;
  assert.deepEqual([cleanup.retentionDays, cleanup.sweepSeconds], [9, 86400], 'configured days; boot sweep + daily');
  const details = cleanup.details!;
  const sessions = join(root, 'r', 'seg', 'w-abc', 'profile', 'sessions');
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const data = Buffer.from(`${JSON.stringify({ type: 'session', version: 3, id: 's-1', cwd: '/workspace' })}\n`);
  await writeFile(join(sessions, 'one.jsonl'), data, { mode: 0o600 });
  const sha256 = createHash('sha256').update(data).digest('hex');
  const session = {
    ref: 'r/seg/w-abc/profile/sessions/one.jsonl',
    sessionId: 's-1',
    sha256,
    bytes: data.length,
    format: 'pi-session-jsonl-v3' as const,
    profile: { sdkProfile: 'p', providerId: 'x', modelId: 'y', skillPack: null, tools: [] },
  };
  assert.deepEqual(await details.preserveSession({ workId: 'work-r', executionId: 'e-1', session: { ...session, sha256: 'f'.repeat(64) } }), {
    status: 'failed',
    code: 'SESSION_ALTERED',
  });
  // Every agent session of the boot (a reviewer's too), each read confined with its hash; an absent runtime lists nothing.
  const boot = 'boot-11111111-2222-4333-8444-555555555555';
  const runtime = join(root, 'r', Buffer.from(boot.slice(5).replaceAll('-', ''), 'hex').toString('base64url'));
  await mkdir(join(runtime, 'w-rev', 'profile', 'sessions'), { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, 'w-rev', 'profile', 'sessions', 'r.jsonl'), data, { mode: 0o600 });
  assert.deepEqual(await details.runtimeSessions!({ boot }), [
    { ref: relative(root, join(runtime, 'w-rev', 'profile', 'sessions', 'r.jsonl')), sha256, bytes: data.length },
  ]);
  assert.deepEqual(await details.runtimeSessions!({ boot: 'boot-99999999-2222-4333-8444-555555555555' }), []);
  // Finding A7: the session of an invocation that never returned is attributed by the launch record of its worker directory, never guessed.
  const invocation = { workId: 'work-r', boot, executionId: 'e-lost', invocationId: 'builder-lost' };
  assert.equal(await details.lostSession!(invocation), null, 'no launch record names that invocation');
  await recordWorkerLaunch(join(runtime, 'w-rev'), { workId: 'work-r', executionId: 'e-lost', invocationId: 'builder-lost', role: 'builder' });
  assert.deepEqual(await details.lostSession!(invocation), {
    ref: relative(root, join(runtime, 'w-rev', 'profile', 'sessions', 'r.jsonl')),
    sha256,
    bytes: data.length,
  });
  assert.equal(await details.lostSession!({ ...invocation, workId: 'other-work' }), null);
  assert.equal(await details.lostSession!({ ...invocation, boot: 'boot-99999999-2222-4333-8444-555555555555' }), null);
  assert.deepEqual(
    await details.preserveSession({
      workId: 'work-r',
      executionId: 'e-1',
      name: 'e-1--rv-0123456789abcdef',
      session: { ref: relative(root, join(runtime, 'w-rev', 'profile', 'sessions', 'r.jsonl')), sha256, bytes: data.length },
    }),
    { status: 'preserved', sha256, bytes: data.length },
  );
  // Review LOW: an empty or non-session file is an opaque hashed copy (never blocking); only an unsafe file is reported with its code.
  await writeFile(join(runtime, 'w-rev', 'profile', 'sessions', 'bad.jsonl'), 'not a session header', { mode: 0o600 });
  await writeFile(join(runtime, 'w-rev', 'profile', 'sessions', 'empty.jsonl'), '', { mode: 0o600 });
  await symlink('/etc/hostname', join(runtime, 'w-rev', 'profile', 'sessions', 'link.jsonl'));
  const listed = await details.runtimeSessions!({ boot });
  const refOf = (name: string) => relative(root, join(runtime, 'w-rev', 'profile', 'sessions', name));
  assert.deepEqual(
    listed.find(item => item.ref === refOf('bad.jsonl')),
    { ref: refOf('bad.jsonl'), sha256: createHash('sha256').update('not a session header').digest('hex'), bytes: 20 },
  );
  assert.deepEqual(
    listed.find(item => item.ref === refOf('empty.jsonl')),
    { ref: refOf('empty.jsonl'), sha256: createHash('sha256').update('').digest('hex'), bytes: 0 },
  );
  assert.deepEqual(
    listed.find(item => item.ref === refOf('link.jsonl')),
    { ref: refOf('link.jsonl'), code: 'SESSION_PATH_UNSAFE' },
  );
  assert.deepEqual(
    await details.preserveSession({
      workId: 'work-r',
      executionId: 'e-1',
      name: 'e-1--rv-00000000000000ee',
      session: { ref: refOf('empty.jsonl'), sha256: createHash('sha256').update('').digest('hex'), bytes: 0 },
    }),
    { status: 'preserved', sha256: createHash('sha256').update('').digest('hex'), bytes: 0 },
  );
  assert.deepEqual(await details.preserveSession({ workId: 'work-r', executionId: 'e-1', session }), { status: 'preserved', sha256, bytes: data.length });
  assert.equal(await readFile(join(root, 'work-r', 'sessions', 'e-1.jsonl'), 'utf8'), data.toString());
  assert.deepEqual(
    await details.preserveSession({ workId: 'work-r', executionId: 'e-2', session: { ...session, ref: 'r/seg/w-abc/profile/sessions/gone.jsonl' } }),
    { status: 'lost', code: 'SESSION_FILE_MISSING' },
  );
  assert.deepEqual((await details.list({ workId: 'work-r' })).items.map(item => item.id).sort(), [
    'session:e-1',
    'session:e-1--rv-00000000000000ee',
    'session:e-1--rv-0123456789abcdef',
  ]);
  assert.deepEqual(await details.remove({ workId: 'work-r', item: { id: 'session:e-1', kind: 'session', executionId: 'e-1' }, expectedSha256: sha256 }), {
    outcome: 'removed',
    code: null,
  });
});
