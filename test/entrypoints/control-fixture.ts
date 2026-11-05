// Integration fixture: the real public Control seam, launched under the same no-fork flock as production.
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { openControl } from '../../src/control/index.js';
import { verifyControllerLock } from '../../src/platform/host/index.js';

process.umask(0o077);
const root = process.argv[2]!;
await verifyControllerLock(`${root}/data/control.lock`);
if (process.argv[3] === 'lock-probe') {
  const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.send?.({ childPid: survivor.pid });
} else {
  const control = await openControl({ storagePath: `${root}/data/control.sqlite`, runtimeInventory: 'empty' });
  const initial = await control.inspect({ kind: 'status' });
  const stop = new AbortController();
  const running = control.run(stop.signal);
  const input = z.strictObject({ request_id: z.string(), operation: z.enum(['pause', 'unpause']), origin: z.literal('local-cli') });
  process.on('message', message => {
    void (async () => {
      const parsed = input.safeParse(message);
      if (parsed.success) process.send?.({ receipt: await control.accept(parsed.data), status: await control.inspect({ kind: 'status' }) });
      else if (message === 'stop') { stop.abort(); process.send?.(await running); process.disconnect?.(); }
    })().catch(() => { process.exitCode = 1; stop.abort(); process.disconnect?.(); });
  });
  process.send?.({ initial, surface: Object.keys(control) });
}
