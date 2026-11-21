import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerLaunchSchema, workerBootstrapSchema } from '../../src/platform/host/index.js';

const path = '/artifacts/factory-output-00000000-0000-4000-8000-000000000001.txt';
const launch = {
  context: { workId: 'work', executionId: 'exec', invocationId: 'inv', role: 'spec', environmentRef: 'env', bootRef: 'boot', phaseId: 'phase' },
  knownSecrets: [],
  prompt: 'read',
  profile: {
    id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
    systemPrompt: 'test',
    providerId: 'offline',
    modelId: 'test',
    apiKey: 'private-key',
    provider: {
      api: 'openai-completions',
      baseUrl: 'https://offline.invalid',
      models: [
        {
          id: 'test',
          name: 'test',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 1,
        },
      ],
    },
  },
};
test('Host reviewer copy selection is strict bounded canonical data with an independent deep snapshot', () => {
  const selectedOutputCopies = [path];
  const parsed = workerLaunchSchema.parse({ ...launch, selectedOutputCopies });
  assert.deepEqual(Reflect.get(parsed, 'selectedOutputCopies'), [path]);
  selectedOutputCopies.length = 0;
  assert.deepEqual(Reflect.get(parsed, 'selectedOutputCopies'), [path]);
  assert.equal(workerLaunchSchema.safeParse({ ...launch, selectedOutputCopies: Array(32).fill(path) }).success, true);
  for (const invalid of [
    null,
    true,
    path,
    [path + '/'],
    [path + '\n'],
    [path + '\r\n'],
    [path.toUpperCase()],
    ['/workspace/' + path.slice(11)],
    [path.replace('-4000-', '-1000-')],
    [path.replace('-8000-', '-7000-')],
    [path.replace('/factory', '/a/../factory')],
    Array(33).fill(path),
    [{ path }],
  ]) {
    assert.equal(workerLaunchSchema.safeParse({ ...launch, selectedOutputCopies: invalid }).success, false, JSON.stringify(invalid));
  }
  for (const selectedOutputCopies of [[], [path]])
    assert.equal(workerLaunchSchema.safeParse({ ...launch, context: { ...launch.context, role: 'builder' }, selectedOutputCopies }).success, false);
  assert.equal(workerLaunchSchema.safeParse({ ...launch, selectedOutputCopies: [], copyOutput: true }).success, false);
  assert.equal(workerLaunchSchema.safeParse({ ...launch, selectedOutputCopies: [], extra: true }).success, false);
  assert.equal(
    workerBootstrapSchema.safeParse({
      ...launch,
      context: { ...launch.context, role: 'builder' },
      selectedOutputCopies: [],
      version: 1,
      endpoint: '/x',
      recordsRoot: '/r',
      profile: { ...launch.profile, directory: '/p' },
    }).success,
    false,
  );
});
