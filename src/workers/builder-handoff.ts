import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import type { ToolDefinition } from '#factory-pi';
import type { HandoffDeclarations, ProposalHandoff } from '../contracts/index.js';
import type { ToolContext, ToolProjection } from '../sandbox/index.js';
import { contentProbeCommand, contentProbeSchema, handoffCommand, parseHandoffSummary } from './handoff.js';
import { declarationsMaxBytes, declarationsSchema, gateCommandDocumented, preservedGateSource, type createToolLedger, type Declarations } from './gates.js';

/**
 * A suspended capture of the Builder proposal. Ticket 13: `declarations` are the treatments/gate evidence the Host resolved for this
 * handoff; `closing` marks the Host's own capture after the Builder session ended (no model request), so Control can verify the content
 * the last reviews (or exemption) apply to.
 */
export type HandoffEvent = { round: number; closing?: true; declarations?: HandoffDeclarations } & (
  { status: 'captured'; summary: ProposalHandoff } | { status: 'failure'; code: string; detail?: string }
);
/**
 * Host directive to a suspended Builder: the effective review results of that round, as the continuation of the SAME session.
 * `end` (ticket 13, closing capture only): nothing more for the Builder; the activation completes without another model request.
 */
export type BuilderDirective = {
  kind: 'review-results';
  round: number;
  prompt: string;
  end?: true | undefined;
  /** Ticket 13: the finding ids each reviewer's effective opinion of that round listed (empty for a role without findings or an exemption).
   * The handoff refuses a treatment of a finding that is not listed, before any capture. */
  findings?: ListedFindings | undefined;
};
export type ListedFindings = { standards: string[]; spec: string[] };
/** Ticket 13 multi-round policy: round numbers start at `first` (continuing earlier Executions of the Work) and at most `max` captures
 * (handoffs plus the closing capture) happen in this invocation; one capture is always kept for the closing. */
export type HandoffRounds = {
  first: number;
  max: number;
  /** Real run R-CAND v2: the findings delivered in rounds BEFORE `first` by the Executions this one continues after a Question; the
   * continued session may treat them, so the handoff knows them from the start (Control's durable record, never the model). */
  delivered?: readonly { round: number; standards: readonly string[]; spec: readonly string[] }[] | undefined;
};

const suspendedResult = (text: string) => ({ content: [{ type: 'text' as const, text }], details: { suspended: true }, isError: true, terminate: true });

/**
 * Host-owned handoff state of one Builder invocation. One review round per invocation in this Factory version (ticket 12); a second
 * request is refused with an explicit result, never silently accepted.
 */
