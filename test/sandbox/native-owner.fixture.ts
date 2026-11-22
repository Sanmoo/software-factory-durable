import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecords } from '../../src/records/index.js';
import { connectReadTools, serveReadTools, type GuestOwner, type ToolContext, type ReadBinding } from '../../src/sandbox/read-tools.js';

/** Sandbox-owned fixture: real owner transport and Records, external VM only substituted. */
export async function nativeOwner(
  context: ToolContext,
  vm: GuestOwner,
  options: Pick<
    ReadBinding,
    'imageSourceMaxBytes' | 'editSourceMaxBytes' | 'copyOutput' | 'profileOrigin' | 'selectedOutputCopies' | 'skillPackFiles' | 'environmentEnded'
  > = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'nr-'));
  const recordsRoot = join(root, 'records');
  await mkdir(recordsRoot, { mode: 0o700 });
  const records = await createRecords({ root: recordsRoot });
  records.registerSecret('synthetic-secret');
  const authority = new AbortController();
  const owner = await serveReadTools({ endpoint: join(root, 'read.sock'), context, signal: authority.signal, records, vm, ...options });
  return {
    root,
    authority,
    records,
    owner,
    connect: () => connectReadTools(owner.endpoint, context),
    async close() {
      await owner.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
