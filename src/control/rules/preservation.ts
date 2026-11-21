import type { PreservationObservation } from '../../contracts/index.js';
import type { OriginObservation, PreservationOccasion, PreservationView } from '../types.js';

// Pure rules of v2 ticket 07 (V2-05..V2-08): what the preservation gate accepts, why it refuses, the instruction that returns a refusal to
// the Builder and the loss after three refusals in a row. No I/O, clock or randomness: callers supply every fact. The gate exists only
// where the sandbox declares no persistent disk; the caller decides that from the capability.

/** V2-07: refusals in a row, in the same return of control, after which the boot is ended as a loss (Operator decision 7 of 2026-11-21). */
export const gateRefusalLimit = 3;
export const gateRefusedCode = 'PRESERVATION_GATE_REFUSED';
export type GateRefusalCode = 'WORKSPACE_MODIFIED' | 'WORKSPACE_UNTRACKED' | 'STASH_PRESENT' | 'HEAD_NOT_PUBLISHED' | 'REMOTE_UNAVAILABLE' | 'REMOTE_UNCONFIRMED' |
  'GATE_OBSERVATION_UNAVAILABLE';
export type GateRefusal = { code: GateRefusalCode; detail: string };
export type GateDecision = { outcome: 'accepted'; commit: string } | ({ outcome: 'refused' } & GateRefusal);

/**
 * V2-06: preservation is concluded only when the guest's workspace is clean (untracked files that are not ignored included), it holds no
 * stash, and its HEAD is the tip of the Work branch as `ls-remote` answered it in the guest AND as Control's own read of `origin` shows
 * it. Dirty workspace, stash, unpublished commit, unavailable remote and a tip Control cannot confirm each refuse under their own reason;
 * the local state comes first because it is what the Builder corrects first.
 */
export function gateDecision({ observation, origin }: { observation: PreservationObservation; origin: OriginObservation }): GateDecision {
  const refused = (code: GateRefusalCode, detail: string): GateDecision => ({ outcome: 'refused', code, detail: detail.slice(0, 400) });
  if (observation.status !== 'observed') return refused('GATE_OBSERVATION_UNAVAILABLE', `the guest workspace could not be observed (${observation.code})`);
  const { head, remote } = observation;
  if (observation.modified > 0) return refused('WORKSPACE_MODIFIED', `${observation.modified} tracked path(s) with uncommitted changes`);
  if (observation.untracked > 0) return refused('WORKSPACE_UNTRACKED', `${observation.untracked} untracked file(s) not ignored`);
  if (observation.stashes > 0) return refused('STASH_PRESENT', `${observation.stashes} stash entr(ies)`);
  if (remote.state === 'unavailable') return refused('REMOTE_UNAVAILABLE', 'origin did not answer ls-remote from the guest');
  if (remote.state === 'absent') return refused('HEAD_NOT_PUBLISHED', `HEAD ${head} is not published: the Work branch does not exist on origin`);
  if (remote.sha !== head) return refused('HEAD_NOT_PUBLISHED', `HEAD ${head} is not the tip of the Work branch on origin (${remote.sha})`);
  if (origin.state !== 'present' || origin.sha !== head) {
    return refused('REMOTE_UNCONFIRMED', `the Factory's own read of origin does not confirm HEAD ${head} as the Work branch tip (${origin.state === 'present' ? origin.sha : origin.state === 'absent' ? 'branch absent' : origin.code})`);
  }
  return { outcome: 'accepted', commit: head };
}

/** The ONE push of a correction activation: HEAD to the Work branch, without force. The Builder Host allows exactly this text (`allowedWipPush`). */
export const gateCorrectionPush = (branch: string, remote: string) => `git -C /workspace/checkout push ${remote} HEAD:refs/heads/${branch}`;

const occasionText: Record<PreservationOccasion, string> = {
  question: 'your Question is recorded and the environment is about to be shut down while the answer is awaited',
  'ci-wait': 'your activation ended and the environment is about to be shut down while GitHub (CI, readiness) is awaited',
  'planned-swap': 'this environment is about to be replaced by a new one',
  'substitute-end': 'your activation ended and the environment is about to be shut down' };

/**
 * V2-07: the refusal returned to the Builder, in the same return of control, for correction. It names the reason, the ONE push the Builder
 * Host allows in this activation, and says that publishing work in progress needs no pull request and never authorizes versioning
 * secrets or improper data.
 */
export function gateCorrectionPrompt(input: { occasion: PreservationOccasion; refusal: GateRefusal; attempt: number; branch: string; push: string; pullRequest: boolean }): string {
  return [
    `Factory preservation gate: ${occasionText[input.occasion]}. This environment keeps NO disk: whatever is not on the Work branch ${input.branch} on origin is lost.`,
    `The gate refused (refusal ${input.attempt} of ${gateRefusalLimit}; after ${gateRefusalLimit} in a row this environment is ended and what is not on origin is LOST): ${input.refusal.code}: ${input.refusal.detail}`,
    'Correct exactly that, in /workspace/checkout, and end your turn; the Factory checks again by itself. The gate accepts only: no uncommitted change, no untracked ' +
      'file that is not ignored, no stash, and HEAD equal to the tip of the Work branch on origin.',
    '- Commit what belongs to the work as work in progress (a WIP commit is fine), delete or ignore what is disposable, and apply or drop every stash.',
    `- Then publish with exactly this command, ALONE as its own bash call (any other push is refused): ${input.push}`,
    '- If origin moved (the push is rejected as non-fast-forward), fetch and integrate the remote tip first, then push again with the same command.',
    input.pullRequest ? '- Do not open, close or edit pull requests here.' : '- No pull request is needed to publish work in progress; do not open one here.',
    'This procedure does not authorize committing secrets, credentials or data that must not be versioned. If the work cannot be published safely, do not commit it: ' +
      'report the impediment instead of forcing the commit (say what blocks it as your final message) and end your turn.',
    'Do not continue the implementation, do not ask questions and do not hand off for review in this activation.',
  ].join('\n');
}

/**
 * V2-07 as amended by the Operator on 2026-11-21 (decision 7): refusals in a row no longer block the Work for the Operator. The loss path
 * applies: Control ends the boot at once and records a loss whose reason is this text, with the diagnostic of the last refusal; a
 * substitute session resumes from the last push through the queue, on one operational recovery.
 */
export function gateLossReason(input: { occasion: PreservationOccasion; refusal: GateRefusal; refusals: number }): string {
  return `Ended by the Factory: the preservation gate refused ${input.refusals} time(s) in a row before ${input.occasion} (last: ${input.refusal.code}: ${input.refusal.detail}).`.slice(0, 512);
}

/** The commits the gate confirmed on `origin` for a Work: the Factory's own history on the Work branch (V2-08). */
export const preservedHeads = (work: { preservation?: PreservationView | undefined }): string[] => [...(work.preservation?.heads ?? [])];
/** The Work's record after one more acceptance: the latest confirmation, with every confirmed commit kept (bounded, oldest dropped). */
export function recordPreserved(previous: PreservationView | null | undefined, accepted: Omit<PreservationView, 'heads'>): PreservationView {
  return { ...accepted, heads: [...new Set([...(previous?.heads ?? []), accepted.commit])].slice(-32) };
}
