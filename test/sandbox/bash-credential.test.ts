import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecords } from '../../src/records/index.js';
import { boundBashTools } from '../../src/sandbox/bash-tools.js';
import type { GuestOwner, ToolContext } from '../../src/sandbox/read-tools.js';

// VM DOUBLE that executes the exact guest argv/stdin with the host's /usr/bin/env + bash (no network, temp cwd), to observe what a guest
// command would see. Not guest/Alpine/gh proof; it proves the owner's delivery shape: token via stdin, never argv or the exec env.
const context: ToolContext = { workId: 'work', executionId: 'execution', invocationId: 'invocation', role: 'builder', environmentRef: 'environment', bootRef: 'boot', phaseId: 'phase' };
const token = 'ghs_syntheticBuilderToken0123456789';

async function harness(t: { after(fn: () => Promise<void>): void }, credential?: { token: string }, gate?: Promise<void>, inFlight?: () => void) {
  const root = await mkdtemp('/tmp/bcred-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await createRecords({ root });
  if (credential) records.registerSecret(credential.token); // the owner registers BEFORE acknowledging delivery
  const seen: { argv: string[]; env: unknown; stdin: unknown }[] = [];
  const vm: GuestOwner = { exec(argv, options) {
    seen.push({ argv, env: options.env, stdin: options.stdin });
    const output = execFileSync(argv[0]!, argv.slice(1).map(arg => arg.replaceAll('/workspace', root)), { input: typeof options.stdin === 'string' ? options.stdin : '', cwd: root, env: {} });
    const first = seen.length === 1;
    return { async *output() { if (first && gate) { inFlight?.(); await gate; } yield { stream: 'stdout' as const, data: output }; }, result: Promise.resolve({ exitCode: 0 }) };
  } };
  const signal = new AbortController();
  // The owner's mutable in-memory holder: renewal replaces the value, withdrawal clears it (ticket 20).
  const holder: { token: string | undefined } = { token: credential?.token };
  const bash = boundBashTools({ endpoint: '/unused', records, context, signal: signal.signal, vm, ...(credential ? { credential: { current: () => holder.token } } : {}) },
    () => !signal.signal.aborted, () => signal.abort());
  const run = async (command: string) => {
    const result = await bash(context, { name: 'bash', command, callId: `c${seen.length}` }, async () => {});
    assert.equal(result.status, 'success', JSON.stringify(result));
    if (result.status !== 'success') throw new Error('unreachable');
    return readFile(join(root, context.workId, 'evidence', result.reference.id, 'output'), 'utf8');
  };
  return { run, seen, root, holder, records };
}

test('AC5: the Builder credential reaches guest commands as explicit GH_TOKEN/gh credential helper via stdin, never argv/exec env; output is filtered', async t => {
  const h = await harness(t, { token });
  const output = await h.run('printf "%s|%s|%s|%s\\n" "${#GH_TOKEN}" "$GH_HOST" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0"; echo "$GH_TOKEN"; env | cut -d= -f1 | sort | tr "\\n" " "');
  assert.match(output, new RegExp(`^${token.length}\\|github\\.com\\|credential\\.https://github\\.com\\.helper\\|!/usr/bin/gh auth git-credential\\n`));
  assert.doesNotMatch(output, /ghs_synthetic/, 'a guest echo of the token is filtered before any capture/SDK');
  assert.ok(output.includes('█'));
  for (const call of h.seen) {
    assert.ok(call.argv.every(arg => !arg.includes(token)), 'never in argv');
    assert.deepEqual(call.env, {}, 'never in the exec wire environment');
    assert.equal(call.stdin, `${token}\n`);
    assert.deepEqual(call.argv.slice(0, 8), ['/usr/bin/env', '-i', 'GIT_AUTHOR_NAME=Software Factory Builder', 'GIT_AUTHOR_EMAIL=software-factory-builder@users.noreply.invalid', 'GIT_COMMITTER_NAME=Software Factory Builder', 'GIT_COMMITTER_EMAIL=software-factory-builder@users.noreply.invalid', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '/bin/bash']);
  }
  assert.ok(!(await readdir(h.root, { recursive: true })).some(name => name.includes(token)));
  const user = await h.run('cat; echo "[$0]"');
  assert.equal(user.trim(), '[/bin/bash]', 'the user command sees an empty stdin, as before');
});

test('AC5: without a delivered credential the exact previous guest argv/stdin is used (no prelude, no token variables)', async t => {
  const h = await harness(t);
  const output = await h.run('echo "${GH_TOKEN-unset}"');
  assert.equal(output.trim(), 'unset');
  assert.deepEqual(h.seen[0]!.argv, ['/usr/bin/env', '-i', 'GIT_AUTHOR_NAME=Software Factory Builder', 'GIT_AUTHOR_EMAIL=software-factory-builder@users.noreply.invalid', 'GIT_COMMITTER_NAME=Software Factory Builder', 'GIT_COMMITTER_EMAIL=software-factory-builder@users.noreply.invalid', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '/bin/bash', '-c', 'echo "${GH_TOKEN-unset}"']);
  assert.equal(h.seen[0]!.stdin, '');
});

test('ticket 20 AC2: a renewed credential reaches only NEW commands; a command already running keeps the environment it started with', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const inFlight = new Promise<void>(resolve => { entered = resolve; });
  const h = await harness(t, { token }, gate, entered);
  const renewed = 'ghs_syntheticRenewedToken9876543210';
  const running = h.run('echo "running:${#GH_TOKEN}"');
  // The event, not a sleep: the owner is consuming the first command's output, which the gate holds open.
  await inFlight;
  assert.equal(h.seen.length, 1, 'the first command is in flight');
  // Renewal delivered while the first command runs: registered for filtering first, then swapped in memory.
  h.records.registerSecret(renewed);
  h.holder.token = renewed;
  release();
  await running;
  const after = await h.run('echo "$GH_TOKEN"');
  assert.doesNotMatch(after, /ghs_synthetic/, 'the renewed value is filtered as well');
  assert.deepEqual(h.seen.map(call => call.stdin), [`${token}\n`, `${renewed}\n`], 'the running command kept the old value; the next command received the new one');
  // Withdrawal (end / external wait / cancellation): new commands receive nothing; the previous argv shape without prelude is used.
  h.holder.token = undefined;
  assert.equal((await h.run('echo "${GH_TOKEN-unset}"')).trim(), 'unset');
  assert.deepEqual([h.seen[2]!.argv.length, h.seen[2]!.stdin], [10, ''], 'no credential prelude (env -i + Factory commit identity + PATH + bash -c command)');
});

