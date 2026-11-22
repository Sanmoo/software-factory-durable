import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remainingMs } from '../runner/budget.js';

const workId = 'producer-ordering-work';
const environment = `env-${createHash('sha256').update(workId).digest('hex')}`;
const boot = 'boot-66666666-2222-4333-8444-555555555555';

async function shortRoot() {
  // The runtime socket profile needs a short root. Locally, the configured test
  // directory's parent is the already-authorized /home/.../software-factory-test.
  const base = process.env.FACTORY_SANDBOX_TEST_ROOT ? dirname(process.env.FACTORY_SANDBOX_TEST_ROOT) : tmpdir();
  for (let attempt = 0; attempt < 10; attempt++) {
    const root = join(base, randomBytes(1).toString('hex'));
    try {
      await mkdir(root, { mode: 0o700 });
      return root;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  throw new Error('NO_NEW_SHORT_TEST_DIRECTORY_AVAILABLE');
}

test('Sandbox adapter configures native public HTTP mediation and private boot CA (real SDK hooks; no VM/DNS/fetch/CA generation)', async () => {
  const root = await shortRoot();
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-test-module-mocks',
        '--import',
        fileURLToPath(new URL('./adapter-diagnostics-fixture.js', import.meta.url)),
        fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)),
        root,
        environment,
        boot,
      ],
      {
        timeout: remainingMs(),
        maxBuffer: 16384,
        encoding: 'utf8',
        env: {
          PATH: '',
          NODE_DISABLE_COMPILE_CACHE: '1',
          ADAPTER_DIAGNOSTIC_FIXTURE_MODE: 'http-policy',
        },
      },
    );
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 1, child.stderr); // The VM double intentionally rejects start.
    assert.match(await readFile(join(root, 'audit'), 'utf8'), /^network-policy-verified\n/);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'environments', environment, boot, 'failure.json'), 'utf8')), {
      version: 1,
      boot,
      phase: 'vm-start',
      code: 'GUEST_READINESS_TIMEOUT',
    });
    assert.equal(`${child.stdout}${child.stderr}`.includes('PRIVATE_TOKEN_CANARY'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Sandbox adapter confines actual SDK filesystem RPC and ancestor symlinks (VM doubled, no VM/network/signal)', async () => {
  const root = await shortRoot();
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-test-module-mocks',
        '--import',
        fileURLToPath(new URL('./adapter-diagnostics-fixture.js', import.meta.url)),
        fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)),
        root,
        environment,
        boot,
      ],
      {
        timeout: remainingMs(),
        maxBuffer: 16384,
        encoding: 'utf8',
        env: {
          PATH: '',
          NODE_DISABLE_COMPILE_CACHE: '1',
          ADAPTER_DIAGNOSTIC_FIXTURE_MODE: 'vfs-confinement',
        },
      },
    );
    assert.equal(child.error, undefined, child.error?.message);
    const audit = (await readFile(join(root, 'audit'), 'utf8')).trim().split('\n');
    assert.equal(child.status, 0, `${child.stderr}\nBoundary audit: ${JSON.stringify(audit)}`);
    assert.deepEqual(audit, ['vfs-probe', 'vfs-confined', 'guest-exec', 'close']);
    const graph = JSON.parse(await readFile(join(root, 'sdk-source-graph.json'), 'utf8'));
    assert.equal(graph.loaded.length, 19);
    assert.equal(graph.sdkHookCalls, 0);
    assert.equal(graph.ownGuardRegistrations, 1);
    assert.equal(graph.vm, 'EXPLICIT_DOUBLE');
    assert.equal(graph.cachedCjsDenied, 3);
    const observed = JSON.parse(await readFile(join(root, 'vfs-observation.json'), 'utf8'));
    assert.deepEqual(observed.summaries, [
      { mount: '/workspace', requests: 12, denied: 15 },
      { mount: '/artifacts', requests: 12, denied: 15 },
    ]);
    assert.equal(observed.sdkHookCalls, 0);
    assert.equal(observed.sourceHashAfter, graph.aggregate);
    assert.deepEqual(observed.native, ['RealFSProvider', 'FsRpcService']);
    assert.deepEqual(observed.doubled, ['VM', 'manager', 'proc', 'cgroup', 'guest commands']);
    // Guest command bodies remain inert DATA; no host shell, even for syntax parsing.
    assert.equal(`${child.stdout}${child.stderr}`.includes('PRIVATE_TOKEN_CANARY'), false);
    for (const zone of ['home', 'control', 'git-cache', 'other-work']) {
      assert.equal(await readFile(join(root, 'protected', zone, 'secret'), 'utf8'), 'PRIVATE_TOKEN_CANARY');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of [
  'shutdown-success',
  'shutdown-concurrent',
  'shutdown-nonzero',
  'shutdown-exec-fails',
  'shutdown-timeout',
  'shutdown-write-fails',
] as const) {
  test(`Sandbox operational adapter finalizes the direct Alpine daemon before close: ${mode} (external doubles, no VM/signal)`, async () => {
    const root = await shortRoot();
    try {
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-test-module-mocks',
          '--import',
          fileURLToPath(new URL('./adapter-diagnostics-fixture.js', import.meta.url)),
          fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)),
          root,
          environment,
          boot,
        ],
        {
          timeout: remainingMs(),
          maxBuffer: 16384,
          encoding: 'utf8',
          env: {
            PATH: '',
            NODE_DISABLE_COMPILE_CACHE: '1',
            ADAPTER_DIAGNOSTIC_FIXTURE_MODE: mode,
          },
        },
      );
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, child.stderr);
      const end =
        mode === 'shutdown-nonzero'
          ? ['guest-nonzero']
          : mode === 'shutdown-exec-fails'
            ? ['guest-exec-failed']
            : mode === 'shutdown-timeout'
              ? ['guest-timeout']
              : mode === 'shutdown-write-fails'
                ? ['guest-finalize-ok', 'synced-begin', 'synced-failed']
                : ['guest-finalize-ok', 'synced-begin', 'synced-durable'];
      assert.deepEqual((await readFile(join(root, 'audit'), 'utf8')).trim().split('\n'), ['profile-ready', 'stop-request', 'guest-finalize', ...end, 'close']);
      const path = join(root, 'environments', environment, boot);
      assert.equal(JSON.parse(await readFile(join(path, 'operational.json'), 'utf8')).boot, boot);
      if (mode === 'shutdown-success' || mode === 'shutdown-concurrent') {
        assert.deepEqual(JSON.parse(await readFile(join(path, 'guest-synced.json'), 'utf8')), { version: 1, boot });
      } else if (mode === 'shutdown-write-fails') {
        assert.equal(await readFile(join(path, 'guest-synced.json'), 'utf8'), '');
      } else assert.equal((await readdir(path)).includes('guest-synced.json'), false);
      // Ticket 47: the stop result is recorded for the next boot whatever happened (clean only when the guest left its root read-only).
      assert.deepEqual(JSON.parse(await readFile(join(path, 'guest-stop.json'), 'utf8')), {
        version: 1,
        boot,
        ...(mode === 'shutdown-timeout'
          ? { result: 'forced', reason: 'GUEST_FINALIZATION_TIMEOUT' }
          : mode === 'shutdown-nonzero' || mode === 'shutdown-exec-fails'
            ? { result: 'forced', reason: 'GUEST_FINALIZATION_FAILED' }
            : { result: 'clean', reason: 'GUEST_ROOT_READ_ONLY' }),
      });
      if (mode === 'shutdown-success' || mode === 'shutdown-concurrent' || mode === 'shutdown-write-fails') {
        const command = await readFile(join(root, 'guest-finalization-command'), 'utf8');
        // DATA assertion only; never hand the guest command body to a host shell.
        assert.equal(command.includes('rc-service'), false);
        // Ticket 47: the guest stops every writer (not only dockerd) and leaves its root read-only before the VMM is closed.
        for (const step of ['docker stop', 'kill -TERM', 'kill -KILL', 'sync', 'mount -o remount,ro /', '/proc/sysrq-trigger'])
          assert.ok(command.includes(step), step);
      }
      assert.equal(`${child.stdout}${child.stderr}`.includes('PRIVATE_TOKEN_CANARY'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const mode of ['slow-write', 'write-fails', 'unknown-error', 'without-stop'] as const) {
  test(`Sandbox adapter entrypoint orders diagnostic attempt before owned close: ${mode} (external doubles, no VM/signal)`, async () => {
    const root = await shortRoot();
    try {
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-test-module-mocks',
          '--import',
          fileURLToPath(new URL('./adapter-diagnostics-fixture.js', import.meta.url)),
          fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)),
          root,
          environment,
          boot,
        ],
        {
          timeout: remainingMs(),
          maxBuffer: 16384,
          encoding: 'utf8',
          env: {
            PATH: '',
            NODE_DISABLE_COMPILE_CACHE: '1',
            ADAPTER_DIAGNOSTIC_FIXTURE_MODE: mode,
          },
        },
      );
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 1, child.stderr);
      assert.equal(`${child.stdout}${child.stderr}`.includes('PRIVATE_TOKEN_CANARY'), false);
      assert.equal(`${child.stdout}${child.stderr}`.includes('PRIVATE_CODE_CANARY'), false);
      const audit = (await readFile(join(root, 'audit'), 'utf8')).trim().split('\n');
      assert.deepEqual(
        audit,
        mode === 'write-fails'
          ? ['failure-begin', 'failure-failed', 'close']
          : ['failure-begin', 'failure-written', 'failure-file-synced', 'failure-durable', 'close'],
      );
      const diagnostic = await readFile(join(root, 'environments', environment, boot, 'failure.json'), 'utf8');
      assert.equal(diagnostic.includes('PRIVATE_TOKEN_CANARY'), false);
      assert.equal(diagnostic.includes('PRIVATE_CODE_CANARY'), false);
      if (mode !== 'write-fails')
        assert.deepEqual(JSON.parse(diagnostic), {
          version: 1,
          boot,
          phase: 'vm-start',
          code: mode === 'unknown-error' ? 'UNCLASSIFIED_STARTUP_FAILURE' : 'GUEST_READINESS_TIMEOUT',
        });
      else assert.equal(diagnostic, '');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const mode of ['markers-slow-write', 'markers-write-fails', 'markers-success'] as const) {
  test(`Sandbox adapter keeps console disabled and publishes an empty startup snapshot: ${mode} (no VM/signal)`, async () => {
    const root = await shortRoot();
    try {
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-test-module-mocks',
          '--import',
          fileURLToPath(new URL('./adapter-diagnostics-fixture.js', import.meta.url)),
          fileURLToPath(new URL('../../src/entrypoints/adapter.js', import.meta.url)),
          root,
          environment,
          boot,
        ],
        {
          timeout: remainingMs(),
          maxBuffer: 16384,
          encoding: 'utf8',
          env: {
            PATH: '',
            NODE_DISABLE_COMPILE_CACHE: '1',
            ADAPTER_DIAGNOSTIC_FIXTURE_MODE: mode,
          },
        },
      );
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, mode === 'markers-success' ? 0 : 1, child.stderr);
      assert.equal(`${child.stdout}${child.stderr}`.includes('PRIVATE_TOKEN_CANARY'), false);
      const path = join(root, 'environments', environment, boot);
      for (const name of await readdir(path)) {
        assert.equal((await readFile(join(path, name), 'utf8')).includes('PRIVATE_TOKEN_CANARY'), false);
      }
      const audit = (await readFile(join(root, 'audit'), 'utf8')).trim().split('\n');
      const publication =
        mode === 'markers-write-fails' ? ['markers-begin', 'markers-failed'] : ['markers-begin', 'markers-written', 'markers-file-synced', 'markers-durable'];
      assert.deepEqual(audit, [
        ...publication,
        ...(mode === 'markers-success' ? ['guest-exec'] : ['failure-begin', 'failure-written', 'failure-file-synced', 'failure-durable']),
        'close',
      ]);
      const content = await readFile(join(path, 'boot-markers.json'), 'utf8');
      if (mode === 'markers-write-fails') assert.equal(content, '');
      else assert.deepEqual(JSON.parse(content), { version: 1, boot, stages: [], callbacks: 0, oversized: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
