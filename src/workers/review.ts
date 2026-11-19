import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import type { ReviewerRole, ReviewOpinion } from '../contracts/index.js';

/** Host-trusted reviewer input (spec §6.4), from Control through the Host launch; never from the model. */
/** Ticket 13: how the reviewer's session of a later round was obtained by the owner launcher (never chosen by the model). */
export type ReviewerSession = { mode: 'continued'; from: string; file: string } | { mode: 'replaced'; from: string; code: string };
export type ReviewInput = { round: number; attempt: number; handoffIndexSha256: string; required: readonly string[]; missing: readonly string[];
  /** Ticket 13 (launch input from Control): the same role's session file of the previous round, to continue when compatible. */
  continueFrom?: string | undefined;
  /** Ticket 13 (set by the owner launcher only): the continued copy or the replacement reason. */
  session?: ReviewerSession | undefined };

const text = (max: number) => z.string().min(1).max(max);
// A checkout-relative path (as models write them) is read as /workspace/checkout/<path>; `..` is never accepted.
const guestPath = z.preprocess(value => typeof value === 'string' && !value.startsWith('/') ? `/workspace/checkout/${value}` : value,
  z.string().max(1024).regex(/^\/(workspace|artifacts)\//).refine(path => !path.split('/').some(part => part === '..' || part === '.'))
    .transform(path => posix.normalize(path)));
const finding = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/), basis: z.enum(['rule', 'requirement', 'heuristic']), reference: text(512),
  location: z.strictObject({ path: guestPath, line: z.number().int().positive().max(10_000_000).optional() }), summary: text(800) });
const verdictSchema = z.strictObject({
  role: z.enum(['standards', 'spec']),
  conclusion: z.enum(['clean', 'findings', 'incomplete']),
  coverage: z.strictObject({ scope: z.enum(['incremental', 'broad']), justification: text(1500), examined: z.array(guestPath).max(120) }),
  findings: z.array(finding).max(40),
  limitations: z.array(z.strictObject({ code: z.enum(['SOURCE_UNREADABLE', 'TRUNCATION_NOT_OVERCOME', 'CONTEXT_INSUFFICIENT', 'OTHER']), detail: text(500) })).max(20),
});
/** Bounded so the complete opinion fits one protected record and one protocol frame. */
export const opinionMaxBytes = 20 * 1024;


/**
 * Host observation of the reviewer's native reads (what was actually read, failures and truncation not overcome). A path is fully read
 * when reads starting at line 1 follow each truncation's continuation until one ends without truncation and without a user limit.
 * Ticket 51 (pilot 35): a window asked past the end of a file the reviewer read to its last line (the SDK's "Offset N is beyond end of file")
 * is not a failed source read, whatever the order of the two reads; every failed read that remains names its path and offset.
 */
