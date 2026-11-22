import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as crash from './crasha34-qualification.js';
import * as long from './long34-qualification.js';

// Supervisor decision (2026-11-16): no ticket 34 pre-pilot recipe may write the SHARED y5 host Git cache (other recipes run after them on the
// same host). R-CRASH-A and R-LONG use their own Factory root; R-HOSTFAULT never fetches (no repository fetch credential is composed).
const shared = '/home/sanmoo/software-factory-test/y5';
const source = (name: string) => readFileSync(join(process.cwd(), 'test', 'entrypoints', name), 'utf8');
/** Longest worker socket under a Factory root (sandbox start.ts / worker-launch.ts): <root>/r/<22 base64url>/s/<uuid>.sock. */
const longestSocket = (root: string) => Buffer.byteLength(`${root}/r/${'x'.repeat(22)}/s/00000000-0000-4000-8000-000000000000.sock`);

test('R-CRASH-A and R-LONG: own Factory roots, distinct, outside y5, within the worker socket limit; their caches are never the shared one', () => {
  const roots = [crash.factoryRoots.main, crash.factoryRoots.cache, long.factoryRoot];
  assert.equal(new Set(roots).size, 3, 'one root per recipe line');
  for (const root of roots) {
    assert.ok(root !== shared && !root.startsWith(`${shared}/`), root);
    assert.ok(longestSocket(root) <= 107, `${root}: worker sockets must fit`);
    assert.ok(!`${root}/cache/git`.startsWith(`${shared}/cache`));
  }
  assert.equal(crash.sharedCache, `${shared}/cache`);
  assert.equal(long.sharedCache, `${shared}/cache`);
});

test('no phase of the three recipes composes the Factory over the shared root: every Sandbox/Workers/inventory/cache/runtime call uses the own root', () => {
  for (const name of ['crasha34-qualification.ts', 'long34-qualification.ts', 'hostfault34-qualification.ts']) {
    // The only allowed mention of the shared cache is the declared `sharedCache` constant (asserted equal above, used in plan text only).
    const text = source(name).replace('export const sharedCache = `${root}/cache`;', '');
    assert.doesNotMatch(text, /fs\.[a-zA-Z]+\([^)]*sharedCache/, `${name}: an I/O call on the shared cache`);
    assert.doesNotMatch(text, /create(Sandbox|Workers)\(\{ root[,} ]/, `${name}: Sandbox/Workers over the shared root`);
    assert.doesNotMatch(
      text,
      /(inventoryRuntime|reconcileInterruptedCaches|observeHostCapacity)\(root\)/,
      `${name}: inventory/cache reconciliation of the shared root`,
    );
    assert.doesNotMatch(text, /workerRuntimeDirectory\(root,/, name);
    assert.doesNotMatch(text, /\$\{root\}\/(cache|environments|r\/)/, `${name}: a path in the shared root`);
    assert.doesNotMatch(text, /\$\{root\}\/\$\{work/, `${name}: Records of the shared root`);
  }
  assert.doesNotMatch(source('hostfault34-qualification.ts'), /repositoryFetch/, 'R-HOSTFAULT never fetches: no host Git cache at all');
});
