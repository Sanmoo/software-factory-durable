// Ticket 40: no fixed timer in fast/ci test code. A numeric `timeout:` (test option, spawnSync, execFile, fork) or a wait loop
// bounded by an iteration count expires under machine load while the run is still healthy; the bound is what remains of the
// runner's tier budget instead (test/runner/budget.ts: ended(), until(), remainingMs()).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

/** Not test timers: the bounds belong to what the code under test receives, or to recipes outside the tiers. */
const exempt: Record<string, string> = {
  'test/entrypoints/credential20-provider.ts': 'scripted model provider of the credential20 qualification recipe: Bash tool arguments (seconds)',
  'test/entrypoints/recovery26-provider.ts': 'scripted model provider of the recovery26 qualification recipe: Bash tool arguments (seconds)',
  'test/entrypoints/limits19-provider.ts': 'scripted model provider of the limits19 qualification recipe: Bash tool arguments (seconds)',
  'test/entrypoints/long34-provider.ts': 'scripted model provider of the long34 (R-LONG) qualification recipe: Bash tool arguments (seconds)',
  'test/entrypoints/finite-qualification-provider.ts': 'scripted model provider of the finite qualification recipe: Bash tool arguments (seconds)',
  'test/workers/native-builder-bash.test.ts': 'the Bash tool `timeout` argument is the input under test (its expiry path), not a test timer',
};

function sources(directory: string, root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sources(path, root));
    else if (/\.(ts|mjs|js)$/.test(entry.name)) found.push(relative(root, path));
  }
  return found;
}

const numericTimeout = /\btimeout:\s*[\d_.]+/;
const countedLoop = /\bfor \(let (\w+) = 0; \1 < [\d_]+/;
const waits = /\b(setTimeout|setImmediate|delay|pause|sleep)\(/;

/** The loop starting at `start`: its single-statement line, or its braced body up to the matching close. */
function loopBody(text: string, start: number): string {
  const lineEnd = text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start);
  if (!text.slice(start, lineEnd).trimEnd().endsWith('{')) return text.slice(start, lineEnd);
  const open = text.lastIndexOf('{', lineEnd);
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return text.slice(start);
}

/**
 * Fixed timers in one source: numeric `timeout:` options, and counted `for` loops that poll (they wait, and stop early on a condition:
 * `&&` in the header, or a break/return in the body). A sweep that waits a different offset on every round is not a poll.
 */
function fixedTimers(text: string): string[] {
  const found: string[] = [];
  let offset = 0;
  text.split('\n').forEach((line, index) => {
    if (numericTimeout.test(line)) found.push(`${index + 1}: numeric timeout`);
    const loop = countedLoop.exec(line);
    const body = loop ? loopBody(text, offset + loop.index) : '';
    const polls = /^[^;]*;[^;]*&&/.test(body) || /\b(break|return)\b/.test(body);
    if (loop && polls && waits.test(body)) found.push(`${index + 1}: wait loop with a fixed count`);
    offset += line.length + 1;
  });
  return found;
}

test('the detector finds numeric timeouts and counted wait loops, and leaves budget-derived bounds and plain loops alone', () => {
  assert.deepEqual(fixedTimers("test('x', { timeout: 15000 }, async () => {});"), ['1: numeric timeout']);
  assert.deepEqual(fixedTimers("spawnSync(node, [], { encoding: 'utf8', timeout: 30_000 });"), ['1: numeric timeout']);
  assert.deepEqual(fixedTimers('for (let i = 0; i < 800; i++) {\n  if (await ready()) return;\n  await delay(10);\n}'), ['1: wait loop with a fixed count']);
  assert.deepEqual(fixedTimers('for (let i = 0; i < 400 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5));'), ['1: wait loop with a fixed count']);
  assert.deepEqual(fixedTimers("test('x', { timeout: remainingMs() }, async () => {});"), []);
  assert.deepEqual(fixedTimers('for (let i = 0; i < 800; i++) {\n  const work = await show();\n  if (work) break;\n  if (time.isSleeping()) time.advance();\n  const x = 1;\n  await new Promise(resolve => setTimeout(resolve, 5));\n}'),
    ['1: wait loop with a fixed count'], 'the whole braced body, however long');
  assert.deepEqual(fixedTimers('for (let i = 0; i < 6000 && !(await work())?.readiness; i++) {\n  if (time.isSleeping()) time.advance();\n  await new Promise(resolve => setTimeout(resolve, 10));\n}'),
    ['1: wait loop with a fixed count'], 'a call in the header condition');
  assert.deepEqual(fixedTimers('for (let offset = 0; offset < 12; offset++) {\n  await new Promise(resolve => setTimeout(resolve, offset * 5));\n  assert.ok(check());\n}'), [], 'a sweep is not a poll');
  assert.deepEqual(fixedTimers('for (let i = 0; i < 128; i++) records.registerSecret(`s-${i}`);'), []);
  assert.deepEqual(fixedTimers('for (let i = 0; i < 10; i++) {\n  try { await mkdir(root); return root; } catch {}\n}\nawait delay(5);'), [], 'a wait after the loop is not in it');
  assert.deepEqual(fixedTimers('for (let round = 0; round < 3; round++) { h.time.advance(); await h.time.sleeping(); }'), [], 'fake clock steps are not waits');
});

test('no fixed timer in fast/ci test code: test()/spawnSync/execFile bounds and waits derive from the runner budget', () => {
  const root = process.cwd();
  const offenders = sources(join(root, 'test'), root)
    .filter(file => !/-qualification/.test(file) && !(file in exempt) && file !== 'test/runner/fixed-timers.test.ts')
    .flatMap(file => fixedTimers(readFileSync(join(root, file), 'utf8')).map(problem => `${file}:${problem}`));
  assert.deepEqual(offenders, [], 'use ended(), until() or remainingMs() from test/runner/budget.ts (ticket 40)');
  for (const file of Object.keys(exempt)) assert.ok(sources(join(root, 'test'), root).includes(file), `exemption for a missing file: ${file}`);
});