/** A failed read the Host observed: the path (as read) and, when the reviewer asked for one, the 1-based line offset. */
export type FailedRead = { path: string; code: string; offset?: number };
// The native SDK read refusal for a window starting after the last line (pi-coding-agent core/tools/read.js).
const pastEndMessage = /^Offset \d+ is beyond end of file \(\d+ lines? total\)$/;
export function createReadObserver() {
  const reads = new Map<string, { covered: number; full: boolean }>();
  const failures: FailedRead[] = [];
  const pastEnd: FailedRead[] = [];
  let count = 0;
  const normalize = (path: unknown) => typeof path === 'string' ? posix.normalize(path.startsWith('/') ? path : `/workspace/${path}`) : '';
  return {
    observe(args: unknown, outcome: { details?: unknown; isError?: boolean; content?: readonly { type: string; text?: string }[] } | { error: unknown }) {
      count++;
      const input = (args ?? {}) as { path?: unknown; offset?: unknown; limit?: unknown };
      const path = normalize(input.path);
      // An isError result is a failed read (never coverage), exactly like a thrown one.
      if ('error' in outcome || outcome.isError === true) {
        const error = 'error' in outcome ? outcome.error : undefined;
        // Ticket 13: reading a directory is an answer (READ_IS_DIRECTORY), never a failed source read and never coverage.
        if (error instanceof Error && error.message.startsWith('READ_IS_DIRECTORY')) return;
        // Ticket 14: an absent path is an answer too; a REQUIRED input that is absent is still never fully read (incomplete).
        if (error instanceof Error && error.message.startsWith('READ_NOT_FOUND')) return;
        const message = error instanceof Error ? error.message : ('content' in outcome ? outcome.content ?? [] : []).map(block => block.text ?? '').join('');
        const offset = typeof input.offset === 'number' && Number.isSafeInteger(input.offset) && input.offset > 0 ? { offset: input.offset } : {};
        if (pastEndMessage.test(message)) {
          // Decided at the summary: it is a failed read only if the file was never read to its last line.
          if (pastEnd.length < 50) pastEnd.push({ path: path.slice(0, 1024), code: 'READ_BEYOND_END', ...offset });
          return;
        }
        if (failures.length < 50) failures.push({ path: path.slice(0, 1024), code: error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'READ_FAILED', ...offset });
        return;
      }
      const state = reads.get(path) ?? { covered: 1, full: false };
      const offset = typeof input.offset === 'number' && input.offset > 0 ? input.offset : 1;
      const truncation = (outcome.details as { truncation?: { truncated?: boolean; outputLines?: number } } | undefined)?.truncation;
      if (offset <= state.covered) {
        if (truncation?.truncated === true) state.covered = Math.max(state.covered, offset + (truncation.outputLines ?? 0));
        else if (input.limit === undefined) state.full = true;
        else {
          // Real run q21-human-v8: a limited read is full when the file ENDED inside the window — the SDK then returns it without
          // truncation and without its "[N more lines in file. Use offset=X to continue.]" notice; with the notice, coverage moves to X.
          const text = ('content' in outcome ? outcome.content ?? [] : []).map(block => block.text ?? '').join('');
          const more = /\n\[\d+ more lines in file\. Use offset=(\d+) to continue\.\]$/.exec(text);
          if (more) state.covered = Math.max(state.covered, Number(more[1]));
          else state.full = true;
        }
      }
      reads.set(path, state);
    },
    summary(required: readonly string[]) {
      const unread = pastEnd.filter(item => !reads.get(item.path)?.full);
      return { reads: count, failedReads: [...failures, ...unread].slice(0, 50), requiredNotFullyRead: required.filter(path => !reads.get(path)?.full) };
    },
  };
}

/**
 * Builds the complete opinion from the reviewer's FINAL assistant message (never a streamed partial). The Host checks can only downgrade:
 * an unreadable source, a required input not fully read, missing context or a declared limitation prevents a clean conclusion; a
 * missing/invalid verdict is a failure, never zero findings.
 */
