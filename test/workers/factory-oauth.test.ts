import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test, mock } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, unlink, symlink, link, lstat } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { createRecords, RecordsError } from '../../src/records/index.js';
import { openFactoryOAuth } from '../../src/workers/factory-oauth.js';

// CLOSED before any native SDK evaluation. No HTTP server or real transport.
const attempts = { fetch: 0, token: 0, deniedURL: 0, physical: 0, forbiddenCredentialPath: 0 };
const deny = () => { attempts.physical++; throw new Error('TEST_TRANSPORT_CLOSED'); };
for (const [object, names] of [
  [net.Socket.prototype, ['connect']], [net.Server.prototype, ['listen']],
  [tls, ['connect']], [http, ['request', 'get']], [https, ['request', 'get']],
  [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [dgram, ['createSocket']], [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
] as const) for (const name of names) mock.method(object, name as never, deny);
mock.method(process, 'dlopen', deny);
// SDK credential reads/writes/metadata must stay in our new synthetic fixtures.
for (const name of ['readFileSync', 'writeFileSync', 'lstatSync', 'statSync', 'existsSync', 'realpathSync'] as const) {
  const original = fs[name];
  mock.method(fs, name, (...args: unknown[]) => {
    const path = String(args[0]);
    if (/(?:auth\.json|chatgpt\.json)$|\/credentials(?:\/|$)/.test(path) &&
        !roots.some(root => path === root || path.startsWith(root + '/'))) {
      attempts.forbiddenCredentialPath++; throw new Error('TEST_CREDENTIAL_PATH_CLOSED');
    }
    return Reflect.apply(original, fs, args);
  });
}
syncBuiltinESMExports();
let tokenResponse = async () => new Response(JSON.stringify({ access_token: 'synthetic-access-new',
  refresh_token: 'synthetic-refresh-new', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' }));
globalThis.fetch = async (input, init) => {
  attempts.fetch++;
  if (String(input) !== 'https://auth.openai.com/api/accounts/oauth/token' || init?.method !== 'POST') {
    attempts.deniedURL++; throw new Error('TEST_URL_CLOSED');
  }
  attempts.token++;
  return tokenResponse();
};
const roots: string[] = [];
const initial = { type: 'oauth' as const, access: 'synthetic-access-old', refresh: 'synthetic-refresh-old',
  expires: 0, clientId: 'synthetic-client', scopes: ['chatgpt.tokens.use.direct'] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fo-')); roots.push(root);
  await mkdir(join(root, 'credentials'), { mode: 0o700 });
  const path = join(root, 'credentials', 'chatgpt.json');
  await writeFile(path, JSON.stringify({ openai: initial }), { mode: 0o600 });
  const recordsRoot = join(root, 'records'); await mkdir(recordsRoot, { mode: 0o700 });
  const records = await createRecords({ root: recordsRoot });
  const profileDirectory = `${root}-profiles`;
  for (const directory of [`${root}-source`, `${root}-guest`, profileDirectory]) {
    await mkdir(directory, { mode: 0o700 }); roots.push(directory);
  }
  const controller = new AbortController();
  const options = { factoryRoot: root, excludedRoots: { source: `${root}-source`, guest: `${root}-guest`, profiles: [`${root}-profiles`] },
    records, acknowledgeSecrets: async (_values: readonly string[]) => {}, signal: controller.signal, profileDirectory };
  return { root, path, records, controller, options };
}
after(async () => {
  // Counters checked before any other assertion about the run's safety.
  assert.equal(attempts.deniedURL, 0); assert.equal(attempts.physical, 0); assert.equal(attempts.forbiddenCredentialPath, 0);
  console.log('closed transport attempts', JSON.stringify(attempts));
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
afterEach(() => { assert.equal(attempts.deniedURL, 0); assert.equal(attempts.physical, 0); assert.equal(attempts.forbiddenCredentialPath, 0); });
beforeEach(() => { tokenResponse = async () => new Response(JSON.stringify({ access_token: 'synthetic-access-new',
  refresh_token: 'synthetic-refresh-new', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' })); });
const closed = { code: 'FACTORY_OAUTH_UNAVAILABLE' };

test('native file credential read waits for private ACK after local registration', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  f.options.acknowledgeSecrets = async values => { seen.push(...values); await gate; };
  const auth = await openFactoryOAuth(f.options);
  let returned = false;
  const read = auth.credentials.read('openai').then(value => { returned = true; return value; });
  while (!seen.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false);
  assert.ok(seen.includes(initial.access)); assert.ok(seen.includes(initial.refresh));
  release();
  assert.deepEqual(await read, initial);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { openai: initial });
  await assert.rejects(auth.credentials.read('openai-codex'), closed);
});

test('two native runtimes reuse a single locked synthetic refresh and persist before ACK/use', async () => {
  const f = await fixture();
  const before = attempts.token;
  const a = await openFactoryOAuth(f.options);
  const b = await openFactoryOAuth(f.options);
  const [first, second] = await Promise.all([a.getAuth(), b.getAuth()]);
  assert.equal(attempts.token - before, 1);
  assert.deepEqual(first, { apiKey: 'synthetic-access-new' });
  assert.deepEqual(second, first);
  await Promise.all([a.settleCredentialWrites(), b.settleCredentialWrites()]);
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).openai.refresh, 'synthetic-refresh-new');
});

test('current credential owner ACK precedes SDK modify callback use', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let observed!: () => void;
  const ackStarted = new Promise<void>(resolve => { observed = resolve; });
  f.options.acknowledgeSecrets = async () => { observed(); await gate; };
  const auth = await openFactoryOAuth(f.options);
  let used = false;
  const modifying = auth.credentials.modify('openai', async () => { used = true; return undefined; });
  await ackStarted;
  try { assert.equal(used, false); } finally { release(); await modifying; }
  assert.equal(used, true);
});

test('rotated local registration precedes private native write; post-commit ACK holds getAuth', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let observed!: () => void;
  const ackStarted = new Promise<void>(resolve => { observed = resolve; });
  let registeredBeforeWrite = false;
  const register = f.records.registerSecret;
  f.options.records = { ...f.records, registerSecret(value: string) {
    if (value === 'synthetic-access-new' && !registeredBeforeWrite) {
      assert.equal(JSON.parse(fs.readFileSync(f.path, 'utf8')).openai.access, initial.access);
      registeredBeforeWrite = true;
    }
    register(value);
  } };
  f.options.acknowledgeSecrets = async values => {
    if (values.includes('synthetic-refresh-new')) { observed(); await gate; }
  };
  const auth = await openFactoryOAuth(f.options);
  let returned = false;
  const pending = auth.getAuth().then(value => { returned = true; return value; });
  await ackStarted;
  try {
    assert.equal(returned, false); assert.equal(registeredBeforeWrite, true);
    assert.equal(JSON.parse(await readFile(f.path, 'utf8')).openai.refresh, 'synthetic-refresh-new');
  } finally { release(); }
  assert.deepEqual(await pending, { apiKey: 'synthetic-access-new' });
});

test('failed owner ACK denies use and later reads but preserves committed private rotation', async () => {
  const f = await fixture();
  f.options.acknowledgeSecrets = async values => { if (values.includes('synthetic-refresh-new')) throw new Error('private ACK detail'); };
  const auth = await openFactoryOAuth(f.options);
  await assert.rejects(auth.getAuth(), closed);
  await auth.settleCredentialWrites();
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).openai.refresh, 'synthetic-refresh-new');
  await assert.rejects(auth.credentials.read('openai'), closed);
});

test('scope abort during native bounded refresh preserves rotation but never returns auth or starts another refresh', async () => {
  const f = await fixture();
  let received!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const response = tokenResponse;
  tokenResponse = async () => { received(); await gate; return response(); };
  const auth = await openFactoryOAuth(f.options);
  const pending = assert.rejects(auth.getAuth(), closed);
  await started;
  f.controller.abort(new Error('synthetic private cancellation reason'));
  await pending;
  release();
  await auth.settleCredentialWrites();
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).openai.refresh, 'synthetic-refresh-new');
  const count = attempts.token;
  await assert.rejects(auth.getAuth(), closed);
  await assert.rejects(auth.credentials.modify('openai', async () => initial), closed);
  assert.equal(attempts.token, count);
});

test('unknown token HTTP body, malformed JSON and SDK exceptions escape only as closed code without cause/stack', async () => {
  for (const body of ['never-registered-ID-token-private-body', '{"access_token":"unregistered-value"']) {
    const f = await fixture();
    tokenResponse = async () => new Response(body, { status: 400, headers: { 'private-header': 'unknown-header-value' } });
    const auth = await openFactoryOAuth(f.options);
    await assert.rejects(auth.getAuth(), error => {
      assert.deepEqual(error, closed);
      assert.equal(JSON.stringify(error), '{"code":"FACTORY_OAUTH_UNAVAILABLE"}');
      return true;
    });
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { openai: initial });
  }
});

test('4096 character access token is accepted; 4097 and Records count exhaustion reject before write/use', async () => {
  for (const size of [4096, 4097]) {
    const f = await fixture();
    tokenResponse = async () => new Response(JSON.stringify({ access_token: 'X'.repeat(size), refresh_token: 'synthetic-refresh-new',
      expires_in: 3600, scope: 'chatgpt.tokens.use.direct' }));
    const auth = await openFactoryOAuth(f.options);
    if (size === 4096) assert.equal((await auth.getAuth()).apiKey.length, 4096);
    else {
      await assert.rejects(auth.getAuth(), closed);
      assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { openai: initial });
    }
  }
  const f = await fixture();
  for (let i = 0; i < 125; i++) f.records.registerSecret(`synthetic-preexisting-${i}`);
  const auth = await openFactoryOAuth(f.options); // three initial fields fill exactly 128.
  await assert.rejects(auth.getAuth(), closed);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { openai: initial });
});

