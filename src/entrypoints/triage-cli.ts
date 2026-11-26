// Spec #68 §10 (ticket #80): the `factory triages` and `factory triage ...` commands. `triage <id or Ticket reference>` shows one Triage
// request; every other form is `triage <subcommand> <id> ...`, one entry of `triageSubcommands`: an entry names its own flags and
// builds its payload. Ticket #81: the interventions `cancel`, `release` and `complete`, which also take a Ticket reference.
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { triageAttemptPattern, triageReferencePattern } from '../contracts/index.js';
import type { Envelope } from '../protocol/index.js';

type Payload = Envelope['payload'];
export type TriageExchange = (root: string, kind: 'inspect' | 'accept', payload: Payload, id: string, runId: string | null) => Promise<Envelope>;
type Flags = Record<string, 'value' | 'flag'>;
type Given = { positional: string[]; values: Map<string, string> };
/** What one command line asks of the controller: a read-only view, or a change with its own identity. */
type TriageRequest =
  | { mode: 'inspect'; payload: Payload }
  | {
      mode: 'accept';
      payload(requestId: string): Payload;
      /** A second request sent right after an accepted first one (`--yes`), under the identity `<id>-confirm`. */
      confirm?(receipt: Payload, requestId: string): Payload | null;
    };
type Subcommand = { usage: string; flags: Flags; request(given: Given): TriageRequest | null };

export const triageUsage =
  'triages [--cursor <n> --limit <n>]|triage <request id|owner/repo#number|JIRA-KEY>|triage transcript <request id> [--attempt <attempt> [--offset <n>]|--verdict]|' +
  'triage cleanup <request id> [--yes]|triage cleanup-confirm <request id> <plan>|triage cancel <request id|Ticket reference>|' +
  'triage release <request id|Ticket reference> --attempt <attempt> --reason <text>|triage complete <request id|Ticket reference> --impediment <reference>';
const commonFlags: Flags = { '--root': 'value', '--json': 'flag', '--request-id': 'value' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identity = /^[a-zA-Z0-9_-]{1,128}$/;
const natural = (value: string | undefined, max = Number.MAX_SAFE_INTEGER) =>
  value !== undefined && /^(0|[1-9][0-9]{0,15})$/.test(value) && Number(value) <= max ? Number(value) : undefined;

/** Splits a command line into positional arguments and the known flags; an unknown or repeated flag, or a missing value, is invalid. */
function given(args: string[], flags: Flags): Given | null {
  const result: Given = { positional: [], values: new Map() };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const kind = Object.hasOwn(flags, arg) ? flags[arg] : undefined;
    if (!kind && arg.startsWith('--')) return null;
    if (!kind) result.positional.push(arg);
    else if (result.values.has(arg)) return null;
    else if (kind === 'flag') result.values.set(arg, '');
    else if (args[index + 1] === undefined || args[index + 1]!.startsWith('--')) return null;
    else result.values.set(arg, args[++index]!);
  }
  return result;
}
const one = (given: Given, pattern: RegExp) => (given.positional.length === 1 && pattern.test(given.positional[0]!) ? given.positional[0]! : null);

/** `triage transcript <id>`: the only command that shows content, one page of an attempt's session or the Verdict text. */
function transcript(given: Given): TriageRequest | null {
  const id = one(given, uuid);
  const selection = transcriptSelection(given.values);
  if (!id || !selection) return null;
  return { mode: 'inspect', payload: { kind: 'triage-transcript', triage_request_id: id, ...selection } };
}
/** What of the request is read: the Verdict text (`--verdict` alone), or an attempt's session and, within it, a page by offset. */
function transcriptSelection(values: Map<string, string>): Payload | null {
  const attempt = values.get('--attempt');
  const offset = values.get('--offset');
  if (values.has('--verdict')) return attempt === undefined && offset === undefined ? { verdict: true } : null;
  if (attempt === undefined) return offset === undefined ? {} : null;
  if (!triageAttemptPattern.test(attempt)) return null;
  if (offset === undefined) return { attempt };
  return natural(offset) === undefined ? null : { attempt, offset: Number(offset) };
}
/** The plan a `--yes` confirms: only an accepted one that would remove something. */
function plannedId(receipt: Payload): string | null {
  const plan = receipt.plan as { planId?: unknown; items?: unknown[] } | null | undefined;
  return receipt.outcome === 'accepted' && typeof plan?.planId === 'string' && plan.items?.length ? plan.planId : null;
}
/** `triage cleanup <id> [--yes]`: the plan of losses of the request's transcripts and Verdict text; `--yes` confirms it at once. */
function cleanup(given: Given): TriageRequest | null {
  const id = one(given, uuid);
  if (!id) return null;
  const confirm = (receipt: Payload, requestId: string): Payload | null => {
    const plan = plannedId(receipt);
    return plan ? { request_id: requestId, operation: 'triage-cleanup-confirm', triage_request_id: id, plan_id: plan, origin: 'local-cli' } : null;
  };
  return {
    mode: 'accept',
    payload: requestId => ({ request_id: requestId, operation: 'triage-cleanup-plan', triage_request_id: id, origin: 'local-cli' }),
    ...(given.values.has('--yes') ? { confirm } : {}),
  };
}
function cleanupConfirm(given: Given): TriageRequest | null {
  const [id, plan] = given.positional;
  if (given.positional.length !== 2 || !uuid.test(id!) || !uuid.test(plan!)) return null;
  return {
    mode: 'accept',
    payload: requestId => ({ request_id: requestId, operation: 'triage-cleanup-confirm', triage_request_id: id!, plan_id: plan!, origin: 'local-cli' }),
  };
}
/**
 * Ticket #81: an intervention on the request named by its id or its Ticket reference. `more`: the command's own fields, or null when a
 * required flag is missing or malformed.
 */
