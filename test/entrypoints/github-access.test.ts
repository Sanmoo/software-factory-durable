import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { prepareController } from './controller-configuration.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHubAccess } from '../../src/platform/github/index.js';
import { createIssueTracker } from '../../src/issue-tracker/index.js';
import { createCodeRepository } from '../../src/code-repository/index.js';

// A local executable stands in for gh/GitHub, not for the adapters or issuer.
async function fixture(t: { after(fn: () => Promise<void>): void }, scenario = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'factory-gh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'credentials'), { mode: 0o700 });
  await mkdir(join(root, 'run'), { mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(join(root, 'credentials/app.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const executable = join(root, 'gh');
  await writeFile(executable, `#!${process.execPath}
import { verify } from 'node:crypto';
const args = process.argv.slice(2);
const scenario=${JSON.stringify(scenario)};
const appToken=process.env.GH_TOKEN ?? '';
if (appToken.split('.').length===3) {
 const [header,payload,signature]=appToken.split('.');
 const claims=JSON.parse(Buffer.from(payload,'base64url'));
 if (claims.iss!=='1' || claims.exp-claims.iat>600 || !verify('RSA-SHA256',Buffer.from(header+'.'+payload),${JSON.stringify(publicKey.export({ type: 'spki', format: 'pem' }))},Buffer.from(signature,'base64url'))) process.exit(12);
}
const endpoint = args.at(-1);
const method = args[args.indexOf('--method') + 1];
if (args[0]!=='api' || !args.includes('--include') || (endpoint.endsWith('/access_tokens') ? method!=='POST' : method!=='GET') ||
 (endpoint.startsWith('/app') ? appToken.split('.').length!==3 : appToken!=='synthetic-installation-secret')) process.exit(13);
const expected = ['PATH','LANG','LC_ALL','GH_TOKEN','GH_HOST','GH_CONFIG_DIR','HOME','XDG_CONFIG_HOME','GH_PROMPT_DISABLED','GH_NO_UPDATE_NOTIFIER','GH_NO_EXTENSION_UPDATE_NOTIFIER','NO_COLOR'];
if (!process.env.GH_TOKEN || Object.keys(process.env).some(k => !expected.includes(k)) || args.some(a => a.includes(process.env.GH_TOKEN)) || !args.includes('X-GitHub-Api-Version: 2026-03-10') || args[args.indexOf('--hostname')+1] !== 'github.com') process.exit(9);
let permissions = ${JSON.stringify(scenario === 'repository' ? { metadata: 'read', contents: 'read', pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read', administration: 'read' } : { metadata: 'read', issues: 'write' })};
const installedRepositories = [
 {id:3,full_name:'acme/project',owner:{login:'acme'}},
 {id:4,full_name:'acme/other',owner:{login:'acme'}},
];
let body, status=200, headers='';
if (endpoint === '/app') body = {id:1};
else if (endpoint === '/app/installations/2') body = {id:2, app_id:1, account:{login:'acme'}, suspended_at:null, permissions:{...permissions,contents:'write',pull_requests:'write',checks:'read',statuses:'read',actions:'read',administration:'read'}};
else if (endpoint === '/app/installations/2/access_tokens' && method === 'POST') {
 let input=''; for await (const data of process.stdin) input+=data;
 const request=JSON.parse(input);
 if (${JSON.stringify(scenario)} === 'controller' && !request.permissions.issues) permissions={metadata:'read',contents:'read',pull_requests:'write',checks:'read',statuses:'read',actions:'read',administration:'read'};
 // https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
 // Official REST contract: repositories (names) or repository_ids, never repository_names.
 // This security fixture deliberately rejects omitted selectors rather than minting the installation ceiling.
 if (Object.keys(request).some(key => !['repositories','repository_ids','permissions'].includes(key)) ||
     (request.repositories === undefined) === (request.repository_ids === undefined) ||
     JSON.stringify(request.permissions)!==JSON.stringify(permissions)) process.exit(10);
 const selector=request.repositories ?? request.repository_ids;
 if (!Array.isArray(selector) || selector.length===0 || selector.some(value => request.repositories !== undefined ? typeof value!=='string' : !Number.isSafeInteger(value))) process.exit(10);
 const repositories=installedRepositories.filter(repo => selector.includes(request.repositories !== undefined ? repo.full_name.split('/')[1] : repo.id));
 if (repositories.length!==selector.length) process.exit(10);
 body={token:'synthetic-installation-secret', expires_at:new Date(Date.now()+3600000).toISOString(),permissions,repositories};
} else if (endpoint === '/repos/acme/project') body={id:3,full_name:'acme/project',owner:{login:'acme'}};
else if (endpoint === '/repos/acme/project/branches/main') body={name:'main',commit:{sha:'a'.repeat(40)}};
else if (endpoint.startsWith('/repos/acme/project/issues/1/dependencies/blocked_by') && ${JSON.stringify(scenario)} === 'dependency-denied') {status=403;body={message:'synthetic-installation-secret'};}
else if (endpoint.startsWith('/repos/acme/project/issues?') && ${JSON.stringify(scenario)} === 'dependency-denied') body=[{id:4,number:1,repository_url:'https://api.github.com/repos/acme/project'}];
else if (endpoint.startsWith('/repos/acme/project/issues')) body=[];
else process.exit(11);
if (scenario==='wide-grant' && endpoint.endsWith('/access_tokens')) body.permissions.contents='write';
if (scenario==='wrong-repository' && endpoint.endsWith('/access_tokens')) body.repositories[0].id=88,body.repositories[0].full_name='acme/other';
if (scenario==='missing-repositories' && endpoint.endsWith('/access_tokens')) delete body.repositories;
if (scenario==='multiple-repositories' && endpoint.endsWith('/access_tokens')) body.repositories=installedRepositories;
if (scenario==='malformed-token' && endpoint.endsWith('/access_tokens')) body.token='synthetic-secret\\nheader';
if (scenario==='rate-limit' && endpoint.includes('/issues')) {status=403;headers='retry-after: 37\\r\\nx-ratelimit-remaining: 0\\r\\n';body={message:'synthetic-installation-secret'};}
if (scenario==='later-page' && endpoint.includes('/issues?')) {
 if (endpoint.includes('page=2')) {status=503;body={message:'synthetic-installation-secret'};}
 else headers='link: <https://api.github.com/repos/acme/project/issues?per_page=100&page=2>; rel="next"\\r\\n';
}
if (scenario==='off-host-page' && endpoint.includes('/issues?')) headers='link: <https://attacker.invalid/repos/acme/project/issues?per_page=100&page=2>; rel="next"\\r\\n';
if (scenario==='bad-payload' && endpoint.includes('/issues')) body=[{id:1}];
if (scenario==='denied' && endpoint.includes('/issues')) {status=403; body={message:'synthetic-installation-secret'};}
process.stdout.write('HTTP/2.0 '+status+' Test\\r\\nx-github-api-version-selected: 2026-03-10\\r\\n'+headers+'\\r\\n'+JSON.stringify(body));
process.exit(status===200?0:1);
`, { mode: 0o700 });
  return { root, executable };
}
const scope = { repository: 'acme/project', installationId: 2, workflows: false, label: 'ready-for-agent' };

test('local GitHub fixture requires explicit REST selectors and grants only selected repositories from a multi-repository installation', async t => {
  const { root, executable } = await fixture(t);
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: '1', iat: 1, exp: 601 })).toString('base64url')}`;
  const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), await readFile(join(root, 'credentials/app.pem'))).toString('base64url')}`;
  const request = (selector: object) => spawnSync(executable, ['api', '--hostname', 'github.com', '--method', 'POST', '--include', '-H', 'X-GitHub-Api-Version: 2026-03-10', '--input', '-', '--', '/app/installations/2/access_tokens'], {
    input: JSON.stringify({ ...selector, permissions: { metadata: 'read', issues: 'write' } }),
    encoding: 'utf8', env: { GH_TOKEN: jwt }, timeout: 5000,
  });
  for (const selector of [{}, { repository_names: ['project'] }, { repositories: [] }]) {
    const rejected = request(selector);
    assert.equal(rejected.status, 10, `must reject ${JSON.stringify(selector)}`);
    assert.equal(rejected.stdout, '', 'rejected selection must not issue a grant');
  }
  for (const [selector, expected] of [
    [{ repositories: ['project'] }, 'acme/project'],
    [{ repository_ids: [4] }, 'acme/other'],
  ] as const) {
    const granted = request(selector);
    assert.equal(granted.status, 0, granted.stderr);
    const body = JSON.parse(granted.stdout.split('\r\n\r\n')[1]!);
    assert.deepEqual(body.repositories.map((repo: { full_name: string }) => repo.full_name), [expected]);
  }
});

