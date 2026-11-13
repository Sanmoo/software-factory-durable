import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = resolve('node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
const config = resolve('.dependency-cruiser.cjs');
interface Violation { from: string; to: string; rule: { name: string }; }
async function analyze(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'factory-architecture-'));
  try {
    await writeFile(join(root, 'tsconfig.json'), await readFile('tsconfig.json', 'utf8'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const result = spawnSync(process.execPath, [checker, '--config', config, '--output-type', 'json', '.'], { cwd: root, encoding: 'utf8' });
    assert.ok(result.stdout, result.stderr);
    // JSON reporter exits zero for a successfully produced graph; use its validation verdict.
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout).summary;
    return { status: summary.advisedExitCode, violations: summary.violations as Violation[] };
  } finally { await rm(root, { recursive: true, force: true }); }
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
  assert.ok(result.violations.some(violation => violation.rule.name === rule && violation.from === from
    && (to === undefined || violation.to === to)), JSON.stringify(result.violations));
}

test('controller composition permits only the approved shared configuration bootstrap, not private module imports', async () => {
  const result = await analyze({
    'src/entrypoints/configuration.ts': 'export const readConfiguration = () => ({});',
    'src/entrypoints/controller/owner.ts': "export { readConfiguration } from '../configuration.js';",
  });
  assert.equal(result.status, 0, JSON.stringify(result.violations));
  await rejects({
    'src/control/durable/private.ts': 'export const secret = 1;',
    'src/entrypoints/controller/owner.ts': "export { secret } from '../../control/durable/private.js';",
  }, 'public-entry:control', 'src/entrypoints/controller/owner.ts', 'src/control/durable/private.ts');
  await rejects({
    'src/entrypoints/configuration.ts': 'export const readConfiguration = () => ({});',
    'src/entrypoints/worker.ts': "export { readConfiguration } from './configuration.js';",
  }, 'composition:worker', 'src/entrypoints/worker.ts', 'src/entrypoints/configuration.ts');
});

test('architecture gate rejects deep imports through relative paths', async () => {
  await rejects({
    'src/records/private.ts': 'export const secret = 1;',
    'src/platform/github/index.ts': "export { secret } from '../../records/private.js';",
  }, 'public-entry:records', 'src/platform/github/index.ts', 'src/records/private.ts');
});

test('architecture gate rejects dependency inversion even through a public export', async () => {
  await rejects({
    'src/control/index.ts': 'export interface Work { id: string }',
    'src/protocol/index.ts': "import type { Work } from '../control/index.js'; export type Message = Work;",
  }, 'zone:protocol', 'src/protocol/index.ts', 'src/control/index.ts');
});

test('architecture gate detects cross-zone cycles made only of types', async () => {
  await rejects({
    'src/contracts/index.ts': "import type { RecordEntry } from '../records/index.js'; export interface Identity { record?: RecordEntry }",
    'src/records/index.ts': "import type { Identity } from '../contracts/index.js'; export interface RecordEntry { id: Identity }",
  }, 'no-cycles', 'src/contracts/index.ts', 'src/records/index.ts');
});

test('architecture gate resolves tsconfig aliases and rejects alias bypass of public entries', async () => {
  await rejects({
    'src/records/private.ts': 'export const secret = 1;',
    'src/platform/github/index.ts': "export { secret } from '@factory/records/private.js';",
  }, 'public-entry:records', 'src/platform/github/index.ts', 'src/records/private.ts');
});

test('architecture gate rejects SQLite outside its durable Control owner', async () => {
  await rejects({ 'src/records/index.ts': "export { DatabaseSync } from 'node:sqlite';" },
    'sdk:sqlite-owner', 'src/records/index.ts', 'node:sqlite');
});

test('architecture gate rejects previously unclassified authored source, even when orphaned', async () => {
  await rejects({ 'src/misc/escape.ts': 'export const bypass = true;' },
    'classified-source', 'src/misc/escape.ts');
});

test('architecture gate forbids Control from importing injected implementations as values', async () => {
  await rejects({
    'src/sandbox/index.ts': 'export const createSandbox = () => ({});',
    'src/control/index.ts': "import { createSandbox } from '../sandbox/index.js'; export const sandbox = createSandbox();",
  }, 'control-contracts-only', 'src/control/index.ts', 'src/sandbox/index.ts');
});