export function builderHandoff(
  policy?: HandoffRounds,
  ledger?: ReturnType<typeof createToolLedger>,
  /** Ticket 18: reads one preserved Ticket/instructions file (Host-fixed, confined); null = unreadable. Absent = gate sources not checked. */
  sources?: (path: string) => Promise<string | null>,
) {
  // Gate evidence can only come from the Host ledger; a multi-round policy without it is a composition error, never a silent gap.
  if (policy && !ledger) throw new Error('HANDOFF_LEDGER_REQUIRED');
  let suspended = false,
    pending = false,
    rounds = 0,
    batch = 0;
  // Ticket 13 review fix 1: the model's declarations are stored RAW; the Host resolves them against the capture's content snapshot.
  let declarations: Declarations | undefined;
  // Ticket 13: findings delivered per round (null = a round delivered without a Host list: only the end-of-Execution check applies).
  const listed = new Map<number, { standards: Set<string>; spec: Set<string> } | null>();
  for (const item of policy?.delivered ?? [])
    if (item.round < policy!.first) listed.set(item.round, { standards: new Set(item.standards), spec: new Set(item.spec) });
  const unknownTreatments = (treatments: NonNullable<Declarations['treatments']>) =>
    treatments.flatMap(item => {
      if (!listed.has(item.round)) return [`${item.round}/${item.role}/${item.findingId}`];
      const known = listed.get(item.round);
      return known && !known[item.role].has(item.findingId) ? [`${item.round}/${item.role}/${item.findingId}`] : [];
    });
  const legacy: ToolDefinition = {
    name: 'handoff',
    label: 'handoff',
    executionMode: 'sequential',
    description:
      'Factory review handoff. Call it exactly once, alone, when your proposal is complete in /workspace/checkout (committed or not; a clean ' +
      'tree is not required). The Factory then suspends ALL your tools and turns, records the proposal (index and diffs under /artifacts/review/r<N>/) ' +
      'and runs independent Standards and Spec reviewers. Their effective results (or failures) arrive as your next message; then treat each finding ' +
      '(fix it, or justify not adopting it) and finish. Do not simulate the reviews.',
    promptSnippet: 'handoff: request the Factory Standards/Spec reviews of the complete proposal (once).',
    parameters: Type.Object({}),
    async execute() {
      if (suspended) return suspendedResult('The Factory already suspended your tools for review. Stop now.');
      if (batch !== 1)
        return {
          content: [
            { type: 'text' as const, text: 'HANDOFF_MUST_BE_ALONE: no handoff happened. Call handoff alone, with no other tool call in the same turn.' },
          ],
          details: { refused: true },
          isError: true,
        };
      if (rounds >= 1)
        return {
          content: [{ type: 'text' as const, text: 'Only one review round is available in this Factory version. Finish with your final message.' }],
          details: { refused: true },
          isError: true,
        };
      rounds++;
      suspended = true;
      pending = true;
      return {
        content: [
          { type: 'text' as const, text: `Handoff accepted for review round ${rounds}. Your tools are suspended; stop now and wait for the review results.` },
        ],
        details: { round: rounds },
        terminate: true,
      };
    },
  };
  const refused = (text: string) => ({ content: [{ type: 'text' as const, text }], details: { refused: true }, isError: true });
  // Ticket 13: repeated rounds with treatments and gate declarations; the Host resolves gate evidence from its own ledger.
  const multi: ToolDefinition = {
    ...legacy,
    description:
      'Factory review handoff. Call it alone, when your proposal is complete in /workspace/checkout (committed or not) and after re-running the ' +
      'documented gates as your LAST commands, each ALONE as its own bash call (never inside a compound command; a `run` gate whose last exact call failed or never happened is refused). Arguments: `gates` (ONLY gates whose exact command the Ticket or preserved instructions document — never one to say none exists: id, source document#section, the EXACT bash command you ran, ' +
      'its documented cwd, status run|not-run|waived, a reason when not run/waived, a waiver references its concrete prior authorization, requiredCheck when ' +
      'it is a GitHub required check) and `treatments` (only for every finding the delivered results listed, never a placeholder for a reviewer without findings: round, role, findingId, outcome fixed|not-adopted, justification, ' +
      'optional evidence/authorization). The Factory takes gate results only from its own record of your Bash calls, suspends ALL your tools and turns, ' +
      'records the proposal and decides whether Standards and Spec review it again (any change of content or context) or whether no new round is needed ' +
      '(unchanged content, or a commit holding exactly the reviewed content). Its answer arrives as your next message.',
    promptSnippet: 'handoff: request the Factory Standards/Spec reviews of the complete proposal, with gates and treatments.',
    parameters: Type.Object(
      {
        gates: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
        treatments: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
      },
      { additionalProperties: false },
    ),
    async execute(_callId, args) {
      if (suspended) return suspendedResult('The Factory already suspended your tools for review. Stop now.');
      if (batch !== 1) return refused('HANDOFF_MUST_BE_ALONE: no handoff happened. Call handoff alone, with no other tool call in the same turn.');
      if (rounds >= policy!.max - 1)
        return refused('HANDOFF_ROUND_LIMIT: no more review rounds are available in this activation. Finish with your final message.');
      const parsed = declarationsSchema.safeParse(args ?? {});
      if (!parsed.success)
        return refused(
          `HANDOFF_DECLARATIONS_INVALID: no handoff happened. Fix and call handoff again: ${parsed.error.issues
            .slice(0, 5)
            .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')
            .slice(0, 1500)}`,
        );
      if (Buffer.byteLength(JSON.stringify(parsed.data)) > declarationsMaxBytes)
        return refused('HANDOFF_DECLARATIONS_TOO_LARGE: no handoff happened. Shorten justifications, reasons and commands.');
      const unknown = [...new Set(unknownTreatments(parsed.data.treatments ?? []))];
      if (unknown.length)
        return refused(
          `HANDOFF_TREATMENT_UNKNOWN_FINDING: no handoff happened and no review round was used. Declare treatments ONLY for ` +
            `findings the delivered review results listed (exact round, role and findingId); omit reviewers and rounds without findings. Unknown: ${unknown.slice(0, 16).join(', ')}`.slice(
              0,
              1500,
            ),
        );
      // Ticket 18 (real run q18-v2): every declared gate must carry an executable command its cited preserved source documents; a gate
      // declared only to say it does not exist would make the Execution unverifiable. Refused here, in session, without using a round.
      if (sources) {
        const problems: string[] = [];
        for (const item of parsed.data.gates ?? []) {
          const path = preservedGateSource(item.source);
          if (!path) {
            problems.push(`${item.id}: ${item.source} is not a preserved Ticket/instructions source (/artifacts/spec|instructions/v<N>/<file>#section)`);
            continue;
          }
          const text = await sources(path).catch(() => null);
          if (text === null) problems.push(`${item.id}: ${path} could not be read`);
          else if (!gateCommandDocumented(item.command, text))
            problems.push(`${item.id}: its command is not an executable command documented in ${item.source}`);
        }
        if (problems.length)
          return refused(
            `HANDOFF_GATE_NOT_DOCUMENTED: no handoff happened and no review round was used. Declare ONLY gates whose exact command ` +
              `the Ticket or the preserved instructions document (cite that file#section and run that command); if none is documented, omit gates — never declare a ` +
              `gate to say it does not exist. ${problems.slice(0, 8).join('; ')}`.slice(0, 1500),
          );
      }
      // Real run q21-human-v6 / ticket 56 (pilot 2, #125): a `run` gate is evidenced only by the LATEST bash call of EXACTLY its command, run
      // alone. A declaration with no such call (never run, or only inside a compound command) or whose last exact call did not pass
      // contradicts the Host's own record and would end unverified/failed after a whole round; refused here, in session, with the command.
      // `not-run`/`waived` stay declarable (Control fails them closed); an exhausted ledger already makes every run gate unverified.
      const observed =
        ledger && !ledger.exhausted()
          ? (parsed.data.gates ?? []).filter(item => item.status === 'run').map(item => ({ item, last: ledger.lastExact(item.command) }))
          : [];
      const unrun = observed.filter(entry => entry.last === 'missing').map(entry => entry.item);
      if (unrun.length)
        return refused(
          'HANDOFF_GATE_NOT_RUN: no handoff happened and no review round was used. A gate result is taken only from a bash call of ' +
            'EXACTLY the declared command, run alone (never inside a compound command such as `git commit && <gate>`). If you cannot run it, declare it ' +
            `\`not-run\` with the reason. ${unrun
              .slice(0, 4)
              .map(item => `${item.id}: run exactly this command ALONE as its own bash call, then hand off again: ${item.command}`)
              .join('; ')}`.slice(0, 1500),
        );
      const failed = observed.flatMap(({ item, last }) => (last !== 'missing' && last.exitCode !== 0 ? [{ item, exitCode: last.exitCode }] : []));
      if (failed.length)
        return refused(
          'HANDOFF_GATE_FAILED: no handoff happened and no review round was used. The Factory binds a gate only to your LAST bash ' +
            'call of EXACTLY the declared command, run alone, never inside a compound command (runs such as `git add && git commit && <gate>` or ' +
            '`git status && <gate>` never count). Fix the proposal, run the gate alone as your last command and hand off again; if the failure cannot be ' +
            'resolved, declare it `not-run` with the reason and ask the operator. ' +
            `${failed
              .slice(0, 4)
              .map(
                ({ item, exitCode }) =>
                  `${item.id}: your last bash call of exactly this command ${
                    exitCode === null ? 'ended without an exit code' : `failed (exit ${exitCode})`
                  }; run it ALONE as its own bash call, as your last command, then hand off again: ${item.command}`,
              )
              .join('; ')}`.slice(0, 1500),
        );
      declarations = parsed.data;
      rounds++;
      suspended = true;
      pending = true;
      return {
        content: [
          { type: 'text' as const, text: `Handoff accepted for capture round ${policy!.first + rounds - 1}. Your tools are suspended; stop now and wait.` },
        ],
        details: { round: policy!.first + rounds - 1 },
        terminate: true,
      };
    },
  };
  return {
    tool: policy ? multi : legacy,
    suspended: () => suspended,
    pending: () => pending,
    round: () => (policy?.first ?? 1) + rounds - 1,
    /** The raw declarations of the pending handoff (ticket 13), consumed once and resolved by the Host after the capture. */
    declarations() {
      const value = declarations;
      declarations = undefined;
      return value;
    },
    /** Ticket 13: the Host's closing capture after the session ended, while a capture is left; suspends the tools meanwhile. */
    closing(): number | null {
      if (!policy || pending || rounds >= policy.max) return null;
      rounds++;
      suspended = true;
      return policy.first + rounds - 1;
    },
    /** Ticket 13: the findings the Host delivered for a round (from its directive), before the Builder resumes. */
    listed(round: number, findings: ListedFindings | undefined) {
      listed.set(round, findings ? { standards: new Set(findings.standards), spec: new Set(findings.spec) } : null);
    },
    /** Tool calls of the assistant message being executed (from its message_end, before its tools run). */
    batch(count: number) {
      batch = count;
    },
    resume() {
      pending = false;
      suspended = false;
    },
  };
}

