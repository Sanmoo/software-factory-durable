import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';

const context = { workId: 'bom-work', executionId: 'bom-exec', invocationId: 'bom-invocation',
  role: 'standards' as const, environmentRef: 'bom-env', bootRef: 'bom-boot', callId: 'bom-read' };

test('file BOM opt-in uses same fatal UTF8 filter and version-1 metadata; default still consumes BOM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'records-bom-'));
  try {
    const records = await createRecords({ root });
    const secret = '🔒ação'; records.registerSecret(secret);
    const input = Buffer.from('\uFEFFfirst\r\n' + secret + '\r\n界🙂');
    for (const preserve of [false, true]) for (let split = 0; split <= input.length; split++) {
      const output = preserve ? await records.openOutput(context, { format: 'text', preserveBOM: true }) : await records.openOutput(context);
      let visible = await output.write(input.subarray(0, split));
      visible += await output.write(input.subarray(split));
      const completion = await output.finish(); visible += completion.tail;
      const expected = (preserve ? '\uFEFF' : '') + 'first\r\n█\r\n界🙂';
      assert.equal(visible, expected); assert.equal(completion.bytes, Buffer.byteLength(expected));
      const directory = join(root, context.workId, 'evidence', completion.reference.id);
      assert.equal(await readFile(join(directory, 'output'), 'utf8'), expected);
      const metadata = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'));
      assert.equal(metadata.version, 1);
      assert.deepEqual(Object.keys(metadata).sort(), ['context', 'reference', 'startedAt', 'version']);
      assert.equal((await records.read({ reference: completion.reference, offset: 0, limit: 65536 })).data.toString(), expected);
    }
    const invalid = await records.openOutput(context, { format: 'text', preserveBOM: true });
    await assert.rejects(invalid.write(Buffer.from([0xff])), /PROTECTED_CAPTURE_UNAVAILABLE/);
    await assert.rejects(invalid.finish(), /PROTECTED_CAPTURE_UNAVAILABLE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
