import { publicationMarkerPrefix } from '../../contracts/index.js';
import type { BranchObservation, DivergenceComparison, ExecutionView, FactoryAppIdentity, PublicationDiscovery, PublicationView } from '../types.js';
import { fenced } from './continuation.js';
import { preservationClaim, withNotice, type RecreatedContext } from './boot-notice.js';
import { repairPreserve } from './repair.js';

// Pure rules of ticket 14 (spec §2.1/§9.1): what may be published, which pull request is the Work's own, the discovery decision, the
// shape of the description, the publication request and the next step of a Work. No I/O, clock or randomness.

export const publicationMarker = (workId: string) => `<!-- ${publicationMarkerPrefix}${workId} -->`;
const markerLine = new RegExp(`^<!-- ${publicationMarkerPrefix}([0-9a-f-]{36}) -->$`);

/** Ticket 13's end-of-Execution verification (`review.verification`) and the content identity of the final capture (consumed, never re-derived). */
const verificationOf = (execution: ExecutionView) => execution.review?.verification ?? null;
const finalSummary = (execution: ExecutionView) => execution.review?.rounds.at(-1)?.handoff.summary ?? null;

/**
 * Spec §9.1/§9.3: only the content the end-of-Execution verification established may be published, and only as the commit that holds it
 * (clean tree, HEAD holding exactly that content). A COMPLETED Execution is never success by itself; absence of evidence is never success.
 */
/**
 * `live` (v2 ticket 06, decision 1A): the Execution is still running in the boot that produced the content — its Builder activation
 * completed and the verification is recorded, but no end and no cessation exist yet. Every other requirement is the same.
 */
export function publishableContent(execution: ExecutionView, options: { live?: boolean } = {}): { ok: true; verified: NonNullable<PublicationView['verified']> } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (execution.request.publication) reasons.push('PUBLICATION_EXECUTION');
  if (options.live) {
    if (execution.state !== 'started' || execution.end) reasons.push('EXECUTION_NOT_LIVE');
  } else {
    if (execution.end?.outcome !== 'completed') reasons.push('EXECUTION_NOT_COMPLETED');
    if (execution.end?.cessation !== 'confirmed') reasons.push('CESSATION_NOT_CONFIRMED');
  }
  const verification = verificationOf(execution);
  if (!execution.review) reasons.push('REVIEWS_NOT_RECORDED');
  else if (!verification) reasons.push('REVIEW_VERIFICATION_ABSENT');
  else if (verification.status !== 'verified') reasons.push('REVIEW_NOT_VERIFIED', ...verification.reasons.slice(0, 16).map(reason => `VERIFICATION:${reason}`));
  const summary = execution.review ? finalSummary(execution) : null;
  const content = summary?.content;
  if (execution.review && verification?.status === 'verified') {
    if (!summary || !content) reasons.push('FINAL_CAPTURE_CONTENT_UNKNOWN');
    else if (!content.clean || !content.headMatches) reasons.push('VERIFIED_CONTENT_NOT_COMMITTED');
    else if (verification.contentSha256 !== content.sha256) reasons.push('VERIFICATION_CONTENT_MISMATCH');
    else if (!/^[0-9a-f]{40}$/.test(summary.head)) reasons.push('VERIFIED_HEAD_UNKNOWN');
    else if (summary.branch !== execution.request.branch) reasons.push('VERIFIED_BRANCH_MISMATCH');
    // Ticket 21: a reconciliation Execution publishes only a head that still contains the authorized remote tip (human commits preserved),
    // as the Host capture established it (never the model's word).
    const reconciliation = execution.request.reconciliation;
    // Ticket 22 (supervisor decision): a repair over human commits likewise publishes only a head that keeps the latest incorporated tip.
    const preserve = reconciliation?.authorizedRemote ?? repairPreserve(execution.request.repair);
    if (preserve && summary) {
      if (summary.preserved?.commit !== preserve) reasons.push('HUMAN_CHANGE_PRESERVATION_UNKNOWN');
      else if (!summary.preserved.ancestor) reasons.push('HUMAN_CHANGE_NOT_PRESERVED');
    }
  }
  if (reasons.length || !summary || !content || !verification) return { ok: false, reasons: reasons.length ? reasons : ['FINAL_CAPTURE_CONTENT_UNKNOWN'] };
  return { ok: true, verified: { executionId: execution.executionId, head: summary.head, contentSha256: content.sha256, verifiedAt: verification.at,
    reviewedRound: verification.reviewedRound, gates: verification.gates.slice(0, 32).map(gate => ({ id: gate.id, outcome: gate.outcome })),
    requiredChecks: verification.requiredChecks.slice(0, 32) } };
}

/** The pull request facts Control needs (a structural subset of the CodeRepository candidate). */
export type CandidateFacts = { pullRequestId: number; nodeId: string; number: number; url: string; state: 'open' | 'closed'; merged: boolean; draft: boolean;
  headRef: string; headSha: string; baseRef: string; headRepositoryId: number | null; author: { id: number; login: string; type: string }; body: string | null };
type Expect = { workId: string; ticketNumber: number; branch: string; base: string; repositoryId: number; head: string; app: FactoryAppIdentity | null };
/** Work ids named by marker lines of a body (a marker of another Work never correlates). */
const markersOf = (body: string | null) => (body ?? '').split(/\r?\n/).flatMap(line => { const match = markerLine.exec(line.trim()); return match ? [match[1]!] : []; });

/**
 * Spec §9.1: "Branch com nome esperado não prova autoria". Own = this Work's marker AND the PINNED Factory App bot user (login and id) as
 * author AND the Work's own branch in the same repository AND the Work's base. Another bot, a human copying the marker, another Work,
 * another branch/base/fork is never adopted; with an unknown App identity nothing is own.
 */
