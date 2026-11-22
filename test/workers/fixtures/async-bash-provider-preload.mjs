// Offline HTTP double and host-spawn sentinel are shared with the existing fixture.
import '../../../dist/test/workers/fixtures/bash-provider-preload.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const original = fs.createWriteStream;
let entry;
fs.createWriteStream = (path, options) => {
  assert.ok(path.startsWith(process.env.TMPDIR + '/'));
  assert.equal(options.flags, 'wx');
  assert.equal(options.mode, 0o600);
  const stream = original(path, { ...options, highWaterMark: 16384 });
  assert.equal(entry, undefined, 'one owned native spill only');
  entry = { stream, writes: 0, maxPending: 0, held: false };
  stream.cork();
  const write = stream.write;
  stream.write = function (chunk, ...rest) {
    const accepted = write.call(this, chunk, ...rest);
    entry.writes++;
    entry.maxPending = Math.max(entry.maxPending, this.writableLength);
    assert.ok(this.writableLength <= 16384 + 24576);
    if (!accepted && !entry.held) {
      entry.held = true;
      process.send?.({ kind: 'test-native-held', writes: entry.writes, pending: stream.writableLength });
    }
    return accepted;
  };
  return stream;
};
syncBuiltinESMExports();
const control = message => {
  if (message?.kind === 'test-native-snapshot')
    process.send?.({ kind: 'test-native-snapshot', writes: entry.writes, pending: entry.stream.writableLength, bytesWritten: entry.stream.bytesWritten });
  if (message?.kind === 'test-native-release') entry.stream.uncork();
  if (message?.kind === 'test-native-fail') entry.stream.destroy(new Error('FIXED_STREAM_FAILURE'));
};
process.on('message', control);
try {
  // Same fixed entrypoint, executed once; native stream interception is test-only.
  await import('../../../dist/src/entrypoints/worker.js');
} finally {
  process.off('message', control);
  fs.createWriteStream = original;
  syncBuiltinESMExports();
  entry?.stream.destroy();
}
