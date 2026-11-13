import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadTool } from '#factory-pi';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';
import { reviewerRead } from '../../src/workers/read.js';
import { nativeOwner } from '../sandbox/native-owner.fixture.js';

const context: ToolContext = { workId: 'bom-work', executionId: 'bom-exec', invocationId: 'bom-invocation',
  role: 'standards', environmentRef: 'bom-env', bootRef: 'bom-boot', phaseId: 'bom-phase' };

for (const range of [{}, { offset: 1, limit: 2 }, { offset: 2, limit: 1 }, { offset: 1.5, limit: 2 }, { limit: -1 }]) {
  test(`native file-read BOM/CRLF/multibyte byte pages parity ${JSON.stringify(range)}`, async t => {
    // Cross the 24576-byte transport boundary inside a multibyte character;
    // stay below the existing 50000-byte whole-buffer text limit.
    const secret = '🔒segredo-ação';
    const text = '\uFEFFα'.repeat(1) + 'x'.repeat(24570) + '界🙂\r\n' + secret + '\r\nlast\r\n';
    const bytes = Buffer.from(text);
    const f = await nativeOwner(context, { exec() { return {
      async *output() {
        // One-byte chunks fragment BOM, UTF-8, CRLF and every secret byte.
        for (let i = 0; i < bytes.length; i++) yield { stream: 'stdout' as const, data: bytes.subarray(i, i + 1) };
      }, result: Promise.resolve({ exitCode: 0 }),
    }; } }); t.after(() => f.close()); f.records.registerSecret(secret);
    // Only already-filtered text is materialized for upstream's default ops oracle.
    await writeFile(join(f.root, 'source.txt'), text.replace(secret, '█'));
    const expected = await createReadTool(f.root).execute('oracle', { path: 'source.txt', ...range });
    const actual = await reviewerRead(context, createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint }))
      .execute('protected', { path: 'source.txt', ...range });
    assert.deepEqual(actual, expected);
    assert.doesNotMatch(JSON.stringify(actual), /segredo|�/);
    if (!('offset' in range) && !('limit' in range)) assert.ok(actual.content.some(block => block.type === 'text' && block.text.startsWith('\uFEFFα')));
  });
}
