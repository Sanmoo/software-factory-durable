import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { listen, protocolVersion } from '../../src/protocol/index.js';
import { connectReadTools, type ToolContext } from '../../src/sandbox/read-tools.js';

const context: ToolContext = {
  workId: 'work',
  executionId: 'exec',
  invocationId: 'invocation',
  role: 'builder',
  environmentRef: 'env',
  bootRef: 'boot',
  phaseId: 'phase',
};

// Deliberately adversarial peer, NOT an alternate execution/capture implementation.
for (const mode of [
  'sequence',
  'byte-count',
  'noncanonical',
  'empty',
  'oversized',
  'context',
  'reply',
  'message-id',
  'completion',
  'completion-reference',
  'completion-data',
  'completion-offset',
] as const) {
  test(`correlated Bash progress rejects ${mode} and permanently closes before dependent calls`, async t => {
    const root = await mkdtemp('/tmp/bp-');
    t.after(() => rm(root, { recursive: true, force: true }));
    const endpoint = join(root, 'tool.sock');
    const server = await listen(
      endpoint,
      {
        async message(request, channel) {
          let data = Buffer.from('f').toString('base64');
          if (mode === 'noncanonical') data = 'Zh==';
          if (mode === 'empty') data = '';
          if (mode === 'oversized') data = Buffer.alloc(24577).toString('base64');
          await channel.send({
            protocol_version: protocolVersion,
            controller_run_id: null,
            message_id: mode === 'message-id' ? 'wrong' : request.message_id,
            reply_to: mode === 'reply' ? 'wrong' : request.message_id,
            kind: 'tool-progress',
            payload: {
              context: mode === 'context' ? { ...context, phaseId: 'stale' } : context,
              sequence: mode === 'sequence' ? 1 : 0,
              bytes: mode === 'byte-count' ? 2 : 1,
              data,
            },
          });
          if (mode.startsWith('completion'))
            await channel.send({
              protocol_version: protocolVersion,
              controller_run_id: null,
              message_id: request.message_id,
              reply_to: request.message_id,
              kind: 'tool-result',
              payload: {
                status: 'success',
                format: 'text',
                reference: { workId: mode === 'completion-reference' ? 'other-work' : context.workId, id: '77777777-2222-4333-8444-555555555555' },
                encoding: 'base64',
                data: mode === 'completion-data' ? 'Zg==' : '',
                bytes: 1,
                nextOffset: mode === 'completion-offset' ? 1 : 0,
                exitCode: 0,
                progressFrames: mode === 'completion' ? 2 : 1,
              },
            });
        },
      },
      { kind: 'worker-tool', binding: context },
    );
    t.after(() => server.close());
    const client = await connectReadTools(endpoint, context);
    t.after(() => client.close());
    let delivered = '';
    const result = await client.executeTool({ name: 'bash', command: 'data', callId: 'call' }, data => {
      delivered += data.toString();
    });
    assert.deepEqual(result, { status: 'failure', code: 'TOOL_CHANNEL_CLOSED' });
    assert.equal(delivered, mode.startsWith('completion') ? 'f' : '');
    assert.deepEqual(await client.executeTool({ name: 'bash', command: 'never retry', callId: 'next' }, () => assert.fail()), {
      status: 'failure',
      code: 'TOOL_CHANNEL_CLOSED',
    });
  });
}