test('IssueTracker.checkAccess explicitly narrows a multi-repository installation and reports read access without certifying merge barriers', async t => {
  const options = await fixture(t);
  const tracker = createIssueTracker({ github: createGitHubAccess({ ...options, appId: 1, privateKeyFile: 'credentials/app.pem' }) });
  const report = await tracker.checkAccess(scope);
  assert.equal(report.status, 'ok');
  assert.equal(report.identity?.appId, 1);
  assert.equal(report.identity?.installationId, 2);
  assert.equal(report.identity?.repositoryId, 3);
  assert.equal(report.certifiesMergeSafety, false);
  assert.equal(report.completeness, 'complete');
  assert.doesNotMatch(JSON.stringify(report), /synthetic-installation-secret|PRIVATE KEY/);
});

test('CodeRepository.checkAccess validates the configured base under its own purpose, independently of tracker reads', async t => {
  const options = await fixture(t, 'repository');
  const repository = createCodeRepository({ github: createGitHubAccess({ ...options, appId: 1, privateKeyFile: 'credentials/app.pem' }) });
  const report = await repository.checkAccess(scope, 'main');
  assert.equal(report.status, 'ok');
  assert.equal(report.grant?.purpose, 'repository');
  assert.equal(report.grant?.permissions.contents, 'read');
  assert.equal(report.grant?.permissions.issues, undefined);
});

