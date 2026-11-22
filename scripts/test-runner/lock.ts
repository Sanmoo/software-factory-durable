import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MachineLock {
  waitedMs: number;
  release(): void;
}

/** One heavy tier (ci/full) at a time on this machine, across worktrees and sessions. */
export function machineLockPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FACTORY_TEST_RUNNER_LOCK) return env.FACTORY_TEST_RUNNER_LOCK;
  if (!env.XDG_RUNTIME_DIR) throw new Error('TEST_RUNNER_LOCK_UNAVAILABLE: XDG_RUNTIME_DIR is not set, so there is no machine lock for ci/full');
  return join(env.XDG_RUNTIME_DIR, 'software-factory-test-runner.lock');
}

/**
 * flock(1) on a descriptor this process keeps open: the lock belongs to the open file description, so it
 * outlives the short flock child and is released when this process closes it or dies (never left behind).
 * Node opens files close-on-exec, so test processes never inherit it.
 */
export async function acquireMachineLock(path: string, holder: Record<string, unknown>, log: (line: string) => void, now = Date.now): Promise<MachineLock> {
  const fd = openSync(path, 'a', 0o600);
  const started = now();
  const stdio = ['ignore', 'ignore', 'pipe', fd] as const;
  try {
    const attempt = spawnSync('flock', ['--nonblock', '--exclusive', '3'], { stdio: [...stdio] });
    if (attempt.error) throw attempt.error;
    if (attempt.status !== 0) {
      let current = 'unknown holder';
      try {
        current = readFileSync(`${path}.holder`, 'utf8').trim();
      } catch {
        /* holder note is advisory */
      }
      log(`machine lock busy (${current}); queued, waiting time is reported apart and not counted in the budget`);
      const status = await new Promise<number | null>((resolve, reject) => {
        const child = spawn('flock', ['--exclusive', '3'], { stdio: [...stdio] });
        child.once('error', reject);
        child.once('exit', code => resolve(code));
      });
      if (status !== 0) throw new Error(`TEST_RUNNER_LOCK_FAILED: flock exited ${status}`);
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  try {
    writeFileSync(`${path}.holder`, JSON.stringify({ ...holder, since: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch {
    /* advisory */
  }
  let released = false;
  return {
    waitedMs: now() - started,
    release: () => {
      if (!released) {
        released = true;
        closeSync(fd);
      }
    },
  };
}