export function composeOpinion(input: { role: ReviewerRole; invocationId: string; review: ReviewInput; status: 'completed' | 'interrupted';
  finalText: string | null; sessionFile: string | null; sessionMode?: { mode: 'new' | 'continued' | 'replaced'; from: string | null; code: string | null }; model: { providerId: string; modelId: string }; profile: { id: string; modelBudget: string | null };
  host: ReturnType<ReturnType<typeof createReadObserver>['summary']> }): Omit<ReviewOpinion, 'reference' | 'recordedAt'> {
  const base = { version: 1 as const, role: input.role, round: input.review.round, attempt: input.review.attempt, invocationId: input.invocationId,
    session: { file: input.sessionFile, ...(input.sessionMode ?? {}) }, model: input.model, profile: input.profile,
    input: { handoffIndexSha256: input.review.handoffIndexSha256, required: [...input.review.required], missing: [...input.review.missing] },
    finalMessageSha256: input.finalText === null ? null : createHash('sha256').update(input.finalText).digest('hex') };
  const hostChecks = { ...input.host, downgraded: [] as string[] };
  const failed = (conclusion: 'failure' | 'cancelled', code: string) => ({ ...base, conclusion, code, coverage: null, findings: [], limitations: [], hostChecks });
  if (input.status !== 'completed') return failed('cancelled', 'REVIEWER_INTERRUPTED');
  // The WHOLE final message is the verdict: a bare JSON object, or exactly one fenced block holding it. Never extracted from prose.
  const message = (input.finalText ?? '').trim();
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n[ \t]*```$/.exec(message);
  const candidate = message.startsWith('{') ? message : fenced && !fenced[1]!.includes('```') ? fenced[1]!.trim() : null;
  let verdict: z.infer<typeof verdictSchema>;
  try {
    if (candidate === null || !candidate.startsWith('{')) throw new Error('not a verdict');
    verdict = verdictSchema.parse(JSON.parse(candidate));
  } catch { return failed('failure', 'REVIEW_VERDICT_INVALID'); }
  if (verdict.role !== input.role) return failed('failure', 'REVIEW_VERDICT_ROLE_MISMATCH');
  // Spec judges the preserved request; Standards judges preserved instructions and must keep heuristics distinct from documented rules.
  if (verdict.findings.some(item => input.role === 'spec' ? item.basis !== 'requirement' : item.basis === 'requirement')) return failed('failure', 'REVIEW_VERDICT_BASIS_INVALID');
  let conclusion: ReviewOpinion['conclusion'] = verdict.conclusion;
  if (conclusion === 'clean' && verdict.findings.length) conclusion = 'findings';
  const reasons = [
    ...(verdict.limitations.length ? ['REVIEWER_DECLARED_LIMITATION'] : []),
    ...(hostChecks.failedReads.length ? ['SOURCE_UNREADABLE'] : []),
    ...(hostChecks.requiredNotFullyRead.length ? ['REQUIRED_INPUT_NOT_FULLY_READ'] : []),
    ...(input.review.missing.length ? ['CONTEXT_INSUFFICIENT'] : []),
  ];
  if (reasons.length && conclusion !== 'incomplete') { hostChecks.downgraded = reasons; conclusion = 'incomplete'; }
  const opinion = { ...base, conclusion, code: null, coverage: verdict.coverage, findings: verdict.findings.map(item => ({ ...item, location: item.location.line === undefined ? { path: item.location.path } : { path: item.location.path, line: item.location.line } })),
    limitations: verdict.limitations, hostChecks };
  if (Buffer.byteLength(JSON.stringify(opinion)) > opinionMaxBytes) return failed('failure', 'REVIEW_VERDICT_TOO_LARGE');
  return opinion;
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Facade validation of a forwarded opinion (the Host never trusts the hop); same bounds as composition. */
export const opinionSchema = z.strictObject({
  version: z.literal(1), role: z.enum(['standards', 'spec']), round: z.number().int().min(1).max(99), attempt: z.number().int().min(1).max(9),
  invocationId: z.string().max(128), reference: z.strictObject({ workId: z.string().max(128), id: z.uuid() }),
  session: z.strictObject({ file: z.string().max(4096).nullable(), mode: z.enum(['new', 'continued', 'replaced']).optional(),
    from: z.string().max(4096).nullable().optional(), code: z.string().regex(/^[A-Z_]{1,64}$/).nullable().optional() }), model: z.strictObject({ providerId: z.string().max(128), modelId: z.string().max(128) }),
  profile: z.strictObject({ id: z.string().max(128), modelBudget: z.string().max(64).nullable() }),
  input: z.strictObject({ handoffIndexSha256: z.string().regex(/^[0-9a-f]{64}$/), required: z.array(z.string().max(1024)).max(32), missing: z.array(z.string().max(64)).max(3) }),
  conclusion: z.enum(['clean', 'findings', 'incomplete', 'failure', 'cancelled']), code: z.string().regex(/^[A-Z_]{1,64}$/).nullable(),
  coverage: verdictSchema.shape.coverage.nullable(), findings: z.array(finding).max(40), limitations: verdictSchema.shape.limitations,
  hostChecks: z.strictObject({ reads: count, failedReads: z.array(z.strictObject({ path: z.string().max(1024), code: z.string().max(64),
    offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() })).max(50),
    requiredNotFullyRead: z.array(z.string().max(1024)).max(32), downgraded: z.array(z.string().max(64)).max(8) }),
  finalMessageSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(), recordedAt: z.iso.datetime(),
});
