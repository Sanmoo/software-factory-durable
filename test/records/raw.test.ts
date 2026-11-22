import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';

const context = {
  workId: 'raw-work',
  executionId: 'execution',
  invocationId: 'invocation',
  role: 'builder' as const,
  environmentRef: 'environment',
  bootRef: 'boot',
  callId: 'call',
};
const unavailable = /PROTECTED_CAPTURE_UNAVAILABLE/;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'records-raw-'));
  return { root, records: await createRecords({ root }), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('raw byte capture preserves NUL, invalid UTF8, image-like bytes and exact EOF through pages', async () => {
  const f = await fixture();
  try {
    const data = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 192]), Buffer.alloc(65536, 254)]);
    const out = await f.records.openOutput(context, { format: 'raw', maxBytes: data.length });
    assert.equal(await out.write(data.subarray(0, 65536)), undefined);
    await out.write(data.subarray(65536));
    assert.deepEqual(await out.finish(), { version: 2, format: 'raw', reference: out.reference, bytes: data.length });
    const pages: Buffer[] = [];
    for (let offset = 0; offset < data.length;) {
      const page = await f.records.read({ format: 'raw', reference: out.reference, offset, limit: 24576 });
      assert.equal(page.format, 'raw');
      assert.equal(page.version, 2);
      assert.equal(page.state, 'complete');
      pages.push(page.data);
      offset = page.nextOffset;
    }
    assert.deepEqual(Buffer.concat(pages), data);
    const reopened = await createRecords({ root: f.root });
    assert.deepEqual((await reopened.read({ format: 'raw', reference: out.reference, offset: 0, limit: 100 })).data, data.subarray(0, 100));
    const metadata = JSON.parse(await readFile(join(f.root, context.workId, 'evidence', out.reference.id, 'complete.json'), 'utf8'));
    assert.equal(metadata.version, 2);
    assert.equal(metadata.format, 'raw');
    const request = { format: 'raw' as const, reference: out.reference, offset: data.length, limit: 1 };
    const eof = await f.records.read(request);
    const version: 2 = eof.version;
    assert.equal(version, 2);
    assert.equal(eof.data.length, 0);
    assert.equal(eof.nextOffset, data.length);
    await assert.rejects(f.records.read({ reference: out.reference, offset: 0, limit: 1 }), unavailable);
  } finally {
    await f.cleanup();
  }
});

test('raw matches every nonASCII secret cut and overlap before disk or base64', async () => {
  const f = await fixture();
  try {
    for (const secret of ['🔒é密', 'ababa', 'baba']) f.records.registerSecret(secret);
    for (const secret of ['🔒é密', 'ababa']) {
      const bytes = Buffer.from(secret);
      for (let cut = 0; cut <= bytes.length; cut++) {
        const out = await f.records.openOutput(context, { format: 'raw', maxBytes: 100 });
        const first = out.write(Buffer.concat([Buffer.from([0, 255]), bytes.subarray(0, cut)]));
        if (cut === bytes.length) await assert.rejects(first, unavailable);
        else {
          await first;
          await assert.rejects(out.write(bytes.subarray(cut)), unavailable);
        }
        await assert.rejects(out.finish(), unavailable);
        const directory = join(f.root, context.workId, 'evidence', out.reference.id);
        const disk = await readFile(join(directory, 'output'));
        assert.equal(disk.includes(bytes), false);
        assert.equal((await readdir(directory)).includes('complete.json'), false);
        for (const name of await readdir(directory)) {
          assert.equal((await readFile(join(directory, name))).includes(bytes), false, `no literal in ${name}`);
        }
        const page = await f.records.read({ format: 'raw', reference: out.reference, offset: 0, limit: 100 });
        assert.equal(page.state, 'partial');
        assert.equal(page.data.length, 0);
      }
    }
    // Only literal UTF-8 values are matched, not their base64 representations.
    const encoded = Buffer.from(Buffer.from('🔒é密').toString('base64'));
    const out = await f.records.openOutput(context, { format: 'raw', maxBytes: encoded.length });
    await out.write(encoded);
    await out.finish();
    assert.deepEqual((await f.records.read({ format: 'raw', reference: out.reference, offset: 0, limit: 100 })).data, encoded);
  } finally {
    await f.cleanup();
  }
});

for (const maxBytes of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
  test(`raw rejects invalid required caller maxBytes ${maxBytes}`, async () => {
    const f = await fixture();
    try {
      // Exercise the runtime boundary with an intentionally malformed call.
      // @ts-expect-error malformed untrusted raw options
      await assert.rejects(f.records.openOutput(context, { format: 'raw', maxBytes }), unavailable);
      assert.deepEqual(await readdir(f.root), []);
    } finally {
      await f.cleanup();
    }
  });
}

