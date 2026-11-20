/**
 * Ticket 44 (operator decision 2026-11-19): every configured repository declares the environment its Work runs in, in
 * `.factory/environment.yaml` on its base branch. Closed schema: Alpine `apk` packages with EXACT versions and, optionally, container images
 * pinned by digest to pull before the Builder starts. No scripts, no free commands, no ranges or tags. The Factory always trusts the file (no
 * operator approval); the host only reads and validates it (never executes it, spec §7.3); a preparation VM installs it (spec §7.4).
 *
 * The validator is plain TypeScript (contracts import nothing): the YAML parse belongs to the adapter that read the file, and the Sandbox
 * re-validates the pinned declaration with this same function before building any guest command from it.
 */
export const environmentDeclarationPath = '.factory/environment.yaml';
/** Bytes; a larger file is invalid (an environment declaration is a short list). */
export const environmentDeclarationMaxBytes = 65536;
export const environmentDeclarationLimits = Object.freeze({ packages: 64, images: 16 });

export type EnvironmentDeclaration = {
  schemaVersion: 1;
  /** Alpine packages installed with `apk add <name>=<version>`; the version is the full Alpine version, release suffix included (`-rN`). */
  apk: { name: string; version: string }[];
  /** Container images pulled by digest (`<registry>/<path>@sha256:<64 hex>`), the registry host always explicit. */
  images: { reference: string }[];
};
export type EnvironmentDeclarationError = { path: string; message: string };

