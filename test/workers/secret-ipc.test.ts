import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecords } from '../../src/records/index.js';
import { createSecretPublisher, createOwnerSecretReceiver } from '../../src/platform/host/index.js';
import { remainingMs } from '../runner/budget.js';

const context = { workId: 'work', executionId: 'exec', invocationId: 'invocation', role: 'spec' as const,
  environmentRef: 'environment', bootRef: 'boot', phaseId: 'phase' };
const values = ['synthetic-access-168', 'synthetic-refresh-168', 'synthetic-client-168'];
class Wire extends EventEmitter {
  connected = true;
  sent: Record<string, unknown>[] = [];
  sendError = false;
  send(message: Record<string, unknown>, callback: (error: Error | null) => void) {
    this.sent.push(message);
    callback(this.sendError ? new Error(values[0]) : null);
    return true;
  }
}
function setup(timeoutMs = 1000) {
  const wire = new Wire(), abort = new AbortController();
  const publisher = createSecretPublisher(wire, context, abort.signal, timeoutMs);
  publisher.protectedStarted();
  return { wire, abort, publisher };
}
const ack = (request: Record<string, unknown>) => ({ kind: 'worker-secret-ack', version: 1, id: request.id, context: request.context });
const denied = (promise: Promise<unknown>) => assert.rejects(promise, error => {
  assert.deepEqual(error, { code: 'SECRET_SYNC_DENIED' });
  assert.doesNotMatch(JSON.stringify(error), /synthetic-/);
  return true;
});

test('protected start, one pending, held ACK and post-await original-signal fence', async () => {
  const wire = new Wire(), abort = new AbortController();
  const early = createSecretPublisher(wire, context, abort.signal);
  await denied(early.acknowledgeSecrets(values));
  early.protectedStarted();
  await denied(early.acknowledgeSecrets(values));
  assert.equal(wire.sent.length, 0);
  const f = setup();
  let uses = 0;
  const pending = f.publisher.acknowledgeSecrets(values).then(() => { uses++; });
  await Promise.resolve();
  assert.equal(uses, 0);
  await denied(f.publisher.acknowledgeSecrets(values));
  await denied(pending);
  assert.equal(f.wire.sent.length, 1);
  assert.equal(f.wire.listenerCount('message'), 0);
  const g = setup();
  const original = g.publisher.acknowledgeSecrets(values);
  g.wire.emit('message', ack(g.wire.sent[0]!));
  g.abort.abort();
  await denied(original);
  assert.equal(uses, 0);
});

test('ticket 37: the production ACK wait is 5000 ms when no Host policy shortens it (undefined is the default, as the worker passes it)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const timeoutMs of [undefined, 5000]) {
    const wire = new Wire(), abort = new AbortController();
    const publisher = createSecretPublisher(wire, context, abort.signal, timeoutMs);
    publisher.protectedStarted();
    let settled = false;
    const pending = publisher.acknowledgeSecrets(values).finally(() => { settled = true; });
    void pending.catch(() => {});
    t.mock.timers.tick(4999);
    await Promise.resolve();
    assert.equal(settled, false, 'still waiting for the owner ACK at 4999 ms');
    t.mock.timers.tick(1);
    await denied(pending);
    assert.equal(wire.listenerCount('message'), 0);
  }
});

test('all seven context fields, wrong UUID/version, unknown fields and malformed replies latch', async () => {
  const mutations: ((reply: Record<string, unknown>) => unknown)[] = [
    ...Object.keys(context).map(key => (reply: Record<string, unknown>) => ({ ...reply, context: { ...context, [key]: 'other' } })),
    reply => ({ ...reply, id: '00000000-0000-4000-8000-000000000000' }),
    reply => ({ ...reply, id: 'not-uuid' }), reply => ({ ...reply, version: 2 }),
    reply => ({ ...reply, value: values[0] }), () => null,
    reply => ({ ...reply, kind: 'worker-secret-error', code: values[0] }),
  ];
  for (const mutate of mutations) {
    const f = setup();
    const pending = f.publisher.acknowledgeSecrets(values);
    f.wire.emit('message', mutate(ack(f.wire.sent[0]!)));
    await denied(pending);
    await denied(f.publisher.acknowledgeSecrets(values));
    assert.equal(f.wire.listenerCount('message'), 0);
  }
});

