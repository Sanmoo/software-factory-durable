import { createHash } from 'node:crypto';

// TEST ONLY. Shared pieces of the pre-pilot real-run recipes authorized by the operator on 2026-11-16 (ticket 34 groups R-REL, R-CAND,
// R-INSPECT): the fixed host paths, the release identity contract between R-REL and R-CAND, the secret-shape scan and the one-shot
// observation writer. Importing this module is inert (pure constants and functions; effects only inside the async helpers' bodies).

export const testRoot = '/home/sanmoo/software-factory-test';
export const y5 = `${testRoot}/y5`;
/**
 * The R-REL installation root. NOT under y5/: the guest runtime directory is `<root>/r/<22 chars>/s/<41-char session socket>` and Linux
 * sun_path holds 107 bytes, so the canonical root may have at most 38 bytes (y5 itself has 37; `y5/<anything>` has at least 39). This path
 * has 38. The recipe namespaces (observations) stay fresh directories under y5/.
 */
// v1 (pr1, mvp-34.1, prel34-v1/qcand34-v1) was consumed: its owner had no user bus (fixed in 5ab72fa); pr1 is cleaned up with the v1 code.
export const installationRoot = `${testRoot}/pr2`;
export const release = 'mvp-34.2';
export const releaseNamespace = `${y5}/prel34-v2`;
// qcand34-v2 (mvp-34.2) held at review: a continuation Execution refused the treatment of an earlier round's finding (fixed in b4c5443).
// v3 runs on mvp-34.3, upgraded INTO the same pr2 root by the product's own `upgrade` (R-UPG, rupg34-qualification.ts): the model login stays.
// qcand34-v3 held at preflight: config.yaml was the one qcand34-v2 had written, not the setup template (now accepted when byte-identical).
// qcand34-v4 held at run: snapshot() read ONE fitted page of `factory list` and never saw its own Work (now every page is followed).
// qcand34-v5 held at review: the repair Execution asked again whether the step-1 waiver covered it (safe; now ONE scripted answer, step 6).
export const candidateNamespace = `${y5}/qcand34-v6`;
export const inspectNamespace = `${y5}/qinspect34-v1`;
/** Written by R-REL `install` (after `verify`): the release first installed into the root (mvp-34.2). */
export const releaseIdentityFile = `${releaseNamespace}/observations/release-identity.json`;
/** R-UPG: the release built from the integration tip and selected in the R-REL root by `upgrade apply`. */
export const upgradeRelease = 'mvp-34.3';
export const upgradeNamespace = `${y5}/prel34-v3`;
/** Written by R-UPG `upgrade` (after `apply`), read by every R-CAND phase: what R-CAND must prove it ran on. */
export const identityFile = `${upgradeNamespace}/observations/release-identity.json`;
/** The account's standard systemd user unit directory (passwd home of sanmoo); the recipe re-checks it against the product's own choice. */
export const serviceDirectory = '/home/sanmoo/.config/systemd/user';
/** Same derivation as `serviceDefinition` (src/entrypoints/setup.ts); the recipe-safety test pins the equality. */
export function serviceUnit(root: string = installationRoot): string {
  return `software-factory-${createHash('sha256').update(root).digest('hex').slice(0, 12)}.service`;
}
export const integrationBranch = 'integration/software-factory-mvp';
/** Commits whose content the candidate release must contain (ancestors of the built commit): the composition V-06.h names, and D-07. */
export const compositionMarkers = {
  'ticket-23-feedback': '580b4d1b06d1057431e06fb57c1a1f6d07f7ad13',
  'ticket-24-single-pass-dispatch': '1f033f8aeade228430ee4e303f18e7cee301f15c',
  'ticket-29-inspection': '0d343d6c33c25470c6ca6bb608705140f01333d4',
  'ticket-34-candidate': 'b30e2bddea160e0f577ac08a943fb91a08438132',
  'd-07-sqlite-scrub': '5a026e7a619006706e73d5a6831f870b447ada77',
  'owner-user-bus': '5ab72fab9a3f52abf3d72557b4ce912f62b246f2',
  'continuation-findings': 'b4c544366b6a0814a84c82faeb51226f5eb8e3d8',
} as const;