test('rejects missing, torn, mixed, key, command and wrong-provider store without network or repair', async () => {
  const cases: unknown[] = [{}, [], null, { openai: { type: 'api_key', key: '!synthetic-command' } },
    { 'openai-codex': initial }, { openai: initial, other: initial }, { openai: { ...initial, key: 'mixed' } },
    { openai: { ...initial, clientId: '' } }, { openai: { ...initial, scopes: [] } },
    { openai: { ...initial, access: '' } }, { openai: { ...initial, expires: 'tomorrow' } }];
  const before = attempts.fetch;
  for (const value of cases) {
    const f = await fixture();
    const raw = JSON.stringify(value);
    await writeFile(f.path, raw);
    await assert.rejects(openFactoryOAuth(f.options), closed);
    assert.equal(await readFile(f.path, 'utf8'), raw);
  }
  for (const raw of ['', '{"openai":']) {
    const f = await fixture(); await writeFile(f.path, raw);
    await assert.rejects(openFactoryOAuth(f.options), closed);
    assert.equal(await readFile(f.path, 'utf8'), raw);
  }
  const f = await fixture(); await unlink(f.path);
  await assert.rejects(openFactoryOAuth(f.options), closed);
  await assert.rejects(lstat(f.path), { code: 'ENOENT' });
  assert.equal(attempts.fetch, before);
});