function intervention(given: Given, operation: string, more: Payload | null): TriageRequest | null {
  const request = one(given, triageReferencePattern);
  if (!request || !more) return null;
  return { mode: 'accept', payload: requestId => ({ request_id: requestId, operation, request, ...more, origin: 'local-cli' }) };
}
/** `triage release <id> --attempt <ref> --reason "..."`: the exact attempt of the Impediment and why the operator says it is over. */
function releaseFields(values: Map<string, string>): Payload | null {
  const attempt = values.get('--attempt');
  const reason = values.get('--reason')?.trim();
  return attempt && triageAttemptPattern.test(attempt) && reason && reason.length <= 500 ? { attempt, reason } : null;
}
/** `triage complete <id> --impediment <ref>`: the exact ambiguous-authorship Impediment the operator read. */
function completeFields(values: Map<string, string>): Payload | null {
  const impediment = values.get('--impediment');
  return impediment && uuid.test(impediment) ? { impediment } : null;
}
/** The subcommands of `factory triage`. A Ticket reference never collides with a name here: none of these is a valid reference. */
export const triageSubcommands: Record<string, Subcommand> = {
  transcript: { usage: 'triage transcript <request id>', flags: { '--attempt': 'value', '--offset': 'value', '--verdict': 'flag' }, request: transcript },
  cleanup: { usage: 'triage cleanup <request id>', flags: { '--yes': 'flag' }, request: cleanup },
  'cleanup-confirm': { usage: 'triage cleanup-confirm <request id> <plan>', flags: {}, request: cleanupConfirm },
  cancel: { usage: 'triage cancel <request id|Ticket reference>', flags: {}, request: given => intervention(given, 'triage-cancel', {}) },
  release: {
    usage: 'triage release <request id|Ticket reference> --attempt <attempt> --reason <text>',
    flags: { '--attempt': 'value', '--reason': 'value' },
    request: given => intervention(given, 'triage-release', releaseFields(given.values)),
  },
  complete: {
    usage: 'triage complete <request id|Ticket reference> --impediment <reference>',
    flags: { '--impediment': 'value' },
    request: given => intervention(given, 'triage-complete', completeFields(given.values)),
  },
};
/** `triage <id or Ticket reference>`: the detail of one request (for a reference, the Ticket's most recent one). */
const show: Subcommand = {
  usage: 'triage <request id|Ticket reference>',
  flags: {},
  request: given => {
    const reference = one(given, triageReferencePattern);
    return reference ? { mode: 'inspect', payload: { kind: 'triage', request: reference } } : null;
  },
};
/** `triages`: the paged list, in arrival order. */
const list: Subcommand = {
  usage: 'triages',
  flags: { '--cursor': 'value', '--limit': 'value' },
  request: given => {
    const cursor = given.values.get('--cursor');
    const limit = given.values.get('--limit');
    const valid = (cursor === undefined || natural(cursor) !== undefined) && (limit === undefined || (natural(limit, 200) ?? 0) >= 1);
    if (given.positional.length || !valid) return null;
    return {
      mode: 'inspect',
      payload: { kind: 'triages', ...(cursor === undefined ? {} : { cursor: Number(cursor) }), ...(limit === undefined ? {} : { limit: Number(limit) }) },
    };
  },
};

