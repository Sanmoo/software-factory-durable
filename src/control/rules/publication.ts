import { publicationMarkerPrefix } from '../../contracts/index.js';
import type { BranchObservation, ExecutionView, FactoryAppIdentity, PublicationDiscovery, PublicationView } from '../types.js';
import { fenced } from './continuation.js';

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
export function publishableContent(execution: ExecutionView): { ok: true; verified: NonNullable<PublicationView['verified']> } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (execution.request.publication) reasons.push('PUBLICATION_EXECUTION');
  if (execution.end?.outcome !== 'completed') reasons.push('EXECUTION_NOT_COMPLETED');
  if (execution.end?.cessation !== 'confirmed') reasons.push('CESSATION_NOT_CONFIRMED');
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
    refs: RefsFacts; baseProtection: ProtectionFacts };
type Summary = PublicationDiscovery['candidates'];
export type DiscoveryDecision = { outcome: 'linked'; pullRequest: CandidateFacts; reasons: []; candidates: Summary } |
  /** Request a publication activation: create ONE draft PR, or (`update`) push a later verified basis to the linked own PR. */
  { outcome: 'absent'; expectedRemote: BranchObservation; update: CandidateFacts | null; refs: Record<string, string>; reasons: []; candidates: Summary;
    /** The own branch was created in the attempt window at exactly the verified head but no PR exists: only the PR is created (no push). */
    recovery?: 'create-pull-request-only' } |
  /** An associated pull request that is not own, before any attempt: never adopted; re-read on a later cycle (ticket 07 operator path). */
  { outcome: 'held'; reasons: string[]; candidates: Summary } |
  { outcome: 'incomplete'; reasons: string[]; candidates: Summary } |
  { outcome: 'blocked'; reasons: string[]; pullRequest: CandidateFacts | null; candidates: Summary };