test('unsolicited, duplicate, late, EOF, exit, abort, send failures and deadline clean listeners', async () => {
  for (const mode of ['unsolicited', 'duplicate', 'disconnect', 'exit', 'error', 'abort', 'send', 'timeout']) {
    const f = setup(5);
    if (mode === 'unsolicited') f.wire.emit('message', ack({ id: '00000000-0000-4000-8000-000000000000', context }));
    if (mode === 'send') f.wire.sendError = true;
    const pending = f.publisher.acknowledgeSecrets(values);
    if (mode === 'duplicate') {
      f.wire.emit('message', ack(f.wire.sent[0]!));
      await pending;
      f.wire.emit('message', ack(f.wire.sent[0]!));
    } else {
      if (mode === 'abort') f.abort.abort();
      else if (['disconnect', 'exit', 'error'].includes(mode)) f.wire.emit(mode);
      await denied(pending);
    }
    f.wire.emit('message', ack(f.wire.sent[0] ?? {}));
    await denied(f.publisher.acknowledgeSecrets(values));
    for (const event of ['message', 'disconnect', 'exit', 'error']) assert.equal(f.wire.listenerCount(event), 0);
  }
});

test('full serialized UTF8 budget includes JSON escaping, NUL and non-ASCII; invalid values never send', async () => {
  for (const input of [[], ['', 'x'], ['x'.repeat(4097)], ['a', 'b', 'c', 'd'], Array(3).fill('\0'.repeat(4096)), ['\0'.repeat(4096), '\0'.repeat(4096), '漢'.repeat(4096)]]) {
    const f = setup();
    await denied(f.publisher.acknowledgeSecrets(input));
    assert.equal(f.wire.sent.length, 0);
  }
  const f = setup();
  const pending = f.publisher.acknowledgeSecrets(['quote"slash\\nul\0漢']);
  assert.ok(Buffer.byteLength(JSON.stringify(f.wire.sent[0])) <= 49152);
  f.wire.emit('message', { kind: 'abort' }); // legal lifecycle demux, not an ACK
  f.wire.emit('message', ack(f.wire.sent[0]!));
  await pending;
  f.publisher.close();
});

test('owner readiness, context, duplicate, capacity and send failures revoke only bound lifetime', async () => {
  for (const mode of ['early', 'context', 'version', 'unknown', 'id', 'duplicate', 'capacity', 'send', 'closed']) {
    const wire = new Wire(), abort = new AbortController();
    let registrations = 0, failures = 0;
    const receiver = createOwnerSecretReceiver(wire, context, abort.signal, () => mode !== 'early', value => {
      registrations++;
      if (mode === 'capacity') throw new Error(value);
    }, () => { failures++; abort.abort(); });
    let request: Record<string, unknown> = { kind: 'worker-secret-register', version: 1,
      id: '00000000-0000-4000-8000-000000000000', context, values };
    if (mode === 'context') request = { ...request, context: { ...context, bootRef: 'different' } };
    if (mode === 'version') request.version = 2;
    if (mode === 'unknown') request.extra = values[0];
    if (mode === 'id') request.id = 'bad';
    if (mode === 'send') wire.sendError = true;
    if (mode === 'closed') abort.abort();
    wire.emit('message', { kind: 'worker-started', receipt: { workId: context.workId, id: '00000000-0000-4000-8000-000000000000' } });
    wire.emit('message', request);
    if (mode === 'duplicate') wire.emit('message', request);
    assert.equal(failures, 1);
    assert.equal(registrations, ['duplicate', 'send'].includes(mode) ? 3 : mode === 'capacity' ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(wire.sent), /synthetic-/);
    receiver.close();
  }
});

test('source context and values snapshot survive caller mutation and async send; malformed lifecycle is denied', async () => {
  const wire = new Wire(), abort = new AbortController();
  const source = { ...context }, secrets = [...values];
  let sendCallback!: (error: Error | null) => void;
  wire.send = (message, callback) => { wire.sent.push(message); sendCallback = callback; return true; };
  const publisher = createSecretPublisher(wire, source, abort.signal);
  publisher.protectedStarted();
  source.phaseId = 'mutated';
  const publication = publisher.acknowledgeSecrets(secrets);
  secrets[0] = 'mutated-token';
  assert.deepEqual(wire.sent[0]!.context, context);
  assert.deepEqual(wire.sent[0]!.values, values);
  wire.emit('message', ack(wire.sent[0]!));
  sendCallback(null);
  await publication;
  wire.emit('message', { kind: 'abort', extra: 'invalid' });
  await denied(publisher.acknowledgeSecrets(values));
});

test('send throws are contained; closed error ACK denies; bounded correlation tombstones refuse replay and overflow', async () => {
  const f = setup();
  f.wire.send = () => { throw new Error(values[0]); };
  await denied(f.publisher.acknowledgeSecrets(values));
  const g = setup();
  const pending = g.publisher.acknowledgeSecrets(values);
  g.wire.emit('message', { ...ack(g.wire.sent[0]!), kind: 'worker-secret-error', code: 'SECRET_SYNC_DENIED' });
  await denied(pending);
  const wire = new Wire(), abort = new AbortController();
  let registrations = 0, failures = 0;
  createOwnerSecretReceiver(wire, context, abort.signal, () => true, () => { registrations++; }, () => { failures++; });
  for (let i = 0; i < 129; i++) wire.emit('message', { kind: 'worker-secret-register', version: 1,
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, context, values });
  assert.equal(registrations, 128 * 3); assert.equal(failures, 1); assert.equal(wire.sent.length, 128);
});

