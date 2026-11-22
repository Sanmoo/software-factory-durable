import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directivesOf, matchSuppressions, parseTolerance, type Entry } from '../../scripts/test-runner/lint-suppressions.ts';

const source = [
  "// eslint-disable-next-line no-restricted-syntax -- reason",
  "const a = await import(x);",
  "const b = 1; // eslint-disable-line no-console, prefer-const",
  "/* eslint-disable */",
  "/* eslint no-console: off */",
  "// eslint is prose here, not a directive",
  "const s = '// eslint-disable-next-line no-restricted-syntax';",
  "const t = `/* eslint-disable */ ${s}`;",
  "/* eslint-enable */",
].join('\n');

test('directives come from real comments: each kind, its rules and the code it targets; strings, templates and prose do not count', () => {
  assert.deepEqual(directivesOf('src/a.ts', source).map(item => [item.line, item.kind, item.rules, item.target]), [
    [1, 'eslint-disable-next-line', ['no-restricted-syntax'], 'const a = await import(x);'],
    [3, 'eslint-disable-line', ['no-console', 'prefer-const'], 'const b = 1;'],
    [4, 'eslint-disable', ['*'], '*'],
    [5, 'eslint', ['no-console'], '*'],
  ]);
});

const entry = (target: string, rule = 'no-restricted-syntax'): Entry => ({ file: 'src/a.ts', rule, target, reason: 'r', decision: 'd' });

test('each suppressed rule matches one entry: a directive without one fails, a stale entry fails, two directives never share one', () => {
  const twice = '// eslint-disable-next-line no-restricted-syntax -- r\nconst a = await import(x);\n// eslint-disable-next-line no-restricted-syntax -- r\nconst a = await import(x);\n';
  const directives = directivesOf('src/a.ts', twice);
  assert.deepEqual(matchSuppressions(directives, [entry('const a = await import(x);'), entry('const a = await import(x);')]), []);
  assert.deepEqual(matchSuppressions(directives, [entry('const a = await import(x);')]).map(f => f.rule), ['suppression-not-tolerated']);
  assert.deepEqual(matchSuppressions([], [entry('gone();')]).map(f => f.rule), ['suppression-stale']);
  assert.deepEqual(matchSuppressions(directives.slice(0, 1), [entry('other();')]).map(f => f.rule), ['suppression-not-tolerated', 'suppression-stale'],
    'an entry tolerates the code it names, not the place');
});

test('the tolerance policy needs every field of every entry', () => {
  assert.throws(() => parseTolerance({ schemaVersion: 1, entries: [{ file: 'a', rule: 'r', target: 't', reason: 'x' }] }), /decision/);
  assert.throws(() => parseTolerance({ entries: [] }), /schemaVersion/);
  assert.deepEqual(parseTolerance({ schemaVersion: 1, entries: [] }), []);
});
