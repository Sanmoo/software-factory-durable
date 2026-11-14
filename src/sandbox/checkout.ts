import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
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
  cache: z.literal('factory-exclusive-bare'), clone: z.literal('no-hardlinks') });

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
export function createCheckouts(options: { root: string; fetch: RepositoryFetchCredentials;
  /** Upstream fetch URL; GitHub by default. Tests substitute a local file:// fixture. The checkout's origin is ALWAYS the GitHub URL. */
  remoteUrl?: (scope: { repository: string }) => string }) {
  const chains = new Map<number, Promise<unknown>>();
  const github = (repository: string) => `https://github.com/${repository}.git`;

  async function run(args: string[], cwd: string, home: string, token?: string, timeout = 600000) {
    // Fixed argv/env; output never recorded (it could echo remote text). Exit code is the observation.
    const env: Record<string, string> = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ATTR_NOSYSTEM: '1',
      ...(token ? { GH_TOKEN: token, GH_HOST: 'github.com', GH_CONFIG_DIR: home, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } : {}) };
    const fixed = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.file.allow=always', '-c', 'submodule.recurse=false',
      '-c', 'core.attributesFile=/dev/null', '-c', 'init.templateDir='];
    return new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/git', [...fixed, ...args], { cwd, env, timeout, maxBuffer: 1024 * 1024, shell: false, encoding: 'utf8' },
        (error, stdout) => error ? reject(new CheckoutFailure('indeterminate', 'CHECKOUT_GIT_FAILED')) : resolve(stdout.trim()));
    });
  }

  async function first(environment: string, request: CheckoutRequest, home: string): Promise<CheckoutView> {
    const cacheRoot = join(options.root, 'cache', 'git');
    const cache = join(cacheRoot, `${request.repositoryId}.git`);
    if (!await exists(cache)) await run(['init', '--quiet', '--bare', '--template=', cache], cacheRoot, home);
    let token: string;
    try { token = (await options.fetch.fetch({ repository: request.repository, installationId: request.installationId, workflows: false })).token; }
    catch { throw new CheckoutFailure('failure', 'CHECKOUT_FETCH_CREDENTIAL_UNAVAILABLE'); }
    const upstream = options.remoteUrl?.({ repository: request.repository }) ?? github(request.repository);
    // A failed fetch never proves an updated base; nothing below runs without it.
    await run(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', upstream, `+refs/heads/${request.base}:refs/heads/${request.base}`], cache, home, token);
    const baseCommit = await run(['rev-parse', '--verify', `refs/heads/${request.base}^{commit}`], cache, home);
    const checkout = join(environment, 'workspace', 'checkout');
    // cwd is the Factory-owned home, never the workspace: no repository discovery above the new checkout. Only this never-booted,
    // Factory-created clone is touched by host git, and only now (never on continuation).
    await run(['clone', '--quiet', '--no-hardlinks', '--template=', '--no-checkout', '--single-branch', '--branch', request.base, '--', cache, checkout], home, home);
    const origin = github(request.repository);
    await run(['-C', checkout, 'remote', 'set-url', 'origin', origin], home, home);
    await run(['-C', checkout, 'checkout', '--quiet', '--no-track', '-b', request.branch, baseCommit], home, home);
    if (await exists(join(checkout, '.git', 'objects', 'info', 'alternates')) || await run(['-C', checkout, 'config', '--get', 'remote.origin.url'], home, home) !== origin ||
      (await readdir(join(checkout, '.git', 'hooks')).catch(() => [])).length) throw new CheckoutFailure('indeterminate', 'CHECKOUT_VERIFICATION_FAILED');
    const preparedAt = new Date().toISOString();
    await durableJson(join(environment, 'checkout.json'), { version: 1, path: '/workspace/checkout', repository: request.repository, repositoryId: request.repositoryId,
      base: request.base, branch: request.branch, baseCommit, origin, preparedAt, cache: 'factory-exclusive-bare', clone: 'no-hardlinks' });
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
