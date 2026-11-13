import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { main } from '../../src/entrypoints/cli.js';

// Command-parser/TTY gate unit test ONLY, not a real CLI/login invocation.
test('login CLI accepts only explicit canonical root and refuses non-TTY before opening anything', async () => {
  const output: string[] = [];
  const error = mock.method(console, 'error', (...args: unknown[]) => { output.push(args.join(' ')); });
  const log = mock.method(console, 'log', (...args: unknown[]) => { output.push(args.join(' ')); });
  let opens = 0;
  const open = mock.method(fs, 'openSync', () => { opens++; throw new Error('CLOSED'); });
  syncBuiltinESMExports();
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  try {
    for (const args of [[], ['--json'], ['--root', '.'], ['--root', '/tmp/../tmp'],
      ['--root', '/tmp', '--json'], ['--root', '/tmp', '--auth-file', 'secret'],
      ['--root', '/tmp', '--root', '/tmp'], ['--provider', 'openai'], ['--root', '/tmp']]) {
      assert.equal(await main(['login', ...args]), 2);
    }
    assert.equal(opens, 0);
    assert.ok(output.every(value => value === '{"code":"INVALID_ARGUMENTS"}'));
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor); else Reflect.deleteProperty(process.stdin, 'isTTY');
    open.mock.restore(); error.mock.restore(); log.mock.restore(); syncBuiltinESMExports();
  }
});
