import { lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { inspectStorage, openControl, type ControlInput } from '../../control/index.js';
import { upgradeBlocksStart } from './upgrade.js';
import { serveControl } from './serve.js';
import { listen, protocolVersion, type Envelope } from '../../protocol/index.js';
import { controllerPaths, startFailureCause, verifyControllerLock } from '../../platform/host/index.js';
import { inventoryRuntime, reconcileInterruptedCaches } from '../../sandbox/index.js';
import { readConfiguration } from '../configuration.js';
import { inspectRelease } from '../release.js';
import { composeProductionAccess, composeProductionExecution } from './composition.js';
import { createGitHubAccess } from '../../platform/github/index.js';

async function own(root: string): Promise<number> {
  process.umask(0o077);
  const paths = await controllerPaths(root);
  await verifyControllerLock(paths.lockPath);
  // A distributed release must verify (every distributed byte, guest assets included, location, explicit selection, private Node) BEFORE
  // storage; a development checkout carries no release and composes no execution (EXECUTION_NOT_ENABLED).
  const release = await inspectRelease(paths.root);
  const blocked = release.checks.filter(check => check.status === 'blocked');
  if (blocked.length > 0) {
    console.error(JSON.stringify({ code: 'RELEASE_INVALID', checks: blocked.map(check => ({ id: check.id, message: check.message })),
      message: 'Run the verified release of this installation; storage was not opened and nothing is repaired.' }));
    return 2;
  }
  // Ticket 33: an interrupted upgrade, or a storage not in this release's operational format, is refused before the storage is opened.
  const pending = await upgradeBlocksStart(paths.root);
  if (pending) {
    console.error(JSON.stringify({ ...pending, message: 'The controller does not start during an incomplete upgrade; storage was not opened.' }));
    return 2;
  }
  const storage = await inspectStorage(paths.storagePath);
  if (storage.kind === 'storage' && storage.operational !== 'ready') {
    console.error(JSON.stringify({ code: storage.operational === 'migration-required' ? 'STORAGE_MIGRATION_REQUIRED' : 'STORAGE_INCOMPATIBLE',
      format: storage.format, supported: storage.current, problems: storage.problems.map(problem => problem.code),
      message: storage.operational === 'migration-required' ? 'This release operates the storage only after the explicitly requested upgrade migration (`upgrade check`); nothing was written.'
        : 'This release cannot operate this storage; nothing was written. Keep the release that operates it.' }));
    return 2;
  }
  const validated = await readConfiguration(paths.root, release.guestAssets);
  if (!validated.configuration.valid) {
    console.error(JSON.stringify({ code: 'CONFIGURATION_INVALID', errors: validated.configuration.errors,
      message: 'Complete the explicit configuration before starting the controller; storage was not opened.' }));
    return 2;
  }
  try {
    const socket = await lstat(paths.endpoint);
    if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error('UNSAFE_SOCKET_PATH');
    await unlink(paths.endpoint); // Only an obsolete own socket, after exclusive ownership.
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const github = createGitHubAccess({ root: paths.root, ...validated.configuration.effective.githubApp });
  const composed = release.release && release.guestAssets
    ? await composeProductionExecution({ root: paths.root, effective: validated.configuration.effective, guestAssets: release.guestAssets, github }) : undefined;
  if (composed?.status === 'refused') {
    console.error(JSON.stringify({ code: 'CONFIGURATION_UNSUPPORTED', reason: composed.code, roles: composed.roles,
      message: 'Every role must name the release worker profile explicitly; storage was not opened.' }));
    return 2;
  }
  const stop = new AbortController();
  const terminate = () => stop.abort();
  process.on('SIGINT', terminate);
  process.on('SIGTERM', terminate);
  const effective = validated.configuration.effective;
  // Polling cadence comes only from the validated configuration (default 60 s); no reload or per-Work override.
  // Ticket 26: host inventory of own runtime resources, after the lock and before the storage opens (attributed, never ignored).
  // Repair-free reconciliation of host Git caches a dead owner left in preparation (proved quiescent + read-only verified, else kept blocked).
  const caches = await reconcileInterruptedCaches(paths.root);
  const listed = await inventoryRuntime(paths.root);
  const runtimeInventory = { kind: 'listed' as const, observedAt: new Date().toISOString(), ...listed,
    cache: listed.cache.map(item => ({ ...item, nextStep: caches.find(entry => entry.repositoryId === item.repositoryId)?.nextStep ?? null })) };
  const control = await openControl({ storagePath: paths.storagePath, runtimeInventory,
    // Executable repositories are Ticket origins; dependency-only repositories are read solely for native blocked_by (composeProductionAccess).
    access: composeProductionAccess({ github, effective }),
    polling: { intervalSeconds: effective.pollingSeconds }, ...(composed?.status === 'composed' ? { execution: composed.ports } : {}) });
  const status = await control.inspect({ kind: 'status' });
  if (!('controller_run_id' in status)) throw new Error('INVALID_CONTROL_STATUS');
  const runId = status.controller_run_id;
  const running = control.run(stop.signal);
  let server;
  try {
    server = await serveControl(paths.endpoint, control, runId, () => stop.abort());
    return (await running).kind === 'clean' ? 0 : 1;
  } finally {
    await server?.close();
    stop.abort();
    await running;
    process.off('SIGINT', terminate);
    process.off('SIGTERM', terminate);
  }
}
try { process.exitCode = await own(process.argv[2] ?? '.'); }
catch (error) {
  console.error(JSON.stringify({ code: 'CONTROLLER_START_FAILED', ...startFailureCause(error),
    message: 'Exclusive private storage and compatible persistence are required; no automatic repair.' }));
  process.exitCode = 3;
}
