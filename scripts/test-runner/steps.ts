import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir, loadavg, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { readCruise } from './architecture.ts';
import { changedSet, gitIn } from './changes.ts';
import { avoidedTerms, findAvoided } from './avoided-terms.ts';
import { checkInstalledDependencies } from './deps.ts';
import { parseManifest, parseTapCounts, type FileResult, type StepResult, type Tier } from './lib.ts';
import { acquireMachineLock, machineLockPath } from './lock.ts';
import type { FileRun, Steps } from './runner.ts';
import { parsePolicy, type IntegralRecord } from './selection.ts';

/** The handoff's Node prefix, applied to every child: no inherited NODE_OPTIONS/compile cache. */
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, NODE_DISABLE_COMPILE_CACHE: '1' };
  // Real-disk sandbox tests run only in full, against a fresh private root (never an inherited one).
  // The run's deadline and shared directory come only from this run (fileEnvironment), never from an enclosing one.
  for (const name of ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'FACTORY_SANDBOX_TEST_ROOT', 'FACTORY_TEST_ROOT', 'FACTORY_TEST_DEADLINE', 'FACTORY_TEST_RUN_DIRECTORY']) delete result[name];
  return result;
}

/** The environment of one test file: the child environment plus what its run gives it (see FileRun). */
export function fileEnvironment(childEnv: NodeJS.ProcessEnv, run: FileRun): NodeJS.ProcessEnv {
  return { ...childEnv, ...(run.sandboxRoot ? { FACTORY_SANDBOX_TEST_ROOT: run.sandboxRoot } : {}),
    ...(run.deadline === undefined ? {} : { FACTORY_TEST_DEADLINE: String(run.deadline) }),
    ...(run.shared ? { FACTORY_TEST_RUN_DIRECTORY: run.shared } : {}) };
}

interface Exit { code: number | null; output: string; ms: number }

export function execute(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Exit> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // Own process group so a budget abort also stops grandchildren (adapters, controllers, release launchers).
    const child = spawn(command, [...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    signal.addEventListener('abort', kill, { once: true });
    child.once('error', reject);
    // A finished test file leaves nothing behind: leaked processes in its group would otherwise hold the pipes open.
    child.once('exit', kill);
    child.once('close', code => {
      signal.removeEventListener('abort', kill);
      resolve({ code: code ?? child.exitCode, output: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started });
    });
  });
}

async function testSources(directory: string, root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await testSources(path, root));
    else if (entry.name.endsWith('.test.ts')) found.push(relative(root, path));
  }
  return found;
}

export interface StaticParts {
  /** Whether the staged SDK (.scratch/factory-development-sdk-v3) exists when the stage starts. */
  staged: boolean;
  compile(): Promise<StepResult[]>;
  lint(): Promise<StepResult>;
  depcruise(): Promise<StepResult[]>;
  pointers(): Promise<StepResult>;
  avoided(): Promise<StepResult>;
}

/**
 * The linters do not read dist/, so they run alongside the compiler. dependency-cruiser waits for the compile stage: it
 * resolves the #factory-* imports to the SDK prepare-sdk stages, and some tests import the build output in dist/ itself.
 */
export async function composeStatic(parts: StaticParts): Promise<StepResult[]> {
  const compiling = parts.compile();
  const [compiled, linted, cruised, pointed, avoided] = await Promise.all([compiling, parts.lint(),
    compiling.then(() => parts.depcruise()), parts.pointers(), parts.avoided()]);
  return [...compiled, linted, ...cruised, pointed, avoided];
}

/** The files a changed-set step analyzed, named in its report line so a Gate Proof can record them. */
export const analyzedNames = (files: readonly string[]) => files.length <= 10 ? files.join(', ') : `${files.length} files`;

const distFile = (source: string) => join('dist', source.replace(/\.ts$/, '.js'));

/** `file(line,col): error TSnnnn` lines of tsc. */
export function tscFindings(output: string): { rule: string; location: string }[] {
  return [...output.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+)/gm)].map(match => ({ rule: match[4]!, location: `${match[1]}:${match[2]}` }));
}