export function classifyCandidate(candidate: CandidateFacts, expect: Pick<Expect, 'workId' | 'branch' | 'base' | 'repositoryId' | 'app'>): { own: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!markersOf(candidate.body).includes(expect.workId)) reasons.push('MARKER_ABSENT');
  if (!expect.app) reasons.push('FACTORY_APP_IDENTITY_UNKNOWN');
  else if (candidate.author.type !== 'Bot' || candidate.author.id !== expect.app.id || candidate.author.login.toLowerCase() !== expect.app.login.toLowerCase()) reasons.push('AUTHOR_NOT_FACTORY_APP');
  if (candidate.headRef !== expect.branch) reasons.push('OTHER_BRANCH');
  if (candidate.headRepositoryId !== expect.repositoryId) reasons.push('OTHER_REPOSITORY');
  if (candidate.baseRef !== expect.base) reasons.push('OTHER_BASE');
  return { own: reasons.length === 0, reasons };
}

/** Repository-wide branch/tag tips (`refs/heads/x`, `refs/tags/y`) from complete listings, or unknown. */
export type RefsFacts = { state: 'complete'; refs: Record<string, string> } | { state: 'unknown'; code: string };
/** Whether the base requires a pull request for every update with NO bypass for the Factory App (rulesets/classic protection), or not. */
export type ProtectionFacts = { state: 'pull-request-required'; sources: string[] } | { state: 'not-required'; reason: string } | { state: 'unknown'; code: string };
export type DiscoveryObservation = { kind: 'incomplete'; code: string } |
  { kind: 'observed'; repositoryId: number; candidates: CandidateFacts[]; branch: BranchObservation | { state: 'unknown'; code: string };
    refs: RefsFacts; baseProtection: ProtectionFacts;
    /** Ticket 21: comparison of the Factory-known tip with the current own branch tip (only read when they differ). */
    comparison?: DivergenceComparison;
    /** Review HIGH: push activity of the own branch, and the comparison of each required/observed tip with the current tip. */
    activity?: { state: 'complete'; entries: { before: string; after: string; type: string; actor: { login: string; id: number } | null; at: string }[]; truncated: boolean } |
      { state: 'unknown'; code: string };
    ancestry?: Record<string, DivergenceComparison> };
/**
 * Ticket 21: what Control knows of its own remote history. `heads`: every head the Factory linked or pushed (attributable); `expected`:
 * the expectation of the next write (lease of the last attempt, the authorized remote, or the last linked head); `authorized`: the ONE
 * concrete divergence the operator's answer authorized (`preserved`: the verified basis contains it, as its capture established).
 */
export type KnownRemote = { heads: readonly string[]; pullRequestId: number | null; expected: BranchObservation | null;
  authorized: { remote: string; mode: 'incorporate' | 'discard'; preserved: boolean } | null;
  /** Review HIGH: commits others pushed that Control observed (with the paths they changed, when known) and that no answer waived: every
   * one must stay an ancestor of a new own head, with those paths untouched, before it is linked. */
  required?: readonly { tip: string; paths: readonly string[] | null }[]; waived?: readonly string[] };
const zero = /^0{40}$/;
/**
 * Review HIGH (Control-side, never the prompt): before a NEW own head is linked, every commit someone else pushed — observed by Control
 * (divergences, discoveries) or reported by the branch's push activity, including a tip a Factory push replaced — must be an ancestor of
 * that head (comparison `ahead`/`identical`) and the paths its change touched must be unchanged since it (ancestry alone does not exclude a
 * revert). Unknown activity/comparison decides nothing.
 */
export function preservationCheck(head: string, known: KnownRemote, observation: Extract<DiscoveryObservation, { kind: 'observed' }>, app: FactoryAppIdentity, attributable: (sha: string) => boolean):
  { kind: 'preserved' } | { kind: 'incomplete'; code: string } | { kind: 'lost'; tip: string; reason: string; comparison: DivergenceComparison } {
  const activity = observation.activity;
  if (!activity) return { kind: 'incomplete', code: 'ACTIVITY_NOT_REPORTED' };
  if (activity.state !== 'complete') return { kind: 'incomplete', code: `ACTIVITY_UNKNOWN:${activity.code}` };
  if (activity.truncated) return { kind: 'incomplete', code: 'ACTIVITY_TRUNCATED' };
  const waived = new Set(known.waived ?? []);
  const required = new Map<string, readonly string[] | null>();
  const add = (tip: string, paths: readonly string[] | null) => {
    if (zero.test(tip) || tip === head || attributable(tip) || waived.has(tip)) return;
    const earlier = required.get(tip);
    required.set(tip, earlier === undefined ? paths : earlier === null ? paths : paths === null ? earlier : [...new Set([...earlier, ...paths])]);
  };
  for (const item of known.required ?? []) add(item.tip, item.paths);
  const bySelf = (actor: { login: string; id: number } | null) => Boolean(actor && actor.id === app.id && actor.login.toLowerCase() === app.login.toLowerCase());
  // A push by someone else leaves its tip; a Factory push that REPLACED a tip it never made (a recaptured lease) leaves the replaced one.
  for (const entry of activity.entries) add(bySelf(entry.actor) ? entry.before : entry.after, null);
  for (const [tip, paths] of required) {
    const compared = observation.ancestry?.[tip];
    if (!compared) return { kind: 'incomplete', code: `PRESERVATION_UNKNOWN:${tip}` };
    if (compared.state !== 'complete') return { kind: 'incomplete', code: `PRESERVATION_UNKNOWN:${tip}:${compared.code}` };
    if (compared.status !== 'ahead' && compared.status !== 'identical') return { kind: 'lost', tip, reason: `NOT_AN_ANCESTOR:${compared.status}`, comparison: compared };
    const touched = paths ? compared.files.filter(path => paths.includes(path)) : [];
    if (touched.length) return { kind: 'lost', tip, reason: `HUMAN_CONTENT_CHANGED:${touched.slice(0, 4).join(',')}`, comparison: compared };
  }
  return { kind: 'preserved' };
}
type Summary = PublicationDiscovery['candidates'];
export type DiscoveryDecision = { outcome: 'linked'; pullRequest: CandidateFacts; reasons: []; candidates: Summary } |
  /** Request a publication activation: create ONE draft PR, or (`update`) push a later verified basis to the linked own PR. */
  { outcome: 'absent'; expectedRemote: BranchObservation; update: CandidateFacts | null; refs: Record<string, string>; reasons: []; candidates: Summary;
    /** The own branch was created in the attempt window at exactly the verified head but no PR exists: only the PR is created (no push). */
    recovery?: 'create-pull-request-only' } |
  /** An associated pull request that is not own, before any attempt: never adopted; re-read on a later cycle (ticket 07 operator path). */
  { outcome: 'held'; reasons: string[]; candidates: Summary } |
  { outcome: 'incomplete'; reasons: string[]; candidates: Summary } |
  { outcome: 'blocked'; reasons: string[]; pullRequest: CandidateFacts | null; candidates: Summary } |
  /** Ticket 21: the own branch/PR holds a head the Factory never linked or pushed: the next write is blocked and the operator is asked. */
  { outcome: 'diverged'; reasons: string[]; pullRequest: CandidateFacts; expected: BranchObservation; current: string;
    trigger: 'update' | 'lease-failed' | 'after-publication'; comparison: DivergenceComparison; uncertainties: string[]; candidates: Summary;
    /** `lost`: the own head does not preserve `current` (a commit someone else pushed); never linked. */
    kind?: 'change' | 'lost' } |
  /** Ticket 21: the linked own PR now targets another base (changed outside the Factory): nothing continues until it is restored. */
  { outcome: 'base-changed'; reasons: string[]; pullRequest: CandidateFacts; from: string; to: string; candidates: Summary };

