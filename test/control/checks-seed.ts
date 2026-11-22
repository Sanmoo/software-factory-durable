// TEST ONLY. Seeds a Work whose own draft pull request ticket 14 linked, as a typed ticket 14 `PublicationView`, directly in a real Pi
// Durable/SQLite store: the storage-real tracker tests need many Works in exact publication states. The real ticket 14 flow that produces
// this record is exercised end to end by test/entrypoints/github-checks-composed.test.ts.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { works } from '../../src/control/durable/admission.js';
import type { PublicationView } from '../../src/control/types.js';
import type { Session } from '../../src/control/durable/store.js';

export const ownHead = 'd'.repeat(40);
export function publication(
  workId: string,
  overrides: { number?: number; headSha?: string; nodeId?: string; linkedHeads?: string[]; requiredChecks?: string[]; state?: PublicationView['state'] } = {},
): PublicationView & { pullRequest: NonNullable<PublicationView['pullRequest']> } {
  const number = overrides.number ?? 7;
  const headSha = overrides.headSha ?? ownHead;
  return {
    state: overrides.state ?? 'published',
    basisExecutionId: 'seeded-execution',
    marker: `<!-- software-factory:work:${workId} -->`,
    branch: 'factory/3-abcdef12',
    base: 'main',
    verified: {
      executionId: 'seeded-execution',
      head: headSha,
      contentSha256: 'f'.repeat(64),
      verifiedAt: null,
      reviewedRound: 1,
      gates: [],
      requiredChecks: overrides.requiredChecks ?? [],
    },
    expectedRemote: { state: 'absent' },
    requestedAt: null,
    description: null,
    discoveries: [],
    reasons: [],
    nextStep: null,
    updatedAt: new Date().toISOString(),
    linkedHeads: overrides.linkedHeads ?? [headSha],
    pullRequest: {
      pullRequestId: 9000 + number,
      nodeId: overrides.nodeId ?? `PR_node${number}`,
      number,
      url: `https://github.com/acme/project/pull/${number}`,
      state: 'open',
      merged: false,
      draft: true,
      headRef: 'factory/3-abcdef12',
      headSha,
      base: 'main',
      author: { id: 41898282, login: 'factory-app[bot]', type: 'Bot' },
      linkedAt: new Date().toISOString(),
      bodySha256: null,
    },
  };
}
/** Marks the Work published (ticket 14 shape) and not pending in its queue. */
export async function seedPublished(session: Session, workId: string, overrides: Parameters<typeof publication>[1] = {}) {
  await session.commit(async tx => {
    const document = await tx.doc(works, workId, null);
    if (!document.work) throw new Error('NO_WORK');
    const seeded = publication(workId, overrides);
    document.work = {
      ...document.work,
      queue: { ...document.work.queue, pending: false },
      publication: seeded,
      pullRequest: { number: seeded.pullRequest.number, url: seeded.pullRequest.url },
    };
  }, BACKGROUND_CONTEXT);
}
