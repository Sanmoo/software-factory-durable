// TEST ONLY (ticket 29): a Work with four Builder Executions over ONE continued Pi session (real JSONL v3 files in a private runtime tree),
// one never started and one without a recorded session, a RECOVERY_BLOCKED impediment and a reviewer history entry; recorded exactly in the
// typed shapes the dispatch/review flows leave (ExecutionView). Used by the flow test and by the CLI composition test.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ExecutionView } from '../../src/control/types.js';
import { initialize, works } from '../../src/control/durable/admission.js';
import { openStore } from '../../src/control/durable/store.js';
import { initializeSlots } from '../../src/control/durable/execution.js';
import { bootRef, seedPublishedWork } from './delivery-fixture.js';

/** Runtime directory segment of the seeded Executions' boot (`r/<segment>`), as the host lays it out. */
export const boot = Buffer.from(bootRef.slice(5).replaceAll('-', ''), 'hex').toString('base64url');
/** A preserved Pi JSONL v3 session in the installation's private runtime tree, as the boot owner leaves it. */
async function session(root: string, worker: string, id: string, lines: unknown[]) {
  const directory = join(root, 'r', boot, worker, 'profile', 'sessions');
  for (const path of [join(root, 'r'), join(root, 'r', boot), join(root, 'r', boot, worker), join(root, 'r', boot, worker, 'profile'), directory]) await mkdir(path, { mode: 0o700 }).catch(() => {});
  const data = [{ type: 'session', version: 3, id, timestamp: 'now', cwd: '/workspace' }, ...lines].map(line => JSON.stringify(line)).join('\n') + '\n';
  const file = join(directory, `${id}.jsonl`);
  await writeFile(file, data, { mode: 0o600 });
  return { ref: `r/${boot}/${worker}/profile/sessions/${id}.jsonl`, file, sha256: createHash('sha256').update(data).digest('hex'), bytes: Buffer.byteLength(data) };
}
const assistant = (id: string, usage: Record<string, unknown>, stopReason = 'stop') => ({ type: 'message', id, parentId: null, timestamp: 'now',
  message: { role: 'assistant', provider: 'openai-codex', model: 'gpt-5.5', stopReason, usage } });
const usage = (input: number, output: number, cost: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const profile = { sdkProfile: 'factory-pi-v1', providerId: 'openai-codex', modelId: 'gpt-5.5', skillPack: null, tools: ['bash', 'write'] };

/** Seeds `storagePath` (created) and the session files under the canonical private `root`; returns the Work id. */
export async function seedInspectedWork(storagePath: string, root: string): Promise<string> {
  const opened = await openStore(storagePath);
  // As a controller leaves it: installation AND Slots documents exist (opening Control then writes nothing).
  await initialize(opened.session);
  await initializeSlots(opened.session);
  const work_id = await seedPublishedWork(opened.session);
  // Two Builder activations of ONE continued session: the second file carries the first one's messages (counted once), plus an aborted one.
  const first = await session(root, 'w-a', 'sess-1', [assistant('m1', usage(100, 10, 0.25)), assistant('m2', usage(50, 5, 0.125))]);
  const second = await session(root, 'w-b', 'sess-1', [assistant('m1', usage(100, 10, 0.25)), assistant('m2', usage(50, 5, 0.125)),
    assistant('m3', usage(20, 0, 0.0625), 'aborted')]);
  await opened.session.commit(async tx => {
    const document = await tx.doc(works, work_id, null);
    const work = document.work!;
    const e1 = JSON.parse(JSON.stringify(work.execution)) as ExecutionView;
    e1.end = { ...e1.end!, session: { ref: first.ref, sessionId: 'sess-1', sha256: first.sha256, bytes: first.bytes, format: 'pi-session-jsonl-v3', profile } };
    e1.timing = { timeoutSeconds: null, clock: 'controller-monotonic', origin: 'o', startedAt: 'now', lastActivity: null, duration: { kind: 'measured', elapsedMs: 1500, endedAt: 'now' },
      timeout: null, overrun: 'not-applicable' };
    const e2: ExecutionView = { ...JSON.parse(JSON.stringify(e1)) as ExecutionView, executionId: 'e-2', invocationId: 'i-2', mode: 'recovery',
      request: { ...e1.request, session: { mode: 'continue', reason: 'compatible', previousExecutionId: 'e-1', previous: null, decidedAt: 'now' } },
      end: { ...e1.end, session: { ref: second.ref, sessionId: 'sess-1', sha256: second.sha256, bytes: second.bytes, format: 'pi-session-jsonl-v3', profile } },
      timing: { ...e1.timing, duration: { kind: 'lower-bound', provenMs: 700, calendarEstimateMs: 900, reconciledAt: 'now' } } };
    // A third Execution that never started and one that started without a recorded session.
    const e3: ExecutionView = { ...JSON.parse(JSON.stringify(e1)) as ExecutionView, executionId: 'e-3', invocationId: 'i-3', start: null, end: null, state: 'released', timing: undefined as never };
    const e4: ExecutionView = { ...JSON.parse(JSON.stringify(e1)) as ExecutionView, executionId: 'e-4', invocationId: 'i-4', end: { ...e1.end, session: null }, timing: undefined as never };
    delete (e3 as { timing?: unknown }).timing; delete (e4 as { timing?: unknown }).timing;
    work.previousExecutions = [e1, e2, e3];
    work.execution = e4;
    work.impediments = [{ code: 'RECOVERY_BLOCKED', scope: 'work', since: 'now', nextStep: 'Inspect the Execution evidence and decide explicitly.' }];
    for (const executionId of ['e-1', 'e-2', 'e-3', 'e-4']) work.history.push({ at: 'now', event: 'execution-started', origin: 'controller-dispatch', executionId });
    work.history.push({ at: 'now', event: 'reviewer-started', origin: 'controller-dispatch', executionId: 'e-2', detail: 'r1:standards' });
  }, BACKGROUND_CONTEXT);
  await opened.close();
  return work_id;
}

