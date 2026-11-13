import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '#factory-pi';
import { createWorkers } from '../../src/workers/index.js';

export async function normalCopyRead(root: string, context: { workId: string; environmentRef: string; bootRef: string }) {
  const workers = createWorkers({ root, knownSecrets: ['synthetic-secret', 'segredo-🔒-ação'], profile: {
    id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3', systemPrompt: 'Private copy Read fixture.', providerId: 'offline-fixture', modelId: 'reader', apiKey: 'synthetic-key',
    provider: { api: 'openai-completions', baseUrl: 'https://offline.invalid', models: [{ id: 'reader', name: 'Reader', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] },
  } });
  // Public facade validation precedes endpoint discovery/spawn/guest source.
  const invalidContext = { ...context, executionId: 'exec', invocationId: 'invalid', role: 'spec' as const, phaseId: 'phase' };
  for (const selectedOutputCopies of [null, true, ['/workspace/not-a-copy'], Array(33).fill('/artifacts/factory-output-00000000-0000-4000-8000-000000000001.txt')]) {
    await assert.rejects(workers.activate({ context: invalidContext, prompt: 'invalid', signal: new AbortController().signal, selectedOutputCopies } as never), /WORKER_LAUNCH_INVALID/);
  }
  await assert.rejects(workers.activate({ context: { ...invalidContext, role: 'builder' }, prompt: 'invalid', signal: new AbortController().signal, selectedOutputCopies: [] }), /WORKER_LAUNCH_INVALID/);
  const runtime = join(root, 'r', Buffer.from(context.bootRef.slice(5).replaceAll('-', ''), 'hex').toString('base64url'));
  let path = '';
  const previous = new Set<string>();
  for (const mode of ['publish', 'builder', 'absent', 'empty', 'selected'] as const) {
    const selectedOutputCopies = mode === 'selected' ? [path] : [];
    const invocation = { context: { ...context, executionId: 'exec', invocationId: mode, role: mode === 'publish' || mode === 'builder' ? 'builder' as const : 'spec' as const, phaseId: 'phase-' + mode },
      prompt: `Task149 ${mode} ${path}`, signal: new AbortController().signal,
      ...(mode === 'publish' || mode === 'builder' ? { copyOutput: true } : mode === 'absent' ? {} : { selectedOutputCopies }) };
    const activating = workers.activate(invocation);
    // Both directions after activate's first await: the caller never owns the snapshot.
    if (mode === 'selected') selectedOutputCopies.length = 0;
    if (mode === 'empty') selectedOutputCopies.push(path);
    const worker = await activating;
    try {
      const started = await worker.started; const completed = await worker.completed;
      assert.equal(completed.status, 'success');
      const receipt = JSON.parse(await readFile(join(root, context.workId, 'evidence', started.receipt.id, 'output'), 'utf8')).event;
      assert.notEqual(receipt.observedProcess.pid, process.pid);
      const launch = (await readdir(runtime)).find(name => name.startsWith('w-') && !previous.has(name))!; previous.add(launch);
      const sessions = join(runtime, launch, 'profile', 'sessions');
      const file = (await readdir(sessions, { recursive: true })).find(name => name.endsWith('.jsonl'))!;
      const full = join(sessions, file); const transcript = await readFile(full, 'utf8');
      assert.doesNotMatch(transcript, /synthetic-secret|synthetic-key|segredo-🔒-ação/);
      // Reopen is evidence/context ONLY; the next Builder starts with no grants.
      const results = SessionManager.open(full).buildSessionContext().messages.filter(m => m.role === 'toolResult');
      const reads = results.filter(m => m.toolName === 'read');
      assert.equal(reads.length, mode === 'publish' ? 2 : 1);
      if (mode === 'publish') {
        const bash = results.find(m => m.toolName === 'bash')!;
        path = (bash.details as { fullOutputPath: string }).fullOutputPath;
        assert.match(path, /^\/artifacts\/factory-output-[0-9a-f-]{36}\.txt$/);
        assert.equal(reads[0]!.isError, false); assert.match(JSON.stringify(reads[0]), /head π █ █ █/);
      }
      const last = reads.at(-1)!;
      assert.equal(last.isError, !['publish', 'selected'].includes(mode));
      assert.match(JSON.stringify(last), ['publish', 'selected'].includes(mode) ? /tail π/ : /READ_PATH_DENIED/);
    } finally { worker.close(); }
  }
  return { path, workers: previous.size };
}
