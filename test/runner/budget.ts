// Guards for tests that wait on real child processes or on a condition with no event (ticket 37).
// No fixed per-test timeout: the bound is what remains of the runner's tier budget (FACTORY_TEST_DEADLINE, see
// scripts/test-runner/runner.ts FileRun), so a slow but healthy run under load never trips it, while a hung child still fails the
// file with the stage it reached and leaves no process behind.
import type { ChildProcess } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

/** Kept before the runner's own budget abort, so the stage is reported instead of only BUDGET_EXCEEDED. */
const marginMs = 5_000;
/** Outside the runner (a manual `node --test`, or `full`, which has no ceiling): the ci ceiling. */
const unboundedMs = 600_000;

export function remainingMs(env: NodeJS.ProcessEnv = process.env, now = Date.now()): number {
  const deadline = Number(env.FACTORY_TEST_DEADLINE);
  if (!env.FACTORY_TEST_DEADLINE || !Number.isFinite(deadline)) return unboundedMs;
  return Math.max(1_000, deadline - now - marginMs);
}

/** SIGKILL the child's whole process group (it must have been started with `detached: true`). */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
}

export interface Ended { code: number | null; signal: NodeJS.Signals | null }

/**
 * The end of a detached child: its exit, then the closing of its pipes (output complete). Whatever its group left behind is killed
 * at its exit, as the runner does for a test file. Past the budget the tree is killed and the promise rejects naming `stage()`.
 */
export function ended(child: ChildProcess, stage: () => string): Promise<Ended> {
  return new Promise((resolve, reject) => {
    let exit: Ended | undefined;
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error(`TEST_BUDGET_EXCEEDED: child ${child.pid} still running after ${remainingMs()} ms; last stage: ${stage()}`));
    }, remainingMs());
    child.once('error', error => { clearTimeout(timer); killTree(child); reject(error); });
    child.once('exit', (code, signal) => { exit = { code, signal }; killTree(child); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve(exit ?? { code, signal }); });
  });
}

/**
 * Re-probe a condition that has no event (a controller observed only through its CLI) until it holds. The bound is the budget, never
 * an iteration count; `probe` returns the value once the condition holds, undefined otherwise.
 */
export async function until<T>(stage: string | (() => string), probe: () => Promise<T | undefined>, everyMs = 25): Promise<T> {
  const end = Date.now() + remainingMs();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`TEST_BUDGET_EXCEEDED waiting for: ${typeof stage === 'string' ? stage : stage()}`);
    await pause(everyMs);
  }
}

/** until() for a boolean condition (ticket 40): resolves once `predicate` holds, bounded by the budget, never by a count. */
export async function untilHolds(stage: string | (() => string), predicate: () => Promise<boolean> | boolean, everyMs = 25): Promise<void> {
  await until(stage, async () => ((await predicate()) ? true : undefined), everyMs);
}
