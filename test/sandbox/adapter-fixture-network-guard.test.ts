import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import dns from 'node:dns';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { guardFixtureNetwork } from './adapter-fixture-network-guard.js';

// Install by direct assignment BEFORE the guard captures either operation.
// Never use mock.method here: guard.restoreAll() must not expose native dispatch.
function inertTransport(root: string, worker = false) {
  const originals = { listen: net.Server.prototype.listen, connect: net.Socket.prototype.connect };
  const calls: { operation: string; receiver: unknown; args: unknown[] }[] = [];
  net.Server.prototype.listen = function(...args: unknown[]) { calls.push({ operation: 'listen', receiver: this, args }); return this; };
  net.Socket.prototype.connect = function(...args: unknown[]) { calls.push({ operation: 'connect', receiver: this, args }); return this; };
  const sentinels = { listen: net.Server.prototype.listen, connect: net.Socket.prototype.connect };
  syncBuiltinESMExports();
  let restoreGuard: (() => void) | undefined;
  try { restoreGuard = guardFixtureNetwork(root, worker); }
  catch (error) { restoreSentinel(); throw error; }
  function restoreSentinel() {
    net.Server.prototype.listen = originals.listen;
    net.Socket.prototype.connect = originals.connect;
    syncBuiltinESMExports();
  }
  return { calls, restore() {
    try {
      restoreGuard?.();
      assert.equal(net.Server.prototype.listen, sentinels.listen, 'restoreAll must restore the inert listener, not native');
      assert.equal(net.Socket.prototype.connect, sentinels.connect, 'restoreAll must restore the inert connector, not native');
    } finally { restoreSentinel(); }
  } };
}