/** Every Builder tool refuses (and ends the batch) while suspended, before any Sandbox call. */
export function suspendable(tool: ToolDefinition, gate: ReturnType<typeof builderHandoff>): ToolDefinition {
  return {
    ...tool,
    async execute(...args: Parameters<ToolDefinition['execute']>) {
      if (gate.suspended()) return suspendedResult('BUILDER_SUSPENDED_FOR_REVIEW: the Factory suspended your tools for review. Stop now.');
      return tool.execute(...args);
    },
  };
}

/** Host-originated fixed capture through the Builder's own binding (no model input); output reaches the Host only via filtered progress. */
export async function captureHandoff(
  context: ToolContext,
  sandbox: ToolProjection,
  round: number,
  baseCommit: string,
  signal: AbortSignal,
  preserve?: string,
): Promise<HandoffEvent> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    const result = await sandbox.executeTool(
      context,
      { name: 'bash', command: handoffCommand(round, baseCommit, preserve), timeout: 300, callId: `handoff-${randomUUID()}` },
      data => {
        bytes += data.length;
        if (bytes <= 65536) chunks.push(Buffer.from(data));
      },
      signal,
    );
    if (result.status !== 'success' || result.format !== 'text' || result.exitCode !== 0) {
      // The constant program always writes one machine line on failure; surface its code/stage (never free text).
      const line = /FACTORY_HANDOFF_ERROR ([A-Z_]{1,32}) ([a-z-]{1,32})/.exec(Buffer.concat(chunks).toString('utf8'));
      return { round, status: 'failure', code: 'HANDOFF_CAPTURE_FAILED', ...(line ? { detail: `${line[1]}:${line[2]}` } : {}) };
    }
    if (bytes > 65536) return { round, status: 'failure', code: 'HANDOFF_CAPTURE_TOO_LARGE' };
    return { round, status: 'captured', summary: parseHandoffSummary(Buffer.concat(chunks).toString('utf8'), round, baseCommit, preserve) };
  } catch {
    return { round, status: 'failure', code: 'HANDOFF_CAPTURE_INVALID' };
  }
}

