import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir, loadavg, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { checkInstalledDependencies } from './deps.ts';
import { parseManifest, parseTapCounts, type FileResult, type StepResult, type Tier } from './lib.ts';
import { acquireMachineLock, machineLockPath } from './lock.ts';
import type { FileRun, Steps } from './runner.ts';

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

const distFile = (source: string) => join('dist', source.replace(/\.ts$/, '.js'));

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
    staticAnalysis: async (tier, signal) => {
      const eslint = ['node_modules/eslint/bin/eslint.js', '--max-warnings', '0'];
      const lint = async (): Promise<StepResult> => {
        if (tier !== 'fast') return tool('eslint', [...eslint, '.'], signal);
        const files = await changedLintable(signal);
        if (files !== 'all' && !files.length) return { name: 'eslint (no changed files)', ms: 0, ok: true };
        return tool(files === 'all' ? 'eslint' : `eslint (${files.length} changed)`, [...eslint, ...(files === 'all' ? ['.'] : files)], signal);
      };
      const depcruise = (): Promise<StepResult[]> => tier === 'fast' ? Promise.resolve([])
        : tool('depcruise', ['node_modules/dependency-cruiser/bin/dependency-cruiser.mjs', '--config', '.dependency-cruiser.cjs', '--output-type', 'err-long', '.'], signal).then(step => [step]);
      // The linters do not read dist/, so they run alongside the compiler. dependency-cruiser resolves the
      // package.json #factory-* imports to files of the staged SDK (.scratch/factory-development-sdk-v3), which
      // a fresh tree only has after prepare-sdk: there it waits for the compile stage instead.
      const staged = existsSync(join(root, '.scratch/factory-development-sdk-v3'));
      const compiling = compile(tier, signal);
      const [compiled, linted, cruised] = await Promise.all([compiling, lint(), staged ? depcruise() : compiling.then(depcruise)]);
      return [...compiled, linted, ...cruised];
    },
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