export type ReleaseIdentity = {
  release: string; commit: string; commitTime: string; branch: string; dirty: false; archive: string; archiveSha256: string; manifestSha256: string;
  guestAssets: { manifestSha256: string }; lockfileSha256: string; node: string; markers: Record<keyof typeof compositionMarkers, boolean>;
  root: string; unit: string; builtAt: string };
/** The Factory stamp every R-CAND result carries (closes the ticket 34 finding that no real-run JSON records the Factory commit). */
export type FactoryStamp = { release: string; commit: string; manifestSha256: string; archiveSha256: string; root: string;
  /** How the stamp was obtained at this phase: the installed manifest re-hashed AND the release's own doctor (every byte re-verified). */
  verifiedBy: string };

/** Known credential shapes (GitHub, OpenAI incl. sk-proj-, Anthropic sk-ant-, JWT, OAuth access/refresh, Google ya29., PEM keys, Bearer). */
export const secretPatterns = [/gh[opsur]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g, /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, /"(?:access|refresh|id)_token"\s*:\s*"[^"]+"/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g, /Bearer [A-Za-z0-9._~+/=-]{20,}/g];
/** Every match replaced BEFORE anything is kept or saved; returns the redacted text and how many matches were found. */
export function redact(text: string): { text: string; found: number } {
  let found = 0;
  for (const pattern of secretPatterns) text = text.replace(pattern, () => { found++; return '[REDACTED]'; });
  return { text, found };
}
/** Bytes scan (storage, sessions): only whether a secret shape occurs and how often, never the match. */
export function secretShapes(bytes: Buffer | string): number {
  return redact(typeof bytes === 'string' ? bytes : bytes.toString('latin1')).found;
}

/**
 * One-shot observation writer: O_EXCL 0600 files in `directory`, bounded, redacted (a redaction is counted in the file), and stamped.
 * Never overwrites: a second write of the same name fails (a consumed phase never reruns).
 */
export function observationWriter(directory: string, stamp: () => Record<string, unknown> = () => ({})) {
  return async (name: string, data: unknown) => {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(name)) throw new Error('OBSERVATION_NAME');
    const fs = await import('node:fs/promises');
    const raw = JSON.stringify({ ...stamp(), ...(data && typeof data === 'object' && !Array.isArray(data) ? data : { value: data }) }, null, 1);
    const { text, found } = redact(raw);
    const body = found ? text.replace(/^\{/, `{\n "redactedSecretShapes": ${found},`) : text;
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${directory}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
  };
}

/** Minimal environment for host commands (systemctl --user needs the user bus); never the caller's tokens or GH_* variables. */
export function hostEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const uid = process.getuid?.() ?? 1000;
  return { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: env.HOME ?? '/home/sanmoo', XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus` };
}

/** Bounded command (no shell, no implicit retry); stdout/stderr redacted before they are returned. */
export async function command(executable: string, args: readonly string[], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}) {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(executable, [...args], { cwd: options.cwd ?? '/', encoding: 'utf8', timeout: options.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024,
    env: options.env ?? hostEnvironment(), shell: false });
  const out = redact(result.stdout ?? ''), err = redact((result.stderr ?? '').slice(-65536));
  return { args: [executable, ...args], status: result.status, signal: result.signal, stdout: out.text, stderr: err.text, secrets: out.found + err.found,
    error: result.error ? (result.error as NodeJS.ErrnoException).code ?? 'SPAWN_FAILED' : null };
}

/** `systemctl --user show` properties as an object (pure parser). */
export function parseShow(text: string): Record<string, string> {
  return Object.fromEntries(text.split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

/** Mount points at or below `root` in a /proc/self/mountinfo text (field 5, octal escapes decoded). A removal never crosses one. */
export function mountsBelow(mountinfo: string, root: string): string[] {
  return mountinfo.split('\n').map(line => line.split(' ')[4]).filter((point): point is string => !!point)
    .map(point => point.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))))
    .filter(point => point === root || point.startsWith(`${root}/`));
}
