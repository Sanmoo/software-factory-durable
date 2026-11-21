import { constants, lstat, realpath, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Diagnostic } from '../contracts/index.js';
import { readConfiguration } from './configuration.js';
import { inspectRelease, productionModelChecks, productionProfile } from './release.js';
import { capacityDiagnostic, environmentIdentityDiagnostic, observeHostCapacity, selectSandboxAdapter, type LambdaServiceFactory } from '../sandbox/index.js';

/** `lambdaService` (v2 ticket 02): composition input for a Lambda installation's account diagnosis (the `aws` CLI by default). */
export async function doctor(root: string, options: { lambdaService?: LambdaServiceFactory } = {}) {
  const canonicalRoot = await realpath(root).catch(() => resolve(root));
  // Release first: only a verified release contributes its guest asset pin and production worker profile (ticket 32).
  const release = await inspectRelease(canonicalRoot);
  const { configuration, checks: configurationChecks, versions } = await readConfiguration(canonicalRoot, release.guestAssets, options);
  const checks: Diagnostic[] = [...release.checks, ...configurationChecks];
  if (release.release && configuration.valid) checks.push(...productionModelChecks(configuration.effective.models));
  // Ticket 24: configured Slots x guest limits against what the host shows NOW (virtual limits are not reservations or proven capacity).
  // v2 ticket 02: host memory and prepared environments are the Gondolin adapter's; a Lambda installation's capacity is its account quota,
  // diagnosed by its own validate above.
  const selected = configuration.valid ? selectSandboxAdapter(configuration.effective.sandbox) : undefined;
  const gondolin = selected?.status === 'selected' && selected.adapter === 'gondolin' ? selected.configuration : undefined;
  if (configuration.valid && gondolin) checks.push(capacityDiagnostic({ concurrency: configuration.effective.concurrency, configuration: gondolin,
    host: await observeHostCapacity(canonicalRoot) }));
  // Ticket 50: before a restart, which retained prepared environments this configuration would invalidate (memory/vCPU never do).
  if (gondolin) checks.push(await environmentIdentityDiagnostic(canonicalRoot, gondolin, release.guestAssets).catch(() => ({
    id: 'environment-identity', status: 'unverified' as const, message: 'Prepared environments could not be listed; their identity was not evaluated.',
    nextStep: 'Inspect `<root>/environments` permissions; doctor never repairs them.' })));
  const paths = { root: canonicalRoot, config: join(canonicalRoot, 'config.yaml'),
    storage: join(canonicalRoot, 'data'), socket: join(canonicalRoot, 'run', 'factory.sock') };
  for (const name of ['', 'credentials', 'data', 'environments', 'run']) {
    let safe = false;
    try {
      const path = join(canonicalRoot, name);
      const info = await lstat(path);
      await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
      safe = info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
    } catch { /* A missing/inaccessible path is a diagnostic, never repaired. */ }
    checks.push({ id: `permissions:${name || 'root'}`, status: safe ? 'ok' : 'blocked',
      message: safe ? 'Account-owned private directory accessible.' : 'Missing, non-private, non-owned, symlinked or inaccessible directory.',
      nextStep: 'Administrator must inspect the named installation directory; no recursive chmod or automatic repair.' });
  }
  for (const [id, path] of [['config', paths.config], ...(release.release && configuration.valid ? [['factory-oauth', join(canonicalRoot, 'credentials', 'chatgpt.json')]] : []), ...(configuration.valid ? [
    ['githubApp', join(canonicalRoot, configuration.effective.githubApp.privateKeyFile)],
    ...Object.entries(configuration.effective.models).flatMap(([role, model]) => model.credentialFile
      ? [[`models.${role}`, join(canonicalRoot, model.credentialFile)]] : []),
  ] : [])]) {
    let safe = false;
    try {
      const info = await lstat(path!);
      await access(path!, constants.R_OK);
      const parent = id === 'config' ? undefined : await lstat(join(canonicalRoot, 'credentials'));
      safe = info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0
        && (!parent || (parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid?.() && (parent.mode & 0o077) === 0));
    } catch { /* References are inspected, never read or repaired. */ }
    checks.push({ id: id === 'config' ? 'permissions:config.yaml' : `credential-file:${id}`,
      status: safe ? 'ok' : 'blocked', message: safe ? 'Private regular file reference accessible; content not authenticated.' : 'Missing, non-private, non-owned or symlinked file/reference parent.',
      nextStep: id === 'factory-oauth' ? 'Operator runs `factory login --root <root>` on this host (first human login); doctor never reads or tests the credential.'
        : 'Administrator must provide an account-owned private file under the installation; doctor never reads credential values.' });
  }
  // Linux sun_path is 108 bytes including the terminating NUL.
  const socketFits = Buffer.byteLength(paths.socket) <= 107;
  checks.push({ id: 'socket-path', status: socketFits ? 'ok' : 'blocked',
    message: `${Buffer.byteLength(paths.socket)} bytes; Linux pathname limit is 107 bytes. No socket was created.`,
    nextStep: 'Choose a shorter canonical installation root if necessary; relocations require environment/reference validation.' });
  // A blocked release is its own top-level result: configuration codes never mask an unverified distribution.
  const code = release.checks.some(check => check.status === 'blocked') ? 'RELEASE_INVALID'
    : !configuration.valid ? 'INVALID_CONFIGURATION'
      : checks.some(check => check.status === 'blocked') ? 'PREREQUISITES_MISSING' : 'RUNTIME_UNQUALIFIED';
  return { code, scope: 'offline' as const, paths, versions: { node: process.versions.node, ...versions }, configuration,
    release: release.release ? { ...release.release, production: { id: productionProfile.id, sdkProfileId: productionProfile.sdkProfileId,
      model: { providerId: productionProfile.model.providerId, modelId: productionProfile.model.modelId, auth: productionProfile.model.auth } } } : null,
    checks: checks satisfies Diagnostic[] };
}
