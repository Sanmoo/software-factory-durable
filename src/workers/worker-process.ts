import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { connect, protocolVersion } from '../protocol/index.js';
import { createRecords } from '../records/index.js';
import type { ReadResult, ToolContext, ToolProjection } from '../sandbox/index.js';
import { startWorker } from './worker-start.js';
import { createQuestionSender, createSecretPublisher, deliverSchema, workerBootstrapSchema } from '../platform/host/index.js';
import type { BuilderDirective, HandoffEvent } from './builder-handoff.js';

/** The fixed entrypoint's own IPC (no new channel): the suspended Builder's handoff notice out, the Host directive in. */
export type WorkerIpc = { send(message: Record<string, unknown>): Promise<void>; onMessage(listener: (value: unknown) => void): () => void };

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const reference = z.strictObject({ workId: identifier, id: z.uuid() });
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base64 = z
  .string()
  .max(32768)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const successSchema = z.strictObject({
  status: z.literal('success'),
  reference,
  bytes: safeCount,
  encoding: z.literal('base64'),
  data: base64,
  nextOffset: safeCount,
});
const readResultSchema = z.union([
  successSchema.extend({
    format: z.literal('text'),
    sourceVersion: z.uuid().optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    progressFrames: safeCount.optional(),
  }),
  successSchema.extend({ format: z.literal('raw'), imageSourceMaxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ status: z.literal('failure'), code: z.string().min(1).max(128) }),
]);
const progressSchema = z.strictObject({ context: z.record(z.string(), z.string()), sequence: safeCount, bytes: safeCount, data: base64.min(4) });

async function privateDirectory(path: string) {
  if (!isAbsolute(path) || (await realpath(path)) !== path) throw new Error('WORKER_PROFILE_NOT_PRIVATE');
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077) {
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
  const close = () => {
    closed = true;
    channel.close();
  };
  signal.addEventListener('abort', close, { once: true });
  const sandbox: ToolProjection = {
    async executeTool(inputContext, call, onData, callSignal): Promise<ReadResult> {
      if (closed || signal.aborted || Object.keys(context).some(key => context[key as keyof ToolContext] !== inputContext[key as keyof ToolContext])) {
        return { status: 'failure', code: 'STALE_TOOL_CONTEXT' };
      }
      if (busy) return { status: 'failure', code: 'TOOL_CALL_IN_PROGRESS' };
      busy = true;
      callSignal?.addEventListener('abort', close, { once: true });
      try {
        if (callSignal?.aborted) throw new Error('aborted');
        // Optional undefined timeout is never serialized as a key.
        const payload = z.record(z.string(), z.json()).parse({ context, call });
        await channel.send({
          protocol_version: protocolVersion,
          controller_run_id: null,
          message_id: call.callId,
          reply_to: null,
          kind: 'execute-tool',
          payload,
        });
        let sequence = 0;
        let bytes = 0;
        while (true) {
          const response = await messages.next();
          if (
            response.done ||
            response.value.reply_to !== call.callId ||
            response.value.message_id !== call.callId ||
            response.value.controller_run_id !== null
          )
            throw new Error('TOOL_CHANNEL_CLOSED');
          if (response.value.kind === 'tool-progress') {
            if (call.name !== 'bash' || !onData) throw new Error('INVALID_TOOL_PROGRESS');
            const frame = progressSchema.parse(response.value.payload);
            const chunk = Buffer.from(frame.data, 'base64');
            if (
              Object.keys(frame.context).length !== Object.keys(context).length ||
              Object.keys(context).some(key => context[key as keyof ToolContext] !== frame.context[key]) ||
              frame.sequence !== sequence++ ||
              chunk.length > 24576 ||
              chunk.toString('base64') !== frame.data ||
              frame.bytes !== bytes + chunk.length ||
              !Number.isSafeInteger(frame.bytes)
            )
              throw new Error('INVALID_TOOL_PROGRESS');
            bytes = frame.bytes;
            await onData(chunk);
            continue;
          }
          if (response.value.kind !== 'tool-result') throw new Error('TOOL_CHANNEL_CLOSED');
          const result = readResultSchema.parse(response.value.payload);
          if (
            call.name === 'bash' &&
            !('operation' in call) &&
            result.status === 'success' &&
            (result.format !== 'text' ||
              result.exitCode === undefined ||
              result.progressFrames !== sequence ||
              result.bytes !== bytes ||
              result.reference.workId !== context.workId ||
              result.data !== '' ||
              result.nextOffset !== 0)
          )
            throw new Error('INVALID_TOOL_RESULT');
          return result;
        }
      } catch {
        close();
        return { status: 'failure', code: 'TOOL_CHANNEL_CLOSED' };
      } finally {
        callSignal?.removeEventListener('abort', close);
        busy = false;
      }
    },
  };
  return {
    sandbox,
    close() {
      signal.removeEventListener('abort', close);
      close();
    },
  };
}

