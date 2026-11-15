import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkers } from '../../src/workers/index.js';

/** Worker startup up to its first provider request is ~1-3 s under an 8-way loaded ci lane; 30 s was idle waiting. */
export const oauthDeadlineMs = 8_000;

export async function normalOAuth(root: string, identity: { workId: string; environmentRef: string; bootRef: string }) {
  const profile = { id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3' as const, systemPrompt: 'Read only the synthetic source.',
    auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
  const mode = JSON.parse(await readFile(join(root, 'oauth-mode'), 'utf8')) as string;
  const workers = createWorkers({ root, knownSecrets: [], profile });
  const context = { ...identity, executionId: 'execution', invocationId: 'oauth-review', role: 'standards' as const, phaseId: 'review' };
  // All override/wrong model forms must fail before owner discovery or spawn.
  for (const override of [{ modelId: 'other' }, { providerId: 'other' }, { api: 'openai-completions' },
    { apiKey: 'forbidden' }, { provider: {} }, { baseUrl: 'https://invalid.example' }, { authFile: '/forbidden' },
    { env: {} }, { fallback: true }]) {
    await assert.rejects(createWorkers({ root, knownSecrets: [], profile: { ...profile, ...override } as typeof profile })
      .activate({ context, prompt: 'Read.', signal: new AbortController().signal }), /WORKER_LAUNCH_INVALID/);
  }
  // Ticket 19: no implicit clock cut. The Host deadline is an explicit policy; only the `deadline` mode sets one. Ticket 37: what it
  // proves is that the explicit value cuts a held provider request, not its length; it only has to outlast the worker's startup up
  // to that first request (the preload holds it until the abort).
  // Ticket 37: `held-ack` proves the fail-closed path of an ACK the owner never sends; the Host policy shortens the 5000 ms wait
  // (whose default is proven in secret-ipc.test.ts) instead of really waiting it.
  const handle = await workers.activate({ context, prompt: mode === 'prompt-bytes' ? 'π'.repeat(2100) : mode === 'prompt-secret' ? 'Read oauth-access-canary.' : 'Read source.txt then report.',
    signal: new AbortController().signal, ...(mode === 'deadline' ? { deadlineMs: oauthDeadlineMs } : {}), ...(mode === 'held-ack' ? { secretAckTimeoutMs: 50 } : {}) });
  try {
    if (mode === 'start-failure') {
      await assert.rejects(handle.started);
      await assert.rejects(handle.completed);
      const counts = JSON.parse(await readFile(join(root, 'oauth-counts'), 'utf8'));
      assert.deepEqual(counts, { auth: 0, http: 0, model: 0, token: 0 });
      return { pid: null, counts, mode };
    }
    const started = await handle.started;
    const completed = await handle.completed;
    if (mode === 'success') assert.deepEqual(completed, { status: 'success', receipt: started.receipt });
    else assert.equal(completed.status, 'failure');
    const counts = JSON.parse(await readFile(join(root, 'oauth-counts'), 'utf8'));
    const models = mode === 'success' || mode === 'third-request' ? 2 : ['held-ack', 'rotation-ack-fail', 'prompt-bytes', 'prompt-secret', 'missing-store'].includes(mode) ? 0 : 1;
    assert.deepEqual(counts, { auth: mode === 'rotation-ack-fail' ? 1 : models, http: mode === 'rotation-ack-fail' ? 1 : models, model: models, token: mode === 'rotation-ack-fail' ? 1 : 0, ...(mode === 'third-request' ? { thirdRequestDenied: true } : {}) });
    if (mode === 'rotation-ack-fail') {
      const privateStore = JSON.parse(await readFile(join(root, 'credentials', 'chatgpt.json'), 'utf8'));
      assert.equal(privateStore.openai.access, 'oauth-access-rotated');
      assert.equal(privateStore.openai.refresh, 'oauth-refresh-rotated');
    }
    const events = await Promise.all((await readdir(join(root, identity.workId, 'evidence'))).map(async id => {
      try { return JSON.parse(await readFile(join(root, identity.workId, 'evidence', id, 'output'), 'utf8')); } catch { return null; }
    }));
    const start = events.find(e => e?.event?.kind === 'worker-start').event;
    const directory = join(start.profileDirectory, 'sessions');
    const files = (await readdir(directory)).filter(f => f.endsWith('.jsonl'));
    const text = (await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join('\n');
    if (mode === 'success') {
      assert.match(text, /oauth vertical complete/);
      assert.match(text, /toolResult/);
      assert.match(text, /█ █/);
    }
    if (['http429', 'http500', 'mutable-error', 'provider-bytes'].includes(mode)) assert.match(text, /WORKER_PROVIDER_UNAVAILABLE/);
    assert.doesNotMatch(text, /oauth-access-canary|oauth-refresh-canary|oauth-access-rotated|oauth-refresh-rotated|unknown-http-secret-body|unknown-abort-secret/);
    return { pid: start.observedProcess.pid, receipt: started.receipt, counts, mode };
  } finally { handle.close(); }
}