/**
 * Ticket 61: the own publication Control recorded for ANOTHER Work of this installation in the same repository — its own branch and the heads
 * Control requested, attempted (recorded at the activation commit, before any launch) or linked as its own PR head. Plain data from Control
 * state; never inferred from the remote.
 */
export type OtherPublication = { workId: string; branch: string; heads: readonly string[];
  /** Acceptance finding A13: that Work's Execution holds its Slot, so its Builder may still be pushing work in progress Control has not recorded yet. */
  live?: true };
type ListedWork = { work_id: string; repository: { repositoryId: number }; branch?: string | null;
  publication?: (Pick<PublicationView, 'branch' | 'state' | 'verified'> & Partial<Pick<PublicationView, 'attempts' | 'linkedHeads'>>) | null;
  preservation?: { branch: string; heads: readonly string[] } | undefined; execution?: { state: string; slot: { held: boolean } } | null | undefined };
/**
 * Ticket 61: the other Works' own publication expectations (same repository, not `self`, with at least one recorded head). Acceptance
 * finding A13: the heads a preservation gate confirmed on that Work's own branch are its own pushes too (a sandbox without a persistent
 * disk publishes work in progress before any pull request), and a Work whose Execution holds its Slot is listed even without a head.
 */
export function otherPublications(works: readonly ListedWork[], self: { workId: string; repositoryId: number }): OtherPublication[] {
  const result: OtherPublication[] = [];
  for (const work of works) {
    const publication = work.publication;
    const branch = publication?.branch ?? work.preservation?.branch ?? work.branch;
    if (work.work_id === self.workId || work.repository.repositoryId !== self.repositoryId || !branch) continue;
    const heads = [...new Set([...(publication?.attempts ?? []).map(item => item.head), ...(publication?.linkedHeads ?? []),
      ...(publication?.state === 'requested' && publication.verified ? [publication.verified.head] : []),
      ...(work.preservation?.branch === branch ? work.preservation.heads : [])])];
    const live = work.execution?.state === 'started' && work.execution.slot.held;
    if (heads.length || live) result.push({ workId: work.work_id, branch, heads, ...(live ? { live: true as const } : {}) });
  }
  return result;
}

/**
 * Refs that changed between the snapshot of the request and now, other than the Work's own branch (bounded list). Ticket 61: a ref that is
 * ANOTHER Work's own branch, created or moved to a head Control recorded for that Work's publication, is that Work's own publication, not an
 * unexpected change. A deletion, another head, another ref or a tag still counts.
 */
