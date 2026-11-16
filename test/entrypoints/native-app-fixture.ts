import https from 'node:https';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { remainingMs } from '../runner/budget.js';

/** Synthetic external boundary only; never used with real credentials or as GitHub proof. */
export function installNativeAppFixture(executable: string, scenario: string) {
  const original = https.request;
  const observation = { tokenPosts: 0, trace: [] as string[] };
  const substitute = (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
    if (options.method === 'POST') observation.tokenPosts++;
    observation.trace.push(`${options.method} ${options.path}`);
    // Closed App operation set; the installation id is decided by the world executable (several installations per world).
    const allowed = (path: string) => path === '/app' ? 'GET' : /^\/app\/installations\/\d+$/.test(path) ? 'GET' : /^\/app\/installations\/\d+\/access_tokens$/.test(path) ? 'POST' : undefined;
    const headers = options.headers as Record<string, string>;
    if (options.hostname !== 'api.github.com' || options.port !== 443 || options.protocol !== 'https:' || options.rejectUnauthorized !== true || options.agent !== false || options.maxHeaderSize !== 16384 || allowed(options.path!) !== options.method || headers.Authorization?.split(' ')[0] !== 'Bearer' || headers['X-GitHub-Api-Version'] !== '2026-03-10' || headers.Accept !== 'application/vnd.github+json' || !headers['User-Agent']) throw Error('INVALID_NATIVE_CONTRACT');
    const request = new EventEmitter() as ClientRequest;
    request.destroy = () => request;
    request.end = ((input?: string) => {
      queueMicrotask(() => {
        if (scenario === 'uncertain-post' && options.method === 'POST') { request.emit('error', new Error('synthetic-secret')); return; }
        const output = spawnSync(executable, ['api', '--hostname', 'github.com', '--method', options.method!, '--include', '-H', 'X-GitHub-Api-Version: 2026-03-10', '--', options.path!], { env: { GH_TOKEN: headers.Authorization!.slice(7), NATIVE_FIXTURE: '1' }, input, encoding: 'utf8', timeout: remainingMs() });
        if (!output.stdout) { request.emit('error', new Error('INVALID_NATIVE_FIXTURE')); return; }
        const [head, body] = output.stdout.split('\r\n\r\n');
        const lines = head!.split('\r\n');
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = Number(lines.shift()!.split(' ')[1]); response.complete = true;
        response.rawHeaders = lines.flatMap(line => { const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1).trim()]; });
        response.rawHeaders.push('content-type', 'application/json');
        if (scenario === 'native-redirect') response.statusCode = 302;
        if (scenario === 'native-version') response.rawHeaders[1] = 'wrong';
        if (scenario === 'known-post-rejected' && options.method === 'POST') response.statusCode = 403;
        if (['post-rate-limit-429', 'post-rate-limit-403'].includes(scenario) && options.method === 'POST') {
          response.statusCode = scenario === 'post-rate-limit-429' ? 429 : 403;
          response.rawHeaders.push('retry-after', '37');
        }
        if (scenario === 'native-status') response.statusCode = 202;
        if (scenario === 'native-duplicate') response.rawHeaders.push('content-type', 'application/json');
        if (scenario === 'native-oversize') { callback(response); response.emit('data', Buffer.alloc(2097153)); response.emit('end'); return; }
        if (scenario === 'native-incomplete') response.complete = false;
        callback(response); response.emit('data', Buffer.from(body!)); response.emit('end');
      });
      return request;
    }) as ClientRequest['end'];
    return request;
  };
  https.request = substitute as typeof https.request;
  return Object.assign(() => { https.request = original; }, { observation });
}
