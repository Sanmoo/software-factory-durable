import assert from 'node:assert/strict';
import fs from 'node:fs';
import { link, lstat, mkdir, readFile, readdir, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '#factory-pi';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { builderBash } from '../../dist/src/workers/bash.js';
import {
  asyncBashFiles,
  imageMimeFacade,
  lexicalQueueFiles,
  prepareDevelopmentSdk,
  sdkProfile,
  sdkStagingDirectory,
} from '../../dist/src/workers/sdk-profile.js';
import { connectReadTools } from '../../dist/src/sandbox/read-tools.js';
import { nativeOwner } from '../../dist/test/sandbox/native-owner.fixture.js';
import { remainingMs } from '../../dist/test/runner/budget.js';

const context = {
  workId: 'v3-work',
  executionId: 'v3-exec',
  invocationId: 'v3-invocation',
  role: 'builder',
  environmentRef: 'v3-env',
  bootRef: 'v3-boot',
  phaseId: 'v3-phase',
};
const deferred = () => {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};

test('new private development profile v3 preserves prior read correction and MIME facade', { timeout: remainingMs() }, async () => {
  assert.equal(sdkProfile.id, 'factory-development-pi-1.5.2-read-async-bash-lexical-v3');
  const evidence = await prepareDevelopmentSdk();
  assert.deepEqual(await prepareDevelopmentSdk(), evidence);
  assert.equal(evidence.license, 'MIT');
  assert.equal(evidence.standaloneLicense, false);
  assert.equal(evidence.resultSHA256, '06867a067ebbadca2e06f75ccb4e682cd7e37b9683d41a71562f770b3105a209');
});

test('v3 preparation refuses unexpected bytes, unsafe links and missing metadata without repair', { timeout: remainingMs() }, async () => {
  const root = '.scratch/factory-development-sdk-v3';
  const extra = root + '/sdk/task105-unexpected';
  try {
    await writeFile(extra, 'OWNED_DRIFT', { flag: 'wx', mode: 0o600 });
    await assert.rejects(prepareDevelopmentSdk(), /SDK_STAGING_DRIFT/);
    assert.equal(await readFile(extra, 'utf8'), 'OWNED_DRIFT');
  } finally {
    await unlink(extra);
  }
  const readme = root + '/sdk/README.md';
  await rename(readme, readme + '.task105-held');
  try {
    await symlink(process.cwd() + '/node_modules/@earendil-works/pi-coding-agent/README.md', readme);
    await assert.rejects(prepareDevelopmentSdk(), /SDK_STAGING_NOT_OWNED/);
  } finally {
    await unlink(readme);
    await rename(readme + '.task105-held', readme);
  }
  await rename(readme, readme + '.task105-held');
  try {
    await link(readme + '.task105-held', readme);
    await assert.rejects(prepareDevelopmentSdk(), /SDK_STAGING_NOT_OWNED/);
    assert.equal((await lstat(readme)).nlink, 2, 'no repair of hardlinked file');
  } finally {
    await unlink(readme);
    await rename(readme + '.task105-held', readme);
  }
  const profile = root + '/profile.json';
  const profileBytes = await readFile(profile);
  await unlink(profile);
  try {
    await assert.rejects(prepareDevelopmentSdk(), { code: 'ENOENT' });
    await assert.rejects(readFile(profile), { code: 'ENOENT' });
  } finally {
    await writeFile(profile, profileBytes, { mode: 0o600, flag: 'wx' });
  }
  assert.deepEqual(await prepareDevelopmentSdk(), await prepareDevelopmentSdk());
});

test('Factory rejects actual unpatched native SDK before any tool RPC or guest effect', { timeout: remainingMs() }, async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    registerHooks({ resolve(spec, context, next) {
      return next(spec === '#factory-pi' ? pathToFileURL(process.cwd() + '/node_modules/@earendil-works/pi-coding-agent/dist/index.js').href : spec, context);
    } });
    const { builderBash } = await import('./dist/src/workers/bash.js');
    let calls = 0;
    const tool = builderBash(${JSON.stringify(context)}, { executeTool() { calls++; throw new Error('FORBIDDEN_RPC'); } });
    await assert.rejects(tool.execute('guard', { command: 'FIXED_DATA_ONLY' }), /BASH_EFFECTS_OR_CAPTURE_UNKNOWN/);
    assert.equal(calls, 0);
    await assert.rejects(tool.execute('later', { command: 'FIXED_DATA_ONLY' }), /BASH_INVOCATION_REVOKED/);
    console.log('PASS missing onDataAsync: zero tool RPCs, no guest effect, later invocation revoked');
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: remainingMs() });
  assert.match(result.stdout, /zero tool RPCs/);
  assert.equal(result.stderr, '');
});