export function unexpectedRefChanges(before: Record<string, string>, now: Record<string, string>, ownBranch: string,
  others: readonly OtherPublication[] = []): string[] {
  const own = `refs/heads/${ownBranch}`;
  const concurrent = new Map<string, Set<string>>();
  for (const other of others) {
    const ref = `refs/heads/${other.branch}`;
    if (ref === own) continue;
    concurrent.set(ref, new Set([...(concurrent.get(ref) ?? []), ...other.heads]));
  }
  const attributable = (ref: string) => now[ref] !== undefined && concurrent.get(ref)?.has(now[ref]) === true;
  return [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(ref => ref !== own && before[ref] !== now[ref] && !attributable(ref)).sort().slice(0, 16);
}
/**
 * Acceptance finding A13: whether every one of `changed` (the result of `unexpectedRefChanges`) is the own branch of another Work whose
 * Execution is still running, created or moved (never deleted). Such a push may be work in progress its preservation gate has not confirmed
 * yet: nothing is decided on this read. Once Control records the head it is attributed; once that Execution ends without it, it is unexpected.
 */
export function unsettledConcurrentPushes(changed: readonly string[], now: Record<string, string>, others: readonly OtherPublication[]): boolean {
  const live = new Set(others.filter(other => other.live).map(other => `refs/heads/${other.branch}`));
  return changed.length > 0 && changed.every(ref => live.has(ref) && now[ref] !== undefined);
}

const refChange = /^UNEXPECTED_REF_CHANGE:/;
const unknownPull = /^UNKNOWN_PULL_REQUEST:/;
const reevaluable = (reason: string) => refChange.test(reason) || unknownPull.test(reason);
/**
 * Ticket 61: a block whose ONLY reasons are ones a new read may decide differently without repeating anything — unexpected ref changes (the
 * corrected rule may attribute them to another Work) and, acceptance finding A14, unknown pull requests (a human may have corrected the
 * marker of the Work's own PR; the classification is re-applied in full, nothing is adopted by the request).
 */
export const reevaluableReasons = (reasons: readonly string[]) => reasons.length > 0 && reasons.every(reevaluable);
/**
 * Ticket 61: whether an operator may ask for a re-evaluation of the blocked publication: blocked ONLY by re-evaluable reasons, after an
 * attempt of the verified head, with the request's refs snapshot (the window the rule is re-applied to). Anything else: the code.
 */
export function reevaluationEligibility(publication: Pick<PublicationView, 'state' | 'reasons' | 'refsBefore' | 'verified' | 'attempts' | 'reconciliation'>):
  { ok: true } | { ok: false; code: string } {
  if (publication.state !== 'blocked') return { ok: false, code: 'PUBLICATION_NOT_BLOCKED' };
  const other = publication.reasons.filter(reason => !reevaluable(reason));
  if (!reevaluableReasons(publication.reasons)) return { ok: false, code: `NOT_REEVALUABLE:${other.join(',') || 'NO_REASON'}`.slice(0, 200) };
  if (!publication.refsBefore) return { ok: false, code: 'REFS_SNAPSHOT_ABSENT' };
  if (!publication.verified || attemptsOf(publication, publication.verified.head).length === 0) return { ok: false, code: 'PUBLICATION_NOT_ATTEMPTED' };
  return { ok: true };
}
/** Ticket 61: the operator command named by a block it applies to. */
export const reevaluationCommand = (workId: string) => `factory reevaluate-publication ${workId} --reason <text>`;
/**
 * What a block's next step adds when the operator may have it re-evaluated ('' when the command does not apply): per reason, what makes a
 * new read decide differently, and the exact command. A14: the exact marker is printed, since one mistyped character is what blocked.
 */
export function reevaluationGuidance(reasons: readonly string[], work: { workId: string; marker: string }): string {
  if (!reevaluableReasons(reasons)) return '';
  const command = `re-evaluate with \`${reevaluationCommand(work.workId)}\`.`;
  const pulls = reasons.filter(reason => unknownPull.test(reason)).map(reason => reason.replace(unknownPull, '').split(',').map(number => `#${number}`).join(', ')).join(', ');
  const conditions = [...(pulls ? [`pull request ${pulls} is this Work's own publication with a wrong marker, correct the marker line of its body to exactly \`${work.marker}\``] : []),
    ...(reasons.some(reason => refChange.test(reason)) ? ['the changed refs are another Work\'s own publication'] : [])];
  return ` If ${conditions.join('; if ')}${pulls ? ' and ' : ', '}${command}`;
}

/**
 * Spec §9.1 recovery: a correlated own publication is linked, never recreated. A publication is requested only from a COMPLETE read, when
 * the verified head was never attempted, with a complete refs snapshot and a base that requires pull requests without App bypass. Several
 * own candidates, an unknown change of the own branch, an unexpected ref change during the publication window, an own PR that cannot be
 * accepted (other head, not draft, non-conformant description, closed/merged) or absence after an attempt block repetition; an incomplete
 * read decides nothing (a safe read may be repeated); an unknown associated PR before any attempt is held (re-read; never adopted).
 */
export function decideDiscovery(input: { expect: Expect; attempted: boolean; previousHeads?: readonly string[]; refsBefore?: Record<string, string> | null;
  /** Ticket 61: the other Works' own publication expectations in this installation (Control state). */
  others?: readonly OtherPublication[];
  /** The only attempt of this head expected the own branch ABSENT (it pushed); no PR-only continuation ran yet. */
  prOnlyRecovery?: boolean; known?: KnownRemote;
  /** v2 ticket 07: the commits a preservation gate confirmed on `origin` (and a rewritten tip the Factory followed, decision 8). Empty with a persistent disk. */
  preservedHeads?: readonly string[];
  /** V2-07: the working Builder may publish work in progress at any time (a sandbox without a persistent disk), so a tip the Factory App pushed is its own. */
  wipPushes?: boolean; observation: DiscoveryObservation }): DiscoveryDecision {
  const { expect, observation } = input;
  if (observation.kind === 'incomplete') return { outcome: 'incomplete', reasons: [observation.code], candidates: [] };
  // Without the pinned App identity nothing can be recognized as own: decide nothing (resolved again on a later cycle).
  if (!expect.app) return { outcome: 'incomplete', reasons: ['FACTORY_APP_IDENTITY_UNKNOWN'], candidates: [] };
  const classified = observation.candidates.map(candidate => ({ candidate, ...classifyCandidate(candidate, expect) }));
  const candidates: Summary = classified.map(item => ({ number: item.candidate.number, url: item.candidate.url, own: item.own, reasons: item.reasons }));
  // Ticket 21: the LINKED own PR (same immutable id) whose only difference is its base: a target-branch change, never "another PR".
  const rebased = input.known?.pullRequestId != null ? classified.find(item => item.candidate.pullRequestId === input.known!.pullRequestId &&
    item.reasons.length === 1 && item.reasons[0] === 'OTHER_BASE') : undefined;
  if (rebased && rebased.candidate.state === 'open' && !rebased.candidate.merged) {
    return { outcome: 'base-changed', reasons: [`BASE_TARGET_CHANGED:${expect.base}->${rebased.candidate.baseRef}`], pullRequest: rebased.candidate,
      from: expect.base, to: rebased.candidate.baseRef, candidates };
  }
  const own = classified.filter(item => item.own).map(item => item.candidate);
  const foreign = classified.filter(item => !item.own).map(item => item.candidate);
  const blocked = (reasons: string[], pullRequest: CandidateFacts | null = null): DiscoveryDecision => ({ outcome: 'blocked', reasons, pullRequest, candidates });
  if (own.length > 1) return blocked([`MULTIPLE_OWN_PULL_REQUESTS:${own.map(item => item.number).join(',')}`]);
  const unknownPulls = foreign.length ? [`UNKNOWN_PULL_REQUEST:${foreign.map(item => item.number).join(',')}`] : [];
  if (unknownPulls.length && input.attempted) return blocked(unknownPulls, own[0] ?? null);
  // Contents W is repository-wide: after an attempt, any other branch/tag changed since the request's snapshot blocks (explicit refs).
  if (input.attempted && input.refsBefore) {
    if (observation.refs.state !== 'complete') return { outcome: 'incomplete', reasons: [`REFS_UNKNOWN:${observation.refs.code}`], candidates };
    const changed = unexpectedRefChanges(input.refsBefore, observation.refs.refs, expect.branch, input.others ?? []);
    if (input.wipPushes === true && unsettledConcurrentPushes(changed, observation.refs.refs, input.others ?? []))
      return { outcome: 'incomplete', reasons: [`CONCURRENT_WORK_PUSH_UNSETTLED:${changed.join(',')}`], candidates };
    if (changed.length) return blocked([`UNEXPECTED_REF_CHANGE:${changed.join(',')}`], own[0] ?? null);
  }
  if (unknownPulls.length) return { outcome: 'held', reasons: unknownPulls, candidates };
  const tip = observation.branch;
  const pull = own[0];
  /** A request needs a complete refs snapshot and a base that forbids non-PR updates without App bypass. */
  const request = (expectedRemote: BranchObservation, update: CandidateFacts | null): DiscoveryDecision => {
    if (observation.refs.state !== 'complete') return { outcome: 'incomplete', reasons: [`REFS_UNKNOWN:${observation.refs.code}`], candidates };
    const protection = observation.baseProtection;
    if (protection.state === 'unknown') return { outcome: 'incomplete', reasons: [`BASE_PROTECTION_UNKNOWN:${protection.code}`], candidates };
    if (protection.state !== 'pull-request-required') return blocked([`BASE_PROTECTION_NOT_VERIFIED:${protection.reason}`], update);
    return { outcome: 'absent', expectedRemote, update, refs: { ...observation.refs.refs }, reasons: [], candidates };
  };
  if (pull) {
    const known = input.known ?? null;
    const live = pull.state === 'open' && !pull.merged;
    const heads = new Set([...(known?.heads ?? []), ...(input.previousHeads ?? [])]);
    const attributable = (sha: string) => sha === expect.head || heads.has(sha);
    // The remote tip of the own branch (its ref when read, else the PR head).
    const current = tip.state === 'present' ? tip.sha : pull.headSha;
    const authorized = known?.authorized ?? null;
    // Ticket 21: the ONE concrete divergence the operator authorized: the next write leases exactly that remote tip (never a recapture).
    if (live && authorized && !input.attempted && pull.headSha === authorized.remote && current === authorized.remote && pull.headSha !== expect.head) {
      if (authorized.mode === 'incorporate' && !authorized.preserved) return blocked(['HUMAN_CHANGE_NOT_PRESERVED'], pull);
      if (!pull.draft) return blocked(['PULL_REQUEST_NOT_DRAFT'], pull);
      return request({ state: 'present', sha: authorized.remote }, pull);
    }
    const updatable = !input.attempted && (input.previousHeads ?? []).includes(pull.headSha) && tip.state === 'present' && tip.sha === pull.headSha && pull.draft;
    // Ticket 21 (spec §10.1): a head the Factory never linked or pushed — a human push, or a push that raced our lease — blocks the next
    // write. Never a recapture of the tip as a new lease: the operator is asked with the concrete divergence.
    if (live && !updatable && tip.state !== 'unknown' && (!attributable(pull.headSha) || !attributable(current)) && !(authorized && current === authorized.remote && pull.headSha === current)) {
      const divergent = !attributable(current) ? current : pull.headSha;
      const expected = known?.expected ?? { state: 'present' as const, sha: [...heads].at(-1) ?? pull.headSha };
      const comparison = observation.comparison ?? { state: 'unknown' as const, code: 'COMPARISON_NOT_READ' };
      const uncertainties: string[] = [];
      if (comparison.state !== 'complete') uncertainties.push(`DIFFERENCES_UNKNOWN:${comparison.code}`);
      else {
        if (comparison.to !== divergent) uncertainties.push('COMPARISON_OF_ANOTHER_TIP');
        if (comparison.truncated) uncertainties.push('COMPARISON_TRUNCATED');
        if (comparison.behindBy > 0) uncertainties.push(`FACTORY_COMMITS_MISSING_ON_REMOTE:${comparison.behindBy}`);
        if (comparison.commits.some(commit => !commit.author)) uncertainties.push('AUTHORSHIP_NOT_PROVEN_FOR_SOME_COMMITS');
      }
      if (pull.headSha !== current) uncertainties.push(`PULL_REQUEST_HEAD_DIFFERS_FROM_BRANCH:${pull.headSha}`);
      // After an attempt: the verified head among the new commits = our push landed and someone pushed after it; absent from a COMPLETE
      // comparison = the lease failed; otherwise unknown.
      const landed = comparison.state === 'complete' && comparison.commits.some(commit => commit.sha === expect.head);
      const trigger = !input.attempted ? 'update' : landed ? 'after-publication'
        : comparison.state === 'complete' && !comparison.truncated && comparison.to === divergent ? 'lease-failed' : 'after-publication';
      if (input.attempted && trigger === 'after-publication' && !landed) uncertainties.push('LEASE_OUTCOME_UNKNOWN');
      return { outcome: 'diverged', reasons: [`HUMAN_CHANGE_NOT_ATTRIBUTABLE:${divergent}`, ...(trigger === 'lease-failed' ? ['LEASE_FAILED'] : [])], pullRequest: pull,
        expected, current: divergent, trigger, comparison, uncertainties, candidates };
    }
    const reasons: string[] = [];
    if (pull.merged) reasons.push('OWN_PULL_REQUEST_MERGED');
    else if (pull.state === 'closed') reasons.push('OWN_PULL_REQUEST_CLOSED');
    if (pull.headSha !== expect.head) {
      // A later verified basis: the linked own PR at an earlier Factory head is UPDATED (never a second PR), once per verified head.
      if (!reasons.length && updatable) return request({ state: 'present', sha: pull.headSha }, pull);
      reasons.push('PUBLISHED_HEAD_NOT_VERIFIED');
    } else if (tip.state === 'present' && tip.sha !== pull.headSha) reasons.push('REMOTE_BRANCH_CHANGED');
    else if (tip.state === 'absent' && pull.state === 'open') reasons.push('REMOTE_BRANCH_MISSING');
    if (!pull.draft && pull.state === 'open') reasons.push('PULL_REQUEST_NOT_DRAFT');
    const description = descriptionCheck(pull.body, { workId: expect.workId, ticketNumber: expect.ticketNumber });
    if (!description.conformant) reasons.push(`DESCRIPTION_NONCONFORMANT:${description.reasons.join('+')}`);
    if (reasons.length) return blocked(reasons, pull);
    if (known) {
      const preserved = preservationCheck(pull.headSha, known, observation, expect.app, attributable);
      if (preserved.kind === 'incomplete') return { outcome: 'incomplete', reasons: [preserved.code], candidates };
      if (preserved.kind === 'lost') {
        return { outcome: 'diverged', kind: 'lost', reasons: [`LOST_HUMAN_CHANGE:${preserved.tip}`, preserved.reason], pullRequest: pull, current: preserved.tip,
          expected: known.expected ?? { state: 'present', sha: pull.headSha }, trigger: 'after-publication', comparison: preserved.comparison,
          uncertainties: [`OWN_HEAD_DOES_NOT_PRESERVE:${pull.headSha}`], candidates };
      }
    }
    return { outcome: 'linked', pullRequest: pull, reasons: [], candidates };
  }
  if (tip.state === 'unknown') return { outcome: 'incomplete', reasons: [`REMOTE_BRANCH_UNKNOWN:${tip.code}`], candidates };
  const where = tip.state === 'absent' ? 'REMOTE_BRANCH_ABSENT' : tip.sha === expect.head ? 'REMOTE_BRANCH_AT_VERIFIED_HEAD' : 'REMOTE_BRANCH_UNKNOWN_CHANGE';
  // AC6 correlated recovery (real run): the attempt's push is observed — the own branch did not exist in the request's snapshot and now holds
  // EXACTLY the verified head, no other ref changed — but no PR exists. Once, a PR-only continuation is requested (never a push, never
  // another head, never a branch that existed before the window).
  if (input.attempted && where === 'REMOTE_BRANCH_AT_VERIFIED_HEAD' && input.prOnlyRecovery && input.refsBefore &&
    input.refsBefore[`refs/heads/${expect.branch}`] === undefined && observation.refs.state === 'complete') {
    const decision = request({ state: 'present', sha: expect.head }, null);
    return decision.outcome === 'absent' ? { ...decision, recovery: 'create-pull-request-only' } : decision;
  }
  if (input.attempted) return blocked(['PUBLICATION_OUTCOME_UNCONFIRMED', where]);
  // v2 ticket 07: a tip the Factory itself confirmed under a preservation gate (work in progress published before any PR) is its own; the
  // verified head is then published over exactly that tip. Final review, must-fix 3: ONLY such a tip. A head Control merely linked or
  // attempted before is, without a PR, the unknown change it was in the MVP, so a sandbox with a persistent disk (no gate) decides as before.
  // V2-07 (must-fix 2): where the Builder may push work in progress at any time, the tip is also its own when GitHub's push activity of
  // the branch (Control's read, never the guest's word) shows that the Factory App moved the branch to it.
  const ownWip = tip.state === 'present' && ((input.preservedHeads ?? []).includes(tip.sha) || (input.wipPushes === true && pushedByApp(observation.activity, tip.sha, expect.app)));
  if (where === 'REMOTE_BRANCH_UNKNOWN_CHANGE' && !ownWip) return blocked([where]);
  // The verified commit already on the own branch is a compatible push (only reachable from this Work's workspace); only the PR is missing.
  return request(tip.state === 'absent' ? { state: 'absent' } : { state: 'present', sha: tip.sha }, null);
}

/** Whether the complete push activity of the branch shows that the pinned Factory App is who moved it to `sha` (latest such entry). Anything unread proves nothing. */
function pushedByApp(activity: Extract<DiscoveryObservation, { kind: 'observed' }>['activity'], sha: string, app: FactoryAppIdentity): boolean {
  if (!activity || activity.state !== 'complete' || activity.truncated) return false;
  const actor = activity.entries.find(entry => entry.after === sha)?.actor ?? null;
  return Boolean(actor && actor.id === app.id && actor.login.toLowerCase() === app.login.toLowerCase());
}

export const descriptionLimits = Object.freeze({ chars: 6000, fencedLines: 30 });
/**
 * Spec §9.1: short Summary (change/reason/link), Validation (synthesis/limitations/waivers) and Risk; the marker first; no transcripts and no
 * local path presented as a useful remote link. A shape check for evidence, never an interpretation of the content.
 */
export function descriptionCheck(body: string | null, input: { workId: string; ticketNumber: number }): { conformant: boolean; reasons: string[] } {
  if (!body?.trim()) return { conformant: false, reasons: ['DESCRIPTION_MISSING'] };
  const reasons: string[] = [];
  const lines = body.split(/\r?\n/);
  if (lines[0]?.trim() !== publicationMarker(input.workId)) reasons.push('MARKER_NOT_FIRST_LINE');
  const heading = (names: string) => new RegExp(`^#{2,3}\\s*(?:${names})\\s*$`, 'mi').test(body);
  if (!heading('Summary|Resumo')) reasons.push('SUMMARY_SECTION_MISSING');
  if (!heading('Validation|Valida[çc][ãa]o')) reasons.push('VALIDATION_SECTION_MISSING');
  if (!heading('Risk|Risco')) reasons.push('RISK_SECTION_MISSING');
  if (!new RegExp(`(?:^|[^\\w/])#${input.ticketNumber}(?!\\d)|/issues/${input.ticketNumber}(?!\\d)`).test(body)) reasons.push('TICKET_LINK_MISSING');
  if (/\]\(\s*(?!https:\/\/|#)[^)]*\)|\bfile:\/\/|href\s*=\s*["']\s*\//i.test(body)) reasons.push('LOCAL_PATH_AS_LINK');
  let fence = 0, inFence = false, longest = 0;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { if (inFence) longest = Math.max(longest, fence); inFence = !inFence; fence = 0; continue; }
    if (inFence) fence++;
  }
  if (Math.max(longest, inFence ? fence : 0) > descriptionLimits.fencedLines) reasons.push('TRANSCRIPT_LIKE');
  if (body.length > descriptionLimits.chars) reasons.push('DESCRIPTION_TOO_LONG');
  return { conformant: reasons.length === 0, reasons };
}

export const publicationPromptBudgetBytes = 15000;
/**
 * The publication request to the Builder (spec §9.1: "se ausente solicita publicação ao Builder"): a self-contained, PUBLISH-ONLY
 * instruction for a new session without the handoff/edit tools. Control states the facts (exact verified commit, own branch/base, lease
 * expectation, marker, the own PR to update when there is one); the Builder publishes DIRECTLY with Git/gh and its own grant. Any change of
 * content is never published: Control discovers the remote and accepts only the verified head. Loading /pr publishes nothing.
 */
export function publicationPrompt(input: { reason: string; executionId: string; previousExecutionId: string; skillDirectory: string;
  repository: string; base: string; branch: string; head: string; marker: string; ticket: { number: number; url: string }; workId: string; checkout: string;
  expectedRemote: BranchObservation; pullRequest: number | null; verified: { reviewedRound: number | null; gates: { id: string; outcome: string }[]; requiredChecks: string[] };
  /** Ticket 21/18: the exact remote token of the push/ls-remote (`origin` or the configured https URL); the Builder push policy gets the SAME value. */
  remote?: string;
  /** v2 ticket 08 (V2-11): the environment was recreated (no persistent disk); the prompt starts with the fixed notice and claims no preservation. */
  recreated?: RecreatedContext | null }):
  { kind: 'prompt'; prompt: string } | { kind: 'too-large'; bytes: number } {
  const lease = input.expectedRemote.state === 'absent' ? '' : input.expectedRemote.sha;
  // Ticket 18 (real run q18-v3): the remote is the CONFIGURED repository's URL, never the guest-writable checkout's `origin` (it may be
  // missing or point elsewhere); the delivered publish grant authenticates github.com HTTPS for this command only.
  // Ticket 21: the Builder push policy receives the SAME token (Control passes it explicitly; default = this configured URL form).
  const remote = input.remote ?? `https://github.com/${input.repository}.git`;
  const pushCommand = fenced(`git -C ${input.checkout} push --force-with-lease=refs/heads/${input.branch}:${lease} ${remote} ${input.head}:refs/heads/${input.branch}`);
  const push = input.expectedRemote.state === 'present' && input.expectedRemote.sha === input.head
    ? [`2. The remote branch ${input.branch} already holds the verified commit ${input.head}: do NOT push.`]
    : input.expectedRemote.state === 'present'
      ? [`2. Update your branch to exactly the verified commit with this explicit lease (the remote must still be at ${input.expectedRemote.sha}), once:`, pushCommand]
      : ['2. Push exactly the verified commit with this explicit lease (the remote branch must not exist yet), once:', pushCommand];
  const facts = [`Factory facts (authoritative): Work ${input.workId}; Ticket #${input.ticket.number} ${input.ticket.url}; repository ${input.repository}; base ${input.base}; ` +
    `your branch ${input.branch}; verified commit ${input.head} (content verified at the end of Execution ${input.previousExecutionId}); ` +
    `remote branch before this activation: ${input.expectedRemote.state === 'absent' ? 'absent' : input.expectedRemote.sha}` +
    `${input.pullRequest === null ? '' : `; your own draft pull request #${input.pullRequest} already exists`}.`,
    `Verification (for the Validation section): reviews round ${input.verified.reviewedRound ?? 'unknown'} applied; gates ${input.verified.gates.length
      ? input.verified.gates.map(gate => `${gate.id}=${gate.outcome}`).join(', ') : 'none declared'}; GitHub required checks still evaluated by GitHub: ${input.verified.requiredChecks.join(', ') || 'none named'}.`];
  const pr = input.pullRequest === null
    ? [`3. Check that no pull request exists for your branch: gh pr list --repo ${input.repository} --head ${input.branch} --state all --json number,url,isDraft. If one exists, do NOT create another: report it.`,
      `4. Otherwise create ONE draft pull request, once: gh pr create --repo ${input.repository} --draft --base ${input.base} --head ${input.branch} --title "<short title>" --body-file /artifacts/publication/pr-body.md`]
    : [`3. Do NOT create a pull request: #${input.pullRequest} follows your branch. Update its description once: gh pr edit ${input.pullRequest} --repo ${input.repository} --body-file /artifacts/publication/pr-body.md`];
  const steps = [
    `1. Read ${input.skillDirectory}/skills/pr/SKILL.md with the read tool and draft the body into /artifacts/publication/pr-body.md exactly as it says. Its FIRST line must be:`,
    fenced(input.marker),
    `   and it must contain "Closes #${input.ticket.number}". This activation is PUBLISH-ONLY: do not change, commit, amend, rebase or reset anything in ${input.checkout} ` +
      `(HEAD must stay ${input.head}); a changed content is never accepted by the Factory.`,
    ...push, ...pr,
    `${input.pullRequest === null ? 5 : 4}. If a command fails or its outcome is unclear, never repeat it blindly: inspect (git ls-remote ${remote}, gh pr list --repo ${input.repository}) and report what you observed.`,
    'Run the push command ALONE as its own bash call, exactly as written (no `&&`, `;`, other commands or options): the Factory Host refuses anything else. ' +
      'A PUSH_POLICY_DENIED is a LOCAL refusal: nothing was sent and it is not a publication attempt; correct it ONCE by running the exact command alone, then continue.',
    'Never merge, approve, mark ready, close, push to the base or to any other branch or tag, force-push without that explicit lease, or change labels, assignees or other pull requests. ' +
      'End with a short final message (the pull request URL). The Factory discovers and verifies the publication itself; your message is not evidence.'];
  const prompt = withNotice(input.recreated, [`Factory publication instruction (publish-only session, reason: ${input.reason}): Execution ${input.executionId} publishes the content verified at the end of ` +
    `Execution ${input.previousExecutionId}. ${preservationClaim(input.recreated, `Your workspace (${input.checkout}), branch, commits and /artifacts are preserved.`)} ` +
    `Before anything else inspect git -C ${input.checkout} log and the remote (git ls-remote ${remote}) and never repeat an earlier effect blindly.`, ...facts, ...steps]).join('\n');
  const bytes = new TextEncoder().encode(prompt).length;
  return bytes <= publicationPromptBudgetBytes ? { kind: 'prompt', prompt } : { kind: 'too-large', bytes };
}

type WorkFacts = { result: string; execution: ExecutionView | null; previousExecutions?: ExecutionView[]; publication?: PublicationView | null };
const active = (execution: ExecutionView | null) => execution !== null && execution.state !== 'released' && !(execution.state === 'ended' && !execution.slot.held);
/**
 * Whether the CURRENT verified head was already attempted: attempts are recorded at the publication activation commit (before any launch),
 * bound to the head they carried. A later verified basis (another head) is not attempted.
 */
export const publicationAttempted = (work: Pick<WorkFacts, 'publication'>) => {
  const head = work.publication?.verified?.head;
  return head !== undefined && work.publication !== null && work.publication !== undefined && attemptsOf(work.publication, head).length > 0;
};
/**
 * Attempts of `head` that count: all of them, or — while an operator authorization of ONE concrete divergence is in force (ticket 21) —
 * only those that leased exactly the authorized remote tip (an attempt refused by a lease before the authorization is not repeated
 * blindly: the authorization is what allows a new attempt with the new, explicit expectation).
 */
export function attemptsOf(publication: Pick<PublicationView, 'attempts' | 'reconciliation'>, head: string) {
  const lease = publication.reconciliation && (publication.reconciliation.state === 'authorized' || publication.reconciliation.state === 'executing')
    ? publication.reconciliation.authorizedRemote : null;
  return (publication.attempts ?? []).filter(item => item.head === head &&
    (lease === null || (item.expectedRemote?.state === 'present' && item.expectedRemote.sha === lease)));
}
export type PublicationStep = { kind: 'none' } | { kind: 'evaluate'; basisExecutionId: string } |
  { kind: 'discover'; trigger: PublicationDiscovery['trigger']; attempted: boolean } |
  /** Ticket 21: a divergence Question is pending: its accepted answer (if any) is resolved, nothing else happens. */
  { kind: 'resolve'; divergenceId: string; questionId: string };
/**
 * The next publication step of a Work, from its durable record: nothing while an Execution is active or its cessation is not confirmed;
 * evaluate a NEW completed implementation basis (also after a published one: it may update the own PR); discover when awaiting discovery or
 * held. `blocked` is settled (explicit operator decision; ticket 26).
 */
export function publicationStep(work: WorkFacts): PublicationStep {
  // Ticket 25: a cancelled Work only reconciles a publication activation already ATTEMPTED (its remote effect may have concluded); it never
  // evaluates a new basis nor requests anything.
  if ((work.result === 'cancelled' || work.result === 'closed-unmerged') && !active(work.execution) && work.publication?.state === 'awaiting-discovery' && publicationAttempted(work)) {
    const last = [work.execution, ...[...(work.previousExecutions ?? [])].reverse()].find(item => item?.end) ?? null;
    return last?.end?.cessation === 'confirmed' ? { kind: 'discover', trigger: 'after-publication', attempted: true } : { kind: 'none' };
  }
  if (work.result !== 'open' || active(work.execution)) return { kind: 'none' };
  const last = [work.execution, ...[...(work.previousExecutions ?? [])].reverse()].find(item => item?.end) ?? null;
  if (!last?.end || last.end.cessation !== 'confirmed') return { kind: 'none' };
  const publication = work.publication ?? null;
  // Ticket 61: a block is settled, except for ONE discovery an operator explicitly asked for (re-evaluation of the same window).
  if (publication?.state === 'blocked') return publication.reevaluation?.state === 'pending' && publicationAttempted(work)
    ? { kind: 'discover', trigger: 'after-publication', attempted: true } : { kind: 'none' };
  if (publication?.state === 'diverged') {
    const divergence = publication.divergences?.at(-1);
    return divergence && divergence.state === 'awaiting-answer' ? { kind: 'resolve', divergenceId: divergence.divergenceId, questionId: divergence.questionId } : { kind: 'none' };
  }
  // A changed base is re-read every cycle until restored (spec §10.1: no continuation before that).
  if (publication?.state === 'base-changed') return { kind: 'discover', trigger: 'reconciliation', attempted: publicationAttempted(work) };
  if (!last.request.publication && last.end.outcome === 'completed' && publication?.basisExecutionId !== last.executionId) return { kind: 'evaluate', basisExecutionId: last.executionId };
  if (publication?.state === 'awaiting-discovery') {
    const attempted = publicationAttempted(work);
    return { kind: 'discover', trigger: attempted ? 'after-publication' : 'verified', attempted };
  }
  return { kind: 'none' };
}

/** The Execution a publication activation resumes from: the verified basis itself (completed), or an earlier publication activation of
 * that same basis (the PR-only continuation after a pushing attempt). */
export const publicationResumes = (previous: ExecutionView | null, basisExecutionId: string) => Boolean(previous?.end && (
  (previous.executionId === basisExecutionId && previous.end.outcome === 'completed') || previous.request.publication?.basisExecutionId === basisExecutionId));

/**
 * Ticket 18 backstop: the blocking reasons that, AFTER a publication attempt, show an effect of the publish-only guest outside its scope —
 * another ref changed, the own PR not draft, merged or closed, the own branch or head moved, a second own PR. GitHub permissions cannot
 * separate push from merge (contents:write) nor draft creation from ready/merge (pull_requests:write), so the Builder's guest command
 * policy is defence in depth and this Control verification is the backstop. (An approval by the PR's own author is impossible on GitHub.)
 */
export function guestEffectOutOfScope(reasons: readonly string[]): string[] {
  return reasons.filter(reason => /^(UNEXPECTED_REF_CHANGE|PULL_REQUEST_NOT_DRAFT|OWN_PULL_REQUEST_MERGED|OWN_PULL_REQUEST_CLOSED|REMOTE_BRANCH_CHANGED|PUBLISHED_HEAD_NOT_VERIFIED|MULTIPLE_OWN_PULL_REQUESTS)\b/.test(reason));
}
