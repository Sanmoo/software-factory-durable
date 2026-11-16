// TEST ONLY. Ticket 16 seeds: a Work whose ticket 13 verified basis Execution and ticket 14 linked own draft PR are recorded exactly as those
// flows record them (typed ExecutionView/PublicationView), plus a ticket 15 checks observation. The real 13/14/15 flows that produce these
// records are exercised end to end by test/entrypoints/github-readiness-composed.test.ts.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { works, type WorkRecord } from '../../src/control/durable/admission.js';
import type { ExecutionView, PublicationView, VerificationView } from '../../src/control/types.js';
import type { PullRequestObservation } from '../../src/code-repository/index.js';
import type { Session } from '../../src/control/durable/store.js';
import { summary } from './publication-doubles.js';
import { publication } from './checks-seed.js';

export const head = 'd'.repeat(40);
export const branch = 'factory/3-abcdef12';
const at = '2026-11-15T10:00:00.000Z';
const complete = <T>(value: T) => ({ state: 'complete' as const, value });

/** A completed implementation Execution whose ticket 13 verification is `verified` for the committed final capture at `head`. */
export function basisExecution(executionId = 'seeded-execution', verifiedHead = head): ExecutionView {
  const capture = summary(1, verifiedHead, branch, true);
  const verification: VerificationView = { at, status: 'verified', reasons: [], reviewedRound: 1, finalRound: 1, contentSha256: capture.content!.sha256,
    applicability: { kind: 'reviewed', head: verifiedHead, reviewedHead: verifiedHead }, gates: [], treatments: [], requiredChecks: [] };
  return {
    executionId, invocationId: `${executionId}-inv`, mode: 'initial', state: 'ended', slot: { held: false, capacity: 1, reservedAt: at, releasedAt: at },
    admission: { attemptId: 'a', evaluationId: 'e', authorizationObservedAt: at, activationAttemptId: null, activationEvaluationId: null },
    dispatch: { intent: 'prepare-start-activate', phase: 'stopped', environment: null, boot: null, updatedAt: at },
    request: { ticket: 'acme/project#3', repository: 'acme/project', base: 'main', branch, baseCommit: 'a'.repeat(40), checkout: null, promptSha256: null, skillPack: null,
      policies: { skillPack: 'factory-skills-v6', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 } },
    credential: null, credentialIssuance: null, credentialRenewals: [],
    credentialLifecycle: { state: 'withdrawn', withdrawnAt: at, reason: 'ended', renewal: 'stopped', renewalStop: null, workerNotice: null },
    start: { receiptId: 'r', confirmedAt: at }, end: { at, outcome: 'completed', code: null, cessation: 'confirmed' }, held: null,
    completion: { automatic: false, reason: 'seeded' },
    review: { rounds: [{ round: 1, attempt: 1, state: 'delivered', handoff: { at, invocationId: 'i', status: 'captured', code: null, detail: null, summary: capture },
      versions: { spec: capture.spec, instructions: capture.instructions, base: null, head: verifiedHead, profile: { skillPack: null, builder: { skillPack: 'factory-skills-v6',
        modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 }, reviewer: { modelBudget: 'reviewer-v1', imageSourceMaxBytes: 5242880 } } },
      identity: { before: null, after: null }, reviewers: {} as never, applicability: 'current', conclusion: 'clean', reasons: [], concludedAt: at, delivery: null }],
      verification },
  };
}

/** Ticket 14's published record of that basis: own draft PR #7 linked at the verified head, conformant description. */
export function readyPublication(workId: string, overrides: { headSha?: string } = {}): PublicationView {
  const seeded = publication(workId, { headSha: overrides.headSha ?? head });
  const capture = summary(1, overrides.headSha ?? head, branch, true);
  return { ...seeded, verified: { ...seeded.verified!, contentSha256: capture.content!.sha256 }, description: { conformant: true, reasons: [] } };
}

/** Seeds the Work with the basis Execution, the published own PR and satisfied dependencies; not pending. */
export async function seedReady(session: Session, workId: string, change: (work: WorkRecord) => void = () => {}) {
  await session.commit(async tx => {
    const document = await tx.doc(works, workId, null);
    if (!document.work) throw new Error('NO_WORK');
    const seeded = readyPublication(workId);
    document.work = { ...document.work, queue: { ...document.work.queue, pending: false }, impediments: [], execution: basisExecution(), publication: seeded,
      pullRequest: { number: seeded.pullRequest!.number, url: seeded.pullRequest!.url },
      dependencies: { latest: { evaluationId: 'd', attemptId: 'p', source: 'github-rest', observedAt: at, evaluatedAt: at, principals: [], completeness: 'complete',
        conclusion: 'satisfied', blockers: [], cycles: [], shared: [], reasons: [], limitations: [] }, lastComplete: null } };
    change(document.work);
  }, BACKGROUND_CONTEXT);
}

/** A complete ticket 15 observation of PR #7: no classic requirement, a ruleset `pull_request` rule (human review stage) and optional extras. */
export function observedPull(extra: { headSha?: string; draft?: boolean; mergeable?: boolean | null; mergeableState?: string; baseTip?: string; recheckHead?: string;
  rules?: unknown[]; state?: 'open' | 'closed'; merged?: boolean; nodeId?: string } = {}): Extract<PullRequestObservation, { kind: 'observed' }> {
  const sha = extra.headSha ?? head;
  const rules = (extra.rules ?? [{ type: 'pull_request', ruleset: { id: 1, sourceType: 'Repository', source: 'acme/project' } }]) as never;
  const tip = extra.baseTip ?? 'b'.repeat(40);
  return { kind: 'observed', source: 'github-rest', observedAt: new Date().toISOString(), completedAt: new Date().toISOString(), repository: 'acme/project', repositoryId: 3,
    pullRequest: { pullRequestId: 9007, nodeId: extra.nodeId ?? 'PR_node7', number: 7, url: 'https://github.com/acme/project/pull/7', state: extra.state ?? 'open', merged: extra.merged ?? false,
      draft: extra.draft ?? true, headRef: branch, headSha: sha, headRepositoryId: 3, baseRef: 'main', baseSha: 'a'.repeat(40), mergeCommitSha: null,
      mergeable: extra.mergeable === undefined ? true : extra.mergeable, mergeableState: extra.mergeableState ?? 'blocked', author: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' } },
    baseTip: complete(tip), classic: complete({ kind: 'none', evidence: 'STATUS_CHECKS_NOT_ENFORCED', settings: null }), rules: complete(rules), checkRuns: complete([]), statuses: complete([]),
    comparison: complete({ status: 'ahead', aheadBy: 1, behindBy: 0 }), recheck: complete({ headSha: extra.recheckHead ?? sha, baseRef: 'main', state: extra.state ?? 'open', merged: extra.merged ?? false }),
    final: { baseTip: complete(tip), classic: complete({ kind: 'none', evidence: 'STATUS_CHECKS_NOT_ENFORCED', settings: null }), rules: complete(rules) }, limitations: [] };
}