test('architecture gate enforces worker composition and CLI type-only access to Control', async () => {
  await rejects({
    'src/control/index.ts': 'export const run = () => 1;',
    'src/entrypoints/worker.ts': "export { run } from '../control/index.js';",
  }, 'composition:worker', 'src/entrypoints/worker.ts', 'src/control/index.ts');
  await rejects({
    'src/control/index.ts': 'export const run = () => 1;',
    'src/entrypoints/cli.ts': "export { run } from '../control/index.js';",
  }, 'cli-control-types-only', 'src/entrypoints/cli.ts', 'src/control/index.ts');
});

async function syntaxViolations(path: string, source: string) {
  const root = await mkdtemp(join(tmpdir(), 'factory-syntax-'));
  try {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
    const result = spawnSync(process.execPath, [resolve('node_modules/eslint/bin/eslint.js'), '--config', resolve('eslint.config.mjs'), '--format', 'json', path],
      { cwd: root, encoding: 'utf8' });
    assert.ok(result.stdout, result.stderr);
    return { status: result.status, messages: JSON.parse(result.stdout)[0].messages as { ruleId: string; message: string }[] };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('architecture syntax gate rejects real clocks in pure Control rules', async () => {
  const result = await syntaxViolations('src/control/rules/decision.ts', 'export const now = Date.now();');
  assert.equal(result.status, 1);
  assert.ok(result.messages.some(message => message.ruleId === 'no-restricted-syntax' && /injected/.test(message.message)));
});

test('architecture syntax gate rejects opaque computed loading while permitting literal dynamic imports', async () => {
  const rejected = await syntaxViolations('src/entrypoints/cli.ts', "const path = './unknown.js'; export const load = () => import(path);");
  assert.equal(rejected.status, 1);
  assert.ok(rejected.messages.some(message => message.ruleId === 'no-restricted-syntax' && /literal/.test(message.message)));
  const allowed = await syntaxViolations('src/entrypoints/cli.ts', "export const load = () => import('../contracts/index.js');");
  assert.equal(allowed.status, 0);
});

test('architecture gate rejects I/O imports in pure Control rules', async () => {
  await rejects({ 'src/control/rules/decision.ts': "import { readFile } from 'node:fs/promises'; export const decide = readFile;" },
    'pure-rules-imports', 'src/control/rules/decision.ts', 'fs/promises');
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
    await rejects({
      [`node_modules/${pkg}/package.json`]: '{"type":"module","exports":"./index.js"}',
      [`node_modules/${pkg}/index.js`]: 'export const SDK = {};',
      [source]: `import { SDK } from '${pkg}'; export { SDK };`,
    }, `sdk:${owner}-owner`, source, `node_modules/${pkg}/index.js`);
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
  await rejects({ 'src/contracts/index.ts': 'export interface Identity { id: string }',
    'escape.mjs': 'export const bypass = true;' }, 'classified-source', 'escape.mjs');
});

test('pure-rule clock restriction also applies to authored ESM JavaScript', async () => {
  const result = await syntaxViolations('src/control/rules/decision.mjs', 'export const now = Date.now();');
  assert.equal(result.status, 1);
  assert.ok(result.messages.some(message => message.ruleId === 'no-restricted-syntax'));
});

test('architecture syntax gate confines the private pinned SDK alias to Workers including type/reexport/dynamic loading', async () => {
  for (const source of ["import type { ResourceLoader } from '#factory-pi'; export type Loader = ResourceLoader;",
    "export { createReadTool } from '#factory-pi';", "export * from '#factory-pi';", "export const load = () => import('#factory-pi');"]) {
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
  await rejects({
    'src/workers/factory-oauth.ts': 'export const privateLogin = () => undefined;',
    'src/entrypoints/setup.ts': "export { privateLogin } from '../workers/factory-oauth.js';",
  }, 'public-entry:workers', 'src/entrypoints/setup.ts', 'src/workers/factory-oauth.ts');
  await rejects({
    'src/workers/index.ts': 'export const firstFactoryOAuthLogin = () => undefined;',
    'src/entrypoints/cli.ts': "export { firstFactoryOAuthLogin } from '../workers/index.js';",
  }, 'cli-workers-setup-only', 'src/entrypoints/cli.ts', 'src/workers/index.ts');
});
