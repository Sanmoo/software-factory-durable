import assert from 'node:assert/strict';
import { test } from 'node:test';
import { functionsOf, identify, matchComplexity, measuredValue, parseTolerance } from '../../scripts/test-runner/complexity.ts';

const source = `export function outer(a: number) {
  const named = () => a;
  const list = [1].map(x => x + 1).filter(y => y > 0);
  return { read: async () => 1, write() { return 2; } };
}
class Desk {
  get size() { return 1; }
  constructor() {}
  run() { return () => 3; }
}
export const later = function () {};
`;

test('a function is named by its containing declarations; an anonymous one by kind and ordinal in its container', () => {
  assert.deepEqual(
    functionsOf('a.ts', source).map(f => f.identity),
    [
      'outer',
      'outer > named',
      'outer > arrow#1',
      'outer > arrow#2',
      'outer > read',
      'outer > write',
      'Desk > get size',
      'Desk > constructor',
      'Desk > run',
      'Desk > run > arrow#1',
      'later',
    ],
  );
});

test('an edit elsewhere in the file never moves an identity', () => {
  const edited = `// a comment\nimport x from 'y';\n\n${source.replace('return 2;', 'if (a) return 2;\n    return 4;')}`;
  assert.deepEqual(
    functionsOf('a.ts', edited).map(f => f.identity),
    functionsOf('a.ts', source).map(f => f.identity),
  );
});

test('two functions with one identity are told apart by order', () => {
  const text = 'function f() { return [{ go: () => 1 }, { go: () => 2 }]; }\n';
  assert.deepEqual(
    functionsOf('a.ts', text).map(f => f.identity),
    ['f', 'f > go', 'f > go (2)'],
  );
});

test('a reported position maps to the innermost function, including a binding name before the function node', () => {
  const text = 'export function outer() {\n  return { afterCycle: async () => { return 1; } };\n}\n';
  assert.deepEqual(
    identify(
      [
        { file: 'a.ts', line: 1, column: 8, complexity: 12 },
        { file: 'a.ts', line: 2, column: 12, complexity: 11 },
      ],
      () => text,
    ),
    [
      { file: 'a.ts', function: 'outer', complexity: 12 },
      { file: 'a.ts', function: 'outer > afterCycle', complexity: 11 },
    ],
  );
  assert.equal(measuredValue("Async function 'outer' has a complexity of 12. Maximum allowed is 10."), 12);
});

const entry = { file: 'src/a.ts', function: 'outer', complexity: 14, decision: 'legacy' };
const all = () => true;

test('a tolerated function passes at its value; a new one, a grown one, a lowered one and a vanished one fail', () => {
  assert.deepEqual(matchComplexity([{ file: 'src/a.ts', function: 'outer', complexity: 14 }], [entry], all), []);
  assert.deepEqual(
    matchComplexity([{ file: 'src/a.ts', function: 'other', complexity: 11 }], [], all).map(f => f.rule),
    ['complexity'],
  );
  assert.deepEqual(
    matchComplexity([{ file: 'src/a.ts', function: 'outer', complexity: 15 }], [entry], all).map(f => f.rule),
    ['complexity:grew'],
  );
  assert.deepEqual(
    matchComplexity([{ file: 'src/a.ts', function: 'outer', complexity: 12 }], [entry], all).map(f => f.rule),
    ['complexity:tolerance-loose'],
  );
  assert.deepEqual(
    matchComplexity([], [entry], all).map(f => f.rule),
    ['complexity:stale-entry'],
  );
  assert.deepEqual(
    matchComplexity([], [entry], () => false),
    [],
    'an entry outside the analyzed files is not stale',
  );
  assert.deepEqual(
    matchComplexity([], [entry, entry], () => false).map(f => f.rule),
    ['complexity:duplicate-entry'],
  );
});

test('the policy requires file, function, a value above the limit and the decision', () => {
  assert.equal(parseTolerance({ complexity: [entry] }).length, 1);
  assert.throws(() => parseTolerance({ complexity: [{ ...entry, complexity: 10 }] }), /above 10/);
  assert.throws(() => parseTolerance({ complexity: [{ ...entry, decision: ' ' }] }), /decision/);
  assert.throws(() => parseTolerance({}), /must be a list/);
});