for (const length of [9, 10, 11])
  test(`raw caller budget 10 with ${length} bytes`, async () => {
    const f = await fixture();
    try {
      const out = await f.records.openOutput(context, { format: 'raw', maxBytes: 10 });
      if (length > 10) {
        await assert.rejects(out.write(Buffer.alloc(length)), unavailable);
        await assert.rejects(out.finish(), unavailable);
      } else {
        await out.write(Buffer.alloc(length));
        assert.equal((await out.finish()).bytes, length);
      }
    } finally {
      await f.cleanup();
    }
  });

test('raw rotation invalidates active captures synchronously, duplicate registration does not', async () => {
  const f = await fixture();
  try {
    f.records.registerSecret('old-secret');
    const a = await f.records.openOutput(context, { format: 'raw', maxBytes: Number.MAX_SAFE_INTEGER });
    const b = await f.records.openOutput(context, { format: 'raw', maxBytes: 10 });
    await a.write(Buffer.from('clean'));
    f.records.registerSecret('old-secret');
    await b.write(Buffer.from('safe'));
    f.records.registerSecret('new-secret-longer');
    await assert.rejects(a.write(Buffer.alloc(0)), unavailable);
    await assert.rejects(a.finish(), unavailable);
    await assert.rejects(b.finish(), unavailable);
    const c = await f.records.openOutput(context, { format: 'raw', maxBytes: 100 });
    await assert.rejects(c.write(Buffer.from('new-secret-longer')), unavailable);
  } finally {
    await f.cleanup();
  }
});

test('raw enforces cumulative retained-input budget, chunk bound and safe page offsets', async () => {
  const f = await fixture();
  try {
    f.records.registerSecret('a-long-secret-🔒');
    const out = await f.records.openOutput(context, { format: 'raw', maxBytes: 10 });
    await out.write(Buffer.alloc(9));
    await out.write(Buffer.alloc(1));
    await assert.rejects(out.write(Buffer.alloc(1)), unavailable);
    const directory = join(f.root, context.workId, 'evidence', out.reference.id);
    assert.equal((await readFile(join(directory, 'output'))).length, 0, 'budget includes unflushed tail');
    const oversized = await f.records.openOutput(context, { format: 'raw', maxBytes: 100000 });
    await assert.rejects(oversized.write(Buffer.alloc(65537)), unavailable);
    await assert.rejects(oversized.finish(), unavailable);
    const empty = await f.records.openOutput(context, { format: 'raw', maxBytes: 1 });
    await empty.finish();
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1]) {
      await assert.rejects(f.records.read({ format: 'raw', reference: empty.reference, offset, limit: 1 }), unavailable);
    }
    for (const limit of [0, -1, 0.5, 65537, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(f.records.read({ format: 'raw', reference: empty.reference, offset: 0, limit }), unavailable);
    }
    assert.equal((await f.records.read({ format: 'raw', reference: empty.reference, offset: 0, limit: 1 })).data.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('raw longest encoded secret tail matches single-byte chunks and chunk/page-boundary literals', async () => {
  const f = await fixture();
  try {
    const secret = '密'.repeat(4096); // 12288 bytes: bound is encoded bytes, not UTF16 units.
    f.records.registerSecret(secret);
    const out = await f.records.openOutput(context, { format: 'raw', maxBytes: 20000 });
    const bytes = Buffer.from(secret);
    for (const byte of bytes.subarray(0, -1)) await out.write(Buffer.from([byte]));
    await assert.rejects(out.write(bytes.subarray(-1)), unavailable);
    assert.equal((await readFile(join(f.root, context.workId, 'evidence', out.reference.id, 'output'))).length, 0);
    f.records.registerSecret('literal-🔒');
    for (const boundary of [24576, 65536]) {
      const capture = await f.records.openOutput(context, { format: 'raw', maxBytes: 100000 });
      const source = Buffer.concat([Buffer.alloc(boundary - 3), Buffer.from('literal-🔒')]);
      await capture.write(source.subarray(0, boundary));
      await assert.rejects(capture.write(source.subarray(boundary)), unavailable);
      const disk = await readFile(join(f.root, context.workId, 'evidence', capture.reference.id, 'output'));
      assert.equal(disk.includes(Buffer.from('literal-🔒')), false);
    }
  } finally {
    await f.cleanup();
  }
});
