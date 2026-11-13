import assert from 'node:assert/strict';
import { after, beforeEach, afterEach, test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, lstat, chmod, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import * as target from '../../src/workers/factory-oauth.js';

// CLOSED before target dynamically evaluates native SDK. HTTP listener is an
// in-memory EventEmitter, NOT TCP. Native login/state/PKCE/token/storage are real.
const roots: string[] = [];
const counters = { physical: 0, modelHTTP: 0, personal: 0, token: 0, fakeListen: 0, close: 0, manualInput: 0 };
const deny = () => { counters.physical++; throw new Error('CLOSED'); };
for (const [object, names] of [
  [net.Socket.prototype, ['connect']], [net.Server.prototype, ['listen']], [tls, ['connect']],
  [http, ['request', 'get']], [https, ['request', 'get']], [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6']], [dgram, ['createSocket']],
  [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
] as const) for (const name of names) mock.method(object, name as never, deny);
mock.method(process, 'dlopen', deny);
for (const name of ['readFileSync', 'writeFileSync', 'lstatSync', 'statSync', 'existsSync', 'realpathSync', 'openSync'] as const) {
  const original = fs[name];
  mock.method(fs, name, (...args: unknown[]) => {
    const path = String(args[0]);
    if (/(?:auth\.json|chatgpt\.json)$|\/credentials(?:\/|$)/.test(path) &&
      !roots.some(root => path === root || path.startsWith(root + '/'))) {
      counters.personal++; throw new Error('PERSONAL_PATH_DENIED');
    }
    return Reflect.apply(original, fs, args);
  });
}
let callback: ((request: { url: string }, response: { writeHead(): void; end(): void }) => void) | undefined;
mock.method(http, 'createServer', (handler: typeof callback) => {
  callback = handler;
  const server = new EventEmitter() as EventEmitter & { listen: (...args: unknown[]) => void; close(): void; closeAllConnections(): void };
  server.listen = (port, host, ready) => {
    counters.fakeListen++;
    assert.equal(port, 1455); assert.equal(host, '127.0.0.1');
    queueMicrotask(() => (ready as () => void)());
  };
  server.close = () => { counters.close++; };
  server.closeAllConnections = () => {};
  return server;
});
syncBuiltinESMExports();
const issued = { type: 'oauth', access: 'synthetic-first-access', refresh: 'synthetic-first-refresh',
  expires: Date.now() + 3_600_000, clientId: 'synthetic-issued-client', scopes: ['chatgpt.tokens.use.direct'] };
let httpFailure = false;
let malformedToken = false;
mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url !== 'https://auth.openai.com/api/accounts/oauth/token') { counters.modelHTTP++; throw new Error('DENIED_HTTP'); }
  counters.token++;
  assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'authorization_code');
  if (httpFailure) return new Response('UNKNOWN_BODY_CANARY https://evil.invalid/secret', { status: 401 });
  return new Response(JSON.stringify({ access_token: malformedToken ? { command: 'echo SECRET' } : issued.access, refresh_token: issued.refresh,
    expires_in: 3600, id_token: 'synthetic-id-token', scope: issued.scopes.join(' ') }), { status: 200 });
});
const login = () => target.firstFactoryOAuthLogin;
const publicOutput: string[] = [];
let logMock: ReturnType<typeof mock.method>, errorMock: ReturnType<typeof mock.method>;
beforeEach(() => {
  publicOutput.length = 0;
  logMock = mock.method(console, 'log', (...args: unknown[]) => { publicOutput.push(args.join(' ')); });
  errorMock = mock.method(console, 'error', (...args: unknown[]) => { publicOutput.push(args.join(' ')); });
});
afterEach(() => {
  logMock.mock.restore(); errorMock.mock.restore();
  assert.deepEqual(publicOutput, []); // No raw body/cause/stack/URL/token public channel.
});
async function fixture() {
  const root = await mkdtemp('/tmp/fl-'); roots.push(root);
  await chmod(root, 0o700); await mkdir(join(root, 'credentials'), { mode: 0o700 });
  const known: string[] = [], urls: string[] = [];
  const controller = new AbortController();
  const options = { factoryRoot: root, records: { registerSecret(value: string) { known.push(value); } },
    signal: controller.signal, tty: { isTTY: true, authorizationURL(url: string) {
      urls.push(url);
      const auth = new URL(url);
      assert.equal(auth.origin + auth.pathname, 'https://auth.openai.com/api/accounts/authorize');
      queueMicrotask(() => callback!({ url: '/auth/callback?' + new URLSearchParams({ code: 'synthetic-code',
        state: auth.searchParams.get('state')!, client_id: issued.clientId }) }, { writeHead() {}, end() {} }));
    } } };
  return { root, path: join(root, 'credentials/chatgpt.json'), options, known, urls, controller };
}
const opaque = (error: unknown) => {
  assert.deepEqual(error, { code: 'FACTORY_OAUTH_UNAVAILABLE' }); return true;
};
after(() => {
  assert.equal(counters.physical, 0); assert.equal(counters.modelHTTP, 0); assert.equal(counters.personal, 0);
  assert.equal(counters.manualInput, 0);
  console.log('first-login CLOSED counters', JSON.stringify(counters));
  // Retain new private synthetic fixtures; no cleanup of prior resources.
});

