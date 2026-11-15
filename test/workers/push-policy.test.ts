import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolContext, ToolProjection } from '../../src/sandbox/index.js';
import { builderBash } from '../../src/workers/bash.js';
import { allowedPush, pushDenied } from '../../src/workers/push-policy.js';

// Ticket 21 review HIGH: the Builder Host refuses any push but the exact leased one BEFORE the guest sees it (no effect, not critical).
const context = { workId: 'w', executionId: 'e', invocationId: 'i', role: 'builder', environmentRef: 'env', bootRef: 'boot' } as unknown as ToolContext;
test('the Builder Bash tool refuses a recaptured lease or a ref API write without reaching the guest; the invocation stays usable', async () => {
  const sent: string[] = [];
  let critical = false;
  const sandbox = { async executeTool(_context: ToolContext, call: { command?: string }) { sent.push(call.command ?? ''); return { status: 'failure', code: 'INVALID_TOOL_CALL' }; } } as unknown as ToolProjection;
  const policy = { branch: 'factory/3-0b9c6a52', expected: 'd'.repeat(40), head: 'e'.repeat(40) };
  const tool = builderBash(context, sandbox, () => { critical = true; }, false, undefined, undefined, policy);
  const recaptured = allowedPush({ ...policy, expected: '1'.repeat(40) });
  await assert.rejects(tool.execute('c1', { command: recaptured }, undefined, undefined, undefined as never), /PUSH_POLICY_DENIED: refused LOCALLY.*The only push allowed is exactly/);
  await assert.rejects(tool.execute('c2', { command: `gh api -X PATCH repos/a/b/git/refs/heads/${policy.branch} -f sha=${policy.head} -F force=true` }, undefined, undefined, undefined as never),
    /PUSH_POLICY_DENIED/);
  assert.deepEqual([sent, critical], [[], false], 'nothing reached the guest; not a critical failure');
  const none = builderBash(context, sandbox, () => {}, false, undefined, undefined, undefined);
  await assert.rejects(none.execute('c3', { command: allowedPush(policy) }, undefined, undefined, undefined as never), /no push is allowed/);
  assert.deepEqual(sent, []);
});

const branch = 'factory/3-0b9c6a52';
const factory = 'd'.repeat(40);
const local = 'e'.repeat(40);
const human = '1'.repeat(40);
test('review HIGH: the Builder Host refuses every push except the exact leased one of its publication activation, and API writes to refs', () => {
  const policy = { branch, expected: factory, head: local };
  assert.equal(pushDenied(allowedPush(policy), policy), null);
  assert.equal(pushDenied(`  ${allowedPush(policy)}\n`, policy), null);
  for (const command of [`git -C /workspace/checkout push --force-with-lease=refs/heads/${branch}:${human} origin ${local}:refs/heads/${branch}`,
    `git -C /workspace/checkout push --force origin ${local}:refs/heads/${branch}`, `git -C /workspace/checkout push -f origin HEAD:${branch}`, `git push origin +HEAD:refs/heads/${branch}`,
    `git push -u origin ${branch}`, `git push --force-with-lease origin ${branch}`, `${allowedPush(policy)} && git push origin HEAD:refs/heads/main`, `cd /workspace/checkout && git push`]) {
    assert.match(pushDenied(command, policy) ?? '', /^PUSH_POLICY_DENIED/, command);
  }
  assert.match(pushDenied(`gh api -X PATCH repos/acme/project/git/refs/heads/${branch} -f sha=${local} -F force=true`, policy) ?? '', /^PUSH_POLICY_DENIED/);
  assert.match(pushDenied('curl -X PATCH https://api.github.com/repos/acme/project/git/refs/heads/x', policy) ?? '', /^PUSH_POLICY_DENIED/);
  assert.equal(pushDenied('gh pr create --repo acme/project --draft --base main --head x --body-file /artifacts/publication/pr-body.md', policy), null);
  assert.equal(pushDenied('git ls-remote origin && git fetch origin', policy), null);
  assert.match(pushDenied(allowedPush(policy), undefined) ?? '', /no push is allowed/, 'outside a publication activation');
  assert.match(pushDenied(allowedPush({ ...policy, expected: local }), { ...policy, expected: local }) ?? '', /no push is allowed/, 'the PR-only continuation never pushes');
  assert.equal(pushDenied(allowedPush({ branch, expected: null, head: local }), { branch, expected: null, head: local }), null, 'creation: empty lease');
});

test('real run q21-human-v3: the chained `rev-parse && push` is refused LOCALLY (strict), and the denial says nothing was sent and to run the exact command alone', () => {
  const policy = { branch: 'factory/13-d34d952b', expected: null, head: '4629a30'.padEnd(40, '0') };
  const exact = allowedPush(policy);
  const chained = `git -C /workspace/checkout rev-parse HEAD && ${exact}`;
  const denied = pushDenied(chained, policy) ?? '';
  assert.match(denied, /^PUSH_POLICY_DENIED/, 'no chained/compound acceptance');
  assert.match(denied, /nothing was sent/i);
  assert.match(denied, /not a publication attempt/i);
  assert.ok(denied.includes(`run exactly this command ALONE as its own bash call: ${exact}`), denied);
  assert.equal(pushDenied(exact, policy), null);
  assert.match(pushDenied(`${exact}; echo done`, policy) ?? '', /^PUSH_POLICY_DENIED/);
});

test('ticket 18 compatibility: the policy accepts exactly the remote token Control emitted (origin or the configured https URL) and nothing else', () => {
  const url = 'https://github.com/acme/project.git';
  const policy = { branch: 'factory/3-0b9c6a52', expected: 'd'.repeat(40), head: 'e'.repeat(40), remote: url };
  assert.equal(pushDenied(allowedPush(policy), policy), null);
  assert.match(pushDenied(allowedPush({ ...policy, remote: 'origin' }), policy) ?? '', /PUSH_POLICY_DENIED/, 'another remote form than the emitted one');
  assert.match(pushDenied(allowedPush({ ...policy, remote: 'https://github.com/other/repo.git' }), policy) ?? '', /PUSH_POLICY_DENIED/);
  assert.match(pushDenied(allowedPush(policy), { ...policy, remote: 'git@github.com:acme/project.git' }) ?? '', /no push is allowed/, 'unsupported token: nothing allowed');
});
