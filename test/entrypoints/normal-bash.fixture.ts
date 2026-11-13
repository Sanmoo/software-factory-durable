import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createSandbox } from '../../src/sandbox/index.js';
import { createWorkers } from '../../src/workers/index.js';
import { SessionManager } from '#factory-pi';

/** Actual public owner registration, Host launch and new native child. Only the
 * external VM/manager/HTTP boundaries are doubled by the existing preload. */
export async function normalBash(root: string, context: { workId: string; environmentRef: string; bootRef: string }) {
  const workers = createWorkers({ root, knownSecrets: ['synthetic-secret', 'segredo-🔒-ação'], profile: {
    id: 'factory-development-pi-1.5.2-read-operations-v1', systemPrompt: 'UTF-8 Bash Builder fixture.',
    providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key',
    provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [
      { id: 'reader', name: 'Reader', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 },
    ] },
  } });
  const invocation = { context: { ...context, executionId: 'execution-05', invocationId: 'builder-05', role: 'builder' as const, phaseId: 'build-1' },
    prompt: 'Run Bash output.', signal: new AbortController().signal };
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
    const reopened = SessionManager.open(join(sessions, session));
    const tools = reopened.buildSessionContext().messages.filter(message => message.role === 'toolResult');
    assert.match(JSON.stringify(tools), /tail π/); assert.match(JSON.stringify(tools), /Full output:/);
    const spills = (await readdir(join(runtime, launch, 't'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
    assert.equal(spills.length, 1);
    assert.equal((await stat(join(spills[0]!.parentPath, spills[0]!.name))).mode & 0o777, 0o600);
    assert.ok((await stat(join(spills[0]!.parentPath, spills[0]!.name))).size > 1024 * 1024);
    await assert.rejects(workers.activate(invocation), /STALE_TOOL_CONTEXT/);
    const sandbox = createSandbox({ root });
    const bash = { name: 'bash' as const, command: 'must not run', callId: 'role-deny' };
    for (const role of ['standards', 'spec'] as const) {
      const reviewer = { ...invocation.context, role, invocationId: `${role}-05` };
      assert.deepEqual(await sandbox.executeTool(reviewer, bash), { status: 'failure', code: 'BASH_ROLE_DENIED' });
      assert.deepEqual(await sandbox.executeTool({ ...reviewer, role: 'builder' }, bash), { status: 'failure', code: 'STALE_TOOL_CONTEXT' });
    }
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const bytes = await readFile(join(entry.parentPath, entry.name));
      for (const value of ['synthetic-secret', 'synthetic-key', 'segredo-🔒-ação']) assert.equal(bytes.includes(Buffer.from(value)), false, entry.name);
    }
    return { receipt: started.receipt, pid: receipt.observedProcess.pid };
  } finally { worker.close(); }
}
