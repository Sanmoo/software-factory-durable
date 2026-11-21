// Gate Proofs: for each quality gate, one deliberate violation in a disposable copy, the Entry Point of the gate's tier run
// over it, and the red result attributed by scripts/test-runner/proof-attribution.ts. Kept out of both Entry Points; run it with
// the pinned Node: `node scripts/test-runner/gate-proofs.ts [gate id...] [--evidence <file>]`. The evidence it writes is
// run output, not committed; GATE-PROOFS.md records each proof's row.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposableCopy, restore, warm, type Copy } from './disposable.ts';
import { analyzedExactly, attribute, type Verdict } from './proof-attribution.ts';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Proof {
  id: string;
  gate: string;
  tier: 'fast' | 'ci';
  /** The single deliberate violation, applied to the change branch of the copy. */
  violation: string;
  apply(copy: Copy): void;
  /** Where the gate must report it. */
  location: string;
  /** A proof whose violation changes installed dependencies runs in a fresh copy of its own, not the shared warm one. */
  isolated?: boolean;
  /** A changed-set gate's declared input: the step that analyzes it and the files, which must be exactly what it analyzed. */
  declared?: { step: string; files: string[] };
}

const append = (line: string) => (text: string) => `${text}${line}\n`;

export const proofs: Proof[] = [
  {
    id: 'types',
    gate: 'Types',
    tier: 'fast',
    location: 'src/control/rules/budget.ts',
    violation: 'pass a string where `timeoutReached` takes a number, in src/control/rules/budget.ts',
    apply: copy => copy.edit('src/control/rules/budget.ts', append("export const proofTypes = timeoutReached('1', 1);")),
  },
  {
    id: 'boundaries',
    gate: 'Context boundaries',
    tier: 'fast',
    location: 'src/records/index.ts',
    violation: 'import the non-public module src/contracts/environment.ts of another context from src/records/index.ts',
    apply: copy => copy.edit('src/records/index.ts', append("import '../contracts/environment.js';")),
  },
  {
    id: 'dependency-rule',
    gate: 'Dependency rule',
    tier: 'fast',
    location: 'src/control/rules/budget.ts',
    violation: 'import the yaml parser package (infrastructure, no I/O) in the pure domain rule src/control/rules/budget.ts',
    apply: copy => copy.edit('src/control/rules/budget.ts', append("import 'yaml';")),
  },
  {
    id: 'guide-pointers',
    gate: 'Guide pointers',
    tier: 'fast',
    location: 'docs/guides/architecture.md',
    violation: 'point a link in docs/guides/architecture.md at a file that does not exist',
    apply: copy => copy.edit('docs/guides/architecture.md', append('- [Removido](../../src/control/removed.ts).')),
  },
  {
    id: 'format',
    gate: 'Format',
    tier: 'fast',
    location: 'src/control/rules/budget.ts',
    declared: { step: 'prettier', files: ['src/control/rules/budget.ts'] },
    violation: 'misindent one line of src/control/rules/budget.ts',
    apply: copy => copy.edit('src/control/rules/budget.ts', text => text.replace('\nexport function timeoutReached(', '\n   export function timeoutReached(')),
  },
  {
    id: 'lint',
    gate: 'Lint',
    tier: 'fast',
    location: 'src/control/rules/budget.ts',
    declared: { step: 'eslint', files: ['src/control/rules/budget.ts'] },
    violation: 'add an unused variable to src/control/rules/budget.ts',
    apply: copy => copy.edit('src/control/rules/budget.ts', append('function proofLint() {\n  const unused = 1;\n}\nexport const proofLintUsed = proofLint;')),
  },
  {
    id: 'secrets',
    gate: 'Secrets',
    tier: 'fast',
    location: 'docs/proof-credentials.txt',
    violation: 'add a file holding a well-formed fake AWS access key id and secret',
    apply: copy =>
      copy.write(
        'docs/proof-credentials.txt',
        `aws_access_key_id = ${'AKIA' + 'Z7QX4L2M3N5P6R7S'}\naws_secret_access_key = ${'q8Vt2LmX9pR4sN7w' + 'K1zB6yH3cJ0dF5gA2eU8iO4t'}\n`,
      ),
  },
  {
    id: 'avoided-terms',
    gate: 'Avoided terms',
    tier: 'fast',
    location: 'src/control/rules/budget.ts',
    violation: 'name a Slot identifier with the avoided synonym seat in src/control/rules/budget.ts',
    apply: copy => copy.edit('src/control/rules/budget.ts', append('export const seatLimit = 1;')),
  },
  {
    id: 'unit-tests',
    gate: 'Unit tests',
    tier: 'fast',
    location: 'test/control/budget-rules.test.ts',
    violation: 'invert the boundary of timeoutReached (>= to >) in the domain rule src/control/rules/budget.ts',
    apply: copy => copy.edit('src/control/rules/budget.ts', text => text.replace('elapsedMs >= timeoutSeconds * 1000', 'elapsedMs > timeoutSeconds * 1000')),
  },
  {
    id: 'integration-tests',
    gate: 'Integration tests',
    tier: 'ci',
    location: 'test/',
    violation: "break the label mapping of the GitHub issue-tracker adapter (src/issue-tracker/index.ts reports each label's name upper-cased)",
    apply: copy =>
      copy.edit('src/issue-tracker/index.ts', text =>
        text.replace(
          'labels: issue.labels.map(label => ({ id: label.id, name: label.name })),',
          'labels: issue.labels.map(label => ({ id: label.id, name: label.name.toUpperCase() })),',
        ),
      ),
  },
  {
    id: 'vulnerabilities',
    gate: 'Dependency vulnerabilities',
    tier: 'ci',
    location: 'minimist',
    isolated: true,
    violation: 'lock minimist 0.0.8 (critical advisory GHSA-xvch-5gv4-984h, prototype pollution) as a dependency',
    apply: copy => {
      execFileSync('npm', ['install', '--save-exact', '--no-audit', '--no-fund', 'minimist@0.0.8'], { cwd: copy.dir, stdio: 'ignore' });
    },
  },
];

