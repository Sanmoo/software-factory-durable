import type { AccessDependencies, BranchObservation, OriginObservation } from '../types.js';
import type { OriginComparison } from '../rules/boot-notice.js';
import type { WorkRecord } from './admission.js';

/**
 * v2 ticket 06: Control's own read of `origin` (never the guest's word): the tip of the base and of the Work branch. It names the commit
 * a boot without a persistent disk clones, and it is the measure of progress after a budget end (decision 2a). Shared by the dispatch
 * and by the boot reconciliation, which records a loss from the same read.
 */
export async function readOriginOf(access: Pick<AccessDependencies, 'repositories' | 'repository'>, work: Pick<WorkRecord, 'repository' | 'ticket'>, branch: string,
  /** v2 ticket 08: also compare this commit (the gate-confirmed one) with the branch tip when they differ (ancestry and the new commits). */
  compareFrom?: string): Promise<{ kind: 'observed'; base: string; branch: BranchObservation; comparison: OriginComparison | null } | { kind: 'unavailable'; code: string }> {
  const configured = access.repositories.find(scope => scope.repository.toLowerCase() === work.repository.repository.toLowerCase());
  if (!configured) return { kind: 'unavailable', code: 'REPOSITORY_NOT_CONFIGURED' };
  try {
    const read = await access.repository.findPublication({ repo: configured, issueNumbers: [work.ticket.number], knownBranches: [branch, work.repository.base],
      ...(compareFrom ? { compareFrom } : {}) });
    if (read.kind !== 'observed') return { kind: 'unavailable', code: `ORIGIN_NOT_READ_${read.code}`.slice(0, 64) };
    const base = read.branches[work.repository.base], tip = read.branches[branch];
    if (!base || base.state !== 'present') return { kind: 'unavailable', code: base?.state === 'absent' ? 'ORIGIN_BASE_ABSENT' : 'ORIGIN_BASE_NOT_READ' };
    if (!tip || tip.state === 'unknown') return { kind: 'unavailable', code: 'ORIGIN_BRANCH_NOT_READ' };
    return { kind: 'observed', base: base.sha, branch: tip.state === 'present' ? { state: 'present', sha: tip.sha } : { state: 'absent' }, comparison: read.comparison ?? null };
  } catch { return { kind: 'unavailable', code: 'ORIGIN_NOT_READ' }; }
}

/** The Work branch tip alone; a read that did not conclude is `unknown` under its code, never "absent". */
export const readOriginTip = (access: Pick<AccessDependencies, 'repositories' | 'repository'>, work: Pick<WorkRecord, 'repository' | 'ticket'>, branch: string): Promise<OriginObservation> =>
  readOriginOf(access, work, branch).then(read => read.kind === 'observed' ? read.branch : { state: 'unknown' as const, code: read.code }, () => ({ state: 'unknown' as const, code: 'ORIGIN_NOT_READ' }));
