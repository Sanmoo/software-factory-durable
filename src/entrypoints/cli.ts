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

const usage = 'factory <setup|doctor|run|status|list|show <work>|question <id>|pause|unpause|answer <question> <text>|grant <work> (--corrections <n>|--recoveries <n>)|update-scope <work> --reason <text>|authorize-readiness <work> --reason <text>|cancel <work>|resume <work>|reopen <work>|new <owner/repo#number> [--keep-predecessor-pr]|cleanup <work> --select <logs,sessions,environment,remote-branch> [--yes]|cleanup-confirm <work> <plan>|forget <work> [--yes]|forget-confirm <work> <plan>|request <id>|upgrade <check|apply|status|resume|rollback> [--migrate <id>]> [--root <installation>] [--json] [--request-id <id>] [doctor --authenticated] [setup --service [--service-directory <absolute dir>]]; factory login --root <canonical-absolute-installation>';
const upgradeUsage = 'factory upgrade <check|apply|status|resume|rollback> [--root <installation>] [--migrate <migration id>] — run with the NEW release: ' +
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
  } finally { clearTimeout(timeout); channel.close(); }
}

async function operational(root: string, command: string, requestId: string | undefined, requested: string | undefined, json: boolean, text?: string,
  grant?: { counter: 'corrections' | 'recoveries'; amount: number }, cycle?: { repository: string; number: number; keep: boolean },
  cleanup?: { select?: string[]; yes?: boolean; plan?: string }) {
  const query = (): Envelope['payload'] => command === 'doctor' ? { kind: 'access' } : command === 'list' ? { kind: 'list' }
    : command === 'show' ? { kind: 'show', work_id: requested! } : command === 'question' ? { kind: 'question', question_id: requested! } : { kind: 'request', request_id: requested! };
  const mutable = command === 'pause' || command === 'unpause' || command === 'answer' || command === 'grant' || command === 'update-scope' || command === 'authorize-readiness' ||
    cycleCommands.includes(command) || cleanupCommands.includes(command);
  const id = requestId ?? randomUUID();
  // Present identity BEFORE sending; stdout remains a single machine-readable result.
  if (mutable) console.error(JSON.stringify({ code: 'REQUEST_IDENTIFIED', request_id: id }));
  try {
    const status = await exchange(root, 'inspect', { kind: 'status' }, randomUUID(), null);
    if (status.kind !== 'view') throw new Error('INVALID_RESPONSE');
    const response = command === 'status' ? status : await exchange(root, mutable ? 'accept' : 'inspect',
      mutable ? (command === 'answer' ? { request_id: id, operation: 'answer', question_id: requested!, text: text!, origin: 'local-cli' }
        : command === 'grant' ? { request_id: id, operation: 'grant', work_id: requested!, counter: grant!.counter, amount: grant!.amount, origin: 'local-cli' }
          : command === 'update-scope' || command === 'authorize-readiness' ? { request_id: id, operation: command, work_id: requested!, reason: text!, origin: 'local-cli' }
          : command === 'cancel' || command === 'resume' || command === 'reopen' ? { request_id: id, operation: command, work_id: requested!, origin: 'local-cli' }
          : command === 'new' ? { request_id: id, operation: 'new', ticket: { repository: cycle!.repository, number: cycle!.number }, keepPredecessorPullRequest: cycle!.keep, origin: 'local-cli' }
          : command === 'cleanup' ? { request_id: id, operation: 'cleanup-plan', work_id: requested!, select: cleanup!.select!, origin: 'local-cli' }
          : command === 'cleanup-confirm' ? { request_id: id, operation: 'cleanup-confirm', work_id: requested!, plan_id: cleanup!.plan!, origin: 'local-cli' }
          : command === 'forget' ? { request_id: id, operation: 'forget-plan', work_id: requested!, origin: 'local-cli' }
          : command === 'forget-confirm' ? { request_id: id, operation: 'forget-confirm', work_id: requested!, plan_id: cleanup!.plan!, origin: 'local-cli' }
            : { request_id: id, operation: command, origin: 'local-cli' }) : query(),
      mutable ? id : randomUUID(), status.controller_run_id);
    // `--yes` (automation): the plan is shown and then confirmed by a second request with its own identity; the controller performs exactly the
    // same revalidation as for a separate `cleanup-confirm` (nothing is skipped).
    const plan = response.payload.plan as { planId?: unknown; items?: unknown[]; state?: unknown } | null | undefined;
    if ((command === 'cleanup' || command === 'forget') && cleanup?.yes && response.kind === 'receipt' && response.payload.outcome === 'accepted' && typeof plan?.planId === 'string' &&
      (command === 'forget' ? plan.state === 'planned' : plan.items?.length)) {
      const confirmId = `${id}-confirm`;
      console.error(JSON.stringify({ code: 'REQUEST_IDENTIFIED', request_id: confirmId }));
      const confirmation = await exchange(root, 'accept', { request_id: confirmId, operation: command === 'forget' ? 'forget-confirm' : 'cleanup-confirm', work_id: requested!, plan_id: plan.planId, origin: 'local-cli' },
        confirmId, status.controller_run_id);
      console.log(JSON.stringify({ plan: response.payload, confirmation: confirmation.payload }, null, json ? undefined : 2));
      if (confirmation.kind === 'error') return confirmation.payload.outcome === 'indeterminate' ? 4 : 2;
      return confirmation.payload.outcome === 'not-applied' || confirmation.payload.kind === 'refused' ? 2 : 0;
    }
    console.log(json ? JSON.stringify(response.payload) : JSON.stringify(response.payload, null, 2));
    if (response.kind === 'error') return response.payload.outcome === 'indeterminate' ? 4 : 2;
    if (response.payload.kind === 'access' && Array.isArray(response.payload.results) &&
      response.payload.results.some(result => !result || typeof result !== 'object' || Array.isArray(result) ||
        !result.tracker || typeof result.tracker !== 'object' || Array.isArray(result.tracker) || result.tracker.status !== 'ok' ||
        !result.repository || typeof result.repository !== 'object' || Array.isArray(result.repository) || result.repository.status !== 'ok')) return 3;
    if (response.payload.kind === 'access' && (!Array.isArray(response.payload.dependencyResults) || response.payload.dependencyResults.some(result =>
      !result || typeof result !== 'object' || Array.isArray(result) || result.status !== 'ok'))) return 3;
    // `answer` not applied (already answered, unknown question, closed Work) is a durable refusal of the request: exit 2, nothing changed.
    return response.payload.kind === 'refused' || response.payload.kind === 'work-not-found' || response.payload.kind === 'question-not-found' ||
      response.payload.outcome === 'not-applied' ? 2 : 0;
  } catch {
    console.error(JSON.stringify({ code: mutable ? 'REQUEST_INDETERMINATE' : 'CONTROLLER_UNAVAILABLE',
      ...(mutable ? { request_id: id } : {}), message: mutable ? 'Query or repeat this same request identity and content; do not invent a replacement ID.' : 'Start the controller; operational inspection never opens SQLite offline.' }));
    return mutable ? 4 : 3;
  }
}