export interface Evidence {
  id: string;
  gate: string;
  tier: string;
  entryPoint: string;
  violation: string;
  exitCode: number | null;
  verdict: Verdict;
  failures: string[];
  /** The report's static line: the steps that ran and, for a changed-set step, the files it analyzed. */
  analyzed: string;
  commit: string;
}

function run(proof: Proof, shared: Copy): Evidence {
  const copy = proof.isolated ? disposableCopy(project, `proof-${proof.id}`) : shared;
  try {
    proof.apply(copy);
    const entryPoint = `scripts/test-runner/run ${proof.tier}`;
    const result = spawnSync(join(copy.dir, 'scripts/test-runner/run'), [proof.tier], {
      cwd: copy.dir,
      encoding: 'utf8',
      env: { ...process.env, FACTORY_INTEGRAL_RECORD: join(copy.dir, '.integral-result.json'), VALIDATION_BASE: 'main' },
    });
    const report = `${result.stdout}${result.stderr}`;
    let verdict = attribute({ exitCode: result.status, report }, proof.gate, proof.location);
    const staticLine = report.split('\n').find(line => line.startsWith('static: ')) ?? '';
    if (proof.declared && verdict.proved) {
      const scope = analyzedExactly(staticLine, proof.declared.step, proof.declared.files);
      if (!scope.ok)
        verdict = {
          ...verdict,
          proved: false,
          reason: `${proof.gate} analyzed ${JSON.stringify(scope.analyzed)}, not the declared ${JSON.stringify(proof.declared.files)}`,
        };
    }
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).stdout.trim();
    return {
      id: proof.id,
      gate: proof.gate,
      tier: proof.tier,
      entryPoint,
      violation: proof.violation,
      exitCode: result.status,
      verdict,
      commit,
      failures: report.split('\n').filter(line => line.startsWith('FAILURE: ')),
      analyzed: staticLine || 'unavailable',
    };
  } finally {
    // The violation is bound to its run: restored (or its copy removed) even after a failure.
    if (proof.isolated) copy.remove();
    else restore(copy);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--evidence');
  const evidencePath = at >= 0 ? args.splice(at, 2)[1] : undefined;
  const selected = args.length ? proofs.filter(proof => args.includes(proof.id)) : proofs;
  if (args.length && selected.length !== args.length) {
    console.error(`unknown proof: ${args.filter(id => !proofs.some(p => p.id === id)).join(', ')}`);
    process.exit(2);
  }
  const evidence: Evidence[] = [];
  // One warm template per run: every proof starts from the same built tree, as a working checkout would.
  const template = warm(disposableCopy(project, 'proof-template'));
  for (const proof of selected) {
    const item = run(proof, template);
    evidence.push(item);
    console.log(`${item.verdict.proved ? 'PROVED' : 'NOT PROVED'} ${item.gate} (${item.entryPoint}, exit ${item.exitCode}): ${item.verdict.reason}`);
    for (const failure of item.failures) console.log(`  ${failure}`);
  }
  template.remove();
  if (evidencePath) {
    mkdirSync(dirname(resolve(evidencePath)), { recursive: true });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 1) + '\n');
  }
  process.exitCode = evidence.every(item => item.verdict.proved) ? 0 : 1;
}
