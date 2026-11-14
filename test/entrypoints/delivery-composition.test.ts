import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeProductionExecution } from '../../src/entrypoints/controller/composition.js';
import type { GitHubAccess } from '../../src/platform/github/index.js';

// Ticket 17: the production composition hands Control the REAL Sandbox removal and the Sandbox export -> Records preservation chain
// (records area = the installation root, never mounted). Exercised on a synthetic environment tree; no VM, GitHub or model.
const effective = { models: { builder: { provider: 'openai', model: 'gpt-6-luna' }, standards: { provider: 'openai', model: 'gpt-6-luna' }, spec: { provider: 'openai', model: 'gpt-6-luna' } },
  repositories: [{ repository: 'acme/project', installationId: 2, workflows: false }], concurrency: 1, sandbox: { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1' } };
const github = { appId: 1 } as unknown as GitHubAccess;
const guestAssets = { directory: '/release/guest', manifestSha256: 'a'.repeat(64) };

test('production composition preserves an own environment\'s evidence into <root>/<work>/evidence and composes the Sandbox removal', async t => {
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
  assert.deepEqual(await cleanup.preserve({ workId, environment }), { status: 'absent' }, 'no artifacts tree: nothing to preserve, never a fabricated reference');
  await mkdir(join(root, 'environments', environment, 'artifacts', 'review', 'r1'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'environments', environment, 'artifacts', 'review', 'r1', 'index.json'), '{"round":1}', { mode: 0o600 });
  const preserved = await cleanup.preserve({ workId, environment });
  assert.equal(preserved.status, 'preserved');
  if (preserved.status !== 'preserved') return;
  assert.deepEqual([preserved.reference.files, preserved.reference.bytes], [1, 11]);
  assert.equal(await readFile(join(root, workId, 'evidence', preserved.reference.id, 'files', 'review', 'r1', 'index.json'), 'utf8'), '{"round":1}');
  const removal = await cleanup.remove({ environment, cleanup: { workId: 'other-work', workDisposition: 'delivered', confirmed: true, evidencePreserved: true } });
  assert.notEqual(removal.status, 'success', 'the Sandbox never removes an environment it cannot prove belongs to that Work');
});
