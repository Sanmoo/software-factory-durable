import { reviewVerdictFormat, type ProposalHandoff, type ProposalIdentity, type ReviewerRole, type ReviewOpinion } from '../../contracts/index.js';

export const reviewerRoles: readonly ReviewerRole[] = ['standards', 'spec'];
export type ReviewPlan = { role: ReviewerRole; invocationId: string; phaseId: string; prompt: string;
  review: { round: number; attempt: number; handoffIndexSha256: string; required: string[]; missing: ('handoff-index' | 'spec-version' | 'instructions-version')[] } };

/** Pure: the reviewer invocation identities, inputs and prompts of one round (spec §6.4). Spec is never omitted for lack of a source. */
export function planReviews(input: { executionId: string; round: number; attempt: number; handoff: ProposalHandoff }): ReviewPlan[] {
  const { handoff, round, attempt } = input;
  return reviewerRoles.map(role => {
    const preserved = role === 'spec' ? handoff.spec : handoff.instructions;
    const missing = preserved ? [] : [role === 'spec' ? 'spec-version' as const : 'instructions-version' as const];
    // Required = must be read COMPLETELY (truncation continued) for a clean conclusion: index, preserved sources, non-empty patches, changed files.
    const patches = (['committed', 'staged', 'unstaged'] as const).map(name => handoff.patches[name]).filter(patch => patch.bytes > 0).map(patch => patch.path);
    const required = [handoff.index, ...(preserved ? [preserved.sources] : []), ...patches, ...handoff.changed].slice(0, 32);
    const sources = preserved
      ? `${preserved.sources} (version ${preserved.version}, sha256 ${preserved.sha256}) and the preserved copies it lists in the same directory`
      : `NONE: no complete preserved ${role === 'spec' ? 'request (spec/vN)' : 'instructions (instructions/vN)'} version was found; this context is insufficient`;
    const axis = role === 'spec'
      ? 'Judge the proposal ONLY against the preserved request (the Ticket and the documents it explicitly references): requirements missing or partial, ' +
        'behaviour not asked for, and requirements that look wrong. Every finding has basis "requirement" and references the preserved source (path#section). ' +
        'Auxiliary documentation is not a requirement.'
      : 'Judge the proposal against the preserved instructions (AGENTS/CLAUDE files and documented standards). A documented rule gives basis "rule" ' +
        'referencing the preserved instruction (path#section). A smell from the baseline (Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, ' +
        'Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, Message Chains, Middle Man, Refused Bequest) ' +
        'is a judgement call: basis "heuristic", never presented as a violation. A documented repository standard overrides the baseline. Skip what tooling enforces.';
    const prompt = [
      `You are the Factory ${role === 'spec' ? 'Spec' : 'Standards'} reviewer of review round ${round} (attempt ${attempt}) of Execution ${input.executionId}.`,
      'You have ONLY the read tool (paths under /workspace and /artifacts; use offset/limit to continue a truncated read; images are supported). You cannot run ' +
        'commands, list directories, search, write or reach the network: the proposal index lists every changed path. Never ask for more tools.',
      `Proposal index: ${handoff.index} (sha256 ${handoff.indexSha256}). Patches: committed ${handoff.patches.committed.path}, staged ${handoff.patches.staged.path}, ` +
        `unstaged ${handoff.patches.unstaged.path}. Checkout /workspace/checkout, branch ${handoff.branch ?? '(detached)'}, head ${handoff.head}, base ${handoff.base}.`,
      `Preserved sources for your axis: ${sources}.`,
      axis,
      `Required inputs (read every required input completely, following each truncation's offset until the end): ${required.join(', ')}` +
        `${handoff.changedTruncated ? ' (more changed files are listed in the index)' : ''}.`,
      'Read the index first, then the patches, then every changed file in full and whatever context beyond the hunks you need. Declare your coverage scope ' +
        '(incremental or broad) with a justification and the paths you examined. If a needed source is missing or unreadable, a read stays truncated, or the ' +
        'context is insufficient, list it under limitations and conclude "incomplete".',
      reviewVerdictFormat,
    ].join('\n\n');
    return { role, invocationId: `${role}-${input.executionId}-r${round}a${attempt}`, phaseId: `review-r${round}`, prompt,
      review: { round, attempt, handoffIndexSha256: handoff.indexSha256, required, missing } };
  });
}