test('rejects unsafe private fixture modes, hardlinks, symlinks, noncanonical roots and excluded intersections', async () => {
  const before = attempts.fetch;
  for (const entry of ['root', 'directory', 'file'] as const) {
    const f = await fixture();
    const path = entry === 'root' ? f.root : entry === 'directory' ? join(f.root, 'credentials') : f.path;
    const mode = entry === 'file' ? 0o644 : 0o755;
    await chmod(path, mode);
    await assert.rejects(openFactoryOAuth(f.options), closed);
    assert.equal((await lstat(path)).mode & 0o777, mode); // no repair.
  }
  {
    const f = await fixture(); await link(f.path, join(f.root, 'alias'));
    await assert.rejects(openFactoryOAuth(f.options), closed);
  }
  {
    const f = await fixture(); const target = join(f.root, 'target');
    await writeFile(target, JSON.stringify({ openai: initial }), { mode: 0o600 });
    await unlink(f.path); await symlink(target, f.path);
    await assert.rejects(openFactoryOAuth(f.options), closed);
  }
  {
    const f = await fixture(); const alias = `${f.root}-alias`; roots.push(alias); await symlink(f.root, alias);
    await assert.rejects(openFactoryOAuth({ ...f.options, factoryRoot: alias }), closed);
    await assert.rejects(openFactoryOAuth({ ...f.options, factoryRoot: `${f.root}/../${f.root.split('/').at(-1)}` }), closed);
  }
  for (const field of ['source', 'guest', 'profiles'] as const) {
    const f = await fixture();
    const excludedRoots = { ...f.options.excludedRoots, [field]: field === 'profiles' ? [join(f.root, 'worker')] : join(f.root, 'excluded') };
    await assert.rejects(openFactoryOAuth({ ...f.options, excludedRoots }), closed);
  }
  assert.equal(attempts.fetch, before);
});

