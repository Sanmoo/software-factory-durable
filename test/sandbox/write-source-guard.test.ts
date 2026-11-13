import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { nativeOwner } from './native-owner.fixture.js';
import { createSandbox, type ToolContext } from '../../src/sandbox/index.js';

import { parser } from './write-source-guard.fixture.js';
const context: ToolContext = { workId: 'guard-work', executionId: 'guard-exec', invocationId: 'guard-invocation',
  role: 'builder', environmentRef: 'guard-env', bootRef: 'guard-boot', phaseId: 'guard-phase' };

test('guest write SOURCE guards existing FD authority before truncation and ENOENT-only exclusive create', async t => {
  let source = '';
  const f = await nativeOwner(context, { exec(argv) {
    source = argv[4]!;
    return { async *output() {}, result: Promise.resolve({ exitCode: 0 }) };
  } }); t.after(() => f.close());
  const sandbox = createSandbox({ root: f.root, toolEndpoint: f.owner.endpoint });
  assert.equal((await sandbox.executeTool(context, { name: 'write', operation: 'create', path: '/workspace/new', content: '', callId: 'source' })).status, 'success');
  const check = (candidate: string) => spawnSync('/usr/bin/python3', ['-I', '-S', '-c', parser], { input: candidate, encoding: 'utf8', timeout: 5000 });
  const valid = check(source);
  assert.equal(valid.status, 0, valid.stderr); assert.match(valid.stdout, /guest BODY NOT executed/);
  for (const adversarial of [source.replace('os.O_EXCL', 'os.O_TRUNC'), source.replace('parts[1], flags', 'parts[1], os.O_RDONLY'),
    source.replace('authorize(parent)\n            os.mkdir', 'os.mkdir'), source.replace('dir_fd=parent)', 'dir_fd=base)'),
    source.replace('os.O_NONBLOCK | ', ''), source.replace('except FileNotFoundError:\n            authorize(parent)\n            fd', 'except OSError:\n            authorize(parent)\n            fd'),
    source.replace('authorize(fd, regular=True)', 'authorize(fd)'), source.replace('authorize(parent)\n        os.ftruncate', 'os.ftruncate'),
    source.replace('os.ftruncate(fd, 0)', 'pass'), source.replace('target = os.readlink("/proc/self/fd/" + str(fd))', 'target = "/workspace/claimed"')]) {
    assert.notEqual(check(adversarial).status, 0, 'static guard must reject authorization/NO_TRUNC regression');
  }
});
