import { z } from 'zod';
import type { ConcreteAuthorization, FindingTreatment, HandoffDeclarations } from '../contracts/index.js';

const text = (max: number) => z.string().min(1).max(max);
const authorization = z.union([
  z.strictObject({ kind: z.literal('question'), questionId: z.uuid() }),
  z.strictObject({
    kind: z.literal('preserved-source'),
    reference: z
      .string()
      .max(1024)
      .regex(/^\/artifacts\/(spec|instructions)\/v[1-9][0-9]{0,3}\/[^#]+(#.*)?$/)
      .refine(
        path =>
          !path
            .split('#')[0]!
            .split('/')
            .some(part => part === '..' || part === '.'),
      ),
  }),
]);
const treatment = z.strictObject({
  round: z.number().int().min(1).max(99),
  role: z.enum(['standards', 'spec']),
  findingId: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/),
  outcome: z.enum(['fixed', 'not-adopted']),
  justification: text(800),
  evidence: text(400).optional(),
  authorization: authorization.optional(),
});
const gate = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_.-]{1,48}$/),
    source: text(256),
    command: text(2048),
    cwd: text(256),
    status: z.enum(['run', 'not-run', 'waived']),
    reason: text(500).optional(),
    authorization: authorization.optional(),
    requiredCheck: text(128).optional(),
  })
  .refine(item => item.status === 'run' || item.reason !== undefined, 'a gate not run or waived states its reason')
  .refine(item => item.status !== 'waived' || item.authorization !== undefined, 'a waiver references its concrete prior authorization');
/** Model input of the `handoff` tool (ticket 13); validated by the Host before any capture, never trusted as evidence by itself. */
export const declarationsSchema = z
  .strictObject({ treatments: z.array(treatment).max(40).optional(), gates: z.array(gate).max(16).optional() })
  .refine(value => new Set((value.gates ?? []).map(item => item.id)).size === (value.gates ?? []).length, 'gate ids are unique')
  .refine(
    value => new Set((value.treatments ?? []).map(item => `${item.round}/${item.role}/${item.findingId}`)).size === (value.treatments ?? []).length,
    'one treatment per finding',
  );
export type Declarations = z.infer<typeof declarationsSchema>;
/** Resolved declarations travel inside one handoff notice with the capture summary (owner relay bound 32 KiB, protocol frame 64 KiB). */
export const declarationsMaxBytes = 16 * 1024;

const reference = z.strictObject({ workId: z.string().min(1).max(128), id: z.uuid() });
/** The RESOLVED declarations as relayed by the owner to the Host facade (strict; produced by the Builder host, re-checked by Control). */
export const resolvedDeclarationsSchema = z.strictObject({
  treatments: z
    .array(
      z.strictObject({
        round: z.number().int().min(1).max(99),
        role: z.enum(['standards', 'spec']),
        findingId: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/),
        outcome: z.enum(['fixed', 'not-adopted']),
        justification: text(800),
        evidence: text(400).nullable(),
        authorization: authorization.nullable(),
      }),
    )
    .max(40),
  gates: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9_.-]{1,48}$/),
        source: text(256),
        command: text(2048),
        cwd: text(256),
        requiredCheck: text(128).nullable(),
        declared: z.enum(['run', 'not-run', 'waived']),
        outcome: z.enum(['passed', 'failed', 'unknown', 'unverified', 'not-run', 'waived']),
        code: z
          .string()
          .regex(/^[A-Z_]{1,64}$/)
          .nullable(),
        exitCode: z.number().int().min(0).max(255).nullable(),
        output: reference.nullable(),
        sequence: z.number().int().positive().nullable(),
        current: z.boolean(),
        reason: text(500).nullable(),
        authorization: authorization.nullable(),
      }),
    )
    .max(16),
});

/** The Host's own observation of one Builder Bash execution: the protected result plus the content snapshot taken around it. */
export type BashObservation = {
  command: string;
  cwd: string;
  exitCode: number | null;
  output: { workId: string; id: string } | null;
  code: string | null;
  contentBeforeSha: string | null;
  contentAfterSha: string | null;
};
const maxCalls = 4096;

/**
 * Host ledger of the Builder's own tool executions in ONE invocation and of the real Bash results (exit code + protected output
 * reference + content snapshots taken by the Host before and after each command). It is the only source of gate evidence.
 *
 * Order is the start order reported by the SDK. Bash is sequential, so Bash-to-Bash order is exact; write/edit may overlap, so their
 * relative order with a Bash call is only bounded by start time. Gate validity does not depend on that order: a gate is current only by
 * CONTENT (the command changed nothing and the captured proposal still has exactly the content it ran on), never by tool names.
 * The ledger is bounded; when full, every declared run gate is explicitly unverified (GATE_LEDGER_EXHAUSTED), never silently stale.
 */