/** ESLint's JSON formatter. The pure-rules bans of eslint.config.mjs are marked so they report under the Dependency rule. */
export function eslintFindings(output: string, root: string): { rule: string; location: string }[] | undefined {
  try {
    const results = JSON.parse(output) as { filePath: string; messages: { ruleId: string | null; message: string; line: number }[] }[];
    return results.flatMap(result => result.messages.map(message => ({
      rule: `${message.ruleId ?? 'parse-error'}${message.message.startsWith('Pure Control rules') ? ':pure-rules' : ''}`,
      location: `${relative(root, result.filePath)}:${message.line}` })));
  } catch { return undefined; }
}

/** The documentary checker's JSON (scripts/agent-checks/check.mjs). */
export function pointerFindings(output: string): { rule: string; location: string }[] | undefined {
  try {
    const result = JSON.parse(output.slice(output.indexOf('{'))) as { findings: { code: string; path: string; target?: string }[] };
    return result.findings.map(finding => ({ rule: finding.code, location: finding.target ? `${finding.path} → ${finding.target}` : finding.path }));
  } catch { return undefined; }
}

/** Where integral validation records its last result, so validation by change can read it. */
export const integralRecordPath = (env: NodeJS.ProcessEnv) => env.FACTORY_INTEGRAL_RECORD
  || join(env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'software-factory/nightly-tests/integral-result.json');

