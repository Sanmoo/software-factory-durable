import { reviewVerdictFormat, type ConcreteAuthorization, type ProposalHandoff, type ProposalIdentity, type ReviewerRole, type ReviewOpinion } from '../../contracts/index.js';
import type { ReviewRoundView, VerificationView } from '../types.js';

export const reviewerRoles: readonly ReviewerRole[] = ['standards', 'spec'];
export type ReviewPlan = { role: ReviewerRole; invocationId: string; phaseId: string; prompt: string;
  review: { round: number; attempt: number; handoffIndexSha256: string; required: string[]; missing: ('handoff-index' | 'spec-version' | 'instructions-version')[];
    /** Ticket 13: the same role's session of the previous reviewed round, preferred when compatible (the Workers decide and record it). */
    continueFrom?: string } };

/** Pure: the reviewer invocation identities, inputs and prompts of one round (spec §6.4). Spec is never omitted for lack of a source. */
export function planReviews(input: { executionId: string; round: number; attempt: number; handoff: ProposalHandoff;
  previousSessions?: Partial<Record<ReviewerRole, string | null>> }): ReviewPlan[] {
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
    const continueFrom = input.previousSessions?.[role] ?? null;
    return { role, invocationId: `${role}-${input.executionId}-r${round}a${attempt}`, phaseId: `review-r${round}`, prompt,
      review: { round, attempt, handoffIndexSha256: handoff.indexSha256, required, missing, ...(continueFrom ? { continueFrom } : {}) } };
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

/** Pure: the effective results (or failures) delivered to the suspended Builder session, from the durable round record. `multi`
 * (ticket 13): the Builder treats the findings and hands off again with treatments and gates instead of finishing. */
export function deliveryPrompt(input: { round: number; conclusion: string; applicability: string; reasons: string[];
  reviewers: Record<ReviewerRole, { opinion: ReviewOpinion | null; failure: { code: string } | null }>; multi?: boolean }, maxBytes = 40000): string {
  const reviewers = reviewerRoles.map(role => {
    const { opinion, failure } = input.reviewers[role];
    return opinion ? { role, conclusion: opinion.conclusion, code: opinion.code, coverage: opinion.coverage, findings: opinion.findings,
      limitations: opinion.limitations, hostDowngrades: opinion.hostChecks.downgraded, model: opinion.model, opinionReference: opinion.reference.id }
      : { role, conclusion: 'failure', code: failure?.code ?? 'OPINION_MISSING', findings: [] };
  });
  const head = `FACTORY REVIEW RESULTS — round ${input.round}. Round conclusion: ${input.conclusion}; applicability: ${input.applicability}` +
    `${input.reasons.length ? ` (${input.reasons.join(', ')})` : ''}. Your tools are available again.\n` +
    'Treat every finding: fix it, or justify why you do not adopt it (with evidence). A failed, cancelled or incomplete review is NOT zero findings and ' +
    'NOT an approval: state it in your final message. A heuristic is a judgement call, not a mandatory violation. ' + (input.multi
      ? `Then call handoff again, alone, with \`treatments\` for EVERY finding listed above for round ${input.round} (round, role, findingId, outcome ` +
        'fixed|not-adopted, justification, evidence) — a reviewer without findings gets NO treatment, never a placeholder — and your documented `gates` re-run as your LAST commands. The Factory decides whether Standards and Spec review again: any ' +
        'change of content or context gets a new round; unchanged content or a commit holding exactly the reviewed content does not. A requirement doubt, a ' +
        'waiver or an approval required by a skill without a concrete prior authorization is a question for the operator (ask_user), never a guess.\n'
      : 'Do not call handoff again in this Factory version; end with your final message listing each finding id with "fixed" or "not adopted: <justification>".\n');
  // Bounded as ENCODED in the protocol frame (quotes/newlines escape again), not only as raw text.
  const size = (text: string) => Buffer.byteLength(JSON.stringify(text));
  let body = JSON.stringify(reviewers, null, 1);
  if (size(head + body) > maxBytes) body = JSON.stringify(reviewers.map(item => ({ role: item.role, conclusion: item.conclusion, code: item.code,
    findings: item.findings.map(finding => ({ id: finding.id, basis: finding.basis, location: finding.location, summary: finding.summary.slice(0, 200) })) })));
  if (size(head + body) > maxBytes) body = JSON.stringify(reviewers.map(item => ({ role: item.role, conclusion: item.conclusion, code: 'RESULTS_TOO_LARGE_FOR_DELIVERY' })));
  return head + body;
}

type Reviewed = Pick<ReviewRoundView, 'round' | 'kind' | 'conclusion' | 'applicability'> & { handoff: Pick<ReviewRoundView['handoff'], 'summary'> };
export type CaptureClass = { kind: 'review' } | { kind: 'exemption'; exemption: NonNullable<ReviewRoundView['exemption']> };
/** The latest round whose two reviewers actually ran (legacy rounds without `kind` are reviews). */
export const lastReviewed = <T extends Pick<ReviewRoundView, 'kind'>>(rounds: readonly T[]): T | undefined => [...rounds].reverse().find(item => (item.kind ?? 'review') === 'review');

/**
 * Pure (spec §6.4 exceptions): whether a capture needs a new round of both reviewers. No round is needed ONLY when the latest reviewed
 * round concluded with both complete opinions applicable to its content, and this capture demonstrates the same content in the same
 * context (content identity, request/instructions versions, base and merge-base), with a host identity that is observed and consistent:
 * `unchanged` (same HEAD: e.g. only a justification outside the proposal) or `identical-commit` (a new HEAD, clean tree and HEAD holding
 * exactly that content). Anything else, including an unknown identity or a capture of an earlier Factory version, is a new round.
 */
export function classifyCapture(input: { summary: ProposalHandoff; identity: ProposalIdentity | null; rounds: readonly Reviewed[] }): CaptureClass {
  const reviewed = lastReviewed(input.rounds);
  const before = reviewed?.handoff.summary;
  const now = input.summary;
  const same = (a: ProposalHandoff['spec'], b: ProposalHandoff['spec']) => (a?.version ?? null) === (b?.version ?? null) && (a?.sha256 ?? null) === (b?.sha256 ?? null);
  if (!reviewed || !before?.content || !now.content || !['clean', 'findings'].includes(reviewed.conclusion ?? '') || reviewed.applicability !== 'current' ||
      input.identity?.status !== 'observed' || !input.identity.consistent || now.content.sha256 !== before.content.sha256 || !same(now.spec, before.spec) ||
      !same(now.instructions, before.instructions) || now.base !== before.base || now.mergeBase !== before.mergeBase || now.branch !== before.branch) return { kind: 'review' };
  const exemption = { reviewedRound: reviewed.round, head: now.head, reviewedHead: before.head, contentSha256: now.content.sha256 };
  if (now.head === before.head) return { kind: 'exemption', exemption: { kind: 'unchanged', ...exemption } };
  if (now.content.clean && now.content.headMatches) return { kind: 'exemption', exemption: { kind: 'identical-commit', ...exemption } };
  return { kind: 'review' };
}

/** Pure: what the Builder receives when no new round is needed (or, for the closing capture, the ending notice). */
export function exemptionPrompt(input: { round: number; exemption: NonNullable<ReviewRoundView['exemption']>; conclusion: string }): string {
  const why = input.exemption.kind === 'identical-commit'
    ? `commit ${input.exemption.head} holds exactly the content reviewed in round ${input.exemption.reviewedRound} (clean tree, same content identity ${input.exemption.contentSha256})`
    : `the content and context are unchanged since review round ${input.exemption.reviewedRound}`;
  return `FACTORY REVIEW — capture ${input.round}: no new reviewer round is needed: ${why}. The round ${input.exemption.reviewedRound} opinions (conclusion ` +
    `${input.conclusion}) still apply, and your treatments and gates of this capture are recorded. Your tools are available again. If you change anything, ` +
    'call handoff again; otherwise finish with your final message (each finding id with fixed / not adopted: justification, the gates and their real results).';
}

/** A concrete authorization is valid only when Control could CORRELATE it: an answered Question of this Work, or a preserved source that
 * the Host confirmed exists and is listed in that version's sources.json (never a path-prefix guess). */
const authorizationOk = (value: ConcreteAuthorization | null, facts: { workId: string;
  question(id: string): { workId: string; state: 'open' | 'answered' } | null; source(reference: string): boolean }) => {
  if (!value) return true;
  if (value.kind === 'question') { const question = facts.question(value.questionId); return question?.workId === facts.workId && question.state === 'answered'; }
  return facts.source(value.reference.split('#')[0]!);
};

/**
 * Pure end-of-Execution verification (spec §6.4/§9.3): presence and correlation of the two current opinions, the treatment of every
 * finding, the gates and the waivers, over the FINAL captured content. Control never interprets the documents or certifies the sources;
 * absence of evidence is never success; a human waiver never satisfies a GitHub required check.
 */
export function verifyExecution(input: { at: string; workId: string; rounds: readonly ReviewRoundView[];
  question(id: string): { workId: string; state: 'open' | 'answered' } | null;
  /** True only for a preserved source file the Host verified (exists, regular/no-follow, listed in that version's sources.json). */
  source(reference: string): boolean }): VerificationView {
  const reasons: string[] = [];
  const rounds = input.rounds;
  const last = rounds.at(-1);
  const reviewed = lastReviewed(rounds);
  const result = (extra: Partial<VerificationView>): VerificationView => ({ at: input.at, status: reasons.length ? 'not-verified' : 'verified', reasons,
    reviewedRound: reviewed?.round ?? null, finalRound: last?.round ?? null, contentSha256: last?.handoff.summary?.content?.sha256 ?? null,
    applicability: { kind: 'none', head: null, reviewedHead: null }, gates: [], treatments: [], requiredChecks: [], ...extra });
  if (!last || !reviewed) { reasons.push('NO_REVIEW_ROUND'); return result({}); }
  if (!last.closing) reasons.push('CONTENT_AFTER_LAST_CAPTURE_UNKNOWN');
  if (last.handoff.status !== 'captured' || !last.handoff.summary?.content) reasons.push('FINAL_CAPTURE_UNAVAILABLE');
  // The two opinions of the reviewed round: complete, correlated to that round's input, applicable to its content.
  for (const role of reviewerRoles) {
    const opinion = reviewed.reviewers[role].opinion;
    if (!opinion) reasons.push(`${role.toUpperCase()}_OPINION_MISSING`);
    else if (opinion.round !== reviewed.round || opinion.invocationId !== reviewed.reviewers[role].invocationId ||
      opinion.input.handoffIndexSha256 !== reviewed.handoff.summary?.indexSha256) reasons.push(`${role.toUpperCase()}_OPINION_NOT_CORRELATED`);
  }
  if (!['clean', 'findings'].includes(reviewed.conclusion ?? '')) reasons.push('REVIEW_INCOMPLETE');
  if (reviewed.applicability !== 'current') reasons.push('REVIEW_NOT_APPLICABLE');
  let applicability: VerificationView['applicability'] = { kind: 'none', head: null, reviewedHead: null };
  if (last === reviewed) applicability = { kind: 'reviewed', head: reviewed.handoff.summary?.head ?? null, reviewedHead: reviewed.handoff.summary?.head ?? null };
  else if (last.kind === 'exemption' && last.exemption?.reviewedRound === reviewed.round) applicability = { kind: last.exemption.kind, head: last.exemption.head, reviewedHead: last.exemption.reviewedHead };
  else reasons.push('REVIEW_NOT_CURRENT');
  const finalContent = last.handoff.summary?.content?.sha256 ?? null;
  // Every finding of every review round is treated in a LATER capture; the latest treatment counts.
  const treatments: VerificationView['treatments'] = [];
  const facts = { workId: input.workId, question: input.question, source: input.source };
  rounds.forEach((round, position) => {
    if ((round.kind ?? 'review') !== 'review') return;
    const sourceContent = round.handoff.summary?.content?.sha256 ?? null;
    for (const role of reviewerRoles) for (const finding of round.reviewers[role].opinion?.findings ?? []) {
      const later = rounds.slice(position + 1);
      // The FIRST capture that declares a treatment for this finding fixes WHEN it was treated; later restatements do not move it.
      const declaration = later.find(item => (item.declarations?.treatments ?? [])
        .some(candidate => candidate.round === round.round && candidate.role === role && candidate.findingId === finding.id));
      const treatment = declaration?.declarations?.treatments
        .find(candidate => candidate.round === round.round && candidate.role === role && candidate.findingId === finding.id);
      treatments.push({ round: round.round, role, findingId: finding.id, outcome: treatment?.outcome ?? 'missing' });
      const key = `${round.round}/${role}/${finding.id}`;
      if (!treatment || !declaration) { reasons.push(`FINDING_UNTREATED:${key}`); continue; }
      const valid = treatment.authorization === null ? null : authorizationOk(treatment.authorization, facts);
      if (treatment.outcome === 'not-adopted' && finding.basis === 'requirement') {
        // A requirement decision always needs the operator's answered Question; a preserved source is not an approval of a requirement.
        if (treatment.authorization === null) reasons.push(`REQUIREMENT_NON_ADOPTION_NOT_AUTHORIZED:${key}`);
        else if (treatment.authorization.kind !== 'question' || !valid) reasons.push(`AUTHORIZATION_NOT_CORRELATED:${key}`);
      } else if (treatment.authorization !== null && !valid) reasons.push(`AUTHORIZATION_NOT_CORRELATED:${key}`);
      // A fix is a content change: it must be reviewed on different content by a round AFTER the treatment was declared.
      // The declaring capture itself starts the round that reviews the changed content, so `>=` is still strictly after the declaration.
      if (treatment.outcome === 'fixed' && !(sourceContent !== null && rounds.some(item => item.round >= declaration.round && (item.kind ?? 'review') === 'review' &&
          item.handoff.summary?.content?.sha256 && item.handoff.summary.content.sha256 !== sourceContent))) reasons.push(`FIX_NOT_REVIEWED:${key}`);
    }
  });
  for (const round of rounds) for (const item of round.declarations?.treatments ?? []) {
    const source = rounds.find(candidate => candidate.round === item.round && (candidate.kind ?? 'review') === 'review');
    if (!source?.reviewers[item.role].opinion?.findings.some(finding => finding.id === item.findingId)) reasons.push(`TREATMENT_UNKNOWN_FINDING:${item.round}/${item.role}/${item.findingId}`);
  }
  // Gates: the latest declaration, bound to the content it was captured with; only a passed and current real result satisfies a gate.
  const declaring = [...rounds].reverse().find(item => (item.declarations?.gates.length ?? 0) > 0);
  const boundContent = declaring?.handoff.summary?.content?.sha256 ?? null;
  const bound = boundContent !== null && boundContent === finalContent;
  if (!declaring) reasons.push('GATES_NOT_DECLARED');
  else if (!bound) reasons.push('GATES_NOT_BOUND_TO_FINAL_CONTENT');
  const gates = (declaring?.declarations?.gates ?? []).map(gate => {
    if (gate.outcome === 'passed' && !gate.current) reasons.push(`GATE_NOT_CURRENT:${gate.id}`);
    else if (gate.outcome === 'failed') reasons.push(`GATE_FAILED:${gate.id}`);
    else if (gate.outcome === 'unknown') reasons.push(`GATE_RESULT_UNKNOWN:${gate.id}`);
    else if (gate.outcome === 'unverified') reasons.push(`GATE_RESULT_UNVERIFIED:${gate.id}`);
    else if (gate.outcome === 'not-run') reasons.push(`GATE_NOT_RUN:${gate.id}`);
    else if (gate.outcome === 'waived') {
      if (!gate.authorization || !authorizationOk(gate.authorization, facts)) reasons.push(`WAIVER_NOT_AUTHORIZED:${gate.id}`);
      if (gate.requiredCheck) reasons.push(`WAIVER_CANNOT_BYPASS_REQUIRED_CHECK:${gate.id}`);
    }
    return { id: gate.id, outcome: gate.outcome, current: gate.current, boundToFinalContent: bound, requiredCheck: gate.requiredCheck };
  });
  const requiredChecks = [...new Set(gates.flatMap(gate => gate.requiredCheck ? [gate.requiredCheck] : []))];
  return result({ applicability, gates, treatments, requiredChecks });
}