export { fixture, scope };

test('IssueTracker.checkAccess fails closed on denied reads without exposing response secrets', async t => {
  const options = await fixture(t, 'denied');
  const report = await createIssueTracker({ github: createGitHubAccess({ ...options, appId: 1, privateKeyFile: 'credentials/app.pem' }) }).checkAccess(scope);
  assert.equal(report.status, 'blocked');
  assert.equal(report.code, 'GITHUB_ACCESS_DENIED');
  assert.equal(report.completeness, 'incomplete');
  assert.doesNotMatch(JSON.stringify(report), /synthetic-installation-secret/);
});

function invoke(root: string, args: string[], fixturePath: string) {
  const child = spawn(process.execPath, [resolve('dist/src/entrypoints/cli.js'), ...args, '--root', root, '--json'], {
    env: { PATH: `${fixturePath}:${process.env.PATH ?? ''}`, GH_TOKEN: 'synthetic-personal-not-authorized', HOME: '/forbidden-personal-profile' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += String(data); });
  child.stderr.on('data', data => { stderr += String(data); });
  return { child, result: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  }) };
}

test('authenticated doctor is owned by the controller and never persists grants or uses the CLI personal identity', { timeout: 20000 }, async t => {
  const options = await fixture(t, 'controller');
  await prepareController(options.root);
  const config = (await readFile(join(options.root, 'config.yaml'), 'utf8'))
    .replace('credentials/unused.pem', 'credentials/app.pem').replace('repositories: []', 'repositories: [{repository: acme/project, base: main, installationId: 2, workflows: false}]');
  await writeFile(join(options.root, 'config.yaml'), config);
  const unavailable = await invoke(options.root, ['doctor', '--authenticated'], options.root).result;
  assert.equal(unavailable.code, 3);
  assert.match(unavailable.stderr, /CONTROLLER_UNAVAILABLE/);
  const owner = invoke(options.root, ['run'], options.root);
  t.after(async () => { owner.child.kill('SIGTERM'); await owner.result; });
  for (let attempt = 0; attempt < 80; attempt++) {
    if ((await invoke(options.root, ['status'], options.root).result).code === 0) break;
    await delay(20);
  }
  const result = await invoke(options.root, ['doctor', '--authenticated'], options.root).result;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.kind, 'access');
  assert.equal(report.scope, 'authenticated');
  assert.equal(report.results[0].tracker.status, 'ok');
  assert.equal(report.results[0].repository.status, 'ok');
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-installation-secret|synthetic-personal-not-authorized|PRIVATE KEY/);
  const status = JSON.parse((await invoke(options.root, ['status'], options.root).result).stdout);
  assert.equal(status.historyLength, 0, 'diagnosis is not a durable command or workflow');
  owner.child.kill('SIGTERM');
  const stopped = await owner.result;
  assert.equal(stopped.code, 0, stopped.stderr);
  const database = await readFile(join(options.root, 'data/control.sqlite'));
  assert.equal(database.includes(Buffer.from('synthetic-installation-secret')), false);
  assert.equal(database.includes(Buffer.from('PRIVATE KEY')), false);
});

