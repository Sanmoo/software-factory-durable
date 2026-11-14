import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RepositoryFetchCredentials } from '../contracts/index.js';

/** Work-owned checkout request: one repository, its configured base and the Work's own branch. */
export type CheckoutRequest = { repository: string; repositoryId: number; installationId: number; base: string; branch: string };
export type CheckoutView = { path: '/workspace/checkout'; repository: string; repositoryId: number; base: string; branch: string;
  baseCommit: string; origin: string; reused: boolean; preparedAt: string };
export type CheckoutResult = { status: 'success'; checkout: CheckoutView } | { status: 'failure' | 'indeterminate'; code: string };

const repositoryName = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const branchName = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const metadataSchema = z.strictObject({ version: z.literal(1), path: z.literal('/workspace/checkout'), repository: z.string(), repositoryId: z.number().int().positive(),
  base: z.string(), branch: z.string(), baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/), origin: z.string(), preparedAt: z.iso.datetime(),
  cache: z.literal('factory-exclusive-bare'), clone: z.literal('no-hardlinks'),
  // Outcome kind of the self-revocation of the one-fetch host credential (absent in metadata written before ticket 20).
  fetchCredentialRevocation: z.enum(['revoked', 'already-invalid', 'failed', 'unknown', 'impossible', 'not-attempted']).optional() });

class CheckoutFailure extends Error {
  constructor(readonly status: 'failure' | 'indeterminate', readonly code: string) { super(code); }
}

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new CheckoutFailure('failure', 'CHECKOUT_PATH_UNSAFE');
}
async function durableJson(path: string, value: unknown) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  const directory = await open(join(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
const exists = (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });

/**
 * Host preparation of a Work's own Git checkout (spec §7.3). Factory-exclusive bare cache per repository at <root>/cache/git/<id>.git,
 * never under environments/ (never mounted). Per repository, fetch -> completed local clone -> next preparation are sequenced in THIS
 * owner (an in-memory chain, not a lock service); distinct repositories proceed in parallel. Git runs with an empty template, no hooks
 * path, no system/global/personal config and filters/LFS disabled, so no repository or personal hook/script/plugin executes on the host.
 * A continuation reuses the recorded checkout WITHOUT running git in the guest-writable tree.
 */
/**
 * Cross-process exclusive lock on <cache>/<id>.lock held by a `flock` child for the whole fetch -> clone sequence (released on exit or if
 * this process dies: the child sees EOF). Bounded wait; never a takeover.
 */
async function acquireLock(path: string, waitSeconds: number): Promise<() => Promise<void>> {
  const file = await open(path, 'a', 0o600);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new CheckoutFailure('failure', 'CHECKOUT_PATH_UNSAFE');
  } finally { await file.close(); }
  if ((await lstat(path)).isSymbolicLink()) throw new CheckoutFailure('failure', 'CHECKOUT_PATH_UNSAFE');
  const child = spawn('/usr/bin/flock', ['--exclusive', '--wait', String(waitSeconds), path, '/bin/sh', '-c', 'echo locked; exec /usr/bin/cat'],
    { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, shell: false });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const acquired = await new Promise<boolean>(resolve => {
    child.stdout!.once('data', (data: Buffer) => resolve(data.toString().startsWith('locked')));
    child.once('exit', () => resolve(false));
    child.once('error', () => resolve(false));
  });
  if (!acquired) { child.kill(); throw new CheckoutFailure('failure', 'CACHE_LOCK_UNAVAILABLE'); }
  return async () => { child.stdin!.end(); await exited; };
}

