import { publicationMarkerPrefix, type ProposalHandoff } from '../../contracts/index.js';
import type { BranchObservation, ExecutionView, PublicationDiscovery, PublicationView } from '../types.js';
import { fenced } from './continuation.js';

// Pure rules of ticket 14 (spec §2.1/§9.1): what may be published, which pull request is the Work's own, the discovery decision, the
// shape of the description, the publication request and the next step of a Work. No I/O, clock or randomness.

export const publicationMarker = (workId: string) => `<!-- ${publicationMarkerPrefix}${workId} -->`;
const markerLine = new RegExp(`^<!-- ${publicationMarkerPrefix}([0-9a-f-]{36}) -->$`);

/**
 * Ticket 13's end-of-Execution verification as recorded on the Execution (`review.verification`) and the content identity of its final
 * capture. Consumed structurally: Control never re-derives or certifies it here.
 */
type VerificationFacts = { at?: string; status: 'verified' | 'not-verified'; reasons: string[]; reviewedRound?: number | null; contentSha256: string | null;
  gates?: { id: string; outcome: string }[]; requiredChecks?: string[] };
type Content = { sha256: string; clean: boolean; headMatches: boolean };
const verificationOf = (execution: ExecutionView) => (execution.review as { verification?: VerificationFacts | null } | undefined)?.verification ?? null;
const finalSummary = (execution: ExecutionView) => (execution.review?.rounds.at(-1)?.handoff.summary ?? null) as (ProposalHandoff & { content?: Content }) | null;

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
  return { ok: true, verified: { executionId: execution.executionId, head: summary.head, contentSha256: content.sha256, verifiedAt: verification.at ?? null,
    reviewedRound: verification.reviewedRound ?? null, gates: (verification.gates ?? []).slice(0, 32).map(gate => ({ id: gate.id, outcome: gate.outcome })),
    requiredChecks: [...(verification.requiredChecks ?? [])].slice(0, 32) } };
}

/** The pull request facts Control needs (a structural subset of the CodeRepository candidate). */
export type CandidateFacts = { pullRequestId: number; nodeId: string; number: number; url: string; state: 'open' | 'closed'; merged: boolean; draft: boolean;
  headRef: string; headSha: string; baseRef: string; headRepositoryId: number | null; author: { id: number; login: string; type: string }; body: string | null };
type Expect = { workId: string; branch: string; base: string; repositoryId: number; head: string };
/** Work ids named by marker lines of a body (a marker of another Work never correlates). */
const markersOf = (body: string | null) => (body ?? '').split(/\r?\n/).flatMap(line => { const match = markerLine.exec(line.trim()); return match ? [match[1]!] : []; });

/**
 * Spec §9.1: "Branch com nome esperado não prova autoria". Own = this Work's marker AND the App bot as author AND the Work's own branch in
 * the same repository AND the Work's base. A human copying the marker, another Work, another branch/base/fork is never adopted.
 */
export function classifyCandidate(candidate: CandidateFacts, expect: Omit<Expect, 'head'>): { own: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!markersOf(candidate.body).includes(expect.workId)) reasons.push('MARKER_ABSENT');
  if (candidate.author.type !== 'Bot') reasons.push('AUTHOR_NOT_APP');
  if (candidate.headRef !== expect.branch) reasons.push('OTHER_BRANCH');
  if (candidate.headRepositoryId !== expect.repositoryId) reasons.push('OTHER_REPOSITORY');
  if (candidate.baseRef !== expect.base) reasons.push('OTHER_BASE');
  return { own: reasons.length === 0, reasons };
}

export type DiscoveryObservation = { kind: 'incomplete'; code: string } |
  { kind: 'observed'; repositoryId: number; candidates: CandidateFacts[]; branch: BranchObservation | { state: 'unknown'; code: string } };
type Summary = PublicationDiscovery['candidates'];
export type DiscoveryDecision = { outcome: 'linked'; pullRequest: CandidateFacts; reasons: []; candidates: Summary } |
  { outcome: 'absent'; expectedRemote: BranchObservation; reasons: []; candidates: Summary } |
  { outcome: 'incomplete'; reasons: string[]; candidates: Summary } |
  { outcome: 'blocked'; reasons: string[]; pullRequest: CandidateFacts | null; candidates: Summary };

/**
 * Spec §9.1 recovery: a correlated own publication is linked, never recreated. Absence requests a publication only from a COMPLETE read and
 * only when no publication activation ever started (a first empty read after an attempt never proves absence). Several own candidates, an
 * unknown associated PR, an unknown change of the own branch or an own PR that cannot be accepted block repetition; an incomplete read
 * decides nothing (a safe read may be repeated).
 */