test('native memory login registers before native private commit; accepted worker can consume fixed file', async () => {
  const f = await fixture();
  const native = await import('#factory-pi-auth-storage');
  const nativeMemoryWrite = native.InMemoryAuthStorageBackend.prototype.withLockAsync;
  let observedMemoryCommits = 0;
  const memoryWrites = mock.method(native.InMemoryAuthStorageBackend.prototype, 'withLockAsync', function<T>(
    this: InstanceType<typeof native.InMemoryAuthStorageBackend>, fn: Parameters<typeof nativeMemoryWrite<T>>[0], operation?: Parameters<typeof nativeMemoryWrite<T>>[1]) {
    return nativeMemoryWrite.call(this, async raw => {
      const next = await fn(raw);
      if (next.next?.includes(issued.access)) {
        observedMemoryCommits++;
        assert.ok([issued.access, issued.refresh, issued.clientId].every(value => f.known.includes(value)));
      }
      return next;
    }, operation) as Promise<T>;
  });
  const nativeWrite = fs.writeFileSync;
  const writes = mock.method(fs, 'writeFileSync', (...args: unknown[]) => {
    if (String(args[0]) === f.path && String(args[1]).includes(issued.access)) {
      assert.ok([issued.access, issued.refresh, issued.clientId].every(value => f.known.includes(value)));
      assert.ok(fs.existsSync(f.path + '.lock'));
    }
    return Reflect.apply(nativeWrite, fs, args);
  }); syncBuiltinESMExports();
  const result = await login()(f.options);
  writes.mock.restore(); memoryWrites.mock.restore(); syncBuiltinESMExports();
  assert.equal(observedMemoryCommits, 1);
  assert.deepEqual(result, { code: 'FACTORY_OAUTH_CREATED', credentialPath: f.path });
  assert.equal(f.urls.length, 1); assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
  const document = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(document.openai.access, issued.access); assert.deepEqual(Object.keys(document), ['openai']);
  assert.ok(!JSON.stringify(result).includes(issued.access));
  for (const name of ['source', 'guest', 'profiles']) await mkdir(join(f.root, name), { mode: 0o700 });
  const acknowledgements: readonly string[][] = [];
  const worker = await target.openFactoryOAuth({ factoryRoot: f.root,
    excludedRoots: { source: join(f.root, 'source'), guest: join(f.root, 'guest'), profiles: [join(f.root, 'profiles')] },
    profileDirectory: join(f.root, 'profiles'), records: f.options.records, signal: f.options.signal,
    async acknowledgeSecrets(values) { (acknowledgements as string[][]).push([...values]); } });
  assert.equal((await worker.credentials.read('openai'))?.type, 'oauth');
  assert.equal(acknowledgements.length, 1);
  const tokenRequests = counters.token;
  assert.deepEqual(await worker.getAuth(), { apiKey: issued.access });
  await worker.settleCredentialWrites();
  assert.equal(counters.token, tokenRequests); // Separate accepted worker proof: no refresh/model HTTP.
  const profile = join(f.root, 'credentials/setup');
  assert.equal(fs.existsSync(join(profile, 'auth.json')), false);
  for (const name of fs.readdirSync(profile)) assert.ok(!(await readFile(join(profile, name), 'utf8')).includes(issued.access));
});

test('existing target, unsafe paths and missing TTY refuse before native HTTP/listener', async () => {
  for (const kind of ['empty', 'symlink', 'mode', 'root-mode', 'hardlink', 'uid', 'not-tty', 'relative'] as const) {
    const f = await fixture();
    if (kind === 'empty') await writeFile(f.path, '', { mode: 0o600 });
    if (kind === 'symlink') { await mkdir(join(f.root, 'elsewhere'), { mode: 0o700 }); await fs.promises.rmdir(join(f.root, 'credentials')); await symlink(join(f.root, 'elsewhere'), join(f.root, 'credentials')); }
    if (kind === 'mode') await chmod(join(f.root, 'credentials'), 0o755);
    if (kind === 'root-mode') await chmod(f.root, 0o755);
    if (kind === 'hardlink') { await writeFile(f.path, 'original', { mode: 0o600 }); await link(f.path, join(f.root, 'alias')); }
    if (kind === 'not-tty') f.options.tty.isTTY = false;
    if (kind === 'relative') f.options.factoryRoot = '.';
    let uidMock: ReturnType<typeof mock.method> | undefined;
    if (kind === 'uid') {
      const original = fs.lstatSync;
      uidMock = mock.method(fs, 'lstatSync', (...args: unknown[]) => {
        const info = Reflect.apply(original, fs, args);
        if (String(args[0]) === f.root) info.uid = 999999;
        return info;
      }); syncBuiltinESMExports();
    }
    const before = { ...counters };
    await assert.rejects(login()(f.options), opaque);
    uidMock?.mock.restore(); syncBuiltinESMExports();
    assert.equal(counters.token, before.token); assert.equal(counters.fakeListen, before.fakeListen);
  }
});