export function createToolLedger(options: { maxCalls?: number } = {}) {
  const limit = options.maxCalls ?? maxCalls;
  let sequence = 0;
  let exhausted = false;
  const calls: { sequence: number; name: string; callId: string; bash?: BashEntry }[] = [];
  type BashEntry = Omit<BashObservation, never> & { sequence: number };
  return {
    /** A tool execution starts (before any effect), keyed by the SDK tool call id. */
    begin(name: string, callId: string) {
      if (calls.length >= limit) {
        exhausted = true;
        return;
      }
      calls.push({ sequence: ++sequence, name, callId });
    },
    /** The Builder Bash outcome observed by the Host: a real result or a lost one, with the content snapshots around the command. */
    bash(callId: string, entry: BashObservation) {
      const call = [...calls].reverse().find(item => item.callId === callId && item.name === 'bash');
      if (call && !call.bash) call.bash = { ...entry, sequence: call.sequence };
    },
    exhausted: () => exhausted,
    /** Real run q21-human-v6 / ticket 56: the result of the LATEST Bash call of EXACTLY `command` (the same one `resolve` binds a `run`
     * gate to), or `missing` when that command never ran alone — also when it ran only EMBEDDED (inside a larger script or with another
     * prefix/suffix), which is never evidence. `exitCode` null = the command ran but its result was lost (timeout, transport). */
    lastExact: (command: string): { exitCode: number | null } | 'missing' => {
      const match = [...calls].reverse().find(call => call.bash?.command === command)?.bash;
      return match ? { exitCode: match.exitCode } : 'missing';
    },
    /**
     * Resolves declared gates against the ledger. A `run` gate takes its exit code/protected output from the LATEST Bash call with
     * exactly the declared command and is `current` only when: the declared cwd is the ACTUAL cwd, both content snapshots exist, the
     * command itself did not change the content (before === after) and the captured proposal still has that content (after === capture).
     */
    resolve(input: Declarations, facts: { captureContentSha: string | null }): HandoffDeclarations {
      const declared = input.gates ?? [];
      const evidence = (item: (typeof declared)[number]) => {
        const auth: ConcreteAuthorization | null = item.authorization ?? null;
        const base = {
          id: item.id,
          source: item.source,
          command: item.command,
          cwd: item.cwd,
          requiredCheck: item.requiredCheck ?? null,
          declared: item.status,
          reason: item.reason ?? null,
          authorization: auth,
          exitCode: null,
          output: null,
          sequence: null,
          current: false,
        };
        if (item.status !== 'run') return { ...base, outcome: item.status, code: null };
        if (exhausted) return { ...base, outcome: 'unverified' as const, code: 'GATE_LEDGER_EXHAUSTED' };
        const match = [...calls].reverse().find(call => call.bash?.command === item.command)?.bash;
        if (!match) return { ...base, outcome: 'unverified' as const, code: 'GATE_RESULT_NOT_FOUND' };
        let currentCode: string | null = null;
        if (match.cwd !== item.cwd) currentCode = 'GATE_CWD_MISMATCH';
        else if (facts.captureContentSha === null) currentCode = 'GATE_CONTENT_UNAVAILABLE';
        else if (match.contentBeforeSha === null || match.contentAfterSha === null) currentCode = 'GATE_SNAPSHOT_UNAVAILABLE';
        else if (match.contentBeforeSha !== match.contentAfterSha) currentCode = 'GATE_MUTATED_CONTENT';
        else if (match.contentAfterSha !== facts.captureContentSha) currentCode = 'GATE_NOT_CURRENT';
        return {
          ...base,
          exitCode: match.exitCode,
          output: match.output,
          sequence: match.sequence,
          current: currentCode === null,
          outcome: match.exitCode === null ? ('unknown' as const) : match.exitCode === 0 ? ('passed' as const) : ('failed' as const),
          code: match.code ?? currentCode,
        };
      };
      const treatments: FindingTreatment[] = (input.treatments ?? []).map(item => ({
        round: item.round,
        role: item.role,
        findingId: item.findingId,
        outcome: item.outcome,
        justification: item.justification,
        evidence: item.evidence ?? null,
        authorization: item.authorization ?? null,
      }));
      return { treatments, gates: declared.map(evidence) };
    },
  };
}

/** The preserved Ticket/instructions file a gate source may cite (`/artifacts/(spec|instructions)/v<N>/<file>[#section]`), or null. */
export function preservedGateSource(source: string): string | null {
  const path = source.split('#')[0]!;
  return /^\/artifacts\/(spec|instructions)\/v[1-9][0-9]{0,3}\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path) &&
    !path.split('/').some(part => part === '..' || part === '.')
    ? path
    : null;
}

/** Command snippets a source documents: inline code spans and fenced block lines (also inside the string values of a JSON Ticket). */
function documentedCommands(source: string): string[] {
  let texts = [source];
  try {
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(JSON.parse(source));
    if (strings.length) texts = strings;
  } catch {
    /* not JSON: the text itself */
  }
  const snippets: string[] = [];
  for (const text of texts) {
    for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) snippets.push(...block[1]!.split('\n'));
    for (const span of text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)) snippets.push(span[1]!);
  }
  return snippets.map(normalize).filter(Boolean);
}
const normalize = (command: string) => command.replace(/\s+/g, ' ').trim();
const directoryChange = /^cd \S+$/;

/**
 * Ticket 18: whether a declared gate command is an executable command its cited source documents — the whole command is a documented
 * snippet, or one of its `&&`/`;` segments other than a bare directory change is. Prose ("Not applicable: …") never is.
 */
export function gateCommandDocumented(command: string, source: string): boolean {
  const declared = normalize(command);
  if (!declared || /^(not applicable|n\/a|none|no |there is no|nothing)/i.test(declared)) return false;
  const snippets = new Set(documentedCommands(source).filter(snippet => !directoryChange.test(snippet)));
  if (snippets.has(declared) && !directoryChange.test(declared)) return true;
  return declared.split(/\s*(?:&&|;)\s*/).some(segment => !directoryChange.test(segment) && snippets.has(normalize(segment)));
}
