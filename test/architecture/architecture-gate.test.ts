import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { cruise } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import { ESLint } from 'eslint';

// Ticket 37: the same checkers as `npm run check:architecture` (dependency-cruiser with .dependency-cruiser.cjs, ESLint with
// eslint.config.mjs), through their public APIs in this one process instead of one CLI process per fixture. Each fixture is still its
// own tree analysed from its own root, exactly as the CLI did with `cwd: root` (the rules are root-relative paths).
const config = resolve('.dependency-cruiser.cjs');
const cruiseOptions = await extractDepcruiseOptions(config);
interface Violation {
  from: string;
  to: string;
  rule: { name: string };
}
async function inside<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(root);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}
async function analyze(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'factory-architecture-'));
  try {
    await writeFile(join(root, 'tsconfig.json'), await readFile('tsconfig.json', 'utf8'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const result = await inside(root, () => cruise(['.'], { ...cruiseOptions, outputType: 'json' }, undefined, { tsConfig: extractTSConfig('tsconfig.json') }));
    const output = typeof result.output === 'string' ? JSON.parse(result.output) : result.output;
    // The JSON reporter's validation verdict, as with the CLI's JSON output.
    const summary = output.summary;
    return { status: summary.advisedExitCode as number, violations: summary.violations as Violation[] };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('architecture gate permits a public records import from platform/github including type-only imports', async () => {
  const result = await analyze({
    'src/records/index.ts': 'export interface Entry { id: string }',
    'src/platform/github/index.ts': "import type { Entry } from '../../records/index.js'; export type Result = Entry;",
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.violations, []);
});

async function rejects(files: Record<string, string>, rule: string, from: string, to?: string) {
  const result = await analyze(files);
  assert.notEqual(result.status, 0, `Fixture unexpectedly passed: ${rule}`);
  assert.ok(
    result.violations.some(violation => violation.rule.name === rule && violation.from === from && (to === undefined || violation.to === to)),
    JSON.stringify(result.violations),
  );
}

test('controller composition permits only the approved shared configuration bootstrap, not private module imports', async () => {
  const result = await analyze({
    'src/entrypoints/configuration.ts': 'export const readConfiguration = () => ({});',
    'src/entrypoints/controller/owner.ts': "export { readConfiguration } from '../configuration.js';",
  });
  assert.equal(result.status, 0, JSON.stringify(result.violations));
  await rejects(
    {
      'src/control/durable/private.ts': 'export const secret = 1;',
      'src/entrypoints/controller/owner.ts': "export { secret } from '../../control/durable/private.js';",
    },
    'public-entry:control',
    'src/entrypoints/controller/owner.ts',
    'src/control/durable/private.ts',
  );
  await rejects(
    {
      'src/entrypoints/configuration.ts': 'export const readConfiguration = () => ({});',
      'src/entrypoints/worker.ts': "export { readConfiguration } from './configuration.js';",
    },
    'composition:worker',
    'src/entrypoints/worker.ts',
    'src/entrypoints/configuration.ts',
  );
});

test('architecture gate rejects deep imports through relative paths', async () => {
  await rejects(
    {
      'src/records/private.ts': 'export const secret = 1;',
      'src/platform/github/index.ts': "export { secret } from '../../records/private.js';",
    },
    'public-entry:records',
    'src/platform/github/index.ts',
    'src/records/private.ts',
  );
});

test('architecture gate rejects dependency inversion even through a public export', async () => {
  await rejects(
    {
      'src/control/index.ts': 'export interface Work { id: string }',
      'src/protocol/index.ts': "import type { Work } from '../control/index.js'; export type Message = Work;",
    },
    'zone:protocol',
    'src/protocol/index.ts',
    'src/control/index.ts',
  );
});

test('architecture gate detects cross-zone cycles made only of types', async () => {
  await rejects(
    {
      'src/contracts/index.ts': "import type { RecordEntry } from '../records/index.js'; export interface Identity { record?: RecordEntry }",
      'src/records/index.ts': "import type { Identity } from '../contracts/index.js'; export interface RecordEntry { id: Identity }",
    },
    'no-cycles',
    'src/contracts/index.ts',
    'src/records/index.ts',
  );
});

test('architecture gate resolves tsconfig aliases and rejects alias bypass of public entries', async () => {
  await rejects(
    {
      'src/records/private.ts': 'export const secret = 1;',
      'src/platform/github/index.ts': "export { secret } from '@factory/records/private.js';",
    },
    'public-entry:records',
    'src/platform/github/index.ts',
    'src/records/private.ts',
  );
});

test('architecture gate rejects SQLite outside its durable Control owner', async () => {
  await rejects({ 'src/records/index.ts': "export { DatabaseSync } from 'node:sqlite';" }, 'sdk:sqlite-owner', 'src/records/index.ts', 'node:sqlite');
});

test('architecture gate rejects previously unclassified authored source, even when orphaned', async () => {
  await rejects({ 'src/misc/escape.ts': 'export const bypass = true;' }, 'classified-source', 'src/misc/escape.ts');
});

test('architecture gate forbids Control from importing injected implementations as values', async () => {
  await rejects(
    {
      'src/sandbox/index.ts': 'export const createSandbox = () => ({});',
      'src/control/index.ts': "import { createSandbox } from '../sandbox/index.js'; export const sandbox = createSandbox();",
    },
    'control-contracts-only',
    'src/control/index.ts',
    'src/sandbox/index.ts',
  );
});

test('architecture gate enforces worker composition and CLI type-only access to Control', async () => {
  await rejects(
    {
      'src/control/index.ts': 'export const run = () => 1;',
      'src/entrypoints/worker.ts': "export { run } from '../control/index.js';",
    },
    'composition:worker',
    'src/entrypoints/worker.ts',
    'src/control/index.ts',
  );
  await rejects(
    {
      'src/control/index.ts': 'export const run = () => 1;',
      'src/entrypoints/cli.ts': "export { run } from '../control/index.js';",
    },
    'cli-control-types-only',
    'src/entrypoints/cli.ts',
    'src/control/index.ts',
  );
});

async function syntaxViolations(path: string, source: string) {
  const root = await mkdtemp(join(tmpdir(), 'factory-syntax-'));
  try {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
    const [result] = await new ESLint({ cwd: root, overrideConfigFile: resolve('eslint.config.mjs') }).lintFiles([path]);
    assert.ok(result, path);
    // The CLI's exit status: 1 when any error, 0 otherwise (no --max-warnings here, as before).
    return { status: result.errorCount > 0 ? 1 : 0, messages: result.messages as { ruleId: string | null; message: string }[] };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('architecture syntax gate rejects real clocks in pure Control rules', async () => {
  const result = await syntaxViolations('src/control/rules/decision.ts', 'export const now = Date.now();');
  assert.equal(result.status, 1);
  assert.ok(result.messages.some(message => message.ruleId === 'no-restricted-syntax' && /injected/.test(message.message)));
});

test('v2: Control never names a sandbox adapter or its service: it reads declared capabilities only', async () => {
  for (const source of [
    "export const preserves = (adapter: string) => adapter === 'gondolin';",
    "export const rotate = (sandbox: { profile: string }) => sandbox.profile.startsWith('lambda-');",
    'export const isLambda = (capabilities: { docker: boolean }) => !capabilities.docker;',
    'export const stop = (service: { terminateMicrovm(): void }) => service.terminateMicrovm();',
    'export const label = (boot: string) => `qemu:${boot}`;',
  ]) {
    for (const path of ['src/control/durable/dispatch.ts', 'src/control/rules/capabilities.ts', 'src/control/types.ts']) {
      const result = await syntaxViolations(path, source);
      assert.equal(result.status, 1, `${path}: ${source}`);
      assert.ok(
        result.messages.some(message => message.ruleId === 'no-restricted-syntax' && /declared capabilities/.test(message.message)),
        `${path}: ${source}`,
      );
    }
  }
  // Deciding from the declared capabilities is the permitted form; other zones (the Sandbox, the composition) name their adapters freely.
  const byCapability = 'export const preserves = (capabilities: { persistentDisk: boolean }) => capabilities.persistentDisk; // Gondolin declares it';
  assert.equal((await syntaxViolations('src/control/rules/capabilities.ts', byCapability)).status, 0);
  assert.equal((await syntaxViolations('src/sandbox/configuration.ts', "export const adapters = ['gondolin', 'lambda'];")).status, 0);
  assert.equal((await syntaxViolations('src/entrypoints/controller/composition.ts', "export const adapter = 'gondolin';")).status, 0);
});

test('architecture syntax gate rejects opaque computed loading while permitting literal dynamic imports', async () => {
  const rejected = await syntaxViolations('src/entrypoints/cli.ts', "const path = './unknown.js'; export const load = () => import(path);");
  assert.equal(rejected.status, 1);
  assert.ok(rejected.messages.some(message => message.ruleId === 'no-restricted-syntax' && /literal/.test(message.message)));
  const allowed = await syntaxViolations('src/entrypoints/cli.ts', "export const load = () => import('../contracts/index.js');");
  assert.equal(allowed.status, 0);
});

test('architecture gate rejects I/O imports in pure Control rules', async () => {
  await rejects(
    { 'src/control/rules/decision.ts': "import { readFile } from 'node:fs/promises'; export const decide = readFile;" },
    'pure-rules-imports',
    'src/control/rules/decision.ts',
    'fs/promises',
  );
});

test('architecture gate keeps SDK ownership rules sensitive to resolved package imports, not missing dependencies', async () => {
  const packages = [
    ['@earendil-works/pi-durable', 'durable', 'src/records/index.ts'],
    ['@earendil-works/pi-coding-agent', 'coding-agent', 'src/control/index.ts'],
    ['@earendil-works/gondolin', 'gondolin', 'src/workers/index.ts'],
    ['@octokit/rest', 'github', 'src/sandbox/index.ts'],
  ];
  for (const [pkg, owner, source] of packages) {
    assert.ok(pkg && owner && source);
    await rejects(
      {
        [`node_modules/${pkg}/package.json`]: '{"type":"module","exports":"./index.js"}',
        [`node_modules/${pkg}/index.js`]: 'export const SDK = {};',
        [source]: `import { SDK } from '${pkg}'; export { SDK };`,
      },
      `sdk:${owner}-owner`,
      source,
      `node_modules/${pkg}/index.js`,
    );
  }
});

test('architecture gate permits injected contracts, the tools type projection, and SQLite in its owning implementation', async () => {
  const result = await analyze({
    'src/contracts/index.ts': 'export interface Identity { id: string }',
    'src/sandbox/index.ts': 'export interface Tools { read(path: string): string }',
    'src/workers/index.ts': "import type { Tools } from '../sandbox/index.js'; export interface Worker { tools: Tools }",
    'src/control/index.ts': "import type { Worker } from '../workers/index.js'; export interface Control { worker: Worker }",
    'src/control/durable/storage.ts': "export { DatabaseSync } from 'node:sqlite';",
    'src/entrypoints/cli.ts': "import type { Control } from '../control/index.js'; export type View = Control;",
  });
  assert.equal(result.status, 0, JSON.stringify(result.violations));
});

test('architecture gate detects unclassified authored source outside src as well', async () => {
  await rejects(
    { 'src/contracts/index.ts': 'export interface Identity { id: string }', 'escape.mjs': 'export const bypass = true;' },
    'classified-source',
    'escape.mjs',
  );
});

test('pure-rule clock restriction also applies to authored ESM JavaScript', async () => {
  const result = await syntaxViolations('src/control/rules/decision.mjs', 'export const now = Date.now();');
  assert.equal(result.status, 1);
  assert.ok(result.messages.some(message => message.ruleId === 'no-restricted-syntax'));
});

test('architecture syntax gate confines the private pinned SDK alias to Workers including type/reexport/dynamic loading', async () => {
  for (const source of [
    "import type { ResourceLoader } from '#factory-pi'; export type Loader = ResourceLoader;",
    "export { createReadTool } from '#factory-pi';",
    "export * from '#factory-pi';",
    "export const load = () => import('#factory-pi');",
  ]) {
    const result = await syntaxViolations('src/sandbox/escape.ts', source);
    assert.equal(result.status, 1, source);
    assert.ok(result.messages.some(message => /private SDK alias/.test(message.message)));
  }
  assert.equal((await syntaxViolations('src/workers/read.ts', "export { createReadTool } from '#factory-pi';")).status, 0);
});

test('fixed human login permits Workers public setup operation only through setup composition', async () => {
  const result = await analyze({
    'src/workers/index.ts': 'export const firstFactoryOAuthLogin = () => undefined;',
    'src/entrypoints/setup.ts': "export { firstFactoryOAuthLogin } from '../workers/index.js';",
  });
  assert.equal(result.status, 0, JSON.stringify(result.violations));
  await rejects(
    {
      'src/workers/factory-oauth.ts': 'export const privateLogin = () => undefined;',
      'src/entrypoints/setup.ts': "export { privateLogin } from '../workers/factory-oauth.js';",
    },
    'public-entry:workers',
    'src/entrypoints/setup.ts',
    'src/workers/factory-oauth.ts',
  );
  await rejects(
    {
      'src/workers/index.ts': 'export const firstFactoryOAuthLogin = () => undefined;',
      'src/entrypoints/cli.ts': "export { firstFactoryOAuthLogin } from '../workers/index.js';",
    },
    'cli-workers-setup-only',
    'src/entrypoints/cli.ts',
    'src/workers/index.ts',
  );
});

test('release bootstrap (ticket 32) is CLI-classified, shared with the controller like configuration, never with workers', async () => {
  const result = await analyze({
    'src/sandbox/index.ts': 'export const prepareReleaseGondolinSdk = () => undefined;',
    'src/entrypoints/release.ts': 'export const readRelease = () => ({});',
    'src/entrypoints/release-build.ts': "export { readRelease } from './release.js'; export { prepareReleaseGondolinSdk } from '../sandbox/index.js';",
    'src/entrypoints/doctor.ts': "export { readRelease } from './release.js';",
    'src/entrypoints/controller/owner.ts': "export { readRelease } from '../release.js';",
  });
  assert.equal(result.status, 0, JSON.stringify(result.violations));
  await rejects(
    {
      'src/entrypoints/release.ts': 'export const readRelease = () => ({});',
      'src/entrypoints/worker.ts': "export { readRelease } from './release.js';",
    },
    'composition:worker',
    'src/entrypoints/worker.ts',
    'src/entrypoints/release.ts',
  );
  for (const from of ['src/entrypoints/release.ts', 'src/entrypoints/release-build.ts']) {
    await rejects(
      {
        'src/workers/index.ts': 'export const skillPacks = {};',
        [from]: "export { skillPacks } from '../workers/index.js';",
      },
      'cli-workers-setup-only',
      from,
      'src/workers/index.ts',
    );
  }
  await rejects(
    {
      'src/entrypoints/setup.ts': 'export const setup = () => undefined;',
      'src/entrypoints/controller/owner.ts': "export { setup } from '../setup.js';",
    },
    'composition:controller',
    'src/entrypoints/controller/owner.ts',
    'src/entrypoints/setup.ts',
  );
});