test('cancelled manual fallback stays input-free; native listener closes and no target reservation', async () => {
  const f = await fixture();
  f.options.tty.authorizationURL = () => { f.controller.abort(); };
  await assert.rejects(login()(f.options), opaque);
  assert.equal(fs.existsSync(f.path), false);
  assert.ok(counters.close > 0);
});

test('supported deadline signal aborts pending native manual prompt without collecting a redirect code', async () => {
  const f = await fixture(); f.options.signal = AbortSignal.timeout(20);
  f.options.tty.authorizationURL = () => {};
  await assert.rejects(login()(f.options), opaque);
  assert.equal(fs.existsSync(f.path), false);
});

test('unknown native HTTP body remains opaque and no target created', async () => {
  const f = await fixture(); httpFailure = true;
  try { await assert.rejects(login()(f.options), opaque); }
  finally { httpFailure = false; }
  assert.equal(fs.existsSync(f.path), false);
});

test('concurrent appearance is never overwritten', async () => {
  const f = await fixture(); const deliver = f.options.tty.authorizationURL;
  f.options.tty.authorizationURL = url => { fs.writeFileSync(f.path, 'concurrent', { mode: 0o600, flag: 'wx' }); deliver(url); };
  await assert.rejects(login()(f.options), opaque);
  assert.equal(await readFile(f.path, 'utf8'), 'concurrent');
});

test('native in-place private write failure retains private partial file with opaque failure', async () => {
  const f = await fixture(); const original = fs.writeFileSync;
  const failure = mock.method(fs, 'writeFileSync', (...args: unknown[]) => {
    if (String(args[0]) === f.path && String(args[1]).includes(issued.access)) {
      Reflect.apply(original, fs, [f.path, '{"openai":', { mode: 0o600 }]);
      throw new Error(issued.access + ' UNKNOWN_WRITE_BODY');
    }
    return Reflect.apply(original, fs, args);
  }); syncBuiltinESMExports();
  try { await assert.rejects(login()(f.options), opaque); }
  finally { failure.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(f.path, 'utf8'), '{"openai":');
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
});

test('malformed native token/command-config response never reaches private commit', async () => {
  const f = await fixture(); malformedToken = true;
  try { await assert.rejects(login()(f.options), opaque); }
  finally { malformedToken = false; }
  assert.equal(fs.existsSync(f.path), false);
});

test('registration failure blocks memory commit and all private persistence', async () => {
  const f = await fixture();
  f.options.records.registerSecret = () => { throw new Error('UNKNOWN_REGISTRY_BODY'); };
  await assert.rejects(login()(f.options), opaque);
  assert.equal(fs.existsSync(f.path), false);
});

test('TTY delivery failure aborts via native supported prompt cancellation and closes fake listener', async () => {
  const f = await fixture(); const closed = counters.close;
  f.options.tty.authorizationURL = () => { throw new Error('UNKNOWN_TTY_BODY'); };
  await assert.rejects(login()(f.options), opaque);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(counters.close, closed + 1);
  assert.equal(fs.existsSync(f.path), false);
});

test('callback host override and unsafe OWN setup files refuse before native activity', async () => {
  for (const kind of ['host', 'setup-symlink', 'device-hardlink', 'cache-symlink', 'setup-mode']) {
    const f = await fixture(); const previousHost = process.env.PI_OAUTH_CALLBACK_HOST;
    const profile = join(f.root, 'credentials/setup');
    if (kind !== 'host') await mkdir(profile, { mode: 0o700 });
    if (kind === 'host') process.env.PI_OAUTH_CALLBACK_HOST = '0.0.0.0';
    if (kind === 'setup-symlink') {
      await fs.promises.rmdir(profile); await mkdir(join(f.root, 'other'), { mode: 0o700 });
      await symlink(join(f.root, 'other'), profile);
    }
    if (kind === 'device-hardlink') {
      await writeFile(join(profile, 'device-id'), '00000000-0000-0000-0000-000000000000', { mode: 0o600 });
      await link(join(profile, 'device-id'), join(f.root, 'device-alias'));
    }
    if (kind === 'cache-symlink') await symlink(join(f.root, 'unknown'), join(profile, 'models-store.json'));
    if (kind === 'setup-mode') await chmod(profile, 0o755);
    const before = { ...counters };
    try { await assert.rejects(login()(f.options), opaque); }
    finally { if (previousHost === undefined) delete process.env.PI_OAUTH_CALLBACK_HOST; else process.env.PI_OAUTH_CALLBACK_HOST = previousHost; }
    assert.equal(counters.fakeListen, before.fakeListen); assert.equal(counters.token, before.token);
    assert.equal(fs.existsSync(f.path), false);
  }
});
