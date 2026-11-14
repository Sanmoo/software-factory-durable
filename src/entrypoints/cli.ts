import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, protocolVersion, type Envelope } from '../protocol/index.js';
import { pathToFileURL } from 'node:url';
import { setup, firstHumanLogin } from './setup.js';
import { doctor } from './doctor.js';

const usage = 'factory <setup|doctor|run|status|list|show <work>|pause|unpause|request <id>> [--root <installation>] [--json] [--request-id <id>] [doctor --authenticated]; factory login --root <canonical-absolute-installation>';

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

async function operational(root: string, command: string, requestId: string | undefined, requested: string | undefined, json: boolean) {
  const query = (): Envelope['payload'] => command === 'doctor' ? { kind: 'access' } : command === 'list' ? { kind: 'list' }
    : command === 'show' ? { kind: 'show', work_id: requested! } : { kind: 'request', request_id: requested! };
  const mutable = command === 'pause' || command === 'unpause';
  const id = requestId ?? randomUUID();
  // Present identity BEFORE sending; stdout remains a single machine-readable result.
  if (mutable) console.error(JSON.stringify({ code: 'REQUEST_IDENTIFIED', request_id: id }));
  try {
    const status = await exchange(root, 'inspect', { kind: 'status' }, randomUUID(), null);
    if (status.kind !== 'view') throw new Error('INVALID_RESPONSE');
    const response = command === 'status' ? status : await exchange(root, mutable ? 'accept' : 'inspect',
      mutable ? { request_id: id, operation: command, origin: 'local-cli' } : query(),
      mutable ? id : randomUUID(), status.controller_run_id);
    console.log(json ? JSON.stringify(response.payload) : JSON.stringify(response.payload, null, 2));
    if (response.kind === 'error') return response.payload.outcome === 'indeterminate' ? 4 : 2;
    if (response.payload.kind === 'access' && Array.isArray(response.payload.results) &&
      response.payload.results.some(result => !result || typeof result !== 'object' || Array.isArray(result) ||
        !result.tracker || typeof result.tracker !== 'object' || Array.isArray(result.tracker) || result.tracker.status !== 'ok' ||
        !result.repository || typeof result.repository !== 'object' || Array.isArray(result.repository) || result.repository.status !== 'ok')) return 3;
    if (response.payload.kind === 'access' && (!Array.isArray(response.payload.dependencyResults) || response.payload.dependencyResults.some(result =>
      !result || typeof result !== 'object' || Array.isArray(result) || result.status !== 'ok'))) return 3;
    return response.payload.kind === 'refused' || response.payload.kind === 'work-not-found' ? 2 : 0;
  } catch {
    console.error(JSON.stringify({ code: mutable ? 'REQUEST_INDETERMINATE' : 'CONTROLLER_UNAVAILABLE',
      ...(mutable ? { request_id: id } : {}), message: mutable ? 'Query or repeat this same request identity and content; do not invent a replacement ID.' : 'Start the controller; operational inspection never opens SQLite offline.' }));
    return mutable ? 4 : 3;
  }
}

async function launch(root: string): Promise<number> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./controller.js', import.meta.url)), root], { stdio: 'inherit' });
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
  if (command === 'login') {
    // Strict explicit root only; never accept an auth file, provider, key, JSON
    // output, environment/profile default or silently canonicalize aliases.
    if (args.length !== 3 || args[1] !== '--root' || !args[2]?.startsWith('/') || resolve(args[2]) !== args[2]) {
      console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS' }));
      return 2;
    }
    return firstHumanLogin(args[2]);
  }
  let root = resolve('.');
  let json = false;
  let authenticated = false;
  let rootSeen = false;
  let valid = ['setup', 'doctor', 'run', 'status', 'list', 'show', 'pause', 'unpause', 'request'].includes(command ?? '');
  let requestId: string | undefined;
  const requested = command === 'request' || command === 'show' ? args[1] : undefined;
  if (command === 'request' && !requested?.match(/^[a-zA-Z0-9_-]{1,128}$/)) valid = false;
  if (command === 'show' && !requested?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) valid = false;
  for (let index = command === 'request' || command === 'show' ? 2 : 1; index < args.length; index++) {
    if (args[index] === '--authenticated' && command === 'doctor' && !authenticated) authenticated = true;
    else if (args[index] === '--json' && !json) json = true;
    else if (args[index] === '--root' && !rootSeen && args[index + 1] && !args[index + 1]?.startsWith('-')) {
      root = resolve(args[++index]!);
      rootSeen = true;
    } else if (args[index] === '--request-id' && !requestId && (command === 'pause' || command === 'unpause') &&
      args[index + 1]?.match(/^[a-zA-Z0-9_-]{1,128}$/)) requestId = args[++index];
    else { valid = false; break; }
  }
  if (!valid) {
    console.error(JSON.stringify({ code: 'INVALID_ARGUMENTS', message: usage }));
    return 2;
  }
  try {
    if (command === 'run') return await launch(root);
    if (command === 'status' || command === 'list' || command === 'show' || command === 'pause' || command === 'unpause' || command === 'request') {
      return await operational(root, command, requestId, requested, json);
    }
    if (command === 'doctor' && authenticated) return await operational(root, command, undefined, undefined, json);
    if (command === 'doctor') {
      const report = await doctor(root);
      const errors = !report.configuration.valid ? report.configuration.errors.map(error => `${error.code}: ${error.path}`).join('\n') + '\n' : '';
      console.log(json ? JSON.stringify(report) :
        `${report.code} (${report.scope})\nRoot: ${report.paths.root}\nNode: ${report.versions.node}\n${errors}` +
        report.checks.map(check => `${check.id}: ${check.status} — ${check.message} Next: ${check.nextStep}`).join('\n'));
      return report.configuration.valid ? (report.code === 'PREREQUISITES_MISSING' ? 3 : 0) : 2;
    }
    const prepared = await setup(root);
    const result = { code: 'SETUP_PREPARED', ...prepared, diagnostics: await doctor(prepared.root) };
    console.log(json ? JSON.stringify(result) :
      `Prepared ${result.root}; created: ${result.created.join(', ') || 'none'}.\n${result.diagnostics.code}: preparation is not runtime qualification. Run doctor --json for details.`);
    return 0;
  } catch {
    console.error(JSON.stringify({ code: 'LOCAL_IO_FAILED', message: 'Check installation paths, types and permissions; no automatic repair.' }));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
