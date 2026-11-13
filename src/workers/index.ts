export type { ReviewerProfile } from './worker-start.js';

/** Host facade deliberately closed: normal boot launch/admission and transient
 * credential delivery are not wired. There is no caller-side SDK fallback. */
export function createWorkers() {
  return {
    async activate(_invocation: unknown): Promise<never> {
      throw new Error('WORKER_EXECUTION_NOT_ENABLED');
    },
  };
}

/** Technical fixed-entrypoint composition only; not Control authorization. */
export async function runWorkerProcess(bootstrap: unknown, signal: AbortSignal) {
  const { run } = await import('./worker-process.js');
  return run(bootstrap, signal);
}
