import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Ticket 14 static gate (spec §2/§9.1, Q7): the Builder publishes DIRECTLY in its guest; the controller has no push gateway/publisher, and
// there is no Git/gh wrapper, shell parser, effect-registration tool or special journal for push/PR creation.
async function sources(directory = 'src'): Promise<{ path: string; text: string }[]> {
  const result: { path: string; text: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(path));
    else if (entry.name.endsWith('.ts')) result.push({ path, text: await readFile(path, 'utf8') });
  }
  return result;
}

test('AC1/AC5: no controller push/PR-creation path, no Git/gh wrapper or shell parser for publication', async () => {
  const files = await sources();
  // Host git runs only to prepare/inspect the checkout, never to push. Heuristic (review LOW): ANY file that spawns a process and names
  // git (any path or a bare `git`) must not carry a push argument or a lease.
  const spawns = files.filter(item => /\b(execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)\s*\(/.test(item.text) && /['"`](?:[^'"`\s]*\/)?git['"`]/.test(item.text));
  assert.ok(spawns.some(item => item.path === 'src/sandbox/checkout.ts'), 'the heuristic sees the known host git');
  for (const file of spawns) assert.doesNotMatch(file.text, /['"`]push['"`]|--force-with-lease|\bgit push\b/, `${file.path}: host git never pushes`);
  // The only Host git files: the Work checkout preparation/inspection, and the release build reading the Factory's OWN source metadata.
  for (const file of spawns.filter(item => /['"`](?:\/usr\/bin\/)?git['"`]\s*,/.test(item.text))) {
    assert.ok(['src/sandbox/checkout.ts', 'src/sandbox/checkout-inspection.ts', 'src/entrypoints/release-build.ts'].includes(file.path), file.path);
  }
  // The controller's GitHub client has exactly one write (the Question comment); no pulls/refs/contents writes.
  const github = files.find(item => item.path === 'src/platform/github/index.ts')!.text;
  assert.equal((github.match(/JSON\.stringify\(\{ body \}\)/g) ?? []).length, 1, 'the only POST body is the issue comment');
  assert.doesNotMatch(github, /\/pulls['`]|\/git\/refs|PATCH|PUT/, 'no PR creation/update or ref write by the controller');
  // The CodeRepository contract stays read-only for the implementation publication.
  const repository = files.find(item => item.path === 'src/code-repository/index.ts')!.text;
  const contract = /export interface CodeRepository \{([\s\S]*?)\n\}/.exec(repository)![1]!;
  // Ticket 15 adds Q4B `readPullRequest`, a GET-only read under the reduced `checks-read` grant (no write permission).
  // Ticket 16 adds Q4B `setDraft`: the draft/ready flag only, a controller effect decided by Control's readiness evaluation.
  assert.deepEqual([...contract.matchAll(/^\s+(\w+)\(/gm)].map(match => match[1]), ['checkAccess', 'findPublication', 'readPullRequest', 'setDraft']);
  // The controller's only GraphQL documents are the two fixed draft mutations and (ticket 17) the atomic conditional deletion of the
  // Work's OWN delivered branch; never review, approval, merge or any other mutation.
  assert.deepEqual([...github.matchAll(/\{ (\w+)\(input:/g)].map(match => match[1]).sort(), ['convertPullRequestToDraft', 'markPullRequestReadyForReview', 'updateRefs']);
  // Ticket 17: updateRefs only deletes ONE ref conditionally (beforeOid, afterOid zero, force false), under the single-use branch-cleanup grant.
  assert.match(github, /refUpdates: \[\{ name: `refs\/heads\/\$\{branch\}`, beforeOid, afterOid: '0'\.repeat\(40\), force: false \}\]/);
  assert.match(github, /'branch-cleanup': \{ metadata: 'read', contents: 'write', pull_requests: 'read' \}/);
  assert.equal((github.match(/issue\(scope, 'branch-cleanup'\)/g) ?? []).length, 1, 'one fresh cleanup grant site');
  assert.equal((github.match(/'POST', 'graphql'/g) ?? []).length, 1, 'one GraphQL call site');
  assert.doesNotMatch(github, /mergePullRequest|addPullRequestReview|submitPullRequestReview|approve|enablePullRequestAutoMerge|\/merge['`]|\/reviews['`]/i);
  assert.match(github, /'readiness-write': \{ metadata: 'read', pull_requests: 'write' \}/);
  const reader = files.find(item => item.path === 'src/code-repository/pull-request.ts')!.text;
  assert.doesNotMatch(reader, /comment\(|transient\(|revoke\(|'POST'|'PATCH'|'PUT'|'DELETE'/, 'readPullRequest never writes');
  assert.match(github, /'checks-read': \{ metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', administration: 'read' \}/);
  // No shell parsing of Builder commands or effect-registration tool for push/PR (Q7): the Workers and Sandbox never look for them.
  for (const file of files.filter(item => /^src\/(workers|sandbox|platform)\//.test(item.path))) {
    assert.doesNotMatch(file.text, /registrar_efeito|register_effect|git push|gh pr create|pr create/, file.path);
  }
});