test('owner all-seven context matrix rejects before registration; other child cannot settle pending ACK', async () => {
  for (const key of Object.keys(context)) {
    const wire = new Wire(), signal = new AbortController();
    let attempts = 0, failures = 0;
    const receiver = createOwnerSecretReceiver(wire, context, signal.signal, () => true, () => { attempts++; }, () => { failures++; });
    wire.emit('message', { kind: 'worker-secret-register', version: 1, id: '00000000-0000-4000-8000-000000000000',
      context: { ...context, [key]: key === 'role' ? 'standards' : 'other' }, values });
    assert.equal(attempts, 0); assert.equal(failures, 1); assert.equal(wire.sent.length, 0);
    receiver.close();
  }
  const a = setup(5), b = setup();
  const pending = a.publisher.acknowledgeSecrets(values);
  b.wire.emit('message', ack(a.wire.sent[0]!));
  await denied(pending);
  await denied(b.publisher.acknowledgeSecrets(values));
});

test('actual registry128 exhaustion produces only closed error, no ACK, and retains partial registrations', async () => {
  const root = await mkdtemp('/tmp/s168c-');
  const records = await createRecords({ root });
  for (let i = 0; i < 127; i++) records.registerSecret(`capacity-token-${i}`);
  const wire = new Wire(), abort = new AbortController();
  let attempts = 0, failures = 0;
  const receiver = createOwnerSecretReceiver(wire, context, abort.signal, () => true, value => {
    attempts++; records.registerSecret(value);
  }, () => { failures++; });
  wire.emit('message', { kind: 'worker-secret-register', version: 1, id: '00000000-0000-4000-8000-000000000000', context, values });
  assert.equal(attempts, 2); assert.equal(failures, 1);
  assert.deepEqual(wire.sent.map(frame => frame.kind), ['worker-secret-error']);
  assert.doesNotMatch(JSON.stringify(wire.sent), /synthetic-/);
  records.registerSecret(values[0]!); // retained even though later registration failed
  assert.throws(() => records.registerSecret('another-token'), /PROTECTED_CAPTURE_UNAVAILABLE/);
  receiver.close();
});

test('owner pending ACK callback deadline, concurrent request, and post-abort late send cannot resurrect', async () => {
  for (const mode of ['deadline', 'concurrent', 'abort']) {
    const wire = new Wire(), abort = new AbortController();
    let callback!: (error: Error | null) => void, failures = 0, registrations = 0, sends = 0;
    wire.send = (_message, cb) => { sends++; callback = cb; return true; };
    createOwnerSecretReceiver(wire, context, abort.signal, () => true, () => { registrations++; }, () => { failures++; }, 5);
    const request = { kind: 'worker-secret-register', version: 1, id: '00000000-0000-4000-8000-000000000000', context, values };
    wire.emit('message', request);
    if (mode === 'concurrent') wire.emit('message', { ...request, id: '00000000-0000-4000-8000-000000000001' });
    if (mode === 'abort') abort.abort();
    if (mode === 'deadline') await new Promise(resolve => setTimeout(resolve, 10));
    callback(null);
    wire.emit('message', { ...request, id: '00000000-0000-4000-8000-000000000002' });
    assert.equal(failures, 1); assert.equal(sends, 1); assert.equal(registrations, 3);
    assert.equal(wire.listenerCount('message'), 0);
  }
});