test('fresh native store operations reject torn or missing file instead of cached credential fallback/autocreation', async () => {
  for (const missing of [false, true]) {
    const f = await fixture(); const auth = await openFactoryOAuth(f.options);
    if (missing) await unlink(f.path); else await writeFile(f.path, '{"openai":');
    await assert.rejects(auth.credentials.read('openai'), closed);
    await assert.rejects(auth.credentials.modify('openai', async () => initial), closed);
    if (missing) await assert.rejects(lstat(f.path), { code: 'ENOENT' });
    else assert.equal(await readFile(f.path, 'utf8'), '{"openai":');
  }
});

const context = { workId: 'work', executionId: 'execution', invocationId: 'invocation', role: 'builder' as const,
  environmentRef: 'environment', bootRef: 'boot', callId: 'call' };
test('rotation fences real Records current projections/raw snapshots; duplicate registration is a no-op; new output is filtered', async () => {
  const f = await fixture(); const auth = await openFactoryOAuth(f.options);
  const out = await f.records.openOutput(context); await out.write(Buffer.from('ordinary text'));
  const done = await out.finish();
  const projection = f.records.projectText({ context, reference: done.reference, expectedBytes: done.bytes });
  for await (const _ of projection.chunks) { /* exhaust */ }
  projection.assertCompleteAndCurrent();
  await auth.credentials.read('openai'); // duplicates must not invalidate.
  projection.assertCompleteAndCurrent();
  const raw = await f.records.openOutput({ ...context, callId: 'raw' }, { format: 'raw', maxBytes: 1024 });
  await raw.write(Buffer.from('ordinary raw'));
  await auth.getAuth();
  assert.throws(() => projection.assertCompleteAndCurrent(), RecordsError);
  await assert.rejects(raw.finish(), RecordsError);
  const filtered = await f.records.openOutput({ ...context, callId: 'filtered' });
  const released = await filtered.write(Buffer.from('synthetic-access-new synthetic-refresh-new'));
  const completion = await filtered.finish();
  assert.ok(!(released + completion.display).includes('synthetic-access-new'));
  assert.ok(!(released + completion.display).includes('synthetic-refresh-new'));
});

test('qualification exposes only OAuth metadata and fails closed for logout, invalid scope and unsafe OWN profile', async () => {
  const f = await fixture(); const auth = await openFactoryOAuth(f.options);
  assert.deepEqual(await auth.credentials.list(), [{ providerId: 'openai', type: 'oauth' }]);
  await assert.rejects(auth.credentials.delete('openai'), closed);
  await chmod(f.options.profileDirectory, 0o755);
  const before = attempts.fetch;
  await assert.rejects(auth.getAuth(), closed);
  assert.equal(attempts.fetch, before);
  f.controller.abort('private reason');
  await assert.rejects(auth.credentials.list(), closed);
  await assert.rejects(openFactoryOAuth(f.options), closed);
});

test('native refresh local registry failure prevents commit; denied initial ACK prevents even fake HTTP', async () => {
  const f = await fixture();
  f.options.acknowledgeSecrets = async () => { throw new Error('private future-owner failure'); };
  const auth = await openFactoryOAuth(f.options);
  const before = attempts.fetch;
  await assert.rejects(auth.getAuth(), closed);
  assert.equal(attempts.fetch, before);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { openai: initial });
});