/**
 * Ticket 13 review fix 1: Host content snapshot of the Builder checkout through the Builder's own binding. The same constant program as
 * the capture, in probe mode (writes nothing). Any failure is an unavailable snapshot, never a guessed identity, so gates fail closed.
 */
export async function probeContent(context: ToolContext, sandbox: ToolProjection, baseCommit: string, signal: AbortSignal): Promise<string | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    const result = await sandbox.executeTool(
      context,
      { name: 'bash', command: contentProbeCommand(baseCommit), timeout: 120, callId: `probe-${randomUUID()}` },
      data => {
        bytes += data.length;
        if (bytes <= 4096) chunks.push(Buffer.from(data));
      },
      signal,
    );
    if (result.status !== 'success' || result.format !== 'text' || result.exitCode !== 0 || bytes > 4096) return null;
    return contentProbeSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).sha256;
  } catch {
    return null;
  }
}

/**
 * Ticket 18: Host-originated fixed read of ONE preserved Ticket/instructions file through the Builder's own binding (no model input; the path
 * is re-validated against the preserved-source pattern, so it cannot carry shell syntax), bounded; a symlink or anything else is unreadable.
 */
export async function readGateSource(context: ToolContext, sandbox: ToolProjection, path: string, signal: AbortSignal): Promise<string | null> {
  if (preservedGateSource(path) !== path) return null;
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    const result = await sandbox.executeTool(
      context,
      { name: 'bash', command: `p='${path}'; [ -f "$p" ] && [ ! -L "$p" ] && head -c 262144 -- "$p"`, timeout: 30, callId: `gate-source-${randomUUID()}` },
      data => {
        bytes += data.length;
        if (bytes <= 262144) chunks.push(Buffer.from(data));
      },
      signal,
    );
    if (result.status !== 'success' || result.format !== 'text' || result.exitCode !== 0 || bytes > 262144) return null;
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  }
}