/** Private bounded bootstrap, received only over the fixed entrypoint's inherited
 * IPC. No callbacks, SDK objects, environment bag or arbitrary executable input. */
export async function run(input: unknown, parentSignal: AbortSignal, ipc?: WorkerIpc) {
  const synchronizationLifetime = new AbortController();
  let signal = AbortSignal.any([parentSignal, synchronizationLifetime.signal]);
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 65536) throw new Error('WORKER_BOOTSTRAP_INVALID');
  const parsed = workerBootstrapSchema.safeParse(input);
  if (!parsed.success) throw new Error('WORKER_BOOTSTRAP_INVALID');
  const bootstrap = parsed.data;
  // No implicit clock cut (spec §4.4): an OAuth worker runs until it ends, its parent aborts it, or the Host policy gave an explicit
  // deadline. The Execution-level clock is the repository's optional timeout, enforced by the controller.
  if (!('apiKey' in bootstrap.profile) && bootstrap.deadlineMs !== undefined) signal = AbortSignal.any([signal, AbortSignal.timeout(bootstrap.deadlineMs)]);
  // Same explicit minimal projection as the existing closed Host launch plan.
  const { TMPDIR: temporary, XDG_CACHE_HOME: cache } = process.env;
  if (
    process.versions.node.split('.')[0] !== '24' ||
    process.env.NODE_DISABLE_COMPILE_CACHE !== '1' ||
    process.env.PATH !== '' ||
    process.env.LANG !== 'C' ||
    process.env.LC_ALL !== 'C' ||
    !temporary ||
    !cache ||
    Object.keys(process.env).some(key => !['PATH', 'LANG', 'LC_ALL', 'NODE_DISABLE_COMPILE_CACHE', 'TMPDIR', 'XDG_CACHE_HOME'].includes(key))
  ) {
    throw new Error('WORKER_ENVIRONMENT_INVALID');
  }
  for (const directory of [bootstrap.recordsRoot, bootstrap.profile.directory, join(bootstrap.profile.directory, 'sessions'), temporary, cache]) {
    await privateDirectory(directory);
  }
  if (!isAbsolute(bootstrap.endpoint)) throw new Error('WORKER_BOOTSTRAP_INVALID');
  const records = await createRecords({ root: bootstrap.recordsRoot });
  const secrets = [...bootstrap.knownSecrets, ...('apiKey' in bootstrap.profile ? [bootstrap.profile.apiKey] : [])];
  for (const secret of secrets) records.registerSecret(secret);
  const publicProfile = 'apiKey' in bootstrap.profile ? (({ apiKey: _key, ...rest }) => rest)(bootstrap.profile) : bootstrap.profile;
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
  const invocation = {
    context: bootstrap.context,
    prompt: bootstrap.prompt,
    signal,
    ...(bootstrap.copyOutput === undefined ? {} : { copyOutput: bootstrap.copyOutput }),
    ...(bootstrap.skillPack === undefined ? {} : { skillPack: bootstrap.skillPack }),
    ...(bootstrap.modelBudget === undefined ? {} : { modelBudget: bootstrap.modelBudget }),
    ...(bootstrap.builderBudget === undefined ? {} : { builderBudget: bootstrap.builderBudget }),
    ...(bootstrap.deadlineMs === undefined ? {} : { deadlineMs: bootstrap.deadlineMs }),
    ...(bootstrap.editSourceMaxBytes === undefined ? {} : { editSourceMaxBytes: bootstrap.editSourceMaxBytes }),
    ...(bootstrap.handoff === undefined ? {} : { handoff: bootstrap.handoff }),
    ...(bootstrap.pushPolicy === undefined ? {} : { pushPolicy: bootstrap.pushPolicy }),
    ...(bootstrap.review === undefined ? {} : { review: bootstrap.review }),
    ...(bootstrap.continuedSession === undefined ? {} : { continuedSession: bootstrap.continuedSession }),
  };
  // One directive per handoff, awaited only while suspended; the abort lifetime ends the wait (no Promise waiting on a human here).
  const onHandoff =
    ipc && bootstrap.handoff
      ? (event: HandoffEvent) =>
          new Promise<BuilderDirective>((resolve, reject) => {
            const done = () => {
              stop();
              signal.removeEventListener('abort', aborted);
            };
            const aborted = () => {
              done();
              reject(new Error('STALE_TOOL_CONTEXT'));
            };
            const stop = ipc.onMessage(value => {
              const parsed = deliverSchema.safeParse(value);
              if (parsed.success && parsed.data.directive.round === event.round) {
                done();
                resolve(parsed.data.directive);
              }
            });
            signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted) {
              aborted();
              return;
            }
            ipc.send({ kind: 'worker-handoff', event }).catch(() => aborted());
          })
      : undefined;
  // Sync protected receipt before even importing/creating the native SDK runtime.
  // Absent (production) leaves the publisher's own default ACK wait (5000 ms); a Host policy may only shorten it (ticket 37).
  const secretPublisher = createSecretPublisher(process, bootstrap.context, signal, bootstrap.secretAckTimeoutMs, () => synchronizationLifetime.abort());
  try {
    const receipt = await startWorker(bootstrap.profile, records, invocation);
    const sender = process.send?.bind(process);
    if (sender)
      await new Promise<void>((resolve, reject) => {
        sender(
          { kind: 'worker-started', receipt, invocation: { executionId: bootstrap.context.executionId, invocationId: bootstrap.context.invocationId } },
          error => (error ? reject(new Error('WORKER_CHANNEL_CLOSED')) : resolve()),
        );
      });
    if (signal.aborted) throw new Error('STALE_TOOL_CONTEXT');
    secretPublisher.protectedStarted();

    const tools = await toolProjection(bootstrap.endpoint, bootstrap.context, signal);
    try {
      const { executeSession } = await import('./worker-session.js');
      const questions = bootstrap.context.role === 'builder' ? createQuestionSender(process, bootstrap.context, signal) : undefined;
      return await executeSession(
        {
          profile: bootstrap.profile,
          records,
          sandbox: tools.sandbox,
          ...(questions
            ? { questions: { send: question => questions.ask(question), containsSecret: text => secrets.some(secret => text.includes(secret)) } }
            : {}),
          oauth: {
            factoryRoot: bootstrap.recordsRoot,
            acknowledgeSecrets: secretPublisher.acknowledgeSecrets,
            publicInputIsSafe: () => !containsSecret({ prompt: bootstrap.prompt, profile: publicProfile }),
            registerSecret(value) {
              records.registerSecret(value);
              if (!secrets.includes(value)) secrets.push(value);
            },
          },
          ...(onHandoff ? { onHandoff } : {}),
        },
        invocation,
        receipt,
      );
    } finally {
      tools.close();
    }
  } finally {
    secretPublisher.close();
  }
}
