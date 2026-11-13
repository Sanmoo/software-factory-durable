import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { connect, protocolVersion } from '../protocol/index.js';
import { createRecords } from '../records/index.js';
import type { ReadResult, ToolContext, ToolProjection } from '../sandbox/index.js';
import { startWorker } from './worker-start.js';
import { workerBootstrapSchema } from '../platform/host/index.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const reference = z.strictObject({ workId: identifier, id: z.uuid() });
const resultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('success'), reference, bytes: z.number().int().nonnegative(),
    data: z.string().max(32768), nextOffset: z.number().int().nonnegative() }),
  z.strictObject({ status: z.literal('failure'), code: z.string().min(1).max(128) }),
]);

async function privateDirectory(path: string) {
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error('WORKER_PROFILE_NOT_PRIVATE');
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new Error('WORKER_PROFILE_NOT_PRIVATE');
  }
}

/** Concrete projection of the existing owner execute-tool endpoint, not RPC or
 * owner registration. The owner still enforces its independently bound context. */
async function toolProjection(endpoint: string, context: ToolContext, signal: AbortSignal) {
  const channel = await connect(endpoint, { kind: 'worker-tool', binding: context });
  const messages = channel.messages[Symbol.asyncIterator]();
  let busy = false;
  let closed = false;
  const close = () => { closed = true; channel.close(); };
  signal.addEventListener('abort', close, { once: true });
  const sandbox: ToolProjection = { async executeTool(inputContext, call): Promise<ReadResult> {
    if (closed || signal.aborted || Object.keys(context).some(key => context[key as keyof ToolContext] !== inputContext[key as keyof ToolContext])) {
      return { status: 'failure', code: 'STALE_TOOL_CONTEXT' };
    }
    if (busy) return { status: 'failure', code: 'TOOL_CALL_IN_PROGRESS' };
    busy = true;
    try {
      await channel.send({ protocol_version: protocolVersion, controller_run_id: null,
        message_id: call.callId, reply_to: null, kind: 'execute-tool', payload: { context, call } });
      const response = await messages.next();
      if (response.done || response.value.kind !== 'tool-result' || response.value.reply_to !== call.callId ||
          response.value.message_id !== call.callId || response.value.controller_run_id !== null) throw new Error('TOOL_CHANNEL_CLOSED');
      return resultSchema.parse(response.value.payload);
    } catch { close(); return { status: 'failure', code: 'TOOL_CHANNEL_CLOSED' }; }
    finally { busy = false; }
  } };
  return { sandbox, close() { signal.removeEventListener('abort', close); close(); } };
}

/** Private bounded bootstrap, received only over the fixed entrypoint's inherited
 * IPC. No callbacks, SDK objects, environment bag or arbitrary executable input. */
export async function run(input: unknown, signal: AbortSignal) {
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 65536) throw new Error('WORKER_BOOTSTRAP_INVALID');
  const parsed = workerBootstrapSchema.safeParse(input);
  if (!parsed.success) throw new Error('WORKER_BOOTSTRAP_INVALID');
  const bootstrap = parsed.data;
  // Same explicit minimal projection as the existing closed Host launch plan.
  const { TMPDIR: temporary, XDG_CACHE_HOME: cache } = process.env;
  if (process.versions.node.split('.')[0] !== '24' || process.env.NODE_DISABLE_COMPILE_CACHE !== '1' ||
      process.env.PATH !== '' || process.env.LANG !== 'C' || process.env.LC_ALL !== 'C' || !temporary || !cache ||
      Object.keys(process.env).some(key => !['PATH', 'LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'TMPDIR', 'XDG_CACHE_HOME'].includes(key))) {
    throw new Error('WORKER_ENVIRONMENT_INVALID');
  }
  for (const directory of [bootstrap.recordsRoot, bootstrap.profile.directory, join(bootstrap.profile.directory, 'sessions'), temporary, cache]) {
    await privateDirectory(directory);
  }
  if (!isAbsolute(bootstrap.endpoint)) throw new Error('WORKER_BOOTSTRAP_INVALID');
  const records = await createRecords({ root: bootstrap.recordsRoot });
  for (const secret of [...bootstrap.knownSecrets, bootstrap.profile.apiKey]) records.registerSecret(secret);
  const { apiKey: _apiKey, ...publicProfile } = bootstrap.profile;
  const secrets = [...bootstrap.knownSecrets, bootstrap.profile.apiKey];
  // Traverse only this schema-bounded public tree, before any JSON escaping.
  // Reject rather than rewrite the prompt or profile passed to the native SDK.
  const containsSecret = (value: unknown): boolean => {
    if (typeof value === 'string') return secrets.some(secret => value.includes(secret));
    if (value !== null && typeof value === 'object') return Object.values(value).some(containsSecret);
    return false;
  };
  if (containsSecret({ prompt: bootstrap.prompt, profile: publicProfile })) {
    throw new Error('WORKER_BOOTSTRAP_INVALID');
  }
  const invocation = { context: bootstrap.context, prompt: bootstrap.prompt, signal };
  // Sync protected receipt before even importing/creating the native SDK runtime.
  const receipt = await startWorker(bootstrap.profile, records, invocation);
  const sender = process.send?.bind(process);
  if (sender) await new Promise<void>((resolve, reject) => {
    sender({ kind: 'worker-started', receipt }, error => error ? reject(new Error('WORKER_CHANNEL_CLOSED')) : resolve());
  });
  if (signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
  const tools = await toolProjection(bootstrap.endpoint, bootstrap.context, signal);
  try {
    const { executeSession } = await import('./worker-session.js');
    return await executeSession({ profile: bootstrap.profile, records, sandbox: tools.sandbox }, invocation, receipt);
  } finally { tools.close(); }
}
