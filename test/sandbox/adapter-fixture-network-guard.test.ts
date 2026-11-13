import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import dns from 'node:dns';
import cp from 'node:child_process';
import { promisify } from 'node:util';
import { guardFixtureNetwork } from './adapter-fixture-network-guard.js';

test('fixture guard rejects SDK roots/leaves before evaluation and denies TCP/DNS/commands, including promisified commands', async () => {
  const root = await mkdtemp('/tmp/gfg-');
  const restore = guardFixtureNetwork(root, true);
  try {
    for (const specifier of [
      '@earendil-works/gondolin',
      new URL('../../../node_modules/@earendil-works/gondolin/dist/src/index.js', import.meta.url).href,
      new URL('../../../.scratch/factory-development-gondolin-v1/sdk/dist/src/index.js', import.meta.url).href,
      new URL('../../../node_modules/@earendil-works/gondolin/dist/src/vm/core.js', import.meta.url).href,
    ]) {
      // eslint-disable-next-line no-restricted-syntax -- Test-only negative imports; deny hook rejects before resolution/evaluation.
      await assert.rejects(import(specifier), /SDK_EVALUATION_FORBIDDEN/);
    }
    assert.throws(() => net.createConnection({ host: '127.0.0.1', port: 1 }), /external networking forbidden/);
    assert.throws(() => dns.lookup('offline.invalid', () => {}), /EXTERNAL_NETWORK_OR_COMMAND_FORBIDDEN/);
    assert.throws(() => cp.spawn('/unlisted-command', []), /EXTERNAL_NETWORK_OR_COMMAND_FORBIDDEN/);
    await assert.rejects(promisify(cp.execFile)('systemctl', ['--user', 'show', 'unlisted']), /EXTERNAL_NETWORK_OR_COMMAND_FORBIDDEN/);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});