/** Refs that changed between the snapshot of the request and now, other than the Work's own branch (bounded list). */
export function unexpectedRefChanges(before: Record<string, string>, now: Record<string, string>, ownBranch: string): string[] {
  const own = `refs/heads/${ownBranch}`;
  return [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(ref => ref !== own && before[ref] !== now[ref]).sort().slice(0, 16);
}

/**
 * Spec §9.1 recovery: a correlated own publication is linked, never recreated. A publication is requested only from a COMPLETE read, when
 * the verified head was never attempted, with a complete refs snapshot and a base that requires pull requests without App bypass. Several
 * own candidates, an unknown change of the own branch, an unexpected ref change during the publication window, an own PR that cannot be
 * accepted (other head, not draft, non-conformant description, closed/merged) or absence after an attempt block repetition; an incomplete
 * read decides nothing (a safe read may be repeated); an unknown associated PR before any attempt is held (re-read; never adopted).
 */
export function decideDiscovery(input: { expect: Expect; attempted: boolean; previousHeads?: readonly string[]; refsBefore?: Record<string, string> | null;
  /** The only attempt of this head expected the own branch ABSENT (it pushed); no PR-only continuation ran yet. */
  prOnlyRecovery?: boolean; observation: DiscoveryObservation }): DiscoveryDecision {
  const { expect, observation } = input;
  if (observation.kind === 'incomplete') return { outcome: 'incomplete', reasons: [observation.code], candidates: [] };
  // Without the pinned App identity nothing can be recognized as own: decide nothing (resolved again on a later cycle).
  if (!expect.app) return { outcome: 'incomplete', reasons: ['FACTORY_APP_IDENTITY_UNKNOWN'], candidates: [] };
  const classified = observation.candidates.map(candidate => ({ candidate, ...classifyCandidate(candidate, expect) }));
  const candidates: Summary = classified.map(item => ({ number: item.candidate.number, url: item.candidate.url, own: item.own, reasons: item.reasons }));
  const own = classified.filter(item => item.own).map(item => item.candidate);
  const foreign = classified.filter(item => !item.own).map(item => item.candidate);
  const blocked = (reasons: string[], pullRequest: CandidateFacts | null = null): DiscoveryDecision => ({ outcome: 'blocked', reasons, pullRequest, candidates });
  if (own.length > 1) return blocked([`MULTIPLE_OWN_PULL_REQUESTS:${own.map(item => item.number).join(',')}`]);
  const unknownPulls = foreign.length ? [`UNKNOWN_PULL_REQUEST:${foreign.map(item => item.number).join(',')}`] : [];
  if (unknownPulls.length && input.attempted) return blocked(unknownPulls, own[0] ?? null);
  // Contents W is repository-wide: after an attempt, any other branch/tag changed since the request's snapshot blocks (explicit refs).
  if (input.attempted && input.refsBefore) {
    if (observation.refs.state !== 'complete') return { outcome: 'incomplete', reasons: [`REFS_UNKNOWN:${observation.refs.code}`], candidates };
    const changed = unexpectedRefChanges(input.refsBefore, observation.refs.refs, expect.branch);
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
    const reasons: string[] = [];
    if (pull.merged) reasons.push('OWN_PULL_REQUEST_MERGED');
    else if (pull.state === 'closed') reasons.push('OWN_PULL_REQUEST_CLOSED');
    if (pull.headSha !== expect.head) {
      // A later verified basis: the linked own PR at an earlier Factory head is UPDATED (never a second PR), once per verified head.
      if (!reasons.length && !input.attempted && (input.previousHeads ?? []).includes(pull.headSha) && tip.state === 'present' && tip.sha === pull.headSha && pull.draft) {
        return request({ state: 'present', sha: pull.headSha }, pull);
      }
      reasons.push('PUBLISHED_HEAD_NOT_VERIFIED');
    } else if (tip.state === 'present' && tip.sha !== pull.headSha) reasons.push('REMOTE_BRANCH_CHANGED');
    else if (tip.state === 'absent' && pull.state === 'open') reasons.push('REMOTE_BRANCH_MISSING');
    if (!pull.draft && pull.state === 'open') reasons.push('PULL_REQUEST_NOT_DRAFT');
    const description = descriptionCheck(pull.body, { workId: expect.workId, ticketNumber: expect.ticketNumber });
    if (!description.conformant) reasons.push(`DESCRIPTION_NONCONFORMANT:${description.reasons.join('+')}`);
    return reasons.length ? blocked(reasons, pull) : { outcome: 'linked', pullRequest: pull, reasons: [], candidates };
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
  if (where === 'REMOTE_BRANCH_UNKNOWN_CHANGE') return blocked([where]);
  // The verified commit already on the own branch is a compatible push (only reachable from this Work's workspace); only the PR is missing.
  return request(tip.state === 'absent' ? { state: 'absent' } : { state: 'present', sha: tip.sha }, null);
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
  expectedRemote: BranchObservation; pullRequest: number | null; verified: { reviewedRound: number | null; gates: { id: string; outcome: string }[]; requiredChecks: string[] } }):
  { kind: 'prompt'; prompt: string } | { kind: 'too-large'; bytes: number } {
  const lease = input.expectedRemote.state === 'absent' ? '' : input.expectedRemote.sha;
  // Ticket 18 (real run q18-v3): the remote is the CONFIGURED repository's URL, never the guest-writable checkout's `origin` (it may be
  // missing or point elsewhere); the delivered publish grant authenticates github.com HTTPS for this command only.
  const remote = `https://github.com/${input.repository}.git`;
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
    'Never merge, approve, mark ready, close, push to the base or to any other branch or tag, force-push without that explicit lease, or change labels, assignees or other pull requests. ' +
      'End with a short final message (the pull request URL). The Factory discovers and verifies the publication itself; your message is not evidence.'];
  const prompt = [`Factory publication instruction (publish-only session, reason: ${input.reason}): Execution ${input.executionId} publishes the content verified at the end of ` +
    `Execution ${input.previousExecutionId}. Your workspace (${input.checkout}), branch, commits and /artifacts are preserved. ` +
    `Before anything else inspect git -C ${input.checkout} log and the remote (git ls-remote ${remote}) and never repeat an earlier effect blindly.`, ...facts, ...steps].join('\n');
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
  return head !== undefined && (work.publication?.attempts ?? []).some(item => item.head === head);
};
export type PublicationStep = { kind: 'none' } | { kind: 'evaluate'; basisExecutionId: string } |
  { kind: 'discover'; trigger: PublicationDiscovery['trigger']; attempted: boolean };
/**
 * The next publication step of a Work, from its durable record: nothing while an Execution is active or its cessation is not confirmed;
 * evaluate a NEW completed implementation basis (also after a published one: it may update the own PR); discover when awaiting discovery or
 * held. `blocked` is settled (explicit operator decision; ticket 26).
 */
export function publicationStep(work: WorkFacts): PublicationStep {
  if (work.result !== 'open' || active(work.execution)) return { kind: 'none' };
  const last = [work.execution, ...[...(work.previousExecutions ?? [])].reverse()].find(item => item?.end) ?? null;
  if (!last?.end || last.end.cessation !== 'confirmed') return { kind: 'none' };
  const publication = work.publication ?? null;
  if (publication?.state === 'blocked') return { kind: 'none' };
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
