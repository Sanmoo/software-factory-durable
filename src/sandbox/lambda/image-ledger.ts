import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const instant = z.string().min(1);
const buildEntrySchema = z.strictObject({ version: z.literal(1), at: instant, event: z.enum(['requested', 'created', 'failed']),
  key: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1), workId: z.string().min(1) });
export type LambdaImageBuildEntry = z.infer<typeof buildEntrySchema>;
const ledgerPath = async (root: string) => join(await realpath(root), 'lambda', 'image-builds.jsonl');

/** Every recorded fact, oldest first; `null` when this installation never recorded a build. An unreadable line throws. */
export async function readLambdaImageBuilds(root: string): Promise<LambdaImageBuildEntry[] | null> {
  let text: string;
  try { text = await readFile(await ledgerPath(root), 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  return text.split('\n').filter(Boolean).map(line => buildEntrySchema.parse(JSON.parse(line)));
}

/**
 * The installation's ledger of image builds, one JSON line per fact (`<root>/lambda/image-builds.jsonl`): a build requested by a Prepare,
 * and how the service settled it, seen by whichever Prepare read the image next. `settle` writes nothing when the key's last build is
 * already settled, so repeated Prepares of a reused image add nothing.
 */
export async function recordLambdaImageBuild(root: string, entry: Omit<LambdaImageBuildEntry, 'version'>): Promise<void> {
  if (entry.event !== 'requested') {
    const last = (await readLambdaImageBuilds(root))?.findLast(line => line.key === entry.key);
    if (last?.event !== 'requested') return;
  }
  const path = await ledgerPath(root);
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(buildEntrySchema.parse({ version: 1, ...entry }))}\n`, { mode: 0o600 });
}
