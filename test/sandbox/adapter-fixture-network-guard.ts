// TEST ONLY: SDK denied by default; the explicit owned-VFS mode is a fixed audited graph.
// No external sockets/DNS or fallback worker commands.
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
import { isAbsolute, normalize } from 'node:path';
import { createAuditedVfsGuard } from './audited-vfs-guard.js';

export function guardFixtureNetwork(root: string, worker = false, mode: 'deny-all' | 'audited-owned-vfs' = 'deny-all') {
  // Caller supplies a newly owned private root. This is lexical confinement, not
  // a claim against hostile same-UID filesystem mutation.
  assert.ok(isAbsolute(root) && normalize(root) === root && root !== '/' && !root.includes('\0'), 'private normalized fixture root required');
  assert.ok(!worker || mode === 'deny-all', 'Workers never receive SDK graph authority');
  const sdk = mode === 'audited-owned-vfs' ? createAuditedVfsGuard() : undefined;
  const hooks = registerHooks(
    sdk?.hooks ?? {
      resolve(specifier, context, nextResolve) {
        if (specifier.includes('@earendil-works/gondolin') || specifier.includes('/gondolin/') || specifier.includes('/factory-development-gondolin-v1/'))
          throw new Error('SDK_EVALUATION_FORBIDDEN');
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url.includes('/gondolin/') || url.includes('/factory-development-gondolin-v1/')) throw new Error('SDK_EVALUATION_FORBIDDEN');
        return nextLoad(url, context);
      },
    },
  );
  const unixArgs = (args: unknown[], connection: boolean): unknown[] => {
    const allowed: (condition: unknown) => asserts condition = condition => {
      assert.ok(condition, 'external networking forbidden');
    };
    let values = args;
    if (Array.isArray(args[0])) {
      // createConnection uses Node's internal [options, callback] normalization.
      // Read only own data slots and discard metadata; never forward this array.
      allowed(connection && args.length === 1);
      const array = args[0];
      allowed(Object.getPrototypeOf(array) === Array.prototype);
      const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(array);
      const length: unknown = Object.getOwnPropertyDescriptor(array, 'length')?.value;
      allowed(length === 1 || length === 2);
      for (const key of Reflect.ownKeys(array)) {
        if (typeof key === 'symbol') {
          const descriptor = Object.getOwnPropertyDescriptor(array, key);
          allowed(key.description === 'normalizedArgs' && descriptor && 'value' in descriptor && descriptor.value === true);
        } else allowed(['0', '1', 'length'].includes(key));
      }
      allowed(descriptors['0'] && 'value' in descriptors['0']);
      allowed(length === 1 || (descriptors['1'] && 'value' in descriptors['1']));
      // Node uses null for an absent callback in normalized connect args.
      const callback: unknown = descriptors['1']?.value;
      values = length === 1 || callback === null ? [descriptors['0'].value] : [descriptors['0'].value, callback];
    }
    allowed(values.length === 1 || values.length === 2);
    const first: unknown = values[0];
    let path: unknown = first;
    if (first !== null && typeof first === 'object') {
      allowed(Object.getPrototypeOf(first) === Object.prototype || Object.getPrototypeOf(first) === null);
      const keys = Reflect.ownKeys(first);
      allowed(keys.length === 1 && keys[0] === 'path');
      const descriptor = Object.getOwnPropertyDescriptor(first, 'path');
      allowed(descriptor && 'value' in descriptor);
      path = descriptor.value; // Capture once: no getter or options revalidation.
    }
    allowed(typeof path === 'string');
    allowed(path.startsWith(root + '/') && normalize(path) === path && !path.includes('\0'));
    const callback: unknown = values[1];
    allowed(callback === undefined || typeof callback === 'function');
    // A fresh canonical Unix-only argument list prevents mixed selectors and
    // mutation/TOCTOU in caller-owned options from affecting native dispatch.
    return callback === undefined ? [path] : [path, callback];
  };
  const connect = net.Socket.prototype.connect;
  mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: unknown[]) {
    return Reflect.apply(connect, this, unixArgs(args, true));
  });
  const listen = net.Server.prototype.listen;
  mock.method(net.Server.prototype, 'listen', function (this: net.Server, ...args: unknown[]) {
    return Reflect.apply(listen, this, unixArgs(args, false));
  });
  const deny = () => {
    throw new Error('EXTERNAL_NETWORK_OR_COMMAND_FORBIDDEN');
  };
  mock.method(tls, 'connect', deny);
  for (const module of [http, https]) {
    mock.method(module, 'request', deny);
    mock.method(module, 'get', deny);
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
    process.removeListener('exit', restore);
    hooks.deregister();
    mock.restoreAll();
    for (const { module, name, value } of dnsOriginals) Reflect.set(module, name, value);
    if (worker) commands.forEach((command, index) => Reflect.set(cp, command, originals[index]));
    syncBuiltinESMExports();
  };
  process.once('exit', restore);
  return Object.assign(restore, { sdk });
}