test('IssueTracker.checkAccess does not claim native dependency support after a denied probe', async t => {
  const options = await fixture(t, 'dependency-denied');
  const report = await createIssueTracker({ github: createGitHubAccess({ ...options, appId: 1, privateKeyFile: 'credentials/app.pem' }) }).checkAccess(scope);
  assert.equal(report.status, 'blocked');
  assert.equal(report.code, 'GITHUB_ACCESS_DENIED');
});

for (const [scenario, code] of [
  ['wide-grant', 'CREDENTIAL_SCOPE_MISMATCH'],
  ['wrong-repository', 'CREDENTIAL_SCOPE_MISMATCH'],
  ['missing-repositories', 'INVALID_CREDENTIAL_GRANT'],
  ['multiple-repositories', 'CREDENTIAL_SCOPE_MISMATCH'],
  ['malformed-token', 'INVALID_CREDENTIAL_GRANT'],
  ['later-page', 'GITHUB_QUERY_FAILED'],
  ['off-host-page', 'INVALID_PAGINATION'],
  ['bad-payload', 'INVALID_GITHUB_PAYLOAD'],
  ['rate-limit', 'GITHUB_RATE_LIMITED'],
]) test(`IssueTracker.checkAccess rejects ${scenario} without partial success or secret leakage`, async t => {
  const options = await fixture(t, scenario);
  const report = await createIssueTracker({ github: createGitHubAccess({ ...options, appId: 1, privateKeyFile: 'credentials/app.pem' }) }).checkAccess(scope);
  assert.equal(report.status, 'blocked');
  assert.equal(report.code, code);
  assert.equal(report.completeness, 'incomplete');
  assert.ok(report.nextStep);
  if (scenario === 'rate-limit') {
    assert.equal(report.waitSeconds, 37);
    assert.equal(report.purpose, 'tracker');
    assert.equal(report.repository, 'acme/project');
  }
  assert.doesNotMatch(JSON.stringify(report), /synthetic-installation-secret|synthetic-secret|PRIVATE KEY/);
});

for (const unsafe of ['permissions', 'symlink']) test(`IssueTracker.checkAccess refuses ${unsafe} key without trying another identity`, async t => {
  const options = await fixture(t);
  const key = join(options.root, 'credentials/app.pem');
  if (unsafe === 'permissions') await chmod(key, 0o644);
  else { await rm(key); await symlink('absent.pem', key); }
  const report = await createIssueTracker({ github: createGitHubAccess({ ...options, executable: '/does-not-exist', appId: 1, privateKeyFile: 'credentials/app.pem' }) }).checkAccess(scope);
  assert.equal(report.status, 'blocked');
  assert.notEqual(report.code, 'GITHUB_TRANSPORT_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE KEY/);
});
