import { z } from 'zod';
import type { ConcreteAuthorization, FindingTreatment, GateEvidence, HandoffDeclarations } from '../contracts/index.js';

const text = (max: number) => z.string().min(1).max(max);
const authorization = z.union([
  z.strictObject({ kind: z.literal('question'), questionId: z.uuid() }),
  z.strictObject({ kind: z.literal('preserved-source'), reference: z.string().max(1024).regex(/^\/artifacts\/(spec|instructions)\/v[1-9][0-9]{0,3}\/[^#]+(#.*)?$/)
    .refine(path => !path.split('#')[0]!.split('/').some(part => part === '..' || part === '.')) }),
]);
const treatment = z.strictObject({ round: z.number().int().min(1).max(99), role: z.enum(['standards', 'spec']), findingId: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/),
  outcome: z.enum(['fixed', 'not-adopted']), justification: text(800), evidence: text(400).optional(), authorization: authorization.optional() });
const gate = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_.-]{1,48}$/), source: text(256), command: text(2048), cwd: text(256),
  status: z.enum(['run', 'not-run', 'waived']), reason: text(500).optional(), authorization: authorization.optional(), requiredCheck: text(128).optional() })
  .refine(item => item.status === 'run' || item.reason !== undefined, 'a gate not run or waived states its reason')
  .refine(item => item.status !== 'waived' || item.authorization !== undefined, 'a waiver references its concrete prior authorization');
/** Model input of the `handoff` tool (ticket 13); validated by the Host before any capture, never trusted as evidence by itself. */
export const declarationsSchema = z.strictObject({ treatments: z.array(treatment).max(40).optional(), gates: z.array(gate).max(16).optional() })
  .refine(value => new Set((value.gates ?? []).map(item => item.id)).size === (value.gates ?? []).length, 'gate ids are unique')
  .refine(value => new Set((value.treatments ?? []).map(item => `${item.round}/${item.role}/${item.findingId}`)).size === (value.treatments ?? []).length, 'one treatment per finding');
export type Declarations = z.infer<typeof declarationsSchema>;
/** Resolved declarations travel inside one handoff notice with the capture summary (owner relay bound 32 KiB, protocol frame 64 KiB). */
export const declarationsMaxBytes = 16 * 1024;

const reference = z.strictObject({ workId: z.string().min(1).max(128), id: z.uuid() });
/** The RESOLVED declarations as relayed by the owner to the Host facade (strict; produced by the Builder host, re-checked by Control). */
export const resolvedDeclarationsSchema = z.strictObject({
  treatments: z.array(z.strictObject({ round: z.number().int().min(1).max(99), role: z.enum(['standards', 'spec']), findingId: z.string().regex(/^[A-Za-z0-9_.-]{1,32}$/),
    outcome: z.enum(['fixed', 'not-adopted']), justification: text(800), evidence: text(400).nullable(), authorization: authorization.nullable() })).max(40),
  gates: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_.-]{1,48}$/), source: text(256), command: text(2048), cwd: text(256), requiredCheck: text(128).nullable(),
    declared: z.enum(['run', 'not-run', 'waived']), outcome: z.enum(['passed', 'failed', 'unknown', 'unverified', 'not-run', 'waived']),
    code: z.string().regex(/^[A-Z_]{1,64}$/).nullable(), exitCode: z.number().int().min(0).max(255).nullable(), output: reference.nullable(),
    sequence: z.number().int().positive().nullable(), current: z.boolean(), reason: text(500).nullable(), authorization: authorization.nullable() })).max(16),
});

type BashEntry = { sequence: number; command: string; exitCode: number | null; output: { workId: string; id: string } | null; code: string | null };
const mutating = new Set(['write', 'edit', 'bash']);

/**
 * Host ledger of the Builder's own tool executions in ONE invocation (order and real Bash results). It is the only source of gate
 * evidence: the protected result of the Bash call (exit code + protected output reference) the Host itself observed.
 */
export function createToolLedger() {
  let sequence = 0;
  const calls: { sequence: number; name: string; callId: string; bash?: BashEntry }[] = [];
  return {
    /** A tool execution starts (before any effect), keyed by the SDK tool call id; bounded. */
    begin(name: string, callId: string) { if (calls.length < 4096) calls.push({ sequence: ++sequence, name, callId }); },
    /** The Builder Bash outcome observed by the Host: a real exit code and protected output, or a lost/unknown result. */
    bash(callId: string, entry: Omit<BashEntry, 'sequence'>) {
      const call = [...calls].reverse().find(item => item.callId === callId && item.name === 'bash');
      if (call && !call.bash) call.bash = { ...entry, sequence: call.sequence };
    },
    /** Resolves declared gates against the ledger: evidence comes from the latest Bash call with EXACTLY the declared command. */
    resolve(input: Declarations): HandoffDeclarations {
      const declared = input.gates ?? [];
      const evidence = (item: (typeof declared)[number]) => {
        const auth: ConcreteAuthorization | null = item.authorization ?? null;
        const base = { id: item.id, source: item.source, command: item.command, cwd: item.cwd, requiredCheck: item.requiredCheck ?? null, declared: item.status,
          reason: item.reason ?? null, authorization: auth, exitCode: null, output: null, sequence: null, current: false };
        if (item.status !== 'run') return { ...base, outcome: item.status, code: null };
        const match = [...calls].reverse().find(call => call.bash?.command === item.command)?.bash;
        if (!match) return { ...base, outcome: 'unverified' as const, code: 'GATE_RESULT_NOT_FOUND' };
        return { ...base, exitCode: match.exitCode, output: match.output, sequence: match.sequence, current: true,
          outcome: match.exitCode === null ? 'unknown' as const : match.exitCode === 0 ? 'passed' as const : 'failed' as const, code: match.code };
      };
      const gates: GateEvidence[] = declared.map(evidence);
      const gateCalls = new Set(gates.flatMap(item => item.sequence === null ? [] : [item.sequence]));
      for (const item of gates) {
        if (item.sequence === null) continue;
        // Correlated with the captured content only if nothing that may change it ran after it (other declared gate runs excepted).
        const later = calls.find(call => call.sequence > item.sequence! && mutating.has(call.name) && !gateCalls.has(call.sequence));
        if (later) { item.current = false; item.code ??= 'GATE_NOT_CURRENT'; }
      }
      const treatments: FindingTreatment[] = (input.treatments ?? []).map(item => ({ round: item.round, role: item.role, findingId: item.findingId, outcome: item.outcome,
        justification: item.justification, evidence: item.evidence ?? null, authorization: item.authorization ?? null }));
      return { treatments, gates };
    },
  };
}
