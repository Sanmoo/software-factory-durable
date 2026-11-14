import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { workerBootstrapSchema, workerLaunchSchema } from '../../src/platform/host/index.js';
import { sdkProfile } from '../../src/workers/sdk-profile.js';

// Static guard of the ticket 19 decision (spec §4.4): the worker has NO implicit clock cut. Only an explicit Host `deadlineMs`
// policy may bound an OAuth activation; the model budget (`modelBudget`/`budgetFor`) still governs requests/tools/bytes, never time.

const timeouts = (source: string) => [...source.matchAll(/AbortSignal\.timeout\(([^)]*)\)/g)].map(match => match[1]!.trim());

test('worker-process applies its only activation clock from bootstrap.deadlineMs, never from a model budget', async () => {
  const source = await readFile('src/workers/worker-process.ts', 'utf8');
  assert.deepEqual(timeouts(source), ['bootstrap.deadlineMs'], 'exactly one time-based abort, fed by the explicit Host policy');
  assert.doesNotMatch(source, /budgetFor\([^)]*\)\.deadlineMs/, 'no budget-derived deadline');
  assert.doesNotMatch(source.replaceAll('bootstrap.deadlineMs', ''), /\.deadlineMs/, 'no other deadline source');
  assert.match(source, /!\(\x27apiKey\x27 in bootstrap\.profile\) && bootstrap\.deadlineMs !== undefined/,
    'absent deadline means no cut; the explicit value is the OAuth worker boundary');
  // The explicit value reaches the Invocation (durable start evidence and the session), not only this local signal.
  assert.match(source, /bootstrap\.deadlineMs === undefined \? \{\} : \{ deadlineMs: bootstrap\.deadlineMs \}/);
});

test('worker-session never turns the model-budget envelope into an activation clock', async () => {
  const source = await readFile('src/workers/worker-session.ts', 'utf8');
  assert.doesNotMatch(source, /AbortSignal\.timeout\(limits\.deadlineMs\)/, 'the old implicit cut is gone');
  assert.doesNotMatch(source, /budgetFor\([^)]*\)\.deadlineMs/, 'the model budget is not read for a clock');
  assert.deepEqual(timeouts(source), ['invocation.deadlineMs'], 'only an explicit Host value can bound the session');
});

const context = { workId: 'work-19', executionId: 'execution-19', invocationId: 'builder-19', role: 'builder' as const,
  environmentRef: 'environment-19', bootRef: 'boot-19', phaseId: 'builder-initial' };
const profile = { id: sdkProfile.id, directory: '/private/profile', systemPrompt: 'Factory worker.',
  auth: 'factory-oauth' as const, providerId: 'openai' as const, modelId: 'gpt-6-luna' as const, api: 'openai-responses' as const };
const bootstrap = { version: 1 as const, context, endpoint: '/private/owner.sock', recordsRoot: '/private/records', knownSecrets: [],
  prompt: '/implement https://github.com/acme/project/issues/1', profile };

test('the bootstrap/launch schemas accept deadlineMs only as an explicit bounded positive integer; absent means no cut', () => {
  const launch = { context, knownSecrets: [], prompt: bootstrap.prompt,
    profile: { id: profile.id, systemPrompt: profile.systemPrompt, auth: profile.auth, providerId: profile.providerId, modelId: profile.modelId, api: profile.api } };
  assert.equal(workerBootstrapSchema.safeParse(bootstrap).success, true, 'deadlineMs is optional');
  assert.equal(workerBootstrapSchema.safeParse(bootstrap).data?.deadlineMs, undefined, 'absent is not defaulted to a cut');
  assert.equal(workerLaunchSchema.safeParse(launch).success, true, 'the Host launch plan also leaves it absent by default');
  for (const value of [1, 86_400_000]) {
    assert.equal(workerBootstrapSchema.safeParse({ ...bootstrap, deadlineMs: value }).success, true, `bootstrap accepts ${String(value)}`);
    assert.equal(workerLaunchSchema.safeParse({ ...launch, deadlineMs: value }).success, true, `launch accepts ${String(value)}`);
  }
  for (const value of [0, -1, 1.5, 86_400_001, '1000', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(workerBootstrapSchema.safeParse({ ...bootstrap, deadlineMs: value }).success, false, `bootstrap rejects ${String(value)}`);
    assert.equal(workerLaunchSchema.safeParse({ ...launch, deadlineMs: value }).success, false, `launch rejects ${String(value)}`);
  }
});
