import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import Module from 'node:module';
import { observeSdkGlobals } from './audited-vfs-observer.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { auditedVfsManifest } from './fixtures/audited-vfs-manifest.js';
import { createAuditedVfsGuard, verifyAuditedVfsSources } from './audited-vfs-guard.js';
import { remainingMs } from '../runner/budget.js';

const root = auditedVfsManifest.root;
const url = (path: string) => pathToFileURL(root + '/' + path).href;
const fixture = new URL('./adapter-diagnostics-fixture.js', import.meta.url).href;
const rpc = 'dist/src/vfs/rpc-service.js';
const base = 'dist/src/vfs/node/vendored-node-vfs/lib/internal/vfs/';

test('audited VFS guard denies unknown targets and parent/alias/builtin edges before inert dispatch', t => {
  const guard = createAuditedVfsGuard();
  let dispatch = 0;
  const nextResolve = () => { dispatch++; throw new Error('INERT_RESOLVE'); };
  const nextLoad = () => { dispatch++; throw new Error('INERT_LOAD'); };
  const cases = [
    ['@earendil-works/gondolin', fixture], [url('dist/src/index.js'), fixture],
    [url('dist/src/vm/core.js'), fixture], [url(base + 'module_hooks.js'), fixture],
    [url(base + 'unlisted.js'), fixture], [url(rpc), import.meta.url],
    [url(base + 'provider.js'), fixture], ['node:fs/promises', url(base + 'providers/real.js')],
    ['node:net', url(rpc)], [url(base + 'provider.js'), url(rpc)],
    ['internal/vfs/provider', url(base + 'providers/real.js')],
    [root + '/' + base + 'provider.js', url(base + 'gondolin-shim.js')],
    ['undici', url(rpc)], ['node:fs', url(rpc)],
    [url('dist/src/index.js').replace('gondolin', '%67ondolin'), fixture],
    ['node:fs', url('dist/src/unlisted.js')],
  ];
  for (const [specifier, parentURL] of cases) {
    assert.throws(() => guard.hooks.resolve!(specifier!, { parentURL: parentURL!, conditions: [], importAttributes: {} }, nextResolve), /SDK_EVALUATION_FORBIDDEN/);
    assert.equal(dispatch, 0);
  }
  for (const path of ['dist/src/index.js', 'dist/src/vm/core.js', base + 'module_hooks.js', base + 'unlisted.js', 'package.json']) {
    assert.throws(() => guard.hooks.load!(url(path), { conditions: [], importAttributes: {}, format: 'module' }, nextLoad), /SDK_EVALUATION_FORBIDDEN/);
    assert.equal(dispatch, 0);
  }
  assert.throws(() => guard.hooks.resolve!('innocent-alias', { parentURL: fixture, conditions: [], importAttributes: {} }, () => ({ url: url(rpc) })), /SDK_EVALUATION_FORBIDDEN/);
  assert.deepEqual(guard.loaded, []);
  t.diagnostic(`rejected=${cases.length + 5}; underlying sentinel calls=${dispatch}; SDK evaluations=0`);
});

test('audited VFS guard permits only pinned entries and exact caller-origin CJS aliases (inert only)', () => {
  const guard = createAuditedVfsGuard();
  const pairs = [
    [url(rpc), fixture, url(rpc)],
    ['./statfs.js', url(rpc), url('dist/src/vfs/statfs.js')],
    [root + '/' + base + 'provider.js', url(base + 'providers/real.js'), url(base + 'provider.js')],
    ['fs', url(base + 'providers/real.js'), 'node:fs'],
    ['module', url(base + 'gondolin-shim.js'), 'node:module'],
  ];
  for (const [specifier, parentURL, target] of pairs) {
    let calls = 0;
    const result = guard.hooks.resolve!(specifier!, { parentURL: parentURL!, conditions: [], importAttributes: {} }, () => {
      calls++; return { url: target!, format: target!.startsWith('node:') ? 'builtin' : 'module' };
    });
    assert.equal(result.url, target); assert.equal(calls, 1);
  }
  assert.throws(() => guard.hooks.resolve!(url(rpc), { parentURL: fixture, conditions: [], importAttributes: {} }, () => ({ url: url('dist/src/index.js') })), /SDK_RESOLUTION_MISMATCH/);
  assert.deepEqual(guard.loaded, []);
});

test('source validation detects byte mismatch as DATA without SDK evaluation or SDK writes', () => {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    reads++;
    assert.equal(args[0], root + '/' + auditedVfsManifest.files[0].path);
    return Buffer.alloc(auditedVfsManifest.files[0].bytes, 0);
  }) as typeof fs.readFileSync;
  try { assert.throws(() => verifyAuditedVfsSources(), /SDK_HASH_MISMATCH/); assert.equal(reads, 1); }
  finally { fs.readFileSync = original; }
});

test('SDK invoke observer denies hook registration before dispatch and detects reference mutation without invoking private APIs', () => {
  const before = Module.registerHooks;
  const observer = observeSdkGlobals();
  try {
    assert.throws(() => Module.registerHooks({}), /SDK_GLOBAL_HOOK_REGISTRATION_FORBIDDEN/);
    assert.equal(observer.calls, 1);
    assert.throws(() => observer.assertUnchanged(), /unexpected SDK Module.registerHooks calls/);
  } finally {
    // Test-induced attempt is intentionally nonzero. Do not call observer.restore,
    // which correctly refuses to bless it; restore only our own test replacement.
    Module.registerHooks = before;
  }
  const clean = observeSdkGlobals();
  const cwd = process.cwd;
  try {
    process.cwd = () => { throw new Error('must not invoke'); };
    assert.throws(() => clean.assertUnchanged(), /SDK_GLOBAL_PATCH cwd/);
  } finally { process.cwd = cwd; clean.restore(); }
  assert.equal(Module.registerHooks, before);
});

test('audited actual VFS import graph loads exactly19 modules without SDK global hooks (no constructors)', async () => {
  const owned = await mkdtemp('/tmp/avfg-');
  try {
    const environment = 'env-' + createHash('sha256').update('producer-ordering-work').digest('hex');
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./adapter-diagnostics-fixture.js', import.meta.url)), owned, environment, 'boot-66666666-2222-4333-8444-555555555555'], {
      timeout: remainingMs(), encoding: 'utf8', maxBuffer: 16384,
      env: { PATH: '', NODE_DISABLE_COMPILE_CACHE: '1', ADAPTER_DIAGNOSTIC_FIXTURE_MODE: 'vfs-confinement' },
    });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
    const observation = JSON.parse(await readFile(owned + '/sdk-source-graph.json', 'utf8'));
    assert.equal(observation.aggregate, auditedVfsManifest.aggregate);
    assert.equal(observation.provider, 'RealFSProvider'); assert.equal(observation.rpc, 'FsRpcService');
    assert.equal(observation.sdkHookCalls, 0); assert.equal(observation.ownGuardRegistrations, 1);
    assert.equal(observation.cachedCjsDenied, 3);
    assert.equal(observation.vm, 'EXPLICIT_DOUBLE');
    assert.deepEqual([...new Set(observation.loaded)].sort(), auditedVfsManifest.files.filter(f => f.kind === 'approved-eager-module').map(f => f.path).sort());
  } finally { await rm(owned, { recursive: true, force: true }); }
});
