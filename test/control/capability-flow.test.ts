import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { untilHolds } from '../runner/budget.js';
import type { SandboxCapabilities } from '../../src/contracts/index.js';
import { openControl } from '../../src/control/index.js';
import type { Control, ListView, WorkView } from '../../src/control/types.js';
import { declaredEnvironmentSha256, githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { recoveryDoubles } from './recovery-doubles.js';

// v2 ticket 01 flow level (V2-03/V2-04): real Control + Pi Durable/SQLite + Records; doubled: GitHub (the declaration read included) and a
// TEST sandbox adapter that only declares capabilities (file-backed host of the recovery doubles), Builder and credentials. Not evidence of
// any real sandbox.
const digest = `sha256:${'a'.repeat(64)}`;
const withImages = { schemaVersion: 1 as const, apk: [], images: [{ reference: `docker.io/testcontainers/ryuk@${digest}` }] };
const full: SandboxCapabilities = { docker: true, persistentDisk: true, bootDuration: null, egress: { mediation: 'http', publicTcp: false, udp: false, ipv6: false, privateNetwork: false } };

async function harness(t: { after(fn: () => Promise<void>): void }, capabilities: SandboxCapabilities, declaration: NonNullable<Remote['environment']>) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-capability-flow-'));
  const world: Remote = { pulls: {}, issues: [remoteIssue(3)], environment: declaration };
  const github = githubDoubles(world);
  const doubles = recoveryDoubles(dir, []);
  const time = manualClock();
  const control: Control = await openControl({ storagePath: join(dir, 'control.sqlite'), runtimeInventory: 'empty',
    execution: { ...doubles.ports, sandbox: { ...doubles.ports.sandbox, capabilities } },
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] }, polling: { intervalSeconds: 60, clock: time.clock } });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  t.after(async () => { stop.abort(); await running; await rm(dir, { recursive: true, force: true }); });
  await time.sleeping();
  const work = async () => (((await control.inspect({ kind: 'list' })) as ListView).works as WorkView[]).find(item => item.ticket.number === 3)!;
  const until = (predicate: () => Promise<boolean> | boolean, label: string) => untilHolds(label, async () => {
    if (await predicate()) return true;
    if (time.isSleeping()) time.advance();
    return false;
  }, 5);
  return { doubles, work, until, time };
}
const declared = (declaration: typeof withImages) => ({ kind: 'declared' as const, commit: 'a'.repeat(40), sha256: declaredEnvironmentSha256, declaration });

test('V2-04: a repository whose declaration has images never starts on a sandbox that does not declare Docker: visible impediment naming the capability, nothing prepared', async t => {
  const h = await harness(t, { ...full, docker: false }, declared(withImages));
  await h.until(async () => (await h.work())?.environment?.state === 'pinned', 'declaration pinned');
  for (let i = 0; i < 3; i++) { h.time.advance(); await h.time.sleeping(); }
  const work = await h.work();
  const impediment = work.impediments.find(item => item.code === 'SANDBOX_CAPABILITY_MISSING');
  assert.ok(impediment, JSON.stringify(work.impediments));
  assert.equal(impediment.scope, 'work');
  assert.match(impediment.nextStep, /\bdocker\b/);
  assert.match(impediment.nextStep, /no fallback to another sandbox/);
  assert.equal(work.dispatch.state, 'held');
  assert.ok(work.dispatch.reasons.includes('SANDBOX_CAPABILITY_MISSING'), JSON.stringify(work.dispatch.reasons));
  assert.equal(work.execution, null, 'no Execution, no Slot, no reservation');
  assert.deepEqual([h.doubles.calls('prepare').length, h.doubles.calls('start').length], [0, 0], 'the sandbox is never asked to prepare or boot it');
});

test('V2-03: the same repository starts when the sandbox declares Docker; a declaration without images starts without it', async t => {
  const docker = await harness(t, full, declared(withImages));
  await docker.until(async () => (await docker.work()).execution?.end?.outcome === 'completed', 'started with Docker declared');
  assert.equal((await docker.work()).impediments.some(item => item.code === 'SANDBOX_CAPABILITY_MISSING'), false);
  const plain = await harness(t, { ...full, docker: false }, declared({ ...withImages, images: [] }));
  await plain.until(async () => (await plain.work()).execution?.end?.outcome === 'completed', 'started without requiring Docker');
});