async function launch(root: string, upgrade?: string[]): Promise<number> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./controller.js', import.meta.url)), root, ...(upgrade ? ['upgrade', ...upgrade] : [])], { stdio: 'inherit' });
  const terminate = () => child.kill('SIGTERM');
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGTERM', terminate); process.on('SIGINT', interrupt);
  try { return await new Promise<number>((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  }); } finally { process.off('SIGTERM', terminate); process.off('SIGINT', interrupt); }
}

export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0; }
  const command = args[0];
  const installation = releaseInstallationRoot();
  if (command === 'login') {
    // Strict explicit root only; never accept an auth file, provider, key, JSON
    // output, environment/profile default or silently canonicalize aliases.
    if (args.length !== 3 || args[1] !== '--root' || !args[2]?.startsWith('/') || resolve(args[2]) !== args[2] ||
        (installation !== undefined && args[2] !== installation)) {
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
    if (rest[0] === '--root' && rest[1]) { upgradeRoot = resolve(rest[1]); rest.splice(0, 2); }
    const migrate = rest.length === 2 && rest[0] === '--migrate' && /^[a-z0-9-]{1,64}$/.test(rest[1]!) && (sub === 'apply' || sub === 'check');
    if (!['check', 'apply', 'status', 'resume', 'rollback'].includes(sub ?? '') || (rest.length && !migrate)) {
      console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS', message: upgradeUsage }));
      return 2;
    }
    if (installation !== undefined && await realpath(upgradeRoot).catch(() => upgradeRoot) !== installation) {
      console.error(JSON.stringify({ code: 'RELEASE_ROOT_MISMATCH', message: 'This release serves only its own installation root.' }));
      return 2;
    }
    try {
      const code = await launch(upgradeRoot, [sub!, ...rest]);
      if (code === 73) console.error(JSON.stringify({ code: 'CONTROLLER_RUNNING', message: 'Stop the controller (paused, clean exit) before upgrading; the lock is never taken over.' }));
      return code;
    } catch {
      console.error(JSON.stringify({ code: 'LOCAL_IO_FAILED', message: 'Check installation paths, types and permissions; no automatic repair.' }));
      return 2;
    }
  }
  let valid = ['setup', 'doctor', 'run', 'status', 'list', 'show', 'question', 'pause', 'unpause', 'answer', 'grant', 'update-scope', 'authorize-readiness', 'request', ...cycleCommands,
    ...cleanupCommands].includes(command ?? '');
  let requestId: string | undefined;
  const requested = command === 'request' || command === 'show' || command === 'question' || command === 'answer' || command === 'grant' || command === 'update-scope' || command === 'authorize-readiness' ||
    cycleCommands.includes(command ?? '') || cleanupCommands.includes(command ?? '') ? args[1] : undefined;
  if (command === 'request' && !requested?.match(/^[a-zA-Z0-9_-]{1,128}$/)) valid = false;
  if ((command === 'show' || command === 'question' || command === 'answer' || command === 'grant' || command === 'update-scope' || command === 'authorize-readiness' ||
    command === 'cancel' || command === 'resume' || command === 'reopen' || cleanupCommands.includes(command ?? '')) && !requested?.match(uuid)) valid = false;
  let cleanup: { select?: string[]; yes?: boolean; plan?: string } | undefined;
  if (command === 'cleanup') {
    if (args[2] === '--select' && cleanupSelection.test(args[3] ?? '')) cleanup = { select: [...new Set(args[3]!.split(','))], yes: false }; else valid = false;
  }
  if (command === 'cleanup-confirm' || command === 'forget-confirm') { if (args[2]?.match(uuid)) cleanup = { plan: args[2] }; else valid = false; }
  if (command === 'forget') cleanup = { yes: false };
  const reference = command === 'new' ? ticketReference.exec(requested ?? '') : null;
  if (command === 'new' && (!reference || Number(reference[2]) > 2 ** 31)) valid = false;
  let keep = false;
  // `grant <work> --corrections <n>` or `--recoveries <n>`: exactly one counter, a plain positive integer up to 100 (spec §11.3).
  let grant: { counter: 'corrections' | 'recoveries'; amount: number } | undefined;
  if (command === 'grant') {
    const flag = args[2], amount = args[3];
    if ((flag === '--corrections' || flag === '--recoveries') && amount?.match(/^[1-9][0-9]{0,2}$/) && Number(amount) <= 100) {
      grant = { counter: flag === '--corrections' ? 'corrections' : 'recoveries', amount: Number(amount) };
    } else valid = false;
  }
  // `answer <question> <text>`: exactly one text argument (quote it), trimmed by the operator, at most 2000 characters.
  // `update-scope <work> --reason <text>`: the concrete change, one quoted argument (the controller decides whether it is concrete).
  const text = command === 'answer' ? args[2] : (command === 'update-scope' || command === 'authorize-readiness') && args[2] === '--reason' ? args[3] : undefined;
  if ((command === 'answer' || command === 'update-scope' || command === 'authorize-readiness') && (!text || text !== text.trim() || text.length > 2000 || text.startsWith('--'))) valid = false;
  for (let index = command === 'answer' || command === 'cleanup-confirm' || command === 'forget-confirm' ? 3 : command === 'grant' || command === 'update-scope' || command === 'authorize-readiness' || command === 'cleanup' ? 4
    : command === 'request' || command === 'show' || command === 'question' || command === 'forget' || cycleCommands.includes(command ?? '') ? 2 : 1; index < args.length; index++) {
    if (args[index] === '--authenticated' && command === 'doctor' && !authenticated) authenticated = true;
    else if (args[index] === '--keep-predecessor-pr' && command === 'new' && !keep) keep = true;
    else if (args[index] === '--yes' && (command === 'cleanup' || command === 'forget') && cleanup && !cleanup.yes) cleanup.yes = true;
    else if (args[index] === '--service' && command === 'setup' && !service && installation !== undefined) service = true;
    else if (args[index] === '--service-directory' && command === 'setup' && serviceDirectory === undefined &&
      args[index + 1] !== undefined && isAbsolute(args[index + 1]!) && resolve(args[index + 1]!) === args[index + 1]) {
      serviceDirectory = args[++index]!;
    }
    else if (args[index] === '--json' && !json) json = true;
    else if (args[index] === '--root' && !rootSeen && args[index + 1] && !args[index + 1]?.startsWith('-')) {
      root = resolve(args[++index]!);
      rootSeen = true;
    } else if (args[index] === '--request-id' && !requestId && (command === 'pause' || command === 'unpause' || command === 'answer' || command === 'grant' || command === 'update-scope' || command === 'authorize-readiness' ||
      cycleCommands.includes(command ?? '') || cleanupCommands.includes(command ?? '')) &&
      args[index + 1]?.match(/^[a-zA-Z0-9_-]{1,128}$/)) requestId = args[++index];
    else { valid = false; break; }
  }
  if (serviceDirectory !== undefined && !service) valid = false;
  // `--yes` derives the confirmation identity `<id>-confirm`, which must still be a valid request identity.
  if (cleanup?.yes && requestId !== undefined && requestId.length > 120) valid = false;
  if (!valid) {
    console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS', message: usage }));
    return 2;
  }
  if (installation !== undefined && await realpath(root).catch(() => root) !== installation) {
    console.error(JSON.stringify({ code: 'RELEASE_ROOT_MISMATCH', message: 'This release serves only its own installation root; use that root\'s launcher. No relocation by copy.' }));
    return 2;
  }
  try {
    if (command === 'run') return await launch(root);
    if (command === 'status' || command === 'list' || command === 'show' || command === 'question' || command === 'pause' || command === 'unpause' ||
        command === 'answer' || command === 'grant' || command === 'update-scope' || command === 'authorize-readiness' || command === 'request' || cycleCommands.includes(command ?? '') ||
        cleanupCommands.includes(command ?? '')) {
      return await operational(root, command!, requestId, requested, json, text, grant, reference ? { repository: reference[1]!, number: Number(reference[2]), keep } : undefined, cleanup);
    }
    if (command === 'doctor' && authenticated) return await operational(root, command, undefined, undefined, json);
    if (command === 'doctor') {
      const report = await doctor(root);
      const errors = !report.configuration.valid ? report.configuration.errors.map(error => `${error.code}: ${error.path}`).join('\n') + '\n' : '';
      console.log(json ? JSON.stringify(report) :
        `${report.code} (${report.scope})\nRoot: ${report.paths.root}\nNode: ${report.versions.node}\n${errors}` +
        report.checks.map(check => `${check.id}: ${check.status} — ${check.message} Next: ${check.nextStep}`).join('\n'));
      if (report.code === 'RELEASE_INVALID') return 3;
      return report.configuration.valid ? (report.code === 'PREREQUISITES_MISSING' ? 3 : 0) : 2;
    }
    const prepared = await setup(root);
    let unit: Awaited<ReturnType<typeof setupService>> | undefined;
    if (service) {
      try { unit = await setupService(prepared.root, serviceDirectory); }
      catch (error) {
        const code = error instanceof Error && ['SERVICE_UNIT_CONFLICT', 'SERVICE_PATH_UNSUPPORTED'].includes(error.message) ? error.message : 'SERVICE_DEFINITION_FAILED';
        console.error(JSON.stringify({ code, message: 'Existing unit definitions are never overwritten; inspect it explicitly. Nothing was started or enabled.' }));
        return 2;
      }
    }
    const result = { code: 'SETUP_PREPARED', ...prepared, ...(unit ? { service: { ...unit, registered: false,
      nextStep: `Administrator: systemctl --user daemon-reload && systemctl --user start ${unit.unit} (same lock as the foreground run).` } } : {}),
    diagnostics: await doctor(prepared.root) };
    console.log(json ? JSON.stringify(result) :
      `Prepared ${result.root}; created: ${result.created.join(', ') || 'none'}.${unit ? ` Service definition ${unit.state}: ${unit.path} (not started).` : ''}\n${result.diagnostics.code}: preparation is not runtime qualification. Run doctor --json for details.`);
    return 0;
  } catch {
    console.error(JSON.stringify({ code: 'LOCAL_IO_FAILED', message: 'Check installation paths, types and permissions; no automatic repair.' }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
