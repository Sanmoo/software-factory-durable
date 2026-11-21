// Rehearses the full Entry Point's two modes on disposable copies of the project, each its own git repository whose base
// commit carries a controlled fixture (a pruned test suite and, where needed, a budget). Kept out of both Entry Points; run
// it with the pinned Node: `node scripts/test-runner/rehearse-modes.ts`. The transcript is run output and is not committed.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposableCopy, type Copy as Disposable } from './disposable.ts';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const kept = ['test/control/budget-rules.test.ts', 'test/protocol/protocol.test.ts', 'test/runner/selection.test.ts'];

type Copy = Disposable & { record: string };

/** A disposable copy whose base commit quarantines every test but `kept` (the controlled fixture) and applies `fixture`. */
function repository(name: string, fixture: (copy: Disposable) => void): Copy {
  const copy = disposableCopy(project, `rehearsal-${name}`, base => {
    const tests = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', 'test'], { cwd: base.dir, encoding: 'utf8' })
      .split('\0')
      .filter(file => file.endsWith('.test.ts') && !kept.includes(file));
    const files = Object.fromEntries(tests.map(file => [file, { quarantine: 'rehearsal fixture', reason: "outside the rehearsal's controlled suite" }]));
    writeFileSync(join(base.dir, 'test/tiers.json'), JSON.stringify({ schemaVersion: 1, files }, null, 1) + '\n');
    fixture(base);
  });
  return { ...copy, record: join(copy.dir, '.integral-result.json') };
}

function entryPoint(copy: Copy, tier: 'ci' | 'full') {
  const run = spawnSync(join(copy.dir, 'scripts/test-runner/run'), [tier], {
    cwd: copy.dir,
    encoding: 'utf8',
    env: { ...process.env, FACTORY_INTEGRAL_RECORD: copy.record, VALIDATION_BASE: 'main' },
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const weakenTimeout = (text: string) => text.replace('elapsedMs >= timeoutSeconds * 1000', 'elapsedMs > timeoutSeconds * 1000');
const results: { name: string; failures: string[] }[] = [];

function scenario(name: string, body: (expect: (condition: boolean, what: string) => void) => void, ...copies: Copy[]) {
  console.log(`\n=== ${name}`);
  const failures: string[] = [];
  try {
    body((condition, what) => {
      if (!condition) failures.push(what);
    });
  } catch (error) {
    failures.push(`threw: ${(error as Error).stack}`);
  }
  for (const failure of failures) console.log(`  ✘ ${failure}`);
  if (!failures.length) console.log('  ✔ passed');
  results.push({ name, failures });
  for (const copy of copies) copy.remove();
}

{
  const copy = repository('dependent', () => {});
  copy.edit('src/control/rules/budget.ts', weakenTimeout);
  scenario(
    'a violation in an affected dependent is caught by a selection that did not widen',
    expect => {
      const { status, output } = entryPoint(copy, 'ci');
      console.log(
        output
          .split('\n')
          .filter(line => /^(selection|mode|FAILURE|RESULT|ok |FAIL)/.test(line))
          .join('\n'),
      );
      expect(status === 1, `exit 1, got ${status}`);
      expect(/^selection: \d+ affected files/m.test(output), 'the selection did not widen');
      expect(/FAILURE: test\/control\/budget-rules\.test\.ts failed/.test(output), 'the dependent test caught the violation');
      expect(!/test\/protocol\/protocol\.test\.ts/.test(output), 'an independent test was not selected');
    },
    copy,
  );
}
{
  const copy = repository('shared', () => {});
  copy.edit('.npmrc', text => `${text}# rehearsal: shared configuration\n`);
  scenario(
    'a shared configuration change widens the selection to every applicable check',
    expect => {
      const { status, output } = entryPoint(copy, 'ci');
      console.log(
        output
          .split('\n')
          .filter(line => /^(selection|mode|RESULT|ok |FAIL)/.test(line))
          .join('\n'),
      );
      expect(status === 0, `exit 0, got ${status}`);
      expect(/^selection widened: shared configuration changed: \.npmrc/m.test(output), 'widened by .npmrc');
      expect(/ok .* test\/protocol\/protocol\.test\.ts/.test(output), 'an otherwise independent test ran');
    },
    copy,
  );
}
{
  const copy = repository('budget', fixture =>
    fixture.edit('scripts/test-runner/policy.json', text => text.replace('"budgetSeconds": 900', '"budgetSeconds": 120')),
  );
  copy.edit('src/control/rules/budget.ts', weakenTimeout);
  scenario(
    'required validation beyond the budget is inconclusive and starts no expensive check',
    expect => {
      const { status, output } = entryPoint(copy, 'ci');
      console.log(
        output
          .split('\n')
          .filter(line => /^(selection|INCONCLUSIVE|RESULT|ok |FAIL)/.test(line))
          .join('\n'),
      );
      expect(status === 3, `exit 3, got ${status}`);
      expect(/INCONCLUSIVE: required validation is estimated at \d+ s, over the approved 120 s budget/.test(output), 'names the budget and the decision');
      expect(!/^(ok |FAIL)/m.test(output), 'no test file started');
    },
    copy,
  );
}
{
  const copy = repository('integral', () => {});
  copy.edit('test/protocol/protocol.test.ts', text => `${text}\n`);
  scenario(
    'integral validation runs the periodic checks that validation by change only reports',
    expect => {
      const before = entryPoint(copy, 'ci');
      expect(before.status === 0, `change mode exit 0, got ${before.status}`);
      expect(/periodic integral-pass .*last integral result: not recorded/.test(before.output), 'change mode only reports integral-pass');
      expect(/periodic random-order .*last integral result: not recorded/.test(before.output), 'change mode only reports random-order');
      const integral = entryPoint(copy, 'full');
      console.log(
        integral.output
          .split('\n')
          .filter(line => /^(mode|  ran|  covered|RESULT)/.test(line))
          .join('\n'),
      );
      expect(integral.status === 0, `integral exit 0, got ${integral.status}`);
      expect(
        /ran integral-pass \[Regression suite\]: passed/.test(integral.output) && /ran random-order \[Regression suite\]: passed/.test(integral.output),
        'integral validation ran both periodic checks',
      );
      const after = entryPoint(copy, 'ci');
      expect(/periodic random-order .*last integral result: passed at [0-9a-f]{12}/.test(after.output), 'change mode then reports the last integral result');
    },
    copy,
  );
}

const failed = results.filter(result => result.failures.length);
console.log(`\n${results.length - failed.length}/${results.length} rehearsal scenarios passed`);
process.exitCode = failed.length ? 1 : 0;