for (const mode of ['release', 'abort', 'stream-error', 'bounded-resume']) {
  test(`Factory native async Bash + real Protocol/Records: held private stream ${mode}`, { timeout: remainingMs() }, async t => {
    const source = Buffer.from('head synthetic-secret π\n' + 'fixed-data\n'.repeat(mode === 'bounded-resume' ? 80000 : 8000) + 'tail π');
    const produced = deferred();
    const offered = deferred();
    const expected = source.toString().replace('synthetic-secret', '█');
    let guestCalls = 0;
    const owner = await nativeOwner(context, {
      exec(argv, options) {
        guestCalls++;
        assert.deepEqual(argv, ['/usr/bin/env', '-i', '/bin/bash', '-c', 'FIXED_DATA_ONLY']);
        assert.equal(options.windowBytes, 65536);
        return {
          async *output() {
            try {
              for (let offset = 0; offset < source.length; offset += 8192) {
                if (offset >= 256 * 1024) offered.resolve();
                yield { stream: 'stdout', data: source.subarray(offset, offset + 8192) };
              }
            } finally {
              offered.resolve();
              produced.resolve();
            }
          },
          result: Promise.resolve({ exitCode: 0 }),
        };
      },
    });
    const client = await connectReadTools(owner.owner.endpoint, context);
    const original = fs.createWriteStream;
    const oldTmp = process.env.TMPDIR;
    process.env.TMPDIR = owner.root;
    const held = deferred();
    const streams = [];
    fs.createWriteStream = (path, options) => {
      assert.ok(path.startsWith(owner.root + '/'));
      assert.equal(options.flags, 'wx');
      assert.equal(options.mode, 0o600);
      const stream = original(path, { ...options, highWaterMark: 16384 });
      const entry = { stream, path, writes: [], closed: deferred() };
      streams.push(entry);
      stream.once('close', entry.closed.resolve);
      // Keep deliberate stream errors observed even against the unpatched RED SDK.
      stream.on('error', () => {});
      stream.cork();
      const write = stream.write;
      stream.write = function (chunk, ...rest) {
        const accepted = write.call(this, chunk, ...rest);
        entry.writes.push({ bytes: chunk.length, pending: this.writableLength });
        if (!accepted) held.resolve(entry);
        return accepted;
      };
      return stream;
    };
    syncBuiltinESMExports();
    const controller = new AbortController();
    let settled = false,
      critical = 0;
    const tool = builderBash(context, { executeTool: (_context, call, onData, signal) => client.executeTool(call, onData, signal) }, () => {
      critical++;
    });
    const running = tool
      .execute('v3-call', { command: 'FIXED_DATA_ONLY' }, controller.signal)
      .then(
        value => ({ value }),
        error => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      const entry = await held.promise;
      await setImmediate();
      await setImmediate();
      assert.equal(settled, false, 'native completion must wait for private stream');
      assert.equal(entry.stream.bytesWritten, 0);
      const admitted = entry.writes.length;
      await setImmediate();
      assert.equal(entry.writes.length, admitted, 'no further native admission while drain held');
      assert.ok(entry.stream.writableLength <= 40960);
      // Do not await the whole producer while capture is held: socket pressure
      // is allowed to stop it. 256KiB source plus base64/envelopes exceeds
      // Protocol's 256KiB wire-byte budget before releasing native capture.
      if (mode === 'bounded-resume') {
        await offered.promise;
        assert.equal(settled, false);
        assert.equal(entry.writes.length, admitted, 'capture stays paused while >budget valid data is offered');
      }
      if (mode === 'release' || mode === 'bounded-resume') entry.stream.uncork();
      else if (mode === 'abort') controller.abort();
      else entry.stream.destroy(new Error('FIXED_STREAM_FAILURE'));
      const outcome = await running;
      await entry.closed.promise;
      assert.equal(guestCalls, 1);
      assert.ok(
        entry.writes.every(write => write.pending <= 40960),
        'all native writes respect HWM + one application chunk',
      );
      assert.equal(entry.stream.listenerCount('drain'), 0);
      if (mode === 'release' || mode === 'bounded-resume') {
        await produced.promise;
        assert.equal(outcome.error, undefined);
        assert.equal(critical, 0);
        assert.match(JSON.stringify(outcome.value), /Full output:/);
        assert.equal(await readFile(entry.path, 'utf8'), expected);
      } else {
        assert.match(outcome.error.message, mode === 'abort' ? /aborted.*effects unknown/ : /BASH_EFFECTS_OR_CAPTURE_UNKNOWN/);
        assert.ok(critical >= 1, 'critical failure revokes the invocation');
        await assert.rejects(tool.execute('later', { command: 'FIXED_DATA_ONLY' }), /BASH_INVOCATION_REVOKED/);
        assert.equal(guestCalls, 1);
      }
      t.diagnostic(
        `source=${source.length}, native max pending=${Math.max(...entry.writes.map(write => write.pending))}; ${mode === 'bounded-resume' ? 'valid >256KiB stream resumes losslessly after held native capture' : mode}`,
      );
    } finally {
      for (const { stream } of streams) stream.uncork();
      await running;
      for (const { stream } of streams) stream.destroy();
      fs.createWriteStream = original;
      syncBuiltinESMExports();
      if (oldTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = oldTmp;
      client.close();
      await owner.close();
    }
  });
}

for (const mode of ['release', 'abort', 'stream-error']) {
  test(`new Node24 v3 worker projection/session JSONL: held native stream ${mode}`, { timeout: remainingMs() }, async t => {
    const source = Buffer.from('head synthetic-secret π\n' + 'fixed-data\n'.repeat(8000) + 'tail π');
    const produced = deferred();
    const owner = await nativeOwner(context, {
      exec() {
        return {
          async *output() {
            for (let offset = 0; offset < source.length; offset += 8192) yield { stream: 'stdout', data: source.subarray(offset, offset + 8192) };
            produced.resolve();
          },
          result: Promise.resolve({ exitCode: 0 }),
        };
      },
    });
    const directory = join(owner.root, 'profile');
    const recordsRoot = join(owner.root, 'worker-records');
    for (const path of [directory, join(directory, 'sessions'), recordsRoot, join(owner.root, 't'), join(owner.root, 'c')]) {
      await mkdir(path, { mode: 0o700 });
    }
    const child = fork(fileURLToPath(new URL('../../dist/src/entrypoints/worker.js', import.meta.url)), [], {
      execPath: process.execPath,
      execArgv: ['--import', fileURLToPath(new URL('./fixtures/async-bash-provider-preload.mjs', import.meta.url))],
      env: { PATH: '', LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: join(owner.root, 't'), XDG_CACHE_HOME: join(owner.root, 'c') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages = [];
    const held = deferred();
    const snapshot = deferred();
    let output = '';
    child.stdout.on('data', data => {
      output += data;
    });
    child.stderr.on('data', data => {
      output += data;
    });
    child.on('message', message => {
      messages.push(message);
      if (message.kind === 'test-native-held') held.resolve(message);
      if (message.kind === 'test-native-snapshot') snapshot.resolve(message);
    });
    const exited = once(child, 'exit');
    try {
      child.send({
        version: 1,
        context,
        endpoint: owner.owner.endpoint,
        recordsRoot,
        knownSecrets: ['synthetic-secret', 'synthetic-key'],
        prompt: mode === 'release' ? 'Run Bash output.' : 'blocked-bash output.',
        profile: {
          id: sdkProfile.id,
          directory,
          systemPrompt: 'Private v3 bounded async Bash fixture.',
          providerId: 'offline-fixture',
          modelId: 'reader',
          apiKey: 'synthetic-key',
          provider: {
            api: 'openai-completions',
            baseUrl: 'https://offline.invalid',
            models: [
              {
                id: 'reader',
                name: 'Reader',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 100000,
                maxTokens: 1000,
              },
            ],
          },
        },
      });
      const first = await held.promise;
      await produced.promise;
      child.send({ kind: 'test-native-snapshot' });
      const state = await snapshot.promise;
      assert.equal(state.writes, first.writes);
      assert.equal(state.pending, first.pending);
      assert.equal(state.bytesWritten, 0);
      assert.ok(state.pending <= 40960);
      assert.equal(
        messages.some(message => message.kind === 'worker-result'),
        false,
      );
      child.send({ kind: mode === 'release' ? 'test-native-release' : mode === 'abort' ? 'abort' : 'test-native-fail' });
      const [code, signal] = await exited;
      assert.equal(code, 0, output);
      assert.equal(signal, null);
      assert.equal(output, '');
      const result = messages.find(message => message.kind === 'worker-result');
      assert.ok(result);
      assert.equal(result.status, mode === 'release' ? 'completed' : 'interrupted');
      assert.equal(messages.filter(message => message.kind === 'provider-request').length, mode === 'release' ? 2 : 1);
      const session = SessionManager.open(result.sessionFile, join(directory, 'sessions'));
      const tools = session.buildSessionContext().messages.filter(message => message.role === 'toolResult');
      assert.equal(tools.length, 1);
      assert.equal(tools[0].isError, mode !== 'release');
      const jsonl = await readFile(result.sessionFile, 'utf8');
      assert.doesNotMatch(jsonl, /synthetic-secret|synthetic-key/);
      if (mode === 'release') {
        assert.match(JSON.stringify(tools), /tail π/);
        const path = tools[0].details.fullOutputPath;
        assert.equal(await readFile(path, 'utf8'), source.toString().replace('synthetic-secret', '█'));
      }
      t.diagnostic(
        `held native writes=${state.writes}, pending=${state.pending}, bytesWritten=0; source=${source.length} bytes (< protocol cap); outcome=${result.status}`,
      );
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
      await owner.close();
    }
  });
}

test('v3 entire copied tree has exactly eleven corrections and unchanged MIME facade', async t => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const upstream = 'node_modules/@earendil-works/pi-coding-agent';
  const target = sdkStagingDirectory + '/sdk';
  const corrected = {
    ...asyncBashFiles,
    ...lexicalQueueFiles,
    'dist/core/tools/read.js': { before: sdkProfile.upstreamSHA256, after: sdkProfile.resultSHA256 },
  };
  const changed = [];
  const tree = createHash('sha256');
  const root = await lstat(sdkStagingDirectory);
  assert.equal(root.uid, process.getuid());
  assert.equal(root.mode & 0o777, 0o700);
  assert.equal(await realpath(sdkStagingDirectory), process.cwd() + '/' + sdkStagingDirectory);
  async function verify(relative = '') {
    const source = join(upstream, relative),
      dest = join(target, relative);
    const original = await lstat(source),
      copy = await lstat(dest);
    assert.equal(copy.uid, process.getuid());
    if (original.isDirectory()) {
      assert.equal(copy.isDirectory(), true);
      assert.equal(copy.isSymbolicLink(), false);
      tree.update(JSON.stringify([relative, 'directory']) + '\n');
      const names = (await readdir(source)).sort();
      assert.deepEqual((await readdir(dest)).sort(), names);
      for (const name of names) await verify(join(relative, name));
    } else if (original.isSymbolicLink()) {
      assert.equal(copy.isSymbolicLink(), true);
      const link = await readlink(source);
      assert.equal(await readlink(dest), link);
      tree.update(JSON.stringify([relative, 'symlink', link]) + '\n');
    } else {
      assert.equal(copy.isFile(), true);
      assert.equal(copy.nlink, 1);
      const before = sha(await readFile(source)),
        after = sha(await readFile(dest));
      if (corrected[relative]) {
        assert.equal(before, corrected[relative].before);
        assert.equal(after, corrected[relative].after);
      } else assert.equal(after, before);
      if (before !== after) changed.push(relative);
      tree.update(JSON.stringify([relative, 'file', after]) + '\n');
    }
  }
  await verify();
  assert.deepEqual(changed.sort(), Object.keys(corrected).sort());
  assert.equal(sha(await readFile(join(sdkStagingDirectory, imageMimeFacade.file))), imageMimeFacade.sha256);
  const resultTreeSHA256 = tree.digest('hex');
  assert.equal(resultTreeSHA256, 'c64ed4dde34103f3829ffe3edb5de6a6bd886a6dab22e589f1cd8f2968713816');
  t.diagnostic('verified entire v3 SDK tree SHA256=' + resultTreeSHA256 + '; exactly eleven corrected regular files');
});