/** Alpine package name (lowercase; digits, `+`, `.`, `_`, `-`). */
export const apkPackageNamePattern = /^[a-z0-9][a-z0-9+._-]{0,127}$/;
/** Full Alpine version: `<digits>(.<digits>)*[letter](_suffix[n])*-r<n>`, e.g. `25.0.5.1_p2-r0`. Never a range, `~`, `<`/`>` or a bare version. */
export const apkVersionPattern = /^[0-9]+(\.[0-9]+)*[a-z]?(_(alpha|beta|pre|rc|cvs|svn|git|hg|p)[0-9]*)*-r[0-9]+$/;
/** `<registry host[:port]>/<path>@sha256:<digest>`; the registry has a dot (docker.io, ghcr.io, quay.io…): no implicit Docker Hub, no tag. */
export const imageReferencePattern = /^(?<registry>[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?)\/(?<path>[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*)@(?<digest>sha256:[a-f0-9]{64})$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Closed validation: unknown keys, wrong types, inexact versions, duplicates and implicit registries are errors, each with its path. */
export function validateEnvironmentDeclaration(value: unknown): { valid: true; declaration: EnvironmentDeclaration } | { valid: false; errors: EnvironmentDeclarationError[] } {
  const errors: EnvironmentDeclarationError[] = [];
  const error = (path: string, message: string) => { if (errors.length < 32) errors.push({ path, message }); };
  if (!isRecord(value)) return { valid: false, errors: [{ path: '$', message: 'the file must be a YAML mapping with schemaVersion, apk and optionally images' }] };
  for (const key of Object.keys(value)) if (!['schemaVersion', 'apk', 'images'].includes(key)) error(key, 'unknown key (allowed: schemaVersion, apk, images; no scripts or commands)');
  if (value.schemaVersion !== 1) error('schemaVersion', 'must be 1');
  const apk: EnvironmentDeclaration['apk'] = [];
  if (!Array.isArray(value.apk)) error('apk', 'required list of { name, version } (may be empty)');
  else {
    if (value.apk.length > environmentDeclarationLimits.packages) error('apk', `at most ${environmentDeclarationLimits.packages} packages`);
    const names = new Set<string>();
    value.apk.slice(0, environmentDeclarationLimits.packages).forEach((entry, index) => {
      const path = `apk[${index}]`;
      if (!isRecord(entry)) { error(path, 'must be a mapping { name, version }'); return; }
      for (const key of Object.keys(entry)) if (!['name', 'version'].includes(key)) error(`${path}.${key}`, 'unknown key (allowed: name, version)');
      const { name, version } = entry;
      if (typeof name !== 'string' || !apkPackageNamePattern.test(name)) error(`${path}.name`, 'must be an Alpine package name (lowercase letters, digits, + . _ -)');
      if (typeof version !== 'string' || !apkVersionPattern.test(version)) error(`${path}.version`, 'must be an exact Alpine version with its release, e.g. 25.0.5.1_p2-r0 (no range, no ~)');
      if (typeof name === 'string' && names.has(name)) error(`${path}.name`, `duplicate package ${name}`);
      if (typeof name === 'string') names.add(name);
      if (typeof name === 'string' && typeof version === 'string') apk.push({ name, version });
    });
  }
  const images: EnvironmentDeclaration['images'] = [];
  if (value.images !== undefined) {
    if (!Array.isArray(value.images)) error('images', 'must be a list of { reference }');
    else {
      if (value.images.length > environmentDeclarationLimits.images) error('images', `at most ${environmentDeclarationLimits.images} images`);
      const seen = new Set<string>();
      value.images.slice(0, environmentDeclarationLimits.images).forEach((entry, index) => {
        const path = `images[${index}]`;
        if (!isRecord(entry)) { error(path, 'must be a mapping { reference }'); return; }
        for (const key of Object.keys(entry)) if (key !== 'reference') error(`${path}.${key}`, 'unknown key (allowed: reference)');
        const { reference } = entry;
        if (typeof reference !== 'string' || reference.length > 512 || !imageReferencePattern.test(reference)) {
          error(`${path}.reference`, 'must be <registry>/<path>@sha256:<64 hex>, e.g. docker.io/testcontainers/ryuk@sha256:… (explicit registry, digest, no tag)');
        } else if (seen.has(reference)) error(`${path}.reference`, 'duplicate image');
        else { seen.add(reference); images.push({ reference }); }
      });
    }
  }
  if (errors.length) return { valid: false, errors };
  return { valid: true, declaration: { schemaVersion: 1, apk, images } };
}

/** The registry host (with port) and digest of a VALID image reference. */
export function imageReferenceParts(reference: string): { registry: string; path: string; digest: string } | null {
  const match = imageReferencePattern.exec(reference);
  return match?.groups ? { registry: match.groups.registry!, path: match.groups.path!, digest: match.groups.digest! } : null;
}

/**
 * What a read of the declaration at the base commit established (the adapter's observation; Control decides). `sha256` is over the exact
 * bytes of the file at `commit`: the identity pinned in the Work.
 */
export type EnvironmentDeclarationObservation =
  { kind: 'declared'; observedAt: string; commit: string; sha256: string; declaration: EnvironmentDeclaration } |
  { kind: 'missing'; observedAt: string; commit: string } |
  { kind: 'invalid'; observedAt: string; commit: string; sha256: string | null; errors: EnvironmentDeclarationError[] } |
  { kind: 'unavailable'; observedAt: string; code: string; waitSeconds?: number; nextStep: string };

/**
 * The declaration pinned in a Work (ticket 44): read once from the base commit, by hash; a later change of the file only affects later Works.
 * Given to `Sandbox.prepare` as is; the Sandbox keys its prepared base disk by (repository, sha256).
 */
export type PinnedEnvironment = { path: string; commit: string; sha256: string; declaration: EnvironmentDeclaration };

/**
 * Ticket 44: identity of the environment a prepared Work environment was created from = declaration hash + resolved manifest (the versions the
 * preparation VM actually installed and the digests it pulled), as recorded by the Sandbox for that environment.
 */
export type EnvironmentBaseIdentity = { base: string; declarationSha256: string; manifestSha256: string; reused: boolean;
  packages: Record<string, string>; images: { reference: string; digest: string }[] };
