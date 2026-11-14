import { runWorkerProcess } from '../workers/index.js';

// Fixed internal executable: one transient private IPC bootstrap, no argv or
// profile discovery. No SDK, Sandbox implementation, or raw diagnostics here.
const lifetime = new AbortController();
process.once('disconnect', () => lifetime.abort());
const directive = (value: unknown) => {
  if (value && typeof value === 'object' && Object.keys(value).length === 1 &&
      'kind' in value && value.kind === 'abort') lifetime.abort();
};

async function send(message: Record<string, unknown>) {
  const sender = process.send?.bind(process);
  if (!process.connected || !sender) return;
  await new Promise<void>((resolve, reject) => sender(message, error => error ? reject(error) : resolve()));
}

// Native accumulator uses an async WriteStream whose open error can arrive before
// its completion handler is installed. A fatal worker fault must never become a
// raw Node diagnostic or permit a dependent model turn. Do not resume execution.
let fatal = false;
const terminate = () => {
  if (fatal) return;
  fatal = true;
  lifetime.abort();
  void send({ kind: 'worker-error', code: 'WORKER_PROCESS_FAILED' }).catch(() => {}).finally(() => process.exit(1));
};
process.on('uncaughtException', terminate);
process.on('unhandledRejection', terminate);

try {
  if (!process.send || process.argv.length !== 2) throw new Error('WORKER_BOOTSTRAP_INVALID');
  const input = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('WORKER_BOOTSTRAP_INVALID')); }, 5000);
    const message = (value: unknown) => { cleanup(); resolve(value); };
    const disconnected = () => { cleanup(); reject(new Error('WORKER_BOOTSTRAP_INVALID')); };
    function cleanup() {
      clearTimeout(timeout);
      process.removeListener('message', message);
      process.removeListener('disconnect', disconnected);
    }
    process.once('message', message);
    process.once('disconnect', disconnected);
  });
  // Bootstrap is consumed exactly once; only this invocation's abort remains.
  process.on('message', directive);
  const result = await runWorkerProcess(input, lifetime.signal, { send, onMessage(listener) {
    process.on('message', listener);
    return () => { process.removeListener('message', listener); };
  } });
  if (!fatal) await send({ kind: 'worker-result', ...result });
} catch (error) {
  // Allowlist codes only: never serialize arbitrary exception messages/stacks,
  // provider output, bootstrap, credentials, or filesystem diagnostics.
  const code = error instanceof Error && ['PROTECTED_CAPTURE_UNAVAILABLE', 'WORKER_PROFILE_NOT_PRIVATE',
    'WORKER_ENVIRONMENT_INVALID', 'STALE_TOOL_CONTEXT', 'WORKER_BOOTSTRAP_INVALID',
    'WORKER_PROFILE_INVALID', 'WORKER_ROLE_UNSUPPORTED', 'WORKER_MODEL_UNAVAILABLE',
    'WORKER_MODEL_MISMATCH'].includes(error.message) ? error.message : 'WORKER_PROCESS_FAILED';
  try { if (!fatal) await send({ kind: 'worker-error', code }); } catch { /* No raw fallback. */ }
  process.exitCode = 1;
} finally {
  process.removeListener('message', directive);
  if (process.connected && !fatal) process.disconnect();
}
