import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '#factory-pi';
import { createWorkers } from '../../src/workers/index.js';

/** Normal public Host -> same owner -> fixed new child. External boundaries are
 * guarded doubles; reopening JSONL grants no new guest Read capability. */
export async function normalBashCopy(root: string, context: { workId: string; environmentRef: string; bootRef: string }) {
  const mode = process.env.TASK145_COPY!;
  const workers = createWorkers({ root, knownSecrets: ['synthetic-secret', 'segredo-🔒-ação'], profile: {
    id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3', systemPrompt: 'Task145 private Bash fixture.',
    providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key',
    provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [
      { id: 'reader', name: 'Reader', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 },
    ] },
  } });
  const invocation = { context: { ...context, executionId: 'copy-exec', invocationId: 'copy-worker', role: 'builder' as const, phaseId: 'copy-phase' },
    prompt: `Task145 ${mode}`, signal: new AbortController().signal,
    ...(mode === 'absent' ? {} : { copyOutput: mode !== 'false' }) };
  if (mode === 'invalid') {
    for (const copyOutput of [1, 'true', null, {}, []]) await assert.rejects(workers.activate({ ...invocation, copyOutput } as never), /WORKER_LAUNCH_INVALID/);
    return { invalid: true };
  }
  const activating = workers.activate(invocation);
  invocation.copyOutput = mode === 'false' || mode === 'absent'; // Mutation after first await cannot flip selection.
  const worker = await activating;
  try {
    const started = await worker.started;
    const completed = await worker.completed;
    assert.equal(completed.status, mode === 'fail' ? 'failure' : 'success');
    if (completed.status === 'failure') assert.equal(completed.code, 'WORKER_INTERRUPTED');
    const receipt = JSON.parse(await readFile(join(root, context.workId, 'evidence', started.receipt.id, 'output'), 'utf8')).event;
    assert.notEqual(receipt.observedProcess.pid, process.pid);
    const tag = Buffer.from(context.bootRef.slice(5).replaceAll('-', ''), 'hex').toString('base64url');
    const runtime = join(root, 'r', tag);
    const launch = (await readdir(runtime)).find(name => name.startsWith('w-'))!;
    const sessions = join(runtime, launch, 'profile', 'sessions');
    const file = (await readdir(sessions, { recursive: true })).find(name => name.endsWith('.jsonl'))!;
    const transcript = await readFile(join(sessions, file), 'utf8');
    assert.doesNotMatch(transcript, /synthetic-secret|synthetic-key|segredo-🔒-ação/);
    const tools = SessionManager.open(join(sessions, file)).buildSessionContext().messages.filter(m => m.role === 'toolResult');
    const bash = tools.find(m => m.toolName === 'bash'); assert.ok(bash);
    if (mode === 'ok') {
      assert.equal(bash.isError, false);
      const details = bash.details as { fullOutputPath: string; truncation: { truncated: boolean } };
      assert.equal(details.truncation.truncated, true);
      assert.match(details.fullOutputPath, /^\/artifacts\/factory-output-[0-9a-f-]{36}\.txt$/);
      assert.ok(bash.content.some(c => c.type === 'text' && c.text.endsWith(`Full output: ${details.fullOutputPath}]`)));
    } else if (mode === 'fail') {
      assert.equal(bash.isError, true); assert.doesNotMatch(JSON.stringify(bash), /Full output:|\/artifacts\/factory-output-/);
      assert.ok(!tools.some(m => m.toolName === 'write' && !m.isError));
    } else assert.match(JSON.stringify(bash), /Full output:/);
    return { pid: receipt.observedProcess.pid, status: completed.status };
  } finally { worker.close(); }
}
