import { z } from 'zod';
import { lostMarkerPattern, lostMarkerPrefix, type GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess, type GitHubSession } from '../platform/github/index.js';

// v2 ticket 12 (V2-16, V2-17, V2-02 Remover): the loss marker refs of ONE Work on `origin` (`refs/factory/lost/<work>/<boot>`).
// `readLostMarkers` is the read Control records a loss with (whether a marker exists is never the guest's word); `cleanupLostMarkers`
// deletes them at the Work's cleanup. Neither reads nor touches a branch or a pull request.

export type LostMarkerSelection = { repo: GitHubScope; repositoryId: number; workId: string };
export type LostMarker = { ref: string; boot: string; sha: string };
/** `unknown`: the listing was not complete or not readable; never read as "no marker". */
export type LostMarkersObservation = { state: 'complete'; observedAt: string; markers: LostMarker[] } | { state: 'unknown'; code: string };
/**
 * `removed`: every marker ref of the Work found by a complete read was deleted atomically and none is left; `absent`: a complete read
 * found none (nothing was sent); `kept`: no atomic conditional deletion is available for this token; `failed`: a known failure with
 * some ref left; `indeterminate`: a listing or a deletion did not answer conclusively (re-read before any new attempt).
 */
export type LostMarkerCleanupResult = { outcome: 'removed' | 'absent' | 'kept' | 'failed' | 'indeterminate'; code: string; observedAt: string;
  removed: string[]; remaining: string[]; nextStep: string; effectId: string };

const sha = z.string().regex(/^[0-9a-f]{40}$/);
/** At most this many marker refs of one Work are handled in one attempt (one per lost boot; a Work has few). */
const markerLimit = 32;

async function listMarkers(session: GitHubSession, repository: string, workId: string): Promise<LostMarker[]> {
  const prefix = lostMarkerPrefix(workId)!;
  const parsed = z.array(z.object({ ref: z.string(), object: z.object({ sha, type: z.string() }) }))
    .safeParse(await session.list(`/repos/${repository}/git/matching-refs/${prefix.slice('refs/'.length)}`, { maxPages: 10 }));
  if (!parsed.success) throw new InvalidGitHubObservation();
  // Only exact marker refs of THIS Work; anything else under the prefix is not the Factory's shape and is left alone.
  return parsed.data.flatMap(item => {
    const match = lostMarkerPattern.exec(item.ref);
    return match && match[1] === workId && item.object.type === 'commit' ? [{ ref: item.ref, boot: match[2]!, sha: item.object.sha }] : [];
  });
}

export function lossMarkerOperations(options: { github: GitHubAccess }) {
  return {
    /** A complete listing of the Work's marker refs under a read-only grant. */
    async readLostMarkers(selection: LostMarkerSelection): Promise<LostMarkersObservation> {
      if (lostMarkerPrefix(selection.workId) === null) return { state: 'unknown', code: 'LOST_MARKER_SELECTION_INVALID' };
      const read = await options.github.read(selection.repo, 'publication-read', async session => {
        if (session.repositoryId !== selection.repositoryId) return null;
        return listMarkers(session, selection.repo.repository, selection.workId);
      });
      if (!read.ok) return { state: 'unknown', code: read.code };
      return read.value === null ? { state: 'unknown', code: 'REPOSITORY_IDENTITY_MISMATCH' } : { state: 'complete', observedAt: read.observedAt, markers: read.value };
    },

    /**
     * Deletes the Work's marker refs: a complete listing, then ONE atomic conditional deletion per ref (`updateRefs`, beforeOid = the
     * listed tip), each under its own single-use cleanup grant, then a complete re-read. A plain DELETE is never sent.
     */
    async cleanupLostMarkers(selection: LostMarkerSelection, effect: { effectId: string }): Promise<LostMarkerCleanupResult> {
      const observedAt = new Date().toISOString();
      const result = (outcome: LostMarkerCleanupResult['outcome'], code: string, removed: string[], remaining: string[], nextStep: string): LostMarkerCleanupResult =>
        ({ outcome, code, observedAt, removed, remaining, nextStep, effectId: effect.effectId });
      const listed = await this.readLostMarkers(selection);
      if (listed.state !== 'complete') return result('indeterminate', listed.code, [], [], 'The marker refs could not be listed; nothing was sent. The next sweep reads again.');
      if (!listed.markers.length) return result('absent', 'LOST_MARKERS_ABSENT', [], [], 'A complete read shows no loss marker ref of this Work; nothing was sent.');
      const removed: string[] = [];
      let stopped: { outcome: 'kept' | 'failed' | 'indeterminate'; code: string } | null = null;
      for (const marker of listed.markers.slice(0, markerLimit)) {
        const attempt = await options.github.cleanup(selection.repo, async session => {
          if (session.repositoryId !== selection.repositoryId) return { kind: 'rejected' as const, code: 'REPOSITORY_IDENTITY_MISMATCH' };
          const repository = z.object({ node_id: z.string().min(1).max(128) }).safeParse(await session.get(`/repos/${selection.repo.repository}`));
          if (!repository.success) return { kind: 'rejected' as const, code: 'REPOSITORY_PAYLOAD_INVALID' };
          return session.deleteRefIfAt({ repositoryNodeId: repository.data.node_id, lostMarker: marker.ref, beforeOid: marker.sha });
        }).catch(() => null);
        if (!attempt) { stopped = { outcome: 'indeterminate', code: 'CLEANUP_ADAPTER_FAILED' }; break; }
        if (!attempt.ok) { stopped = { outcome: attempt.outcome === 'unknown' ? 'indeterminate' : 'failed', code: attempt.code }; break; }
        if (attempt.value.kind === 'unavailable') { stopped = { outcome: 'kept', code: attempt.value.code }; break; }
        // A rejected deletion (the ref moved or is gone) is settled by the re-read below, never assumed.
        if (attempt.value.kind === 'deleted') removed.push(marker.ref);
      }
      const after = await this.readLostMarkers(selection);
      if (after.state !== 'complete') return result('indeterminate', after.code, removed, [], 'The deletion was sent but the re-read failed; the next sweep reads again before any new attempt.');
      const remaining = after.markers.map(marker => marker.ref);
      if (!remaining.length) return result('removed', 'LOST_MARKERS_DELETED', removed, [], 'Loss marker refs deleted atomically and re-read absent. No branch and no pull request was touched.');
      return result(stopped?.outcome ?? 'failed', stopped?.code ?? 'LOST_MARKERS_REMAIN', removed, remaining, stopped?.outcome === 'kept'
        ? 'kept: atomic delete unavailable for this token; the marker refs are kept and never deleted without a precondition. Operator decides.'
        : 'Some loss marker ref is still there; the next sweep lists and tries again.');
    },
  };
}