type Parsed = { request: TriageRequest; root: string | undefined; json: boolean; requestId: string | undefined };
/** The command a line names and its own arguments: `triages`, a named subcommand of `triage`, or `triage <reference>`. */
function subcommandOf(args: string[]): { subcommand: Subcommand; rest: string[] } {
  if (args[0] === 'triages') return { subcommand: list, rest: args.slice(1) };
  const name = args[1] ?? '';
  return Object.hasOwn(triageSubcommands, name) ? { subcommand: triageSubcommands[name]!, rest: args.slice(2) } : { subcommand: show, rest: args.slice(1) };
}
/** `--request-id` names a change only; with `--yes` the derived `<id>-confirm` must still be a valid request identity. */
function identityValid(request: TriageRequest, requestId: string | undefined): boolean {
  if (requestId === undefined) return true;
  if (request.mode !== 'accept' || !identity.test(requestId)) return false;
  return !request.confirm || requestId.length <= 120;
}
function parse(args: string[]): Parsed | null {
  const { subcommand, rest } = subcommandOf(args);
  const parsed = given(rest, { ...commonFlags, ...subcommand.flags });
  if (!parsed) return null;
  const request = subcommand.request(parsed);
  const requestId = parsed.values.get('--request-id');
  if (!request || !identityValid(request, requestId)) return null;
  return { request, root: parsed.values.get('--root'), json: parsed.values.has('--json'), requestId };
}

/** Exit table of the views: 0 shown; 2 not found, absent or removed content, refused or not applied; 3 it cannot be established now. */
function viewCode(payload: Payload): number {
  if (payload.kind === 'triage-not-found' || payload.kind === 'refused' || payload.outcome === 'not-applied') return 2;
  if (payload.kind !== 'triage-transcript') return 0;
  if (payload.state === 'unknown') return 3;
  return ['absent', 'expired', 'removed'].includes(String(payload.state)) ? 2 : 0;
}
function errorCode(payload: Payload): number {
  if (payload.outcome === 'indeterminate') return 4;
  return payload.outcome === 'unavailable' ? 3 : 2;
}
const responseCode = (response: Envelope) => (response.kind === 'error' ? errorCode(response.payload) : viewCode(response.payload));
const print = (value: unknown, json: boolean) => console.log(json ? JSON.stringify(value) : JSON.stringify(value, null, 2));
const identified = (requestId: string) => console.error(JSON.stringify({ code: 'REQUEST_IDENTIFIED', request_id: requestId }));

async function send(root: string, parsed: Parsed, exchange: TriageExchange): Promise<number> {
  const { request, json } = parsed;
  const id = parsed.requestId ?? randomUUID();
  // The identity is presented BEFORE the request is sent; stdout stays one machine-readable result.
  if (request.mode === 'accept') identified(id);
  const status = await exchange(root, 'inspect', { kind: 'status' }, randomUUID(), null);
  if (status.kind !== 'view') throw new Error('INVALID_RESPONSE');
  const runId = status.controller_run_id;
  if (request.mode === 'inspect') {
    const view = await exchange(root, 'inspect', request.payload, randomUUID(), runId);
    print(view.payload, json);
    return responseCode(view);
  }
  const receipt = await exchange(root, 'accept', request.payload(id), id, runId);
  const confirmId = `${id}-confirm`;
  const confirmation = receipt.kind === 'receipt' ? request.confirm?.(receipt.payload, confirmId) : null;
  if (!confirmation) {
    print(receipt.payload, json);
    return responseCode(receipt);
  }
  identified(confirmId);
  const confirmed = await exchange(root, 'accept', confirmation, confirmId, runId);
  print({ plan: receipt.payload, confirmation: confirmed.payload }, json);
  return responseCode(confirmed);
}

const unavailable = (mutable: boolean) =>
  mutable
    ? {
        code: 'REQUEST_INDETERMINATE',
        scope: 'request',
        outcome: 'indeterminate',
        nextStep: 'Repeat this same request identity and content, or query it: factory request <id>.',
      }
    : {
        code: 'CONTROLLER_UNAVAILABLE',
        scope: 'installation',
        outcome: 'unavailable',
        nextStep: 'Start the controller and repeat the query; unavailability is not an empty result.',
      };

/** Whether a command line belongs here. */
export const isTriageCommand = (command: string | undefined) => command === 'triage' || command === 'triages';
/** Runs one `triages`/`triage` command line against the controller of the installation; returns the process exit code. */
export async function triageCommand(args: string[], deps: { installation: string | undefined; exchange: TriageExchange }): Promise<number> {
  const parsed = parse(args);
  if (!parsed) {
    console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS', message: `factory <${triageUsage}> [--root <installation>] [--json] [--request-id <id>]` }));
    return 2;
  }
  const root = parsed.root === undefined ? (deps.installation ?? resolve('.')) : resolve(parsed.root);
  if (deps.installation !== undefined && (await realpath(root).catch(() => root)) !== deps.installation) {
    console.error(JSON.stringify({ code: 'RELEASE_ROOT_MISMATCH', message: 'This release serves only its own installation root.' }));
    return 2;
  }
  const mutable = parsed.request.mode === 'accept';
  try {
    return await send(root, parsed, deps.exchange);
  } catch {
    console.error(JSON.stringify(unavailable(mutable)));
    return mutable ? 4 : 3;
  }
}
