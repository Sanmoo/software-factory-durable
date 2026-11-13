import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkers } from '../../src/workers/index.js';
import { SessionManager } from '#factory-pi';

/** Trusted Host composition: Q6 admission/reservation is a caller precondition.
 * This local fixture grants no production Control authority. */
export async function normalWorker(root: string, context: { workId: string; environmentRef: string; bootRef: string }) {
  const configuration = { root, knownSecrets: ['synthetic-secret'], profile: {
    id: 'factory-development-pi-1.5.2-read-operations-v1', systemPrompt: 'Read only, no personal resources.',
    providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key',
    provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [
      { id: 'reader', name: 'Reader', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 },
    ] },
  } } as const;
  const mutableConfiguration = { ...configuration, knownSecrets: [...configuration.knownSecrets], profile: {
    ...configuration.profile, provider: { ...configuration.profile.provider, models: configuration.profile.provider.models.map(model => ({ ...model, input: [...model.input] })) },
  } };
  const workers = createWorkers(mutableConfiguration);
  const invocation = { context: { ...context, executionId: 'execution-05', invocationId: 'standards-05',
    role: 'standards' as const, phaseId: 'review-1' }, prompt: 'Read source.txt offset 5001 limit 2.', signal: new AbortController().signal };
  const worker = await workers.activate(invocation);
  try {
    // The once-only claim must already exist, before any child SDK turn.
    await assert.rejects(workers.activate(invocation), /STALE_TOOL_CONTEXT/);
    const started = await worker.started;
    const completed = await worker.completed;
    assert.equal(completed.status, 'success');
    if (completed.status !== 'success') throw new Error('EXPECTED_SUCCESS');
    assert.deepEqual(completed.receipt, started.receipt);
    const evidence = join(root, context.workId, 'evidence', started.receipt.id);
    await readFile(join(evidence, 'complete.json'));
    const receipt = JSON.parse(await readFile(join(evidence, 'output'), 'utf8')).event;
    assert.deepEqual(receipt.suppliedContext, invocation.context);
    assert.notEqual(receipt.observedProcess.pid, process.pid);
    const tag = Buffer.from(context.bootRef.slice(5).replaceAll('-', ''), 'hex').toString('base64url');
    const runtime = join(root, 'r', tag);
    const launch = (await readdir(runtime)).find(name => name.startsWith('w-'))!;
    const sessions = join(runtime, launch, 'profile', 'sessions');
    const files = await readdir(sessions, { recursive: true });
    const session = files.find(name => name.endsWith('.jsonl'))!;
    const transcript = await readFile(join(sessions, session), 'utf8');
    assert.match(transcript, /toolResult/); assert.match(transcript, /█/);
    assert.doesNotMatch(transcript, /synthetic-secret|synthetic-key/);
    const reopened = SessionManager.open(join(sessions, session));
    assert.ok(reopened.buildSessionContext().messages.some(message => message.role === 'toolResult'));
    await assert.rejects(workers.activate(invocation), /STALE_TOOL_CONTEXT/);
    await assert.rejects(workers.activate({ ...invocation, context: { ...invocation.context, executionId: 'other-execution' } }), /STALE_TOOL_CONTEXT/);
    // A genuine critical Records failure in another actual normal child cannot
    // reach provider/tools and does not free its technical invocation identity.
    const failingWorkers = createWorkers({ ...mutableConfiguration, knownSecrets: ['version'] });
    const failedInvocation = { ...invocation, context: { ...invocation.context, invocationId: 'failed-start' } };
    const failed = await failingWorkers.activate(failedInvocation);
    try {
      await assert.rejects(failed.started, /WORKER_EXECUTION_UNCERTAIN|PEER_CLOSED/);
      await assert.rejects(failed.completed);
      await assert.rejects(failingWorkers.activate(failedInvocation), /STALE_TOOL_CONTEXT/);
    } finally { failed.close(); }
    return { receipt: started.receipt, pid: receipt.observedProcess.pid };
  } finally { worker.close(); }
}