test('missing credentials directory/root and symlink directory cannot trigger native autocreation', async () => {
  for (const missing of ['directory', 'root'] as const) {
    const f = await fixture();
    const path = missing === 'root' ? f.root : join(f.root, 'credentials');
    await rm(path, { recursive: true });
    await assert.rejects(openFactoryOAuth(f.options), closed);
    await assert.rejects(lstat(path), { code: 'ENOENT' });
  }
  const f = await fixture(); const directory = join(f.root, 'credentials');
  await rm(directory, { recursive: true });
  const target = join(f.root, 'target'); await mkdir(target, { mode: 0o700 });
  await writeFile(join(target, 'chatgpt.json'), JSON.stringify({ openai: initial }), { mode: 0o600 });
  await symlink(target, directory);
  await assert.rejects(openFactoryOAuth(f.options), closed);
});

test('canonical excluded roots cannot disguise a source intersection behind a symlink alias', async () => {
  const f = await fixture();
  const alias = `${f.root}-source-alias`; roots.push(alias); await symlink(f.root, alias);
  await assert.rejects(openFactoryOAuth({ ...f.options,
    excludedRoots: { ...f.options.excludedRoots, source: alias } }), closed);
});

test('four selected OAuth module pins reject same-size byte drift before native operation without modifying SDK files', async () => {
  const before = attempts.fetch;
  for (const name of ['auth-storage.js', 'auth-storage.d.ts', 'model-runtime.js', 'model-runtime.d.ts']) {
    const f = await fixture();
    const original = fs.readFileSync;
    const stub = mock.method(fs, 'readFileSync', (...args: unknown[]) => {
      const result = Reflect.apply(original, fs, args);
      if (String(args[0]).endsWith(`/sdk/dist/core/${name}`)) {
        const bytes = Buffer.from(result as Buffer); bytes[0] = bytes[0] === 65 ? 66 : 65; return bytes;
      }
      return result;
    });
    syncBuiltinESMExports();
    try { await assert.rejects(openFactoryOAuth(f.options), closed); }
    finally { stub.mock.restore(); syncBuiltinESMExports(); }
  }
  assert.equal(attempts.fetch, before);
});

test('profile identity and literal private runtime/type selections reject metadata drift with no SDK/profile edits', async () => {
  const before = attempts.fetch;
  for (const variant of ['profile', 'runtime-alias', 'types-alias'] as const) {
    const f = await fixture(); const original = fs.readFileSync;
    const stub = mock.method(fs, 'readFileSync', (...args: unknown[]) => {
      const result = Reflect.apply(original, fs, args);
      const path = String(args[0]);
      if (variant === 'profile' && path.endsWith('/factory-development-sdk-v3/profile.json')) {
        return JSON.stringify({ ...JSON.parse(String(result)), id: 'unapproved-profile' });
      }
      if (variant !== 'profile' && path === new URL('../../../package.json', import.meta.url).href) {
        const manifest = JSON.parse(String(result));
        manifest.imports['#factory-pi-model-runtime'][variant === 'runtime-alias' ? 'default' : 'types'] = './unapproved-model-runtime.js';
        return JSON.stringify(manifest);
      }
      return result;
    });
    syncBuiltinESMExports();
    try { await assert.rejects(openFactoryOAuth(f.options), closed); }
    finally { stub.mock.restore(); syncBuiltinESMExports(); }
  }
  assert.equal(attempts.fetch, before);
});

test('native raw key/command replacement is rejected before resolver dispatch; failure latches against stale fallback', async () => {
  const f = await fixture(); const auth = await openFactoryOAuth(f.options);
  assert.deepEqual(await auth.credentials.read('openai'), initial);
  // Child-process functions are already inert deny sentinels before SDK import.
  // This string is synthetic and never allowed to reach resolveConfigValue.
  await writeFile(f.path, JSON.stringify({ openai: { type: 'api_key', key: '!synthetic-never-executed' } }));
  const before = attempts.physical;
  await assert.rejects(auth.credentials.read('openai'), closed);
  await assert.rejects(auth.credentials.list(), closed);
  assert.equal(attempts.physical, before);
  await writeFile(f.path, JSON.stringify({ openai: initial }));
  await assert.rejects(auth.credentials.read('openai'), closed);
  await assert.rejects(auth.credentials.modify('openai', async () => initial), closed);
});
