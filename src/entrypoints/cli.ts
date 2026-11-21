import { isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, protocolVersion, type Envelope } from '../protocol/index.js';
import { pathToFileURL } from 'node:url';
import { setup, setupService, firstHumanLogin } from './setup.js';
import { doctor } from './doctor.js';
import { releaseInstallationRoot } from './release.js';
// Ticket 41: the blocked reference shown by `factory show`; its shape is shared, Control checks it is exactly the blocked one.
import { blockedReferencePattern as blockedReference, blockedStartCodePattern, startRetryRemedies } from '../contracts/index.js';

const usage =
  'factory <setup|doctor|run|status|list [--cursor <n> --limit <n>]|show <work> [--cursor <n> --limit <n>]|history <work>|logs <work> [--after <capture>] [--read <capture> [--offset <n>]]|usage [<work>]|question <id>|pause|unpause|answer <question> <text>|grant <work> (--corrections <n>|--recoveries <n>|--continuations <n>)|update-scope <work> --reason <text>|authorize-readiness <work> --reason <text>|repair <work> --reason <text>|reevaluate-publication <work> --reason <text>|cancel <work>|resume <work> [--override-blocked-recovery <reference> --request-id <id>|--new-review-round --request-id <id>|--retry-blocked-start <code> [--remedy <recreate-artifact-seed|repair-disk|replace-disk>] --request-id <id>]|reopen <work>|new <owner/repo#number> [--keep-predecessor-pr]|cleanup <work> --select <logs,sessions,environment,remote-branch> [--yes]|cleanup-confirm <work> <plan>|forget <work> [--yes]|forget-confirm <work> <plan>|request <id>|upgrade <check|apply|status|resume|rollback> [--migrate <id>]> [--root <installation>] [--json] [--request-id <id>] [doctor --authenticated] [setup --service [--service-directory <absolute dir>]] [history|logs: --execution <id> --role <builder|standards|spec> --limit <n>; history: --cursor <n>]; factory login --root <canonical-absolute-installation>';
const upgradeUsage =
  'factory upgrade <check|apply|status|resume|rollback> [--root <installation>] [--migrate <migration id>] — run with the NEW release: ' +
  '<root>/releases/<id>/node/bin/node <root>/releases/<id>/dist/src/entrypoints/cli.js upgrade ...';
// Ticket 25 (spec §11.3): cycle commands; `new` names the Ticket as owner/repo#number.
const cycleCommands = ['cancel', 'resume', 'reopen', 'new'];
// Ticket 30 (spec §12.4): explicit cleanup — a plan of losses, then its confirmation (`--yes` sends both, with the same verifications).
// Ticket 31 (spec §12.4): `forget` — explicit history deletion, a plan of losses then its confirmation (`--yes`: same verifications).
const cleanupCommands = ['cleanup', 'cleanup-confirm', 'forget', 'forget-confirm'];
const cleanupSelection = /^(logs|sessions|environment|remote-branch)(,(logs|sessions|environment|remote-branch)){0,3}$/;
const ticketReference = /^([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,9})$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function exchange(root: string, kind: 'inspect' | 'accept', payload: Envelope['payload'], id: string, runId: string | null) {
  const endpoint = resolve(await realpath(root), 'run', 'control.sock');
  const channel = await connect(endpoint, 'local-operator');
  const timeout = setTimeout(() => channel.close(), payload.kind === 'access' ? 120000 : 5000);
  try {
    await channel.send({ protocol_version: protocolVersion, controller_run_id: runId, message_id: id, reply_to: null, kind, payload });
    for await (const response of channel.messages) {
      if (response.reply_to !== id || !response.controller_run_id) throw new Error('INVALID_RESPONSE');
      return response;
    }
    throw new Error('CONNECTION_LOST');
  } finally {
    clearTimeout(timeout);
    channel.close();
  }
}