export function createCheckouts(options: { root: string; fetch: RepositoryFetchCredentials; lockWaitSeconds?: number;
  /** Upstream fetch URL; GitHub by default. Tests substitute a local file:// fixture. The checkout's origin is ALWAYS the GitHub URL. */
  remoteUrl?: (scope: { repository: string }) => string }) {
  const chains = new Map<number, Promise<unknown>>();
  const github = (repository: string) => `https://github.com/${repository}.git`;

  /** `lock`: the repository's git lock, held by `flock` for the lifetime of THIS git process (it survives a controller crash with it). */
  async function run(args: string[], cwd: string, home: string, token?: string, timeout = 600000, lock?: string) {
    // Fixed argv/env; output never recorded (it could echo remote text). Exit code is the observation.
    const env: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ATTR_NOSYSTEM: '1',
      ...(token ? { GH_TOKEN: token, GH_HOST: 'github.com', GH_CONFIG_DIR: home, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } : {}) };
    const fixed = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.file.allow=always', '-c', 'submodule.recurse=false',
      '-c', 'core.attributesFile=/dev/null', '-c', 'init.templateDir='];
    return new Promise<string>((resolve, reject) => {
      execFile(lock ? '/usr/bin/flock' : '/usr/bin/git', [...(lock ? ['--exclusive', lock, '/usr/bin/git'] : []), ...fixed, ...args],
        { cwd, env, timeout, maxBuffer: 1024 * 1024, shell: false, encoding: 'utf8' },
        (error, stdout) => error ? reject(new CheckoutFailure('indeterminate', 'CHECKOUT_GIT_FAILED')) : resolve(stdout.trim()));
    });
  }

  async function first(environment: string, request: CheckoutRequest, home: string): Promise<CheckoutView> {
    const cacheRoot = join(options.root, 'cache', 'git');
    const cache = join(cacheRoot, `${request.repositoryId}.git`);
    // Credential first: a known issuance failure leaves the cache untouched (no 'mutating' state).
    let token: string;
    try { token = (await options.fetch.fetch({ repository: request.repository, installationId: request.installationId, workflows: false })).token; }
    catch { throw new CheckoutFailure('failure', 'CHECKOUT_FETCH_CREDENTIAL_UNAVAILABLE'); }
    // Used by ONE fetch only: self-revoked right after it (success or failure), once; only the outcome kind is kept (ticket 20 review).
    let revocation: Promise<string> | undefined;
    const revokeFetch = () => revocation ??= options.fetch.revoke({ token }).then(result => result.kind, () => 'unknown');
    let release: () => Promise<void>;
    try { release = await acquireLock(join(cacheRoot, `${request.repositoryId}.lock`), options.lockWaitSeconds ?? 600); }
    catch (error) { await revokeFetch(); throw error; }
    try {
      // An interrupted earlier mutation (crash between fetch and clone) is refused until the operator reconciles it (spec §7.3).
      const statePath = join(cacheRoot, `${request.repositoryId}.state.json`);
      const previous = await readFile(statePath, 'utf8').then(text => JSON.parse(text) as { state?: string }, () => undefined);
      if (previous && previous.state !== 'idle') throw new CheckoutFailure('failure', 'CACHE_RECONCILIATION_REQUIRED');
      const state = async (value: 'mutating' | 'idle') => {
        const temporary = `${statePath}.${process.pid}.tmp`;
        // `lock: git-flock-v1`: every git command of this mutation holds the repository git lock (ticket 26 reconciliation proof).
        await writeFile(temporary, JSON.stringify({ version: 1, state: value, pid: process.pid, at: new Date().toISOString(), lock: 'git-flock-v1' }), { mode: 0o600 });
        await rename(temporary, statePath);
      };
      await state('mutating');
      const view = await mutate(environment, request, home, cache, cacheRoot, token, revokeFetch);
      await state('idle');
      return view;
    } finally { await revokeFetch(); await release(); }
  }

  async function mutate(environment: string, request: CheckoutRequest, home: string, cache: string, cacheRoot: string, token: string,
    revokeFetch: () => Promise<string>): Promise<CheckoutView> {
    if (!await exists(cache)) await run(['init', '--quiet', '--bare', '--template=', cache], cacheRoot, home, undefined, 600000, join(cacheRoot, `${request.repositoryId}.git.lock`));
    const gitLock = join(cacheRoot, `${request.repositoryId}.git.lock`);
    const upstream = options.remoteUrl?.({ repository: request.repository }) ?? github(request.repository);
    // A failed fetch never proves an updated base; nothing below runs without it.
    try { await run(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', upstream, `+refs/heads/${request.base}:refs/heads/${request.base}`], cache, home, token, 600000, gitLock); }
    finally { await revokeFetch(); }
    const fetchCredentialRevocation = await revokeFetch();
    const baseCommit = await run(['rev-parse', '--verify', `refs/heads/${request.base}^{commit}`], cache, home, undefined, 600000, gitLock);
    const checkout = join(environment, 'workspace', 'checkout');
    // cwd is the Factory-owned home, never the workspace: no repository discovery above the new checkout. Only this never-booted,
    // Factory-created clone is touched by host git, and only now (never on continuation).
    await run(['clone', '--quiet', '--no-hardlinks', '--template=', '--no-checkout', '--single-branch', '--branch', request.base, '--', cache, checkout], home, home, undefined, 600000, gitLock);
    const origin = github(request.repository);
    await run(['-C', checkout, 'remote', 'set-url', 'origin', origin], home, home, undefined, 600000, gitLock);
    await run(['-C', checkout, 'checkout', '--quiet', '--no-track', '-b', request.branch, baseCommit], home, home, undefined, 600000, gitLock);
    if (await exists(join(checkout, '.git', 'objects', 'info', 'alternates')) || await run(['-C', checkout, 'config', '--get', 'remote.origin.url'], home, home, undefined, 600000, gitLock) !== origin ||
      (await readdir(join(checkout, '.git', 'hooks')).catch(() => [])).length) throw new CheckoutFailure('indeterminate', 'CHECKOUT_VERIFICATION_FAILED');
    const preparedAt = new Date().toISOString();
    await durableJson(join(environment, 'checkout.json'), { version: 1, path: '/workspace/checkout', repository: request.repository, repositoryId: request.repositoryId,
      base: request.base, branch: request.branch, baseCommit, origin, preparedAt, cache: 'factory-exclusive-bare', clone: 'no-hardlinks', fetchCredentialRevocation });
    return { path: '/workspace/checkout', repository: request.repository, repositoryId: request.repositoryId, base: request.base, branch: request.branch,
      baseCommit, origin, reused: false, preparedAt };
  }

  return {
    /** `environment` is the prepared environment directory (adapter-owned); only `workspace/checkout` is guest-visible. */
    async prepare(environment: string, request: CheckoutRequest): Promise<CheckoutResult> {
      if (!repositoryName.test(request.repository) || request.repository.split('/').some(part => part === '.' || part === '..') ||
        !Number.isSafeInteger(request.repositoryId) || request.repositoryId <= 0 || !branchName.test(request.base) || !branchName.test(request.branch)) {
        return { status: 'failure', code: 'CHECKOUT_REQUEST_INVALID' };
      }
      try {
        const recorded = join(environment, 'checkout.json');
        if (await exists(recorded)) {
          const metadata = metadataSchema.safeParse(JSON.parse(await readFile(recorded, 'utf8')));
          if (!metadata.success) return { status: 'indeterminate', code: 'CHECKOUT_METADATA_INVALID' };
          const value = metadata.data;
          if (value.repository !== request.repository || value.repositoryId !== request.repositoryId || value.base !== request.base || value.branch !== request.branch) {
            return { status: 'failure', code: 'CHECKOUT_IDENTITY_MISMATCH' };
          }
          if (!(await lstat(join(environment, 'workspace', 'checkout'))).isDirectory()) return { status: 'indeterminate', code: 'CHECKOUT_WORKSPACE_MISSING' };
          return { status: 'success', checkout: { path: value.path, repository: value.repository, repositoryId: value.repositoryId, base: value.base, branch: value.branch,
            baseCommit: value.baseCommit, origin: value.origin, reused: true, preparedAt: value.preparedAt } };
        }
        // One-shot intent before any effect: an earlier partial preparation is never retried nor adopted.
        try { await durableJson(join(environment, 'checkout-intent.json'), { version: 1, ...request, at: new Date().toISOString() }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'indeterminate', code: 'CHECKOUT_PREPARATION_INCOMPLETE' }; throw error; }
        if (await exists(join(environment, 'workspace', 'checkout'))) return { status: 'indeterminate', code: 'CHECKOUT_PREPARATION_INCOMPLETE' };
        // Host git may only create the checkout before ANY guest could have written the workspace (spec §7.3).
        if ((await readdir(environment)).some(name => name.startsWith('boot-'))) return { status: 'failure', code: 'CHECKOUT_REQUIRES_UNBOOTED_ENVIRONMENT' };
        const previous = chains.get(request.repositoryId) ?? Promise.resolve();
        const current = previous.catch(() => {}).then(async () => {
          await privateDirectory(join(options.root, 'cache'));
          await privateDirectory(join(options.root, 'cache', 'git'));
          const home = await mkdtemp(join(options.root, 'cache', 'git-home-'));
          try { return await first(environment, request, home); } finally { await rm(home, { recursive: true, force: true }); }
        });
        chains.set(request.repositoryId, current);
        return { status: 'success', checkout: await current };
      } catch (error) {
        return error instanceof CheckoutFailure ? { status: error.status, code: error.code } : { status: 'indeterminate', code: 'CHECKOUT_PREPARATION_UNAVAILABLE' };
      }
    },
  };
}

export type CacheReconciliation = { repositoryId: number; outcome: 'reconciled' | 'kept'; code: string | null; nextStep: string | null };
/**
 * Ticket 26 (spec §5.2/§7.3): reconciliation of host Git caches left in preparation by a dead owner, run by the exclusive controller owner
 * BEFORE its storage opens. Repair-free: nothing is fetched, rewritten or deleted. A cache is marked idle again only when (1) its mutation
 * used the git-lock discipline, (2) the repository git lock can be taken at once — no git command of the interrupted mutation can still run —
 * and (3) a read-only connectivity check of the bare cache (Factory-only, never guest-writable) succeeds. Otherwise it stays blocked with an
 * explicit operator action.
 */
export async function reconcileInterruptedCaches(root: string): Promise<CacheReconciliation[]> {
  const cacheRoot = join(root, 'cache', 'git');
  const names = await readdir(cacheRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
  const results: CacheReconciliation[] = [];
  for (const name of names.sort()) {
    const match = /^([0-9]{1,20})\.state\.json$/.exec(name);
    if (!match) continue;
    const repositoryId = Number(match[1]);
    const statePath = join(cacheRoot, name);
    const keep = (code: string): CacheReconciliation => ({ repositoryId, outcome: 'kept', code, nextStep: `Host Git cache of repository ${repositoryId} was left in ` +
      `preparation (${code}). Verify that no git process uses ${join(cacheRoot, `${repositoryId}.git`)}, then remove that bare cache and ${statePath} (the next ` +
      'preparation fetches again) and restart the controller. The Factory never repairs or deletes it by itself.' });
    let state: { state?: unknown; lock?: unknown };
    try {
      const info = await lstat(statePath);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size > 4096) { results.push(keep('CACHE_STATE_UNSAFE')); continue; }
      state = JSON.parse(await readFile(statePath, 'utf8')) as typeof state;
    } catch { results.push(keep('CACHE_STATE_UNREADABLE')); continue; }
    if (state.state === 'idle') continue;
    if (state.lock !== 'git-flock-v1') { results.push(keep('CACHE_PREPARATION_WITHOUT_GIT_LOCK')); continue; }
    const gitLock = join(cacheRoot, `${repositoryId}.git.lock`);
    const cache = join(cacheRoot, `${repositoryId}.git`);
    const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: cacheRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const exists = await lstat(cache).then(info => info.isDirectory() && !info.isSymbolicLink(), () => false);
    // Under the git lock taken WITHOUT waiting: busy means a git command of the dead owner still runs.
    const checked = await new Promise<number | null>(resolve => {
      execFile('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', gitLock,
        ...(exists ? ['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--git-dir', cache, 'fsck', '--connectivity-only', '--no-dangling', '--no-progress'] : ['/usr/bin/true'])],
      { cwd: cacheRoot, env, timeout: 600000, maxBuffer: 1024 * 1024, shell: false }, error => resolve(error ? (typeof error.code === 'number' ? error.code : null) : 0));
    });
    if (checked === 75) { results.push(keep('CACHE_GIT_STILL_RUNNING')); continue; }
    if (checked !== 0) { results.push(keep('CACHE_INTEGRITY_UNVERIFIED')); continue; }
    const temporary = `${statePath}.${process.pid}.reconcile.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, state: 'idle', at: new Date().toISOString(), reconciled: { previous: state.state, cache: exists ? 'connectivity-verified' : 'absent' }, lock: 'git-flock-v1' }), { mode: 0o600 });
    await rename(temporary, statePath);
    results.push({ repositoryId, outcome: 'reconciled', code: null, nextStep: null });
  }
  return results;
}