/**
 * Pure round conclusion. Clean ONLY when both opinions are complete and clean AND the Host identity of the proposal was consistent at
 * handoff and unchanged after the reviewers ended. A failure, cancellation, incomplete opinion or unknown/changed identity is never clean;
 * a missing opinion is never treated as zero findings.
 */
export function concludeRound(input: { opinions: Partial<Record<ReviewerRole, ReviewOpinion | null>>; before: ProposalIdentity | null; after: ProposalIdentity | null }) {
  const reasons: string[] = [];
  const { before, after } = input;
  let applicability: 'current' | 'invalidated' | 'unknown';
  if (before?.status !== 'observed' || after?.status !== 'observed') applicability = 'unknown';
  else applicability = before.sha256 === after.sha256 ? 'current' : 'invalidated';
  if (applicability === 'invalidated') reasons.push('PROPOSAL_CHANGED_DURING_REVIEW');
  if (applicability === 'unknown') reasons.push('PROPOSAL_IDENTITY_UNKNOWN');
  if (before?.status === 'observed' && !before.consistent) reasons.push('PROPOSAL_IDENTITY_INCONSISTENT');
  let findings = false;
  for (const role of reviewerRoles) {
    const opinion = input.opinions[role] ?? null;
    if (!opinion) { reasons.push(`${role.toUpperCase()}_OPINION_MISSING`); continue; }
    if (opinion.conclusion === 'findings') findings = true;
    else if (opinion.conclusion !== 'clean') reasons.push(`${role.toUpperCase()}_${opinion.conclusion.toUpperCase()}`);
  }
  const conclusion: 'clean' | 'findings' | 'incomplete' = reasons.length ? 'incomplete' : findings ? 'findings' : 'clean';
  return { applicability, conclusion, reasons };
}

/** Pure: the effective results (or failures) delivered to the suspended Builder session, from the durable round record. */
export function deliveryPrompt(input: { round: number; conclusion: string; applicability: string; reasons: string[];
  reviewers: Record<ReviewerRole, { opinion: ReviewOpinion | null; failure: { code: string } | null }> }, maxBytes = 40000): string {
  const reviewers = reviewerRoles.map(role => {
    const { opinion, failure } = input.reviewers[role];
    return opinion ? { role, conclusion: opinion.conclusion, code: opinion.code, coverage: opinion.coverage, findings: opinion.findings,
      limitations: opinion.limitations, hostDowngrades: opinion.hostChecks.downgraded, model: opinion.model, opinionReference: opinion.reference.id }
      : { role, conclusion: 'failure', code: failure?.code ?? 'OPINION_MISSING', findings: [] };
  });
  const head = `FACTORY REVIEW RESULTS — round ${input.round}. Round conclusion: ${input.conclusion}; applicability: ${input.applicability}` +
    `${input.reasons.length ? ` (${input.reasons.join(', ')})` : ''}. Your tools are available again.\n` +
    'Treat every finding: fix it, or justify why you do not adopt it (with evidence). A failed, cancelled or incomplete review is NOT zero findings and ' +
    'NOT an approval: state it in your final message. A heuristic is a judgement call, not a mandatory violation. Do not call handoff again in this ' +
    'Factory version; end with your final message listing each finding id with "fixed" or "not adopted: <justification>".\n';
  // Bounded as ENCODED in the protocol frame (quotes/newlines escape again), not only as raw text.
  const size = (text: string) => Buffer.byteLength(JSON.stringify(text));
  let body = JSON.stringify(reviewers, null, 1);
  if (size(head + body) > maxBytes) body = JSON.stringify(reviewers.map(item => ({ role: item.role, conclusion: item.conclusion, code: item.code,
    findings: item.findings.map(finding => ({ id: finding.id, basis: finding.basis, location: finding.location, summary: finding.summary.slice(0, 200) })) })));
  if (size(head + body) > maxBytes) body = JSON.stringify(reviewers.map(item => ({ role: item.role, conclusion: item.conclusion, code: 'RESULTS_TOO_LARGE_FOR_DELIVERY' })));
  return head + body;
}
