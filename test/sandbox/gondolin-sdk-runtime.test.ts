import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDevelopmentGondolinSdk } from '../../src/sandbox/gondolin-sdk-runtime.js';
import { gondolinSdkProfile, prepareDevelopmentGondolinSdk } from '../../src/sandbox/gondolin-sdk-profile.js';

const project = process.cwd();
const entry = (root: string) => pathToFileURL(join(root, gondolinSdkProfile.directory, 'sdk/dist/src/index.js')).href;

// TEST ONLY: replace exactly the verified public entry BEFORE evaluation. No SDK
// code (including transitive CPU/key/assets self-tests) may execute in this test.
test('closed loader verifies every request before exact-entry substitution; synthetic only, no native proof', async t => {
  let allowedEntry = entry(project), imports = 0;
  const effects = { creates: 0, commands: 0 };
  const counterKey = Symbol.for('factory-test-only-gondolin-runtime-effects');
  Object.defineProperty(globalThis, counterKey, { value: effects, configurable: true });
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === allowedEntry) return { url: specifier, shortCircuit: true };
      if (specifier.includes('@earendil-works/gondolin') || specifier.includes('/factory-development-gondolin-v1/') || context.parentURL === allowedEntry) throw new Error('UNLISTED_SDK_IMPORT');
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === allowedEntry) {
        imports++;
        return { format: 'module', shortCircuit: true, source: `
          export class VM {
            constructor() { throw new Error('SYNTHETIC_CONSTRUCTOR_FORBIDDEN'); }
            static create() { globalThis[Symbol.for('factory-test-only-gondolin-runtime-effects')].creates++; throw new Error('SYNTHETIC_CREATE_FORBIDDEN'); }
            exec() { globalThis[Symbol.for('factory-test-only-gondolin-runtime-effects')].commands++; throw new Error('SYNTHETIC_COMMAND_FORBIDDEN'); }
          }
          export class RealFSProvider {
            constructor() { throw new Error('SYNTHETIC_PROVIDER_FORBIDDEN'); }
          }
        ` };
      }
      if (url.includes('/gondolin/') || url.includes('/factory-development-gondolin-v1/')) throw new Error('UNLISTED_SDK_LOAD');
      return nextLoad(url, context);
    },
  });
  const root = await mkdtemp(join(tmpdir(), 'gdr-'));
  const staged = join(root, gondolinSdkProfile.directory);
  try {
    // All fixture SDK source is copied as DATA only, never evaluated.
    await mkdir(join(root, 'node_modules/@earendil-works'), { recursive: true });
    await cp(join(project, 'node_modules/@earendil-works/gondolin'), join(root, 'node_modules/@earendil-works/gondolin'), { recursive: true });
    for (const name of ['cbor2', 'ssh2', 'undici', '@earendil-works/gondolin-krun-runner-linux-x64']) {
      const target = join(root, 'node_modules', name, 'package.json');
      await mkdir(dirname(target), { recursive: true });
      await cp(join(project, 'node_modules', name, 'package.json'), target);
    }
    await cp(join(project, 'package-lock.json'), join(root, 'package-lock.json'));
    await mkdir(join(root, 'docs/evidence'), { recursive: true });
    await cp(join(project, 'docs/evidence/gondolin-sdk-v1'), join(root, 'docs/evidence/gondolin-sdk-v1'), { recursive: true });
    await mkdir(join(root, '.scratch'));
    // Run the authored compiled modules at their normal layout in our fixture.
    // This tests fixed module-relative selection, without production test seams.
    const app = join(root, 'dist/src/sandbox');
    await mkdir(app, { recursive: true });
    for (const name of ['gondolin-sdk-runtime.js', 'gondolin-sdk-profile.js']) {
      await cp(new URL(`../../src/sandbox/${name}`, import.meta.url), join(app, name));
    }
    // eslint-disable-next-line no-restricted-syntax -- Test-only owned copy of authored compiled module, not an SDK module URL.
    const fixtureLoader: typeof import('../../src/sandbox/gondolin-sdk-runtime.js') = await import(pathToFileURL(join(app, 'gondolin-sdk-runtime.js')).href);
    const loadFixture = fixtureLoader.loadDevelopmentGondolinSdk;
    allowedEntry = entry(root);
    imports = 0;
    await assert.rejects(loadFixture()); // missing profile, no fallback
    assert.equal(imports, 0);
    await mkdir(staged, { mode: 0o700 });
    await assert.rejects(loadFixture()); // incomplete, never repaired
    assert.equal(imports, 0);
    await rm(staged, { recursive: true }); // own test fixture only
    await prepareDevelopmentGondolinSdk(root);
    const core = join(staged, 'sdk/dist/src/vm/core.js');
    const original = await readFile(core);
    await writeFile(core, 'drift');
    await assert.rejects(loadFixture());
    assert.equal(imports, 0);
    await writeFile(core, original);
    const first = await loadFixture();
    assert.equal(imports, 1);
    assert.equal(await loadFixture().then(sdk => sdk.VM), first.VM);
    assert.equal(imports, 1); // Node caches namespace, not verifier approval
    await writeFile(core, 'drift after cached import');
    await assert.rejects(loadFixture());
    assert.equal(imports, 1);
    assert.equal(await readFile(core, 'utf8'), 'drift after cached import');
    process.chdir(root); // Selection must not depend on the systemd working directory.
    allowedEntry = entry(project);
    imports = 0;
    // Actual retained profile: verifier-only reads followed by controlled entry
    // substitution. Snapshot metadata confirms this test does not rewrite it.
    const record = join(project, gondolinSdkProfile.directory, 'profile.json');
    const before = await stat(record), bytes = await readFile(record);
    const sdk = await loadDevelopmentGondolinSdk();
    assert.equal(typeof sdk.VM.create, 'function');
    assert.equal(typeof sdk.RealFSProvider, 'function');
    assert.equal(imports, 1);
    assert.deepEqual(await readFile(record), bytes);
    assert.equal((await stat(record)).mtimeMs, before.mtimeMs);

    // Fail before effects: synthetic SDK create/exec are never requested.
    assert.deepEqual(effects, { creates: 0, commands: 0 });
    t.diagnostic('missing/incomplete/drift import0; fixture valid+cached import1; cached drift refused; actual verified exact-entry substitution1; synthetic create0/command0; real SDK evaluations0');
  } finally {
    process.chdir(project);
    hooks.deregister();
    Reflect.deleteProperty(globalThis, counterKey);
    await rm(root, { recursive: true, force: true });
  }
});

test('adapter routes at existing sdk-import gate; backend and lifecycle options stay intact (static, no host boots)', async () => {
  const source = await readFile(join(project, 'src/sandbox/adapter.ts'), 'utf8');
  const gate = source.indexOf("phase = 'sdk-import'");
  const load = source.indexOf('await loadDevelopmentGondolinSdk()');
  assert.ok(gate > source.indexOf('await inspectGuestAssets('));
  assert.ok(load > gate && load < source.indexOf("phase = 'vm-create'"));
  assert.equal(source.includes("await import('@earendil-works/gondolin')"), false);
  for (const preserved of ['startTimeoutMs: 30000', 'AbortSignal.timeout(10000)', "accel: 'kvm'", 'netEnabled: false',
    'rootDiskReadOnly: false', 'rootDiskDeleteOnClose: false', 'debugLog: null', 'await vm.start()', 'vm?.close()']) {
    assert.ok(source.includes(preserved), preserved);
  }
});
