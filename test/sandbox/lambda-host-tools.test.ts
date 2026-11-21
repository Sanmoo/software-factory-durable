import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostToolProbe } from '../../src/sandbox/lambda/host-tools.js';

// The probe behind `lambda-ssh` and `lambda-websocat`, against stand-in files in a private PATH. The host's real tools are never run.
test('a host tool is available when it can be run from the PATH of the process, whatever it exits with; absent or not executable is unavailable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-lambda-host-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const invoked = join(directory, 'invoked');
  await writeFile(join(directory, 'ssh'), `#!/bin/sh\nprintf '%s' "$*" > '${invoked}'\nexit 1\n`);
  await chmod(join(directory, 'ssh'), 0o700);
  const probe = createHostToolProbe({ environment: { PATH: directory } });
  assert.equal(await probe('ssh'), true);
  assert.equal(await probe('websocat'), false, 'absent from the PATH');
  await writeFile(join(directory, 'websocat'), '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  assert.equal(await probe('websocat'), false, 'present but not executable');
  await chmod(join(directory, 'websocat'), 0o700);
  assert.equal(await probe('websocat'), true);
  assert.equal(await createHostToolProbe({ environment: { PATH: join(directory, 'empty') } })('ssh'), false);
});
