import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkers } from '../../src/workers/index.js';
import { SessionManager } from '#factory-pi';

/** Several modes may share one boot (ticket 37): each is its own activation (`invocationId`), found by its own receipt. */
export async function normalEdit(
  root: string,
  context: { workId: string; environmentRef: string; bootRef: string },
  mode = process.env.TASK114_EDIT!,
  invocationId = 'edit-worker',
) {
  const workers = createWorkers({
    root,
    knownSecrets: ['synthetic-secret'],
    profile: {
      id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
      systemPrompt: 'Private Edit fixture.',
      providerId: 'offline-fixture',
      modelId: 'reader',
      apiKey: 'synthetic-key',
      provider: {
        api: 'openai-completions',
        baseUrl: 'https://offline.invalid',
        models: [
          {
            id: 'reader',
            name: 'Reader',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100000,
            maxTokens: 1000,
          },
        ],
      },
    },
  });
  const abort = new AbortController();
  const invocation = {
    context: {
      ...context,
      executionId: 'edit-exec',
      invocationId,
      role: (mode === 'standards' || mode === 'spec' ? mode : 'builder') as 'standards' | 'spec' | 'builder',
      phaseId: 'edit-phase',
    },
    prompt: mode,
    signal: abort.signal,
    ...(mode === 'absent' ? {} : { editSourceMaxBytes: mode === 'budget' || mode === 'empty' ? 0 : 8192 }),
  };
  if (mode === 'invalid') {
    for (const value of [-1, 8193, 0.5, NaN, Infinity, '8192', null]) {
      await assert.rejects(workers.activate({ ...invocation, editSourceMaxBytes: value } as never), /WORKER_LAUNCH_INVALID/);
    }
    return { invalid: true };
  }
  const activating = workers.activate(invocation);
  // Public Host must copy/validate before its first await; callers cannot change
  // the trusted policy while endpoint discovery and owner launch are pending.
  invocation.editSourceMaxBytes = mode === 'budget' ? 8192 : 0;
  const worker = await activating;
  try {
    const started = await worker.started;
    const completed = await worker.completed;
    // Ticket 46: `budget`/`secret` (capture refused before effect) are ordinary tool errors; the session continues and completes.
    const interrupted = ['uncertain', 'persist', 'cancel', 'eof'].includes(mode);
    assert.equal(completed.status, interrupted ? 'failure' : 'success');
    if (completed.status === 'failure') assert.equal(completed.code, mode === 'eof' ? 'WORKER_EXECUTION_UNCERTAIN' : 'WORKER_INTERRUPTED');
    const receipt = JSON.parse(await readFile(join(root, context.workId, 'evidence', started.receipt.id, 'output'), 'utf8')).event;
    assert.notEqual(receipt.observedProcess.pid, process.pid);
    // This activation's own worker directory (its receipt names it), not the first w-* of the boot.
    const sessions = join(receipt.profileDirectory, 'sessions');
    const file = (await readdir(sessions, { recursive: true })).find(name => name.endsWith('.jsonl'))!;
    const transcript = await readFile(join(sessions, file), 'utf8');
    assert.doesNotMatch(transcript, /synthetic-secret|synthetic-key/);
    const messages = SessionManager.open(join(sessions, file)).buildSessionContext().messages;
    if (mode === 'cancel' || mode === 'eof') {
      assert.doesNotMatch(transcript, /Successfully replaced|Successfully wrote/);
      return { pid: receipt.observedProcess.pid, status: completed.status };
    }
    if (!['absent', 'standards', 'spec'].includes(mode)) {
      assert.ok(messages.some(m => m.role === 'toolResult'));
      if (mode === 'empty') assert.match(transcript, /Could not find|empty/i);
      const refused = mode === 'secret' || mode === 'budget';
      if (refused) {
        assert.match(transcript, /EDIT_SOURCE_NOT_LOSSLESS/);
        assert.doesNotMatch(transcript, /Successfully replaced/);
      }
      if (!interrupted && mode !== 'empty' && !refused) {
        assert.match(transcript, /Successfully replaced/);
        assert.match(transcript, /diff/);
        assert.match(transcript, /█/);
      }
    }
    return { pid: receipt.observedProcess.pid, status: completed.status };
  } finally {
    worker.close();
  }
}