/** Ticket 29: filters/pages of `history`/`logs`/`list`/`show`/`usage`, and a `logs --read` page (read-only queries). */
type Inspection = { execution?: string; role?: string; cursor?: number; after?: string; limit?: number; read?: string; offset?: number };
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const count = (value: string | undefined, max: number) => (value?.match(/^(0|[1-9][0-9]{0,15})$/) && Number(value) <= max ? Number(value) : undefined);
/** Parses inspection options from `args` (after the Work); returns the options and the remaining arguments, or null when invalid. */
function inspectionOptions(command: string, args: string[], hasWork: boolean): { options: Inspection; rest: string[] } | null {
  const options: Inspection = {};
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!,
      value = args[index + 1];
    const reading = options.read !== undefined;
    const filters = command === 'history' || (command === 'logs' && !reading);
    // `--cursor` pages history, list, show (its Executions) and installation usage; logs page by capture id (`--after`).
    const cursors = command === 'history' || command === 'list' || command === 'show' || (command === 'usage' && !hasWork);
    if (flag === '--execution' && filters && options.execution === undefined && value?.match(identifier)) {
      options.execution = value;
      index++;
    } else if (flag === '--role' && filters && options.role === undefined && ['builder', 'standards', 'spec'].includes(value ?? '')) {
      options.role = value!;
      index++;
    } else if (flag === '--cursor' && cursors && options.cursor === undefined && count(value, Number.MAX_SAFE_INTEGER) !== undefined) {
      options.cursor = count(value, Number.MAX_SAFE_INTEGER)!;
      index++;
    } else if (flag === '--after' && command === 'logs' && !reading && options.after === undefined && value?.match(uuid)) {
      options.after = value;
      index++;
    } else if (flag === '--limit' && (filters || cursors) && options.limit === undefined && count(value, 200) !== undefined && Number(value) >= 1) {
      options.limit = Number(value);
      index++;
    } else if (
      flag === '--read' &&
      command === 'logs' &&
      !reading &&
      options.execution === undefined &&
      options.role === undefined &&
      options.after === undefined &&
      options.limit === undefined &&
      value?.match(uuid)
    ) {
      options.read = value;
      index++;
    } else if (flag === '--offset' && command === 'logs' && reading && options.offset === undefined && count(value, Number.MAX_SAFE_INTEGER) !== undefined) {
      options.offset = count(value, Number.MAX_SAFE_INTEGER)!;
      index++;
    } else rest.push(flag);
  }
  return options.offset !== undefined && options.read === undefined ? null : { options, rest };
}
function inspectionQuery(command: string, work: string | undefined, options: Inspection): Envelope['payload'] {
  const page = { ...(options.cursor !== undefined ? { cursor: options.cursor } : {}), ...(options.limit !== undefined ? { limit: options.limit } : {}) };
  const filters = { ...(options.execution ? { execution: options.execution } : {}), ...(options.role ? { role: options.role } : {}) };
  if (command === 'list') return { kind: 'list', ...page };
  if (command === 'show') return { kind: 'show', work_id: work!, ...page };
  if (command === 'usage') return work ? { kind: 'usage', work_id: work } : { kind: 'usage', ...page };
  if (command === 'logs' && options.read)
    return { kind: 'log', work_id: work!, capture: options.read, ...(options.offset !== undefined ? { offset: options.offset } : {}) };
  if (command === 'logs')
    return {
      kind: 'logs',
      work_id: work!,
      ...filters,
      ...(options.after ? { after: options.after } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
  return { kind: command, work_id: work!, ...filters, ...page };
}

async function operational(
  root: string,
  command: string,
  requestId: string | undefined,
  requested: string | undefined,
  json: boolean,
  text?: string,
  grant?: { counter: 'corrections' | 'recoveries' | 'continuations'; amount: number },
  cycle?: { repository: string; number: number; keep: boolean },
  cleanup?: { select?: string[]; yes?: boolean; plan?: string },
  inspection: Inspection = {},
  override?: string,
  newReviewRound = false,
  retry?: { code: string; remedy?: string },
) {
  const query = (): Envelope['payload'] =>
    ['history', 'logs', 'usage', 'list', 'show'].includes(command)
      ? inspectionQuery(command, requested, inspection)
      : command === 'doctor'
        ? { kind: 'access' }
        : command === 'question'
          ? { kind: 'question', question_id: requested! }
          : { kind: 'request', request_id: requested! };
  const mutable =
    command === 'pause' ||
    command === 'unpause' ||
    command === 'answer' ||
    command === 'grant' ||
    command === 'update-scope' ||
    command === 'authorize-readiness' ||
    command === 'repair' ||
    command === 'reevaluate-publication' ||
    cycleCommands.includes(command) ||
    cleanupCommands.includes(command);
  const id = requestId ?? randomUUID();
  // Present identity BEFORE sending; stdout remains a single machine-readable result.
  if (mutable) console.error(JSON.stringify({ code: 'REQUEST_IDENTIFIED', request_id: id }));
  try {
    const status = await exchange(root, 'inspect', { kind: 'status' }, randomUUID(), null);
    if (status.kind !== 'view') throw new Error('INVALID_RESPONSE');
    const response =
      command === 'status'
        ? status
        : await exchange(
            root,
            mutable ? 'accept' : 'inspect',
            mutable
              ? command === 'answer'
                ? { request_id: id, operation: 'answer', question_id: requested!, text: text!, origin: 'local-cli' }
                : command === 'grant'
                  ? { request_id: id, operation: 'grant', work_id: requested!, counter: grant!.counter, amount: grant!.amount, origin: 'local-cli' }
                  : command === 'update-scope' || command === 'authorize-readiness' || command === 'repair' || command === 'reevaluate-publication'
                    ? { request_id: id, operation: command, work_id: requested!, reason: text!, origin: 'local-cli' }
                    : command === 'resume' && override
                      ? { request_id: id, operation: 'resume', work_id: requested!, override_blocked_recovery: override, origin: 'local-cli' }
                      : command === 'resume' && newReviewRound
                        ? { request_id: id, operation: 'resume', work_id: requested!, new_review_round: true, origin: 'local-cli' }
                        : command === 'resume' && retry
                          ? {
                              request_id: id,
                              operation: 'resume',
                              work_id: requested!,
                              retry_blocked_start: retry.code,
                              ...(retry.remedy ? { remedy: retry.remedy } : {}),
                              origin: 'local-cli',
                            }
                          : command === 'cancel' || command === 'resume' || command === 'reopen'
                            ? { request_id: id, operation: command, work_id: requested!, origin: 'local-cli' }
                            : command === 'new'
                              ? {
                                  request_id: id,
                                  operation: 'new',
                                  ticket: { repository: cycle!.repository, number: cycle!.number },
                                  keepPredecessorPullRequest: cycle!.keep,
                                  origin: 'local-cli',
                                }
                              : command === 'cleanup'
                                ? { request_id: id, operation: 'cleanup-plan', work_id: requested!, select: cleanup!.select!, origin: 'local-cli' }
                                : command === 'cleanup-confirm'
                                  ? { request_id: id, operation: 'cleanup-confirm', work_id: requested!, plan_id: cleanup!.plan!, origin: 'local-cli' }
                                  : command === 'forget'
                                    ? { request_id: id, operation: 'forget-plan', work_id: requested!, origin: 'local-cli' }
                                    : command === 'forget-confirm'
                                      ? { request_id: id, operation: 'forget-confirm', work_id: requested!, plan_id: cleanup!.plan!, origin: 'local-cli' }
                                      : { request_id: id, operation: command, origin: 'local-cli' }
              : query(),
            mutable ? id : randomUUID(),
            status.controller_run_id,
          );
    // `--yes` (automation): the plan is shown and then confirmed by a second request with its own identity; the controller performs exactly the
    // same revalidation as for a separate `cleanup-confirm` (nothing is skipped).
    const plan = response.payload.plan as { planId?: unknown; items?: unknown[]; state?: unknown } | null | undefined;
    if (
      (command === 'cleanup' || command === 'forget') &&
      cleanup?.yes &&
      response.kind === 'receipt' &&
      response.payload.outcome === 'accepted' &&
      typeof plan?.planId === 'string' &&
      (command === 'forget' ? plan.state === 'planned' : plan.items?.length)
    ) {
      const confirmId = `${id}-confirm`;
      console.error(JSON.stringify({ code: 'REQUEST_IDENTIFIED', request_id: confirmId }));
      const confirmation = await exchange(
        root,
        'accept',
        {
          request_id: confirmId,
          operation: command === 'forget' ? 'forget-confirm' : 'cleanup-confirm',
          work_id: requested!,
          plan_id: plan.planId,
          origin: 'local-cli',
        },
        confirmId,
        status.controller_run_id,
      );
      console.log(JSON.stringify({ plan: response.payload, confirmation: confirmation.payload }, null, json ? undefined : 2));
      if (confirmation.kind === 'error') return confirmation.payload.outcome === 'indeterminate' ? 4 : 2;
      return confirmation.payload.outcome === 'not-applied' || confirmation.payload.kind === 'refused' ? 2 : 0;
    }
    console.log(json ? JSON.stringify(response.payload) : JSON.stringify(response.payload, null, 2));
    if (response.kind === 'error') return response.payload.outcome === 'indeterminate' ? 4 : response.payload.outcome === 'unavailable' ? 3 : 2;
    // Ticket 29: an inspection whose evidence source is unavailable/indeterminate is not a success (and never an empty listing).
    const listing = response.payload.listing;
    // Exit table (ticket 29): 0 view; 2 invalid/refused/not found/absent (incl. OFFSET_OUT_OF_RANGE); 3 unavailable/incomplete/unknown; 4 indeterminate.
    if (response.payload.kind === 'logs' && listing && typeof listing === 'object' && !Array.isArray(listing) && listing.state !== 'complete') return 3;
    if (response.payload.kind === 'log' && response.payload.state === 'unknown') return 3;
    if (
      response.payload.kind === 'log' &&
      (response.payload.state === 'absent' || response.payload.state === 'expired' || response.payload.state === 'removed')
    )
      return 2;
    if (
      response.payload.kind === 'access' &&
      Array.isArray(response.payload.results) &&
      response.payload.results.some(
        result =>
          !result ||
          typeof result !== 'object' ||
          Array.isArray(result) ||
          !result.tracker ||
          typeof result.tracker !== 'object' ||
          Array.isArray(result.tracker) ||
          result.tracker.status !== 'ok' ||
          !result.repository ||
          typeof result.repository !== 'object' ||
          Array.isArray(result.repository) ||
          result.repository.status !== 'ok',
      )
    )
      return 3;
    if (
      response.payload.kind === 'access' &&
      (!Array.isArray(response.payload.dependencyResults) ||
        response.payload.dependencyResults.some(result => !result || typeof result !== 'object' || Array.isArray(result) || result.status !== 'ok'))
    )
      return 3;
    // `answer` not applied (already answered, unknown question, closed Work) is a durable refusal of the request: exit 2, nothing changed.
    return response.payload.kind === 'refused' ||
      response.payload.kind === 'work-not-found' ||
      response.payload.kind === 'question-not-found' ||
      response.payload.outcome === 'not-applied'
      ? 2
      : 0;
  } catch {
    console.error(
      JSON.stringify({
        code: mutable ? 'REQUEST_INDETERMINATE' : 'CONTROLLER_UNAVAILABLE',
        ...(mutable ? { request_id: id } : {}),
        scope: mutable ? 'request' : 'installation',
        outcome: mutable ? 'indeterminate' : 'unavailable',
        message: mutable
          ? 'Query or repeat this same request identity and content; do not invent a replacement ID.'
          : 'Start the controller; operational inspection never opens SQLite offline.',
        nextStep: mutable
          ? `factory request ${id}`
          : 'Start the controller (`factory run` or its service) and repeat the query; unavailability is not an empty result.',
      }),
    );
    return mutable ? 4 : 3;
  }
}

async function launch(root: string, upgrade?: string[]): Promise<number> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./controller.js', import.meta.url)), root, ...(upgrade ? ['upgrade', ...upgrade] : [])], {
    stdio: 'inherit',
  });
  const terminate = () => child.kill('SIGTERM');
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
  }
}

