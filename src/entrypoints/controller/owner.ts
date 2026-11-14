import { lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { openControl, type ControlInput } from '../../control/index.js';
import { listen, protocolVersion, type Envelope } from '../../protocol/index.js';
import { controllerPaths, verifyControllerLock, controllerRuntimeInventory } from '../../platform/host/index.js';
import { readConfiguration } from '../configuration.js';
import { createGitHubAccess } from '../../platform/github/index.js';
import { createIssueTracker } from '../../issue-tracker/index.js';
import { createCodeRepository } from '../../code-repository/index.js';

const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const command = z.union([z.strictObject({ request_id: requestId, operation: z.enum(['pause', 'unpause']), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('answer'), question_id: z.uuid(), text: z.string().min(1).max(2000), origin: z.literal('local-cli') }),
  z.strictObject({ request_id: requestId, operation: z.literal('grant'), work_id: z.uuid(), counter: z.enum(['corrections', 'recoveries']),
    amount: z.number().int().min(1).max(100), origin: z.literal('local-cli') })]);
const query = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('status') }), z.strictObject({ kind: z.literal('access') }),
  z.strictObject({ kind: z.literal('list') }), z.strictObject({ kind: z.literal('show'), work_id: z.uuid() }),
  z.strictObject({ kind: z.literal('request'), request_id: requestId }), z.strictObject({ kind: z.literal('question'), question_id: z.uuid() })]);

async function own(root: string): Promise<number> {
  process.umask(0o077);
  const paths = await controllerPaths(root);
  await verifyControllerLock(paths.lockPath);
  const validated = await readConfiguration(paths.root);
  if (!validated.configuration.valid) {
    console.error(JSON.stringify({ code: 'CONFIGURATION_INVALID', errors: validated.configuration.errors,
      message: 'Complete the explicit configuration before starting the controller; storage was not opened.' }));
    return 2;
  }
  try {
    const socket = await lstat(paths.endpoint);
    if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error('UNSAFE_SOCKET_PATH');
    await unlink(paths.endpoint); // Only an obsolete own socket, after exclusive ownership.
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const stop = new AbortController();
  const terminate = () => stop.abort();
  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);
  const effective = validated.configuration.effective;
  const github = createGitHubAccess({ root: paths.root, ...effective.githubApp });
  const dependencyScopes = effective.dependencyRepositories.map(entry => ({ repository: entry.repository, installationId: entry.installationId, workflows: false }));
  // Polling cadence comes only from the validated configuration (default 60 s); no reload or per-Work override.
  const control = await openControl({ storagePath: paths.storagePath, runtimeInventory: await controllerRuntimeInventory(paths.root),
    // Executable repositories are Ticket origins; dependency-only repositories are read solely for native blocked_by, with their own installation.
    access: { tracker: createIssueTracker({ github, scopes: effective.repositories, dependencyScopes }), repository: createCodeRepository({ github }),
      repositories: effective.repositories, dependencyRepositories: dependencyScopes, operators: effective.operators },
    polling: { intervalSeconds: effective.pollingSeconds } });
  const status = await control.inspect({ kind: 'status' });
  if (!('controller_run_id' in status)) throw new Error('INVALID_CONTROL_STATUS');
  const runId = status.controller_run_id;
  const running = control.run(stop.signal);
  let server;
  try {
    server = await listen(paths.endpoint, { message: async (envelope, channel) => {
      const reply = async (kind: string, payload: Envelope['payload']) => channel.send({ protocol_version: protocolVersion,
        controller_run_id: runId, message_id: randomUUID(), reply_to: envelope.message_id, kind, payload });
      if (envelope.reply_to !== null || (envelope.controller_run_id !== runId &&
        !(envelope.controller_run_id === null && envelope.kind === 'inspect' && envelope.payload.kind === 'status'))) {
        await reply('error', { code: 'STALE_CONTROLLER' }); return;
      }
      let result: Envelope['payload'];
      let responseKind: string;
      if (envelope.kind === 'accept') {
        const parsed = command.safeParse(envelope.payload);
        if (!parsed.success || envelope.message_id !== parsed.data.request_id) { await reply('error', { code: 'INVALID_COMMAND' }); return; }
        try { result = await control.accept(parsed.data as ControlInput); }
        catch {
          // A failed commit is never a durable receipt; query/retry the SAME identity after recovery.
          await reply('error', { code: 'PERSISTENCE_UNAVAILABLE', outcome: 'indeterminate' }).catch(() => {});
          stop.abort(); return;
        }
        responseKind = 'receipt';
      } else if (envelope.kind === 'inspect') {
        const parsed = query.safeParse(envelope.payload);
        if (!parsed.success) { await reply('error', { code: 'INVALID_QUERY' }); return; }
        try { result = await control.inspect(parsed.data); }
        catch { await reply('error', { code: 'DIAGNOSTIC_UNAVAILABLE' }); return; }
        responseKind = 'view';
      } else { await reply('error', { code: 'INVALID_COMMAND' }); return; }
      // Transport loss after a successful commit does NOT fail the authority or undo that commit.
      await reply(responseKind, result);
    } }, 'local-operator');
    return (await running).kind === 'clean' ? 0 : 1;
  } finally {
    await server?.close();
    stop.abort();
    await running;
    process.off('SIGINT', terminate);
    process.off('SIGTERM', terminate);
  }
}
try { process.exitCode = await own(process.argv[2] ?? '.'); }
catch {
  console.error(JSON.stringify({ code: 'CONTROLLER_START_FAILED', message: 'Exclusive private storage and compatible persistence are required; no automatic repair.' }));
  process.exitCode = 3;
}
