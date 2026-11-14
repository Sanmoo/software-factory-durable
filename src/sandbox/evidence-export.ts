import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { copyConfinedTree } from './confined.js';
import type { EnvironmentRef } from './prepare.js';

/** Guest-written evidence that sustains retained records (spec §12.1): review captures and the preserved request/instruction versions. */
const evidenceTrees = ['review', 'spec', 'instructions'] as const;
export type EvidenceExport = { status: 'success'; files: number; bytes: number } | { status: 'absent' } | { status: 'failure'; code: string };

/**
 * Ticket 17: copy the evidence trees of an OWN environment's artifacts into a caller-owned private destination before its removal, with
 * confined no-follow reads (a symlink, special file or hard link fails the whole export; nothing is followed or partially claimed).
 * Factory seeds and the agent's output copies are not evidence (their protected originals live in the records area). `absent`: the
 * artifacts tree no longer exists (nothing left to preserve). Bounded; exceeding the bound is a failure, never a truncated copy.
 */
export async function exportEvidence(root: string, environment: EnvironmentRef, destination: string, budget = { files: 8192, bytes: 1024 * 1024 * 1024 }): Promise<EvidenceExport> {
  if (!/^env-[a-f0-9]{64}$/.test(environment)) return { status: 'failure', code: 'ENVIRONMENT_REF_INVALID' };
  try {
    const directory = join(await realpath(root), 'environments', environment);
    let artifacts: string;
    try { artifacts = await realpath(join(directory, 'artifacts')); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
      throw error;
    }
    const info = await lstat(join(directory, 'artifacts'));
    if (!info.isDirectory() || info.isSymbolicLink() || artifacts !== join(await realpath(directory), 'artifacts')) return { status: 'failure', code: 'EVIDENCE_UNSAFE' };
    const remaining = { ...budget };
    for (const tree of evidenceTrees) await copyConfinedTree(artifacts, tree, join(destination, tree), remaining);
    return { status: 'success', files: budget.files - remaining.files, bytes: budget.bytes - remaining.bytes };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { status: 'failure', code: code === 'CONFINED_TREE_TOO_LARGE' || code === 'CONFINED_FILE_TOO_LARGE' ? 'EVIDENCE_TOO_LARGE'
      : code === 'CONFINED_PATH_UNSAFE' ? 'EVIDENCE_UNSAFE' : 'EVIDENCE_EXPORT_FAILED' };
  }
}