export function realSteps(root: string, env: NodeJS.ProcessEnv, log: (line: string) => void): Steps {
  const childEnv = childEnvironment(env);
  const node = process.execPath;
  const tool = (name: string, args: readonly string[], signal: AbortSignal): Promise<StepResult> =>
    execute(node, args, root, childEnv, signal).then(exit => ({ name, ms: exit.ms, ok: exit.code === 0, output: exit.output }));
  const timingsPath = join(root, 'node_modules/.cache/software-factory-test-runner/timings.json');
  const tsc = (incremental: boolean, signal: AbortSignal) =>
    tool('tsc', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', ...(incremental ? ['--incremental'] : [])], signal);
  const prepare = async (signal: AbortSignal): Promise<StepResult> => {
    const steps = [await tool('prepare-sdk', ['dist/src/workers/sdk-profile.js'], signal)];
    if (steps[0]!.ok) steps.push(await tool('prepare-sdk', ['dist/src/sandbox/gondolin-sdk-profile.js'], signal));
    return { name: 'prepare-sdk', ms: steps.reduce((sum, step) => sum + step.ms, 0), ok: steps.every(step => step.ok), output: steps.map(step => step.output).join('') };
  };
  /** Compile once. A fresh tree needs tsc → prepare:sdk → tsc (the #factory-pi types live in the staged SDK). */
  const compile = async (tier: Tier, signal: AbortSignal): Promise<StepResult[]> => {
    if (tier !== 'fast') await rm(join(root, 'dist'), { recursive: true, force: true });
    const first = await tsc(tier === 'fast', signal);
    if (first.ok) return [first, await prepare(signal)];
    if (existsSync(join(root, '.scratch/factory-development-sdk-v3')) || !existsSync(join(root, 'dist/src/workers/sdk-profile.js'))) return [first];
    const staged = await prepare(signal);
    if (!staged.ok) return [{ ...first, name: 'tsc (bootstrap)', ok: true, output: '' }, staged];
    const second = await tsc(tier === 'fast', signal);
    return [{ ...first, name: 'tsc (bootstrap)', ok: true, output: '' }, staged, second];
  };
  const changedLintable = async (signal: AbortSignal): Promise<string[] | 'all'> => {
    const git = (args: string[]) => execute('git', args, root, childEnv, signal).then(exit => exit.code === 0 ? exit.output.split('\n').filter(Boolean) : []);
    const changed = [...await git(['diff', '--name-only', '--diff-filter=d', 'HEAD']), ...await git(['ls-files', '--others', '--exclude-standard'])];
    if (changed.some(file => /^(eslint\.config\.mjs|package(-lock)?\.json)$/.test(file))) return 'all';
    return [...new Set(changed.filter(file => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && existsSync(join(root, file))))];
  };
  return {
    cpus: availableParallelism(),
    now: () => Date.now(),
    log,
    loadAverage: () => loadavg(),
    checkDependencies: () => checkInstalledDependencies(root),
    loadManifest: async () => parseManifest(JSON.parse(await readFile(join(root, 'test/tiers.json'), 'utf8')), file => existsSync(join(root, file))),
    acquireLock: tier => acquireMachineLock(machineLockPath(env), { pid: process.pid, tier, root }, log),
    staticAnalysis: async (tier, signal, part = 'all') => {
      const pointers = async (): Promise<StepResult> => {
        const step = await tool('guide-pointers', ['scripts/agent-checks/check.mjs', '--docs-only'], signal);
        return { ...step, check: 'guide-pointers', findings: pointerFindings(step.output ?? '') ?? [] };
      };
      if (part === 'documentation') return [await pointers()];
      const eslint = ['node_modules/eslint/bin/eslint.js', '--max-warnings', '0', '--format', 'json'];
      const linted = async (name: string, args: readonly string[]): Promise<StepResult> => {
        const step = await tool(name, args, signal);
        const findings = eslintFindings(step.output ?? '', root);
        return { ...step, check: 'lint', findings: findings ?? [], ...(findings ? { output: findings.map(f => `${f.location} ${f.rule}`).join('\n') } : {}) };
      };
      const lint = async (): Promise<StepResult> => {
        if (tier !== 'fast') return linted('eslint', [...eslint, '.']);
        const files = await changedLintable(signal);
        if (files !== 'all' && !files.length) return { name: 'eslint (no changed files)', ms: 0, ok: true, check: 'lint' };
        return linted(files === 'all' ? 'eslint' : `eslint (changed: ${analyzedNames(files)})`, [...eslint, ...(files === 'all' ? ['.'] : files)]);
      };
      const depcruise = async (): Promise<StepResult[]> => {
        const step = await tool('depcruise', ['node_modules/dependency-cruiser/bin/dependency-cruiser.mjs', '--config', '.dependency-cruiser.cjs', '--output-type', 'json', '.'], signal);
        try {
          const { violations, graph } = readCruise(step.output ?? '');
          const findings = violations.map(item => ({ rule: item.rule, location: `${item.from} → ${item.to}` }));
          return [{ ...step, ok: step.ok && !violations.length, check: 'boundaries', findings, graph,
            output: findings.map(f => `${f.rule}: ${f.location}`).join('\n') }];
        } catch { return [{ ...step, ok: false, check: 'boundaries', findings: [{ rule: 'cruise-unreadable', location: '.dependency-cruiser.cjs' }] }]; }
      };
      const compiled = async (): Promise<StepResult[]> => (await compile(tier, signal)).map(step => step.name.startsWith('tsc')
        ? { ...step, check: 'types', findings: tscFindings(step.output ?? '') } : step);
      const avoided = async (): Promise<StepResult> => {
        const started = Date.now();
        const findings = await scanAvoidedTerms(root);
        return { name: 'avoided-terms', ms: Date.now() - started, ok: !findings.length, check: 'avoided-terms', findings,
          output: findings.map(f => `${f.rule}: ${f.location}`).join('\n') };
      };
      return composeStatic({ staged: existsSync(join(root, '.scratch/factory-development-sdk-v3')),
        compile: compiled, lint, depcruise, pointers, avoided });
    },
    audit: async signal => {
      const step = await execute('npm', ['audit', '--audit-level=high', '--json'], root, childEnv, signal)
        .catch(error => ({ code: null, output: String(error), ms: 0 }));
      const findings = auditFindings(step.output);
      if (findings === undefined) return { name: 'npm audit', ms: step.ms, ok: false, check: 'vulnerabilities',
        findings: [{ rule: 'audit-unavailable', location: step.output.slice(0, 160) }] };
      return { name: 'npm audit', ms: step.ms, ok: !findings.length, check: 'vulnerabilities', findings,
        output: findings.map(f => `${f.rule}: ${f.location}`).join('\n') };
    },
    loadPolicy: async () => {
      const text = await readFile(join(root, 'scripts/test-runner/policy.json'), 'utf8');
      return parsePolicy(JSON.parse(text), text);
    },
    changedSet: async base => changedSet(root, env.VALIDATION_BASE || base, gitIn(root)),
    loadIntegral: async () => {
      try { return JSON.parse(await readFile(integralRecordPath(env), 'utf8')) as IntegralRecord; } catch { return undefined; }
    },
    saveIntegral: async record => {
      const path = integralRecordPath(env);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(record, null, 1) + '\n');
    },
    headCommit: async () => gitIn(root)(['rev-parse', 'HEAD'])?.trim() ?? 'unknown',
    listTests: async () => (await testSources(join(root, 'test'), root))
      // Only sources with a compiled output; stale dist files of deleted tests never run.
      .filter(source => existsSync(join(root, distFile(source)))).sort(),
    loadTimings: async () => {
      try { return JSON.parse(await readFile(timingsPath, 'utf8')) as Record<string, number>; } catch { return {}; }
    },
    saveTimings: async timings => {
      await mkdir(dirname(timingsPath), { recursive: true });
      await writeFile(timingsPath, JSON.stringify(timings, null, 1) + '\n');
    },
    sandboxRoot: async () => {
      // A short private parent (the sandbox tests derive socket roots from its dirname) and a fresh root under it,
      // on a disk filesystem: Sandbox storage admission refuses tmpfs (/tmp), so not os.tmpdir(). Kept short because
      // the adapter's runtime sockets live under it (a long parent overflows sun_path).
      const base = env.FACTORY_TEST_RUNNER_SANDBOX_PARENT || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'sft');
      await mkdir(base, { recursive: true, mode: 0o700 });
      const parent = await mkdtemp(join(base, 's-'));
      const path = join(parent, 'r');
      await mkdir(path, { mode: 0o700 });
      return { path, cleanup: () => rm(parent, { recursive: true, force: true }) };
    },
    runDirectory: async () => {
      const path = await mkdtemp(join(tmpdir(), 'sf-test-run-'));
      return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
    },
    runFile: async (file, run, signal) => {
      const args = ['--experimental-test-module-mocks', '--test', '--test-reporter=tap',
        ...(run.randomSeed === undefined ? [] : ['--test-randomize', `--test-random-seed=${run.randomSeed}`]), distFile(file)];
      const exit = await execute(node, args, root, fileEnvironment(childEnv, run), signal);
      const result: FileResult = { file, ms: exit.ms, ok: exit.code === 0 && !signal.aborted, counts: parseTapCounts(exit.output) };
      if (!result.ok) result.output = signal.aborted ? `${file}: stopped by the tier budget` : exit.output;
      return result;
    },
  };
}