export async function main(input: string[]): Promise<number> {
  let args = input;
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return 0;
  }
  const command = args[0];
  const installation = releaseInstallationRoot();
  if (command === 'login') {
    // Strict explicit root only; never accept an auth file, provider, key, JSON
    // output, environment/profile default or silently canonicalize aliases.
    if (
      args.length !== 3 ||
      args[1] !== '--root' ||
      !args[2]?.startsWith('/') ||
      resolve(args[2]) !== args[2] ||
      (installation !== undefined && args[2] !== installation)
    ) {
      console.error(JSON.stringify({ code: installation !== undefined && args[2] !== installation ? 'RELEASE_ROOT_MISMATCH' : 'INVALID_ARGUMENTS' }));
      return 2;
    }
    return firstHumanLogin(args[2]);
  }
  // A release serves exactly its own installation root (releases/<id> of it); a development checkout uses --root or the cwd.
  let root = installation ?? resolve('.');
  let service = false;
  let serviceDirectory: string | undefined;
  let json = false;
  let authenticated = false;
  let rootSeen = false;
  // Ticket 33: `upgrade <check|apply|status|resume|rollback> [--migrate <id>]`, run by the NEW release under the canonical-storage lock.
  if (command === 'upgrade') {
    const sub = args[1];
    const rest = args.slice(2);
    let upgradeRoot = installation ?? resolve('.');
    if (rest[0] === '--root' && rest[1]) {
      upgradeRoot = resolve(rest[1]);
      rest.splice(0, 2);
    }
    const migrate = rest.length === 2 && rest[0] === '--migrate' && /^[a-z0-9-]{1,64}$/.test(rest[1]!) && (sub === 'apply' || sub === 'check');
    if (!['check', 'apply', 'status', 'resume', 'rollback'].includes(sub ?? '') || (rest.length && !migrate)) {
      console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS', message: upgradeUsage }));
      return 2;
    }
    if (installation !== undefined && (await realpath(upgradeRoot).catch(() => upgradeRoot)) !== installation) {
      console.error(JSON.stringify({ code: 'RELEASE_ROOT_MISMATCH', message: 'This release serves only its own installation root.' }));
      return 2;
    }
    try {
      const code = await launch(upgradeRoot, [sub!, ...rest]);
      if (code === 73)
        console.error(
          JSON.stringify({ code: 'CONTROLLER_RUNNING', message: 'Stop the controller (paused, clean exit) before upgrading; the lock is never taken over.' }),
        );
      return code;
    } catch {
      console.error(JSON.stringify({ code: 'LOCAL_IO_FAILED', message: 'Check installation paths, types and permissions; no automatic repair.' }));
      return 2;
    }
  }
  let valid = [
    'setup',
    'doctor',
    'run',
    'status',
    'list',
    'show',
    'history',
    'logs',
    'usage',
    'question',
    'pause',
    'unpause',
    'answer',
    'grant',
    'update-scope',
    'authorize-readiness',
    'repair',
    'reevaluate-publication',
    'request',
    ...cycleCommands,
    ...cleanupCommands,
  ].includes(command ?? '');
  // Ticket 29: `history <work>`, `logs <work>` (filters/page or `--read <capture> [--offset <n>]`) and `usage [<work>]`.
  let inspection: Inspection = {};
  if (command === 'history' || command === 'logs' || command === 'usage' || command === 'list' || command === 'show') {
    const hasWork = (command !== 'usage' && command !== 'list') || (command === 'usage' && args[1] !== undefined && !args[1].startsWith('--'));
    const parsed = inspectionOptions(command, args.slice(hasWork ? 2 : 1), hasWork);
    if (!parsed || (hasWork && !args[1]?.match(uuid))) valid = false;
    else {
      inspection = parsed.options;
      args = [...args.slice(0, hasWork ? 2 : 1), ...parsed.rest];
    }
  }
  let requestId: string | undefined;
  const withReason = command === 'update-scope' || command === 'authorize-readiness' || command === 'repair' || command === 'reevaluate-publication';
  const requested =
    command === 'request' ||
    command === 'show' ||
    command === 'question' ||
    command === 'answer' ||
    command === 'grant' ||
    withReason ||
    cycleCommands.includes(command ?? '') ||
    cleanupCommands.includes(command ?? '') ||
    command === 'history' ||
    command === 'logs' ||
    (command === 'usage' && args[1] !== undefined && !args[1].startsWith('--'))
      ? args[1]
      : undefined;
  if (command === 'request' && !requested?.match(/^[a-zA-Z0-9_-]{1,128}$/)) valid = false;
  if (
    (command === 'show' ||
      command === 'question' ||
      command === 'answer' ||
      command === 'grant' ||
      withReason ||
      command === 'cancel' ||
      command === 'resume' ||
      command === 'reopen' ||
      cleanupCommands.includes(command ?? '')) &&
    !requested?.match(uuid)
  )
    valid = false;
  let cleanup: { select?: string[]; yes?: boolean; plan?: string } | undefined;
  if (command === 'cleanup') {
    if (args[2] === '--select' && cleanupSelection.test(args[3] ?? '')) cleanup = { select: [...new Set(args[3]!.split(','))], yes: false };
    else valid = false;
  }
  if (command === 'cleanup-confirm' || command === 'forget-confirm') {
    if (args[2]?.match(uuid)) cleanup = { plan: args[2] };
    else valid = false;
  }
  if (command === 'forget') cleanup = { yes: false };
  const reference = command === 'new' ? ticketReference.exec(requested ?? '') : null;
  if (command === 'new' && (!reference || Number(reference[2]) > 2 ** 31)) valid = false;
  let keep = false;
  let override: string | undefined;
  // Ticket 51: `resume <work> --new-review-round --request-id <id>`, the operator's decision after REVIEWER_RETRY_LIMIT (the other one is `cancel`).
  let newReviewRound = false;
  // Ticket 50: `resume <work> --retry-blocked-start <code> [--remedy <name>]` (generic retry of a refused boot/preparation).
  let retry: string | undefined;
  let remedy: string | undefined;
  // `grant <work> --corrections <n>`, `--recoveries <n>` or (ticket 48) `--continuations <n>`: exactly one counter, a plain positive integer
  // up to 100 (spec §11.3).
  let grant: { counter: 'corrections' | 'recoveries' | 'continuations'; amount: number } | undefined;
  if (command === 'grant') {
    const flag = args[2],
      amount = args[3];
    const counters = { '--corrections': 'corrections', '--recoveries': 'recoveries', '--continuations': 'continuations' } as const;
    if ((flag === '--corrections' || flag === '--recoveries' || flag === '--continuations') && amount?.match(/^[1-9][0-9]{0,2}$/) && Number(amount) <= 100) {
      grant = { counter: counters[flag], amount: Number(amount) };
    } else valid = false;
  }
  // `answer <question> <text>`: exactly one text argument (quote it), trimmed by the operator, at most 2000 characters.
  // `update-scope <work> --reason <text>`: the concrete change, one quoted argument (the controller decides whether it is concrete).
  // Ticket 23: `repair <work> --reason <text>` has the same shape (the controller decides concreteness and the phase answer).
  const text = command === 'answer' ? args[2] : withReason && args[2] === '--reason' ? args[3] : undefined;
  if ((command === 'answer' || withReason) && (!text || text !== text.trim() || text.length > 2000 || text.startsWith('--'))) valid = false;
  for (
    let index =
      command === 'answer' || command === 'cleanup-confirm' || command === 'forget-confirm'
        ? 3
        : command === 'grant' || withReason || command === 'cleanup'
          ? 4
          : command === 'request' ||
              command === 'show' ||
              command === 'question' ||
              command === 'forget' ||
              cycleCommands.includes(command ?? '') ||
              command === 'history' ||
              command === 'logs' ||
              (command === 'usage' && requested !== undefined)
            ? 2
            : 1;
    index < args.length;
    index++
  ) {
    if (args[index] === '--authenticated' && command === 'doctor' && !authenticated) authenticated = true;
    else if (args[index] === '--keep-predecessor-pr' && command === 'new' && !keep) keep = true;
    else if (args[index] === '--override-blocked-recovery' && command === 'resume' && override === undefined && blockedReference.test(args[index + 1] ?? ''))
      override = args[++index];
    else if (args[index] === '--new-review-round' && command === 'resume' && !newReviewRound) newReviewRound = true;
    else if (args[index] === '--retry-blocked-start' && command === 'resume' && retry === undefined && blockedStartCodePattern.test(args[index + 1] ?? ''))
      retry = args[++index];
    else if (
      args[index] === '--remedy' &&
      command === 'resume' &&
      remedy === undefined &&
      (startRetryRemedies as readonly string[]).includes(args[index + 1] ?? '')
    )
      remedy = args[++index];
    else if (args[index] === '--yes' && (command === 'cleanup' || command === 'forget') && cleanup && !cleanup.yes) cleanup.yes = true;
    else if (args[index] === '--service' && command === 'setup' && !service && installation !== undefined) service = true;
    else if (
      args[index] === '--service-directory' &&
      command === 'setup' &&
      serviceDirectory === undefined &&
      args[index + 1] !== undefined &&
      isAbsolute(args[index + 1]!) &&
      resolve(args[index + 1]!) === args[index + 1]
    ) {
      serviceDirectory = args[++index]!;
    } else if (args[index] === '--json' && !json) json = true;
    else if (args[index] === '--root' && !rootSeen && args[index + 1] && !args[index + 1]?.startsWith('-')) {
      root = resolve(args[++index]!);
      rootSeen = true;
    } else if (
      args[index] === '--request-id' &&
      !requestId &&
      (command === 'pause' ||
        command === 'unpause' ||
        command === 'answer' ||
        command === 'grant' ||
        withReason ||
        cycleCommands.includes(command ?? '') ||
        cleanupCommands.includes(command ?? '')) &&
      args[index + 1]?.match(/^[a-zA-Z0-9_-]{1,128}$/)
    )
      requestId = args[++index];
    else {
      valid = false;
      break;
    }
  }
  if (serviceDirectory !== undefined && !service) valid = false;
  // Ticket 41: an override is an explicit decision with its own identity (deduplicated across crashes): `--request-id` is required.
  if (override !== undefined && requestId === undefined) valid = false;
  // Ticket 51: the same for a new review round; it is never combined with an override (two different decisions).
  if (newReviewRound && (requestId === undefined || override !== undefined)) valid = false;
  // Ticket 50: same for a retry of a refused boot/preparation; a remedy only with it; never both decisions in one request.
  if (retry !== undefined && (requestId === undefined || override !== undefined)) valid = false;
  if (remedy !== undefined && retry === undefined) valid = false;
  // Tickets 50/51: one explicit decision per request (override, new review round or retry of a refused start).
  if (retry !== undefined && newReviewRound) valid = false;
  // `--yes` derives the confirmation identity `<id>-confirm`, which must still be a valid request identity.
  if (cleanup?.yes && requestId !== undefined && requestId.length > 120) valid = false;
  if (!valid) {
    console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS', message: usage }));
    return 2;
  }
  if (installation !== undefined && (await realpath(root).catch(() => root)) !== installation) {
    console.error(
      JSON.stringify({
        code: 'RELEASE_ROOT_MISMATCH',
        message: "This release serves only its own installation root; use that root's launcher. No relocation by copy.",
      }),
    );
    return 2;
  }
  try {
    if (command === 'run') return await launch(root);
    if (
      command === 'status' ||
      command === 'list' ||
      command === 'show' ||
      command === 'question' ||
      command === 'pause' ||
      command === 'unpause' ||
      command === 'answer' ||
      command === 'grant' ||
      withReason ||
      command === 'request' ||
      cycleCommands.includes(command ?? '') ||
      cleanupCommands.includes(command ?? '') ||
      command === 'history' ||
      command === 'logs' ||
      command === 'usage'
    ) {
      return await operational(
        root,
        command!,
        requestId,
        requested,
        json,
        text,
        grant,
        reference ? { repository: reference[1]!, number: Number(reference[2]), keep } : undefined,
        cleanup,
        inspection,
        override,
        newReviewRound,
        retry ? { code: retry, ...(remedy ? { remedy } : {}) } : undefined,
      );
    }
    if (command === 'doctor' && authenticated) return await operational(root, command, undefined, undefined, json);
    if (command === 'doctor') {
      const report = await doctor(root);
      const errors = !report.configuration.valid ? report.configuration.errors.map(error => `${error.code}: ${error.path}`).join('\n') + '\n' : '';
      console.log(
        json
          ? JSON.stringify(report)
          : `${report.code} (${report.scope})\nRoot: ${report.paths.root}\nNode: ${report.versions.node}\n${errors}` +
              report.checks.map(check => `${check.id}: ${check.status} — ${check.message} Next: ${check.nextStep}`).join('\n'),
      );
      if (report.code === 'RELEASE_INVALID') return 3;
      return report.configuration.valid ? (report.code === 'PREREQUISITES_MISSING' ? 3 : 0) : 2;
    }
    const prepared = await setup(root);
    let unit: Awaited<ReturnType<typeof setupService>> | undefined;
    if (service) {
      try {
        unit = await setupService(prepared.root, serviceDirectory);
      } catch (error) {
        const code =
          error instanceof Error && ['SERVICE_UNIT_CONFLICT', 'SERVICE_PATH_UNSUPPORTED'].includes(error.message) ? error.message : 'SERVICE_DEFINITION_FAILED';
        console.error(
          JSON.stringify({ code, message: 'Existing unit definitions are never overwritten; inspect it explicitly. Nothing was started or enabled.' }),
        );
        return 2;
      }
    }
    const result = {
      code: 'SETUP_PREPARED',
      ...prepared,
      ...(unit
        ? {
            service: {
              ...unit,
              registered: false,
              nextStep: `Administrator: systemctl --user daemon-reload && systemctl --user start ${unit.unit} (same lock as the foreground run).`,
            },
          }
        : {}),
      diagnostics: await doctor(prepared.root),
    };
    console.log(
      json
        ? JSON.stringify(result)
        : `Prepared ${result.root}; created: ${result.created.join(', ') || 'none'}.${unit ? ` Service definition ${unit.state}: ${unit.path} (not started).` : ''}\n${result.diagnostics.code}: preparation is not runtime qualification. Run doctor --json for details.`,
    );
    return 0;
  } catch {
    console.error(JSON.stringify({ code: 'LOCAL_IO_FAILED', message: 'Check installation paths, types and permissions; no automatic repair.' }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
