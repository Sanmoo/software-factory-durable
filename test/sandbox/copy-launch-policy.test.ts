import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { serveOwnerRegistration } from '../../src/sandbox/owner-registration.js';
import { bootRuntimePaths } from '../../src/sandbox/start.js';
import { connectReadTools } from '../../src/sandbox/read-tools.js';
import type { WorkerBootHost, WorkerLaunch } from '../../src/platform/host/index.js';
import { connect, protocolVersion } from '../../src/protocol/index.js';
import type { BootRef } from '../../src/sandbox/lifecycle.js';

const boot = 'boot-66666666-2222-4333-8444-555555555555' as BootRef;
const context = { workId: 'work', executionId: 'exec', invocationId: 'inv', role: 'builder' as const, environmentRef: 'env', bootRef: boot, phaseId: 'phase' };
const profile: WorkerLaunch['profile'] = {
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
};
const qualified = { copyOutput: true, profileOrigin: 'factory-development-gondolin-0.14.0-stdin-capacity-v1' as const };
for (const [capabilities, role] of [
  [undefined, 'builder'],
  [{ copyOutput: true }, 'builder'],
  [{ ...qualified, copyOutput: false }, 'builder'],
  [{ ...qualified, profileOrigin: 'legacy' } as never, 'builder'],
  [qualified, 'standards'],
  [qualified, 'spec'],
] as const)
  test(`owner rejects opted-in ${role} launch before ANY worker/guest effect: ${JSON.stringify(capabilities)}`, async () => {
    const root = await mkdtemp('/tmp/lp-');
    try {
      const runtime = bootRuntimePaths(root, boot).directory;
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      const host = new Proxy({} as WorkerBootHost, {
        get() {
          assert.fail('must reject before Host launch');
        },
      });
      const owner = await serveOwnerRegistration(
        root,
        { workId: context.workId, environmentRef: context.environmentRef, bootRef: boot },
        {
          exec() {
            assert.fail('no guest effect');
          },
        },
        host,
        capabilities,
      );
      const channel = await connect(join(runtime, 'owner'), {
        kind: 'host-boot',
        binding: {
          workId: context.workId,
          environmentRef: context.environmentRef,
          bootRef: boot,
        },
      });
      try {
        await channel.send({
          protocol_version: protocolVersion,
          controller_run_id: null,
          message_id: 'launch',
          reply_to: null,
          kind: 'launch-worker',
          payload: { context: { ...context, role }, profile, prompt: 'no run', knownSecrets: [], copyOutput: true },
        });
        assert.deepEqual((await channel.messages[Symbol.asyncIterator]().next()).value?.payload, { status: 'failure', code: 'WORKER_LAUNCH_INVALID' });
      } finally {
        channel.close();
        await owner.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('boot availability alone does NOT grant copy to context-only direct registration', async () => {
  const root = await mkdtemp('/tmp/lp-');
  try {
    const runtime = bootRuntimePaths(root, boot).directory;
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    let commands = 0;
    const owner = await serveOwnerRegistration(
      root,
      { workId: context.workId, environmentRef: context.environmentRef, bootRef: boot },
      {
        exec() {
          commands++;
          return { async *output() {}, result: Promise.resolve({ exitCode: 0 }) };
        },
      },
      {} as WorkerBootHost,
      qualified,
    );
    const channel = await connect(join(runtime, 'owner'), {
      kind: 'host-boot',
      binding: {
        workId: context.workId,
        environmentRef: context.environmentRef,
        bootRef: boot,
      },
    });
    try {
      await channel.send({
        protocol_version: protocolVersion,
        controller_run_id: null,
        message_id: 'bind',
        reply_to: null,
        kind: 'register-binding',
        payload: { context },
      });
      const response = (await channel.messages[Symbol.asyncIterator]().next()).value?.payload;
      assert.equal(response?.status, 'success');
      assert.equal(typeof response?.endpoint, 'string');
      const tools = await connectReadTools(response!.endpoint as string, context);
      try {
        const result = await tools.executeTool({ name: 'bash', command: 'data', callId: 'capture' }, async () => {});
        assert.equal(result.status, 'success');
        if (result.status !== 'success') throw new Error('capture failed');
        assert.deepEqual(await tools.executeTool({ name: 'bash', operation: 'copy-output', reference: result.reference, callId: 'copy' }), {
          status: 'failure',
          code: 'BASH_COPY_DENIED',
        });
        assert.equal(commands, 1);
      } finally {
        tools.close();
      }
    } finally {
      channel.close();
      await owner.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