/** Identifiers of the tracked and untracked code under src/, test/ and scripts/ against GLOSSARY.md's _Avoid_ terms. */
export async function scanAvoidedTerms(root: string): Promise<{ rule: string; location: string }[]> {
  const terms = avoidedTerms(await readFile(join(root, 'GLOSSARY.md'), 'utf8'));
  const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', 'src', 'test', 'scripts'], { cwd: root, encoding: 'utf8' }).split('\0');
  const files = listed.filter(file => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && existsSync(join(root, file)));
  const found: { rule: string; location: string }[] = [];
  for (const file of files) found.push(...findAvoided(file, await readFile(join(root, file), 'utf8'), terms));
  return found;
}

/** npm audit's JSON: one finding per vulnerable package at high or critical severity, or undefined when it is not an audit report. */
export function auditFindings(output: string): { rule: string; location: string }[] | undefined {
  try {
    const report = JSON.parse(output) as { vulnerabilities?: Record<string, { severity: string; via: (string | { url?: string; title?: string })[] }> };
    if (!report.vulnerabilities) return undefined;
    return Object.entries(report.vulnerabilities).filter(([, item]) => item.severity === 'high' || item.severity === 'critical')
      .map(([name, item]) => ({ rule: item.severity,
        location: `${name} (${item.via.map(via => typeof via === 'string' ? via : via.url ?? via.title ?? '?').join(', ')})` }));
  } catch { return undefined; }
}