test('actual fixed standalone child denies dependent use on real IPC EOF, forged ACK and owner registry exhaustion', { timeout: remainingMs() }, async () => {
  for (const mode of ['eof', 'forged', 'capacity']) {
    const root = await mkdtemp('/tmp/s168n-'), workerRoot = join(root, 'w');
    await mkdir(workerRoot, { mode: 0o700 });
    const owner = await createRecords({ root });
    if (mode === 'capacity') for (let i = 0; i < 128; i++) owner.registerSecret(`full-registry-${i}`);
    const child = fork(new URL('./secret-ipc.fixture.js', import.meta.url), [], {
      execPath: '/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node', execArgv: [],
      env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '', requests = 0, uses = 0, failures = 0, registrations = 0;
    child.stdout!.on('data', chunk => { output += String(chunk); });
    child.stderr!.on('data', chunk => { output += String(chunk); });
    const abort = new AbortController();
    const receiver = mode === 'capacity' ? createOwnerSecretReceiver(child, context, abort.signal, () => true, value => {
      registrations++; owner.registerSecret(value);
    }, () => { failures++; }) : undefined;
    child.on('message', message => {
      const frame = message as Record<string, unknown>;
      if (frame.kind === 'fixture-result') uses += Number(frame.uses);
      else if (frame.kind === 'worker-secret-register') {
        requests++;
        if (mode === 'eof') child.disconnect();
        if (mode === 'forged') child.send({ ...ack(frame), context: { ...context, bootRef: 'other-boot' } });
      }
    });
    const exited = once(child, 'exit');
    child.send({ root: workerRoot, context, values });
    const [code] = await exited;
    receiver?.close();
    assert.equal(requests, 1); assert.equal(uses, 0); assert.equal(output, ''); assert.equal(code, 0);
    assert.equal(registrations, mode === 'capacity' ? 1 : 0); assert.equal(failures, mode === 'capacity' ? 1 : 0);
    assert.deepEqual(await readdir(workerRoot), [], 'no dependent local evidence/use after failed ACK');
  }
});

test('actual fixed Node24 IPC, actual helper/receiver and TWO Records: registry fence precedes held ACK', { timeout: remainingMs() }, async () => {
  const root = await mkdtemp('/tmp/s168-'); // mkdtemp is 0700; never touch pre-existing fixtures
  const workerRoot = join(root, 'w'); await mkdir(workerRoot, { mode: 0o700 });
  const owner = await createRecords({ root });
  const { phaseId: _phase, ...recordContext } = context;
  const outputContext = { ...recordContext, callId: 'owner-proof' };
  const capture = await owner.openOutput(outputContext);
  await capture.write(Buffer.from('public projection'));
  const completed = await capture.finish();
  const projection = owner.projectText({ context: outputContext, reference: completed.reference, expectedBytes: completed.bytes });
  for await (const _ of projection.chunks) { /* drain */ }
  const raw = await owner.openOutput({ ...outputContext, callId: 'raw-proof' }, { format: 'raw', maxBytes: 100 });
  await raw.write(Buffer.from('safe bytes'));
  const child = fork(new URL('./secret-ipc.fixture.js', import.meta.url), [], {
    execPath: '/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node', execArgv: [],
    env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdio = '', dependentUses = 0, registrations = 0;
  child.stdout!.on('data', chunk => { stdio += String(chunk); });
  child.stderr!.on('data', chunk => { stdio += String(chunk); });
  const abort = new AbortController();
  let release!: () => void;
  let ackObserved!: () => void;
  const ackReady = new Promise<void>(resolve => { ackObserved = resolve; });
  // Real child transport, held outbound ACK only. Production uses child.send directly.
  const held = Object.assign(new EventEmitter(), { connected: true,
    send(message: Record<string, unknown>, callback: (error: Error | null) => void) {
      assert.equal(registrations, 3);
      assert.throws(() => projection.assertCompleteAndCurrent(), /PROTECTED_CAPTURE_UNAVAILABLE/);
      assert.doesNotMatch(JSON.stringify(message), /synthetic-/);
      release = () => child.send(message, callback);
      ackObserved(); return true;
    } });
  child.on('message', message => {
    if ((message as { kind: string }).kind === 'fixture-result') dependentUses += (message as { uses: number }).uses;
    else held.emit('message', message);
  });
  const receiver = createOwnerSecretReceiver(held, context, abort.signal, () => true, value => {
    registrations++; owner.registerSecret(value);
  }, () => abort.abort());
  const result = once(child, 'message').then(async () => {
    await ackReady;
    assert.equal(dependentUses, 0);
    await assert.rejects(raw.finish(), /PROTECTED_CAPTURE_UNAVAILABLE/);
    release();
    return (await once(child, 'message'))[0] as { uses: number; reference: { workId: string; id: string } };
  });
  const exited = once(child, 'exit');
  child.send({ root: workerRoot, context, values });
  const local = await result;
  await exited;
  receiver.close();
  assert.equal(local.uses, 1); assert.equal(dependentUses, 1); assert.equal(stdio, '');
  const stored = await readFile(join(workerRoot, local.reference.workId, 'evidence', local.reference.id, 'output'), 'utf8');
  assert.doesNotMatch(stored, /synthetic-/); assert.match(stored, /█/);
  const filtered = await owner.record({ ...outputContext, callId: 'filtered' }, { value: values[0] });
  assert.doesNotMatch((await owner.read({ reference: filtered, offset: 0, limit: 4096 })).data.toString(), /synthetic-/);
  const fresh = owner.projectText({ context: outputContext, reference: completed.reference, expectedBytes: completed.bytes });
  for await (const _ of fresh.chunks) { /* drain */ }
  owner.registerSecret(values[0]!);
  fresh.assertCompleteAndCurrent(); // duplicate is a revision no-op
});
