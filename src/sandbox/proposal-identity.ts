import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProposalIdentity } from '../contracts/index.js';
import { observeConfined, readConfinedAt } from './confined.js';

const entrySchema = z.looseObject({
  path: z.string().min(1).max(4096),
  present: z.boolean(),
  kind: z.enum(['file', 'symlink', 'other']).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
const indexSchema = z.looseObject({
  round: z.number().int().min(1).max(99),
  head: z.string().regex(/^[0-9a-f]{40}$/),
  branch: z.string().max(512).nullable(),
  counts: z.looseObject({ entries: z.number().int().nonnegative() }),
  entries: z.array(entrySchema).max(5000),
});

/**
 * Host-side identity of a handed-off proposal (spec §6.4: light identity by hashes/presence/removal/metadata), WITHOUT host git or
 * following guest links: the round index is read with a confined read, every indexed checkout path is hashed in place, plus HEAD, the
 * branch ref, packed-refs and the Git index file. `consistent` compares with the guest-reported hashes. Two observations with equal
 * `sha256` mean no observed change of the indexed proposal; it is not a freeze nor proof against an unindexed new file or a hostile writer.
 */
export async function observeProposal(
  environmentDirectory: string,
  round: number,
  limits = { fileBytes: 256 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024 },
): Promise<ProposalIdentity> {
  try {
    if (!Number.isInteger(round) || round < 1 || round > 99) return { status: 'refused', code: 'PROPOSAL_ROUND_INVALID' };
    const directory = await realpath(environmentDirectory);
    const artifacts = join(directory, 'artifacts');
    const checkout = join(directory, 'workspace', 'checkout');
    const bytes = await readConfinedAt(artifacts, `review/r${round}/index.json`, 16 * 1024 * 1024);
    if (!bytes) return { status: 'unavailable', code: 'PROPOSAL_INDEX_MISSING' };
    const indexSha256 = createHash('sha256').update(bytes).digest('hex');
    const index = indexSchema.parse(JSON.parse(bytes.toString('utf8')));
    // Bounded and well-formed: exactly the counted entries, each path once.
    if (
      index.round !== round ||
      index.counts.entries !== index.entries.length ||
      new Set(index.entries.map(entry => entry.path)).size !== index.entries.length
    ) {
      return { status: 'refused', code: 'PROPOSAL_INDEX_INVALID' };
    }
    let consistent = true;
    let total = 0;
    const files: [string, string, string | null][] = [];
    for (const entry of index.entries) {
      const observed = await observeConfined(checkout, entry.path, limits.fileBytes).catch((error: Error) => {
        if (error.message === 'CONFINED_FILE_TOO_LARGE') throw error;
        return { kind: 'unsafe' as const };
      });
      if ('size' in observed && (total += observed.size) > limits.totalBytes) return { status: 'refused', code: 'PROPOSAL_TOO_LARGE' };
      const sha = 'sha256' in observed ? observed.sha256 : null;
      files.push([entry.path, observed.kind, sha]);
      const expected = entry.present ? (entry.kind ?? 'other') : 'absent';
      // Only the whole-identity pass/fail is exposed: never which guest-supplied hash matched a path.
      if (observed.kind !== expected || (sha !== null && sha !== (entry.sha256 ?? null))) consistent = false;
    }
    const git: Record<string, string | null> = {};
    for (const name of ['HEAD', 'index', 'packed-refs', ...(index.branch ? [`refs/heads/${index.branch}`] : [])]) {
      const observed = await observeConfined(checkout, `.git/${name}`, limits.fileBytes).catch(() => ({ kind: 'unsafe' as const }));
      git[name] = 'sha256' in observed ? `${observed.kind}:${observed.sha256}` : observed.kind;
    }
    const ref = index.branch
      ? ((await readConfinedAt(checkout, `.git/refs/heads/${index.branch}`, 4096).catch(() => null))?.toString('utf8').trim() ??
        (await readConfinedAt(checkout, '.git/packed-refs', 16 * 1024 * 1024).catch(() => null))
          ?.toString('utf8')
          .split('\n')
          .find(line => line.endsWith(` refs/heads/${index.branch}`))
          ?.split(' ')[0])
      : null;
    if (index.branch && ref !== index.head) consistent = false;
    const sha256 = createHash('sha256').update(JSON.stringify({ indexSha256, files, git })).digest('hex');
    return { status: 'observed', sha256, indexSha256, entries: index.entries.length, consistent, observedAt: new Date().toISOString() };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'CONFINED_PATH_UNSAFE') return { status: 'refused', code: 'PROPOSAL_PATH_UNSAFE' };
    if (code === 'CONFINED_FILE_TOO_LARGE') return { status: 'refused', code: 'PROPOSAL_TOO_LARGE' };
    return { status: 'unavailable', code: 'PROPOSAL_IDENTITY_UNAVAILABLE' };
  }
}
