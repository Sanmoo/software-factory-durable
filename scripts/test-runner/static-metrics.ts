// The Static metrics quality gate over src/ (production code; test/ and scripts/ are not production and stay out of its scope):
// cyclomatic complexity at most 10 per function (ESLint's `complexity` rule, pinned ESLint, a configuration of its own so the
// Lint configuration never changes what it measures), at most 3% duplicated code (jscpd, pinned), and zero dependency cycles
// (dependency-cruiser's `no-cycles`, reported with the cruise). Complexity above the limit at adoption is tolerated function by
// function in scripts/test-runner/static-metrics-tolerated.json; duplication tolerates nothing.
// `node scripts/test-runner/static-metrics.ts` prints what the gate reports, with the value each failing function must reach.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { identify, limit, matchComplexity, measuredValue, parseTolerance, type Finding } from './complexity.ts';

export const scope = 'src';
export const duplicationLimit = 3;
const policyFile = 'scripts/test-runner/static-metrics-tolerated.json';

/** The functions of src/ above the complexity limit, at their identities. */
export async function measureComplexity(root: string): Promise<Finding[]> {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules: { complexity: ['error', limit] } }],
  });
  const results = await eslint.lintFiles([`${scope}/**/*.ts`]);
  const measured = results.flatMap(result =>
    result.messages
      .filter(message => message.ruleId === 'complexity')
      .map(message => ({ file: relative(root, result.filePath), line: message.line, column: message.column, complexity: measuredValue(message.message) ?? 0 })),
  );
  return identify(measured, file => readFileSync(join(root, file), 'utf8'));
}

/** jscpd over src/: the duplicated share of its lines, and the clones behind it. */
export async function measureDuplication(root: string): Promise<{ percentage: number; clones: string[] }> {
  const output = await mkdtemp(join(tmpdir(), 'sf-jscpd-'));
  try {
    await promisify(execFile)(
      process.execPath,
      [join(root, 'node_modules/jscpd/run-jscpd.js'), '--silent', '--reporters', 'json', '--output', output, '--format', 'typescript', scope],
      { cwd: root },
    );
    const report = JSON.parse(await readFile(join(output, 'jscpd-report.json'), 'utf8')) as {
      statistics: { total: { percentage: number } };
      duplicates: { firstFile: { name: string; start: number; end: number }; secondFile: { name: string; start: number; end: number } }[];
    };
    const at = (file: { name: string; start: number; end: number }) => `${scope}/${file.name}:${file.start}-${file.end}`;
    return { percentage: report.statistics.total.percentage, clones: report.duplicates.map(clone => `${at(clone.firstFile)} = ${at(clone.secondFile)}`) };
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

/** The complexity and duplication findings of the gate (cycles come with the cruise). */
export async function scanStaticMetrics(root: string): Promise<{ findings: { rule: string; location: string }[]; summary: string }> {
  const tolerated = parseTolerance(JSON.parse(await readFile(join(root, policyFile), 'utf8')));
  const [complexity, duplication] = await Promise.all([measureComplexity(root), measureDuplication(root)]);
  const findings = matchComplexity(complexity, tolerated, file => file.startsWith(`${scope}/`));
  if (duplication.percentage > duplicationLimit)
    findings.push({
      rule: 'duplication',
      location: `${scope}/ ${duplication.percentage.toFixed(2)}% over ${duplicationLimit}% (${duplication.clones.length} clones)`,
    });
  return {
    findings,
    summary: `static metrics: ${complexity.length} functions above ${limit} (${tolerated.length} tolerated entries), duplication ${duplication.percentage.toFixed(2)}% of ${scope}/`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await scanStaticMetrics(process.cwd());
  console.log(result.summary);
  for (const finding of result.findings) console.log(`${finding.rule}: ${finding.location}`);
  process.exitCode = result.findings.length ? 1 : 0;
}
