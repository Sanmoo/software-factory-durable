import https from 'node:https';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { ClientRequest, IncomingMessage } from 'node:http';

/** Synthetic external boundary only; never used with real credentials or as GitHub proof. */
export function installNativeAppFixture(executable: string, scenario: string): () => void {
  const original = https.request;
  const substitute = (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
    const allowed: Record<string, string> = { '/app': 'GET', '/app/installations/2': 'GET', '/app/installations/2/access_tokens': 'POST' };
    const headers = options.headers as Record<string, string>;
    if (options.hostname !== 'api.github.com' || options.port !== 443 || options.protocol !== 'https:' || options.rejectUnauthorized !== true || options.agent !== false || options.maxHeaderSize !== 16384 || allowed[options.path!] !== options.method || headers.Authorization?.split(' ')[0] !== 'Bearer' || headers['X-GitHub-Api-Version'] !== '2026-03-10' || headers.Accept !== 'application/vnd.github+json' || !headers['User-Agent']) throw Error('INVALID_NATIVE_CONTRACT');
    const request = new EventEmitter() as ClientRequest;
    request.destroy = () => request;
    request.end = ((input?: string) => {
      queueMicrotask(() => {
        if (scenario === 'uncertain-post' && options.method === 'POST') { request.emit('error', new Error('synthetic-secret')); return; }
        const output = spawnSync(executable, ['api', '--hostname', 'github.com', '--method', options.method!, '--include', '-H', 'X-GitHub-Api-Version: 2026-03-10', '--', options.path!], { env: { GH_TOKEN: headers.Authorization!.slice(7), NATIVE_FIXTURE: '1' }, input, encoding: 'utf8', timeout: 5000 });
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
  return () => { https.request = original; };
}
