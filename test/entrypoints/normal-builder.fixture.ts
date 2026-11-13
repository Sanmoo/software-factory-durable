import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createSandbox } from '../../src/sandbox/index.js';
import { createWorkers } from '../../src/workers/index.js';
import { SessionManager } from '#factory-pi';

/** Public normal owner/Host launch, not a caller-side SDK substitute. The adapter
 * fixture substitutes ONLY external manager/VM boundaries; FD hardware unproven. */
export async function normalBuilder(root: string, context: { workId: string; environmentRef: string; bootRef: string }) {
  const workers = createWorkers({ root, knownSecrets: ['synthetic-secret'], profile: {
    id: 'factory-development-pi-1.5.2-read-async-bash-v2', systemPrompt: 'Regular-file Builder write fixture.',
    providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key',
    provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [
      { id: 'reader', name: 'Reader', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 },
    ] },
  } });
  const invocation = { context: { ...context, executionId: 'execution-05', invocationId: 'builder-05', role: 'builder' as const, phaseId: 'build-1' },
    prompt: 'Overwrite an existing regular file.', signal: new AbortController().signal };
  const worker = await workers.activate(invocation);
  try {
    const started = await worker.started;
    const completed = await worker.completed;
    assert.equal(completed.status, 'success');
    if (completed.status !== 'success') throw new Error('EXPECTED_SUCCESS');
    assert.deepEqual(completed.receipt, started.receipt);
    const receipt = JSON.parse(await readFile(join(root, context.workId, 'evidence', started.receipt.id, 'output'), 'utf8')).event;
    assert.equal(receipt.suppliedContext.role, 'builder'); assert.notEqual(receipt.observedProcess.pid, process.pid);
    const tag = Buffer.from(context.bootRef.slice(5).replaceAll('-', ''), 'hex').toString('base64url');
    const runtime = join(root, 'r', tag);
    const launch = (await readdir(runtime)).find(name => name.startsWith('w-'))!;
    const sessions = join(runtime, launch, 'profile', 'sessions');
    const session = (await readdir(sessions, { recursive: true })).find(name => name.endsWith('.jsonl'))!;
    const transcript = await readFile(join(sessions, session), 'utf8');
    assert.doesNotMatch(transcript, /synthetic-secret|synthetic-key/);
    const reopened = SessionManager.open(join(sessions, session));
    assert.ok(reopened.buildSessionContext().messages.some(message => message.role === 'toolResult' && JSON.stringify(message).includes('Successfully wrote to nested/new.txt')));
    await assert.rejects(workers.activate(invocation), /STALE_TOOL_CONTEXT/);
    const sandbox = createSandbox({ root });
    const mkdir = { name: 'write' as const, operation: 'mkdir' as const, path: '/workspace/nested', callId: 'role-deny' };
    for (const role of ['standards', 'spec'] as const) {
      const reviewer = { ...invocation.context, role, invocationId: `${role}-05` };
      assert.deepEqual(await sandbox.executeTool(reviewer, mkdir), { status: 'failure', code: 'WRITE_ROLE_DENIED' });
      assert.deepEqual(await sandbox.executeTool({ ...reviewer, role: 'builder' }, mkdir), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
    }
    const builder = { ...invocation.context, invocationId: 'existing-file-05' };
    assert.equal((await sandbox.executeTool(builder, { name: 'write', operation: 'create', path: '/workspace/nested/new.txt', content: '', callId: 'overwrite-empty' })).status,
      'success');
    return { receipt: started.receipt, pid: receipt.observedProcess.pid };
  } finally { worker.close(); }
}
