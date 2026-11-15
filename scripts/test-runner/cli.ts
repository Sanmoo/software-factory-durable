// Single entry point for the test tiers: `scripts/test-runner/run fast|ci|full [--report <file>] [--seed <n>] [filter...]`.
// Filters (substrings of test/**/*.test.ts paths) are a manual convenience and never a gate.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tierNames, type Tier } from './lib.ts';
import { runTier, type RunOptions } from './runner.ts';
import { realSteps } from './steps.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const usage = 'usage: scripts/test-runner/run fast|ci|full [--report <file>] [--seed <n>] [filter...]';
const fail = (message: string): never => { process.stderr.write(`${message}\n`); process.exit(2); };

const pinned = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { engines: { node: string } }).engines.node;
if (process.versions.node !== pinned) fail(`NODE_VERSION_MISMATCH: running Node ${process.versions.node}, the project pins ${pinned}`);
for (const name of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE']) if (process.env[name]) fail(`NODE_ENV_LEAK: ${name} is set; run through scripts/test-runner/run`);

const [tier, ...rest] = process.argv.slice(2);
if (!tierNames.includes(tier as Tier)) fail(usage);
const filters: string[] = [];
const options: RunOptions = { tier: tier as Tier, filters };
let reportPath: string | undefined;
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i]!;
  if (arg === '--report') reportPath = rest[++i] ?? fail(usage);
  else if (arg === '--seed') options.seed = Number(rest[++i] ?? fail(usage));
  else if (arg.startsWith('-')) fail(usage);
  else filters.push(arg);
}
if (options.seed !== undefined && !Number.isSafeInteger(options.seed)) fail(usage);

const log = (line: string) => process.stdout.write(`${line}\n`);
const outcome = await runTier(options, realSteps(root, process.env, log));
if (reportPath) {
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(reportPath, outcome.report + '\n');
}
process.exitCode = outcome.exitCode;