export function decideDiscovery(input: { expect: Expect; attempted: boolean; observation: DiscoveryObservation }): DiscoveryDecision {
  const { expect, observation } = input;
  if (observation.kind === 'incomplete') return { outcome: 'incomplete', reasons: [observation.code], candidates: [] };
  const classified = observation.candidates.map(candidate => ({ candidate, ...classifyCandidate(candidate, expect) }));
  const candidates: Summary = classified.map(item => ({ number: item.candidate.number, url: item.candidate.url, own: item.own, reasons: item.reasons }));
  const own = classified.filter(item => item.own).map(item => item.candidate);
  const foreign = classified.filter(item => !item.own).map(item => item.candidate);
  const blocked = (reasons: string[], pullRequest: CandidateFacts | null = null): DiscoveryDecision => ({ outcome: 'blocked', reasons, pullRequest, candidates });
  if (own.length > 1) return blocked([`MULTIPLE_OWN_PULL_REQUESTS:${own.map(item => item.number).join(',')}`]);
  if (foreign.length) return blocked([`UNKNOWN_PULL_REQUEST:${foreign.map(item => item.number).join(',')}`], own[0] ?? null);
  const tip = observation.branch;
  const pull = own[0];
  if (pull) {
    const reasons: string[] = [];
    if (pull.merged) reasons.push('OWN_PULL_REQUEST_MERGED');
    else if (pull.state === 'closed') reasons.push('OWN_PULL_REQUEST_CLOSED');
    if (pull.headSha !== expect.head) reasons.push('PUBLISHED_HEAD_NOT_VERIFIED');
    else if (tip.state === 'present' && tip.sha !== pull.headSha) reasons.push('REMOTE_BRANCH_CHANGED');
    else if (tip.state === 'absent' && pull.state === 'open') reasons.push('REMOTE_BRANCH_MISSING');
    if (!pull.draft && pull.state === 'open') reasons.push('PULL_REQUEST_NOT_DRAFT');
    return reasons.length ? blocked(reasons, pull) : { outcome: 'linked', pullRequest: pull, reasons: [], candidates };
  }
  if (tip.state === 'unknown') return { outcome: 'incomplete', reasons: [`REMOTE_BRANCH_UNKNOWN:${tip.code}`], candidates };
  const where = tip.state === 'absent' ? 'REMOTE_BRANCH_ABSENT' : tip.sha === expect.head ? 'REMOTE_BRANCH_AT_VERIFIED_HEAD' : 'REMOTE_BRANCH_UNKNOWN_CHANGE';
  if (input.attempted) return blocked(['PUBLICATION_OUTCOME_UNCONFIRMED', where]);
  if (where === 'REMOTE_BRANCH_UNKNOWN_CHANGE') return blocked([where]);
  // The verified commit already on the own branch is a compatible push (only reachable from this Work's workspace); only the PR is missing.
  return { outcome: 'absent', expectedRemote: tip.state === 'absent' ? { state: 'absent' } : { state: 'present', sha: tip.sha }, reasons: [], candidates };
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
 * The publication request to the Builder (spec §9.1: "se ausente solicita publicação ao Builder"). `continue` mode is a `publish` message
 * to the SAME compatible session; `replace` is a self-contained instruction for a new session. Control states the facts (exact commit, own
 * branch/base, lease expectation, marker); the Builder publishes DIRECTLY with Git/gh and its own grant. Loading /pr publishes nothing.
 */
export function publicationPrompt(input: { mode: 'continue' | 'replace'; reason: string; executionId: string; previousExecutionId: string; skillDirectory: string;
  repository: string; base: string; branch: string; head: string; marker: string; ticket: { number: number; url: string }; workId: string; checkout: string;
  expectedRemote: BranchObservation; verified: { reviewedRound: number | null; gates: { id: string; outcome: string }[]; requiredChecks: string[] } }):
  { kind: 'prompt'; prompt: string } | { kind: 'too-large'; bytes: number } {
  const lease = input.expectedRemote.state === 'absent' ? '' : input.expectedRemote.sha;
  const push = input.expectedRemote.state === 'present'
    ? [`2. The remote branch ${input.branch} already holds the verified commit ${input.head}: do NOT push.`]
    : [`2. Push exactly the verified commit with this explicit lease (the remote branch must not exist yet), once:`,
      fenced(`git -C ${input.checkout} push --force-with-lease=refs/heads/${input.branch}:${lease} origin ${input.head}:refs/heads/${input.branch}`)];
  const facts = [`Factory facts (authoritative): Work ${input.workId}; Ticket #${input.ticket.number} ${input.ticket.url}; repository ${input.repository}; base ${input.base}; ` +
    `your branch ${input.branch}; verified commit ${input.head} (content verified at the end of Execution ${input.previousExecutionId}); ` +
    `remote branch before this activation: ${input.expectedRemote.state === 'absent' ? 'absent' : input.expectedRemote.sha}.`,
    `Verification (for the Validation section): reviews round ${input.verified.reviewedRound ?? 'unknown'} applied; gates ${input.verified.gates.length
      ? input.verified.gates.map(gate => `${gate.id}=${gate.outcome}`).join(', ') : 'none declared'}; GitHub required checks still evaluated by GitHub: ${input.verified.requiredChecks.join(', ') || 'none named'}.`];
  const steps = [
    `1. Read ${input.skillDirectory}/skills/pr/SKILL.md with the read tool and draft the body into /artifacts/publication/pr-body.md exactly as it says. Its FIRST line must be:`,
    fenced(input.marker),
    `   and it must contain "Closes #${input.ticket.number}". Do not change, commit, amend, rebase or reset anything in ${input.checkout}: HEAD must stay ${input.head}.`,
    ...push,
    `3. Check that no pull request exists for your branch: gh pr list --repo ${input.repository} --head ${input.branch} --state all --json number,url,isDraft. If one exists, do NOT create another: report it.`,
    `4. Otherwise create ONE draft pull request, once: gh pr create --repo ${input.repository} --draft --base ${input.base} --head ${input.branch} --title "<short title>" --body-file /artifacts/publication/pr-body.md`,
    '5. If a command fails or its outcome is unclear, never repeat it blindly: inspect (git ls-remote origin, gh pr list) and report what you observed.',
    'Never merge, approve, mark ready, close, push to the base or to any other branch, force-push without that explicit lease, or change labels, assignees or other pull requests. ' +
      'End with a short final message (the pull request URL if you created it). The Factory discovers and verifies the publication itself; your message is not evidence.'];
  const prompt = (input.mode === 'continue'
    ? ['publish', `Factory publication request in the SAME session: Execution ${input.executionId} publishes the content verified at the end of Execution ${input.previousExecutionId}. ` +
        'Your workspace, branch, commits and /artifacts were preserved; check the effect of your last tool call before anything else.']
    : [`Factory publication instruction (new session, replacement reason: ${input.reason}): Execution ${input.executionId} publishes the content verified at the end of ` +
        `Execution ${input.previousExecutionId}. Your previous session is not available; your workspace (${input.checkout}), branch, commits and /artifacts are preserved. ` +
        'Before anything else inspect git -C ' + input.checkout + ' log and the remote (git ls-remote origin) and never repeat an earlier effect blindly.']).concat(facts, steps).join('\n');
  const bytes = new TextEncoder().encode(prompt).length;
  return bytes <= publicationPromptBudgetBytes ? { kind: 'prompt', prompt } : { kind: 'too-large', bytes };
}

type WorkFacts = { result: string; execution: ExecutionView | null; previousExecutions?: ExecutionView[]; publication?: PublicationView | null };
const active = (execution: ExecutionView | null) => execution !== null && execution.state !== 'released' && !(execution.state === 'ended' && !execution.slot.held);
/** Whether a publication activation of this Work ever STARTED (a proven non-start is not an attempt). Derived from durable Executions. */
export const publicationAttempted = (work: Pick<WorkFacts, 'execution' | 'previousExecutions'>) =>
  [...(work.previousExecutions ?? []), ...(work.execution ? [work.execution] : [])].some(item => Boolean(item.request.publication) && item.start !== null);
export type PublicationStep = { kind: 'none' } | { kind: 'evaluate'; basisExecutionId: string } |
  { kind: 'discover'; trigger: PublicationDiscovery['trigger']; attempted: boolean };
/**
 * The next publication step of a Work, from its durable record: nothing while an Execution is active or its cessation is not confirmed;
 * evaluate a NEW completed implementation basis; discover when awaiting discovery. `published` and `blocked` are settled (an explicit
 * decision moves them; ticket 26).
 */
export function publicationStep(work: WorkFacts): PublicationStep {
  if (work.result !== 'open' || active(work.execution)) return { kind: 'none' };
  const last = [work.execution, ...[...(work.previousExecutions ?? [])].reverse()].find(item => item?.end) ?? null;
  if (!last?.end || last.end.cessation !== 'confirmed') return { kind: 'none' };
  const publication = work.publication ?? null;
  if (publication?.state === 'published' || publication?.state === 'blocked') return { kind: 'none' };
  if (!last.request.publication && last.end.outcome === 'completed' && publication?.basisExecutionId !== last.executionId) return { kind: 'evaluate', basisExecutionId: last.executionId };
  if (publication?.state === 'awaiting-discovery') {
    const attempted = publicationAttempted(work);
    return { kind: 'discover', trigger: attempted ? 'after-publication' : 'verified', attempted };
  }
  return { kind: 'none' };
}