test('closed Unix dispatch: approved arguments reach only inert sentinels once; rejected shapes reach zero', async t => {
  const root = await mkdtemp('/tmp/gfg-'); // newly owned private 0700 root
  const before = { listen: net.Server.prototype.listen, connect: net.Socket.prototype.connect, exits: process.listeners('exit') };
  const transport = inertTransport(root);
  const path = root + '/owned.sock';
  const callback = () => { throw new Error('sentinel must not invoke callbacks'); };
  let rejected = 0;
  let approved = 0;
  try {
    for (const operation of ['listen', 'connect'] as const) {
      // No native constructors, handles, sockets or bindings, even during RED.
      const receiver: unknown = Object.create(operation === 'listen' ? net.Server.prototype : net.Socket.prototype);
      const invoke = (args: unknown[]) => Reflect.apply(operation === 'listen' ? net.Server.prototype.listen : net.Socket.prototype.connect, receiver, args);
      const good: unknown[][] = [[path], [path, callback], [{ path }], [{ path }, callback], [Object.assign(Object.create(null), { path })], [path, undefined]];
      if (operation === 'connect') good.push([[{ path }, undefined]], [[{ path }, null]], [[{ path }, callback]],
        [Object.defineProperty([{ path }, callback], Symbol('normalizedArgs'), { value: true })]);
      for (const args of good) {
        transport.calls.length = 0;
        assert.equal(invoke(args), receiver);
        assert.equal(transport.calls.length, 1);
        const call = transport.calls[0]!;
        assert.equal(call.operation, operation); assert.equal(call.receiver, receiver);
        const cb = Array.isArray(args[0]) ? args[0][1] : args[1];
        // Canonical string path and optional callback only; never raw options/arrays.
        assert.deepEqual(call.args, cb === undefined || cb === null ? [path] : [path, cb]);
        approved++;
      }
      let getterReads = 0;
      const getter = { get path() { getterReads++; return path; } };
      const inherited = Object.create({ path });
      const prototypeSelector = Object.assign(Object.create({ port: 0 }), { path });
      const hiddenSelector = Object.defineProperty({ path }, 'port', { value: 0 });
      const getterSelector = Object.defineProperty({ path }, 'port', { get() { getterReads++; return 0; } });
      const bad: unknown[][] = [
        [{ path, port: 0 }], [{ path, host: '127.0.0.1', port: 0 }], [{ path, host: 'localhost' }],
        [{ path, fd: 1 }], [{ path, handle: {} }], [{ path, _handle: {} }], [{ path, backlog: 1 }],
        [{ path, unknown: true }], [{ path, [Symbol('port')]: 0 }], [hiddenSelector], [getterSelector], [inherited], [prototypeSelector], [getter],
        ['/tmp/outside.sock'], [root + '-sibling/owned.sock'], [root + '/../outside.sock'], [root + '/nested/../../outside.sock'], [root + '/./owned.sock'], [path + '\0'], [root],
        [{ fd: 1 }], [{ handle: {} }], [{ port: 0 }], [0], [{ host: '127.0.0.1', port: 1 }],
        [path, 0], [path, null], [path, callback, { port: 0 }], [{ path }, undefined, callback],
      ];
      for (const selector of ['host', 'fd', 'handle', '_handle', 'unknown']) {
        bad.push([Object.assign(Object.create({ [selector]: 0 }), { path })]);
      }
      if (operation === 'connect') bad.push(
        [[{ path, port: 0 }, callback]], [[{ path }, callback, { port: 0 }]], [[{ path }], callback],
        [[[{ path }]]], [Object.assign([{ path }, callback], { port: 0 })],
        [Object.defineProperty([{ path }, callback], '0', { get() { getterReads++; return { path }; } })],
        [Object.defineProperty([{ path }, callback], '1', { get() { getterReads++; return callback; } })],
        [Object.defineProperty([{ path }, callback], Symbol('port'), { value: 0 })],
      );
      else bad.push([[{ path }, callback]]);
      for (const args of bad) {
        transport.calls.length = 0;
        assert.throws(() => invoke(args), /external networking forbidden/);
        assert.equal(transport.calls.length, 0, `${operation}: denied before underlying sentinel`);
        rejected++;
      }
      assert.equal(getterReads, 0, 'accessor path never evaluated');
    }
    t.diagnostic(`approved=${approved}; rejected=${rejected}; zeroUnderlyingForRejected=0; nativeDispatch=0 (inert sentinels only)`);
  } finally {
    transport.restore();
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(net.Server.prototype.listen, before.listen);
  assert.equal(net.Socket.prototype.connect, before.connect);
  assert.deepEqual(process.listeners('exit'), before.exits);
});

test('fixture guard rejects SDK roots/leaves before evaluation and denies TCP/DNS/commands, including promisified commands', async () => {
  const root = await mkdtemp('/tmp/gfg-');
  const before = { spawn: cp.spawn, execFile: cp.execFile, kill: process.kill, lookup: dns.lookup, exits: process.listeners('exit') };
  const transport = inertTransport(root, true);
  try {
    for (const specifier of [
      '@earendil-works/gondolin',
      new URL('../../../node_modules/@earendil-works/gondolin/dist/src/index.js', import.meta.url).href,
      new URL('../../../.scratch/factory-development-gondolin-v1/sdk/dist/src/index.js', import.meta.url).href,
      new URL('../../../node_modules/@earendil-works/gondolin/dist/src/vm/core.js', import.meta.url).href,
    ]) {
      // eslint-disable-next-line no-restricted-syntax -- Test-only negative imports; deny hook rejects before resolution/evaluation.
      await assert.rejects(import(specifier), /SDK_EVALUATION_FORBIDDEN/);
    }
    assert.throws(() => net.createConnection({ host: '127.0.0.1', port: 1 }), /external networking forbidden/);
    assert.equal(transport.calls.length, 0);
    assert.throws(() => dns.lookup('offline.invalid', () => {}), /EXTERNAL_NETWORK_OR_COMMAND_FORBIDDEN/);
    assert.throws(() => cp.spawn('/unlisted-command', []), /EXTERNAL_NETWORK_OR_COMMAND_FORBIDDEN/);
    await assert.rejects(promisify(cp.execFile)('systemctl', ['--user', 'show', 'unlisted']), /EXTERNAL_NETWORK_OR_COMMAND_FORBIDDEN/);
  } finally {
    transport.restore();
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(cp.spawn, before.spawn); assert.equal(cp.execFile, before.execFile);
  assert.equal(process.kill, before.kill); assert.equal(dns.lookup, before.lookup);
  assert.deepEqual(process.listeners('exit'), before.exits);
});

// Direct P1 reproduction: this must never be changed to a real native listener.
test('P1 owned path plus TCP selector is rejected before inert listen/connect sentinels', async t => {
  const root = await mkdtemp('/tmp/gfg-');
  const transport = inertTransport(root);
  try {
    const results: { operation: string; calls: number; error: unknown }[] = [];
    for (const operation of ['listen', 'connect'] as const) {
      transport.calls.length = 0;
      const receiver: unknown = Object.create(operation === 'listen' ? net.Server.prototype : net.Socket.prototype);
      let error: unknown;
      try { Reflect.apply(operation === 'listen' ? net.Server.prototype.listen : net.Socket.prototype.connect, receiver,
        [{ path: root + '/owned.sock', host: '127.0.0.1', port: 0 }]); }
      catch (caught) { error = caught; }
      t.diagnostic(`${operation}: underlying inert calls=${transport.calls.length}; native calls=0`);
      results.push({ operation, calls: transport.calls.length, error });
    }
    for (const result of results) {
      assert.equal(result.calls, 0, `${result.operation}: mixed selectors must not reach underlying inert sentinel`);
      assert.match(String(result.error), /external networking forbidden/);
    }
  } finally { transport.restore(); await rm(root, { recursive: true, force: true }); }
});
