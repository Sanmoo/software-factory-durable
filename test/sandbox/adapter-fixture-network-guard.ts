// TEST ONLY: no SDK evaluation, external sockets/DNS, or fallback worker commands.
// The only sockets permitted are Unix sockets underneath this new fixture root.
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import cp from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';

export function guardFixtureNetwork(root: string, worker = false) {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.includes('@earendil-works/gondolin') || specifier.includes('/gondolin/') || specifier.includes('/factory-development-gondolin-v1/')) throw new Error('SDK_EVALUATION_FORBIDDEN');
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.includes('/gondolin/') || url.includes('/factory-development-gondolin-v1/')) throw new Error('SDK_EVALUATION_FORBIDDEN');
      return nextLoad(url, context);
    },
  });
  const unixPath = (args: unknown[]) => {
    // Node's normalized connect args wrap options in an array.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const path = typeof first === 'string' ? first : first && typeof first === 'object' && 'path' in first ? first.path : undefined;
    assert.ok(typeof path === 'string' && path.startsWith(root + '/') && !path.split('/').includes('..'), 'external networking forbidden');
  };
  const connect = net.Socket.prototype.connect;
  mock.method(net.Socket.prototype, 'connect', function(this: net.Socket, ...args: unknown[]) {
    unixPath(args); return Reflect.apply(connect, this, args);
  });
  const listen = net.Server.prototype.listen;
  mock.method(net.Server.prototype, 'listen', function(this: net.Server, ...args: unknown[]) {
    unixPath(args); return Reflect.apply(listen, this, args);
  });
  const deny = () => { throw new Error('EXTERNAL_NETWORK_OR_COMMAND_FORBIDDEN'); };
  mock.method(tls, 'connect', deny);
  for (const module of [http, https]) {
    mock.method(module, 'request', deny); mock.method(module, 'get', deny);
  }
  mock.method(dgram, 'createSocket', deny);
  // Include specialized resolvers and Resolver construction, not just lookup().
  const dnsOriginals: { module: object; name: string; value: unknown }[] = [];
  for (const module of [dns, dns.promises]) {
    for (const name of Object.keys(module)) {
      const value: unknown = Reflect.get(module, name);
      if (typeof value !== 'function') continue;
      dnsOriginals.push({ module, name, value });
      Reflect.set(module, name, deny);
    }
  }
  const commands = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
  const originals = commands.map(command => cp[command]);
  if (worker) {
    // Direct replacement intentionally drops original util.promisify.custom.
    for (const command of commands) Reflect.set(cp, command, deny);
    mock.method(process, 'kill', deny);
  }
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    hooks.deregister(); mock.restoreAll();
    for (const { module, name, value } of dnsOriginals) Reflect.set(module, name, value);
    if (worker) commands.forEach((command, index) => Reflect.set(cp, command, originals[index]));
    syncBuiltinESMExports();
  };
  process.once('exit', restore);
  return restore;
}