test('ticket 20 AC7: a renewed synthetic value split across output chunks and streams is filtered before capture and progress', async t => {
  const root = await mkdtemp('/tmp/bcred-split-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = await createRecords({ root });
  const renewed = 'ghs_syntheticSplitRenewal5556667778';
  records.registerSecret(token);
  const holder: { token: string | undefined } = { token };
  const vm: GuestOwner = { exec() {
    return { async *output() {
      yield { stream: 'stdout' as const, data: Buffer.from(`before ${renewed.slice(0, 9)}`) };
      yield { stream: 'stderr' as const, data: Buffer.from(`${renewed.slice(9, 20)}`) };
      yield { stream: 'stdout' as const, data: Buffer.from(`${renewed.slice(20)} after\n`) };
    }, result: Promise.resolve({ exitCode: 0 }) };
  } };
  const signal = new AbortController();
  const bash = boundBashTools({ endpoint: '/unused', records, context, signal: signal.signal, vm, credential: { current: () => holder.token } }, () => true, () => signal.abort());
  records.registerSecret(renewed); // the owner registers a renewal before it is used
  holder.token = renewed;
  const progress: string[] = [];
  const result = await bash(context, { name: 'bash', command: 'gh auth status', callId: 'split' }, async frame => { progress.push(Buffer.from(frame.data, 'base64').toString()); });
  assert.equal(result.status, 'success');
  if (result.status !== 'success') return;
  const output = await readFile(join(root, context.workId, 'evidence', result.reference.id, 'output'), 'utf8');
  assert.doesNotMatch(output, /ghs_synthetic|SplitRenewal/);
  assert.doesNotMatch(progress.join(''), /ghs_synthetic|SplitRenewal/, 'streamed progress is filtered too');
  assert.match(output, /before .* after/);
});

test('ticket 14 real-run fix: guest commands export a fixed PATH that CHILD processes see (gh is Go: it resolves git from its environment)', async t => {
  for (const credential of [undefined, { token }]) {
    const h = await harness(t, credential);
    // /usr/bin/env is a child process: it prints the exported environment, not bash's unexported default PATH.
    const output = await h.run('/usr/bin/env');
    assert.match(output, /^PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m, credential ? 'with the credential prelude' : 'without credential');
    assert.ok(h.seen[0]!.argv.includes(`PATH=${'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`), 'explicit in the fixed argv, never the host PATH');
  }
});
