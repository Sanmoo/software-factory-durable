import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sdkProfile } from './sdk-profile.js';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import type { CreateModelRuntimeOptions, ModelRuntime } from '#factory-pi-model-runtime';

type CredentialStore = NonNullable<CreateModelRuntimeOptions['credentials']>;
type Credential = NonNullable<Awaited<ReturnType<CredentialStore['read']>>>;
type Operation = Parameters<CredentialStore['read']>[1];
type Backend = import('#factory-pi-auth-storage').AuthStorageBackend;
export type FactoryOAuthOptions = {
  factoryRoot: string;
  excludedRoots: { source: string; guest: string; profiles: readonly string[] };
  records: { registerSecret(value: string): void };
  /** PRIVATE technical future-owner publication, not WorkAdmission/model permission. */
  acknowledgeSecrets(values: readonly string[]): Promise<void>;
  signal: AbortSignal;
  /** Trusted OWN worker profile, never a default/personal model-cache directory. */
  profileDirectory: string;
};
const unavailable = () => Object.freeze({ code: 'FACTORY_OAUTH_UNAVAILABLE' as const });
function requireCondition(condition: unknown): asserts condition { if (!condition) throw unavailable(); }
const canonical = (path: string) => isAbsolute(path) && resolve(path) === path;
const intersects = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

// Selected unpatched v1.5.2 OAuth seam bytes, measured against the installed originals.
// This is NOT an attestation of the entire adopted tree or its transitive dependencies.
const selectedModules = [
  ['auth-storage.js', 16884, '85c773c95be71695a27f5ed2f9f5bfaedc6c2ab3fe1fa7fcdf09707a3a73ce48'],
  ['auth-storage.d.ts', 3379, '6197ffc082ffe1ef47894168fea1a575175743eaaa078bb4664ea310115dc9a6'],
  ['model-runtime.js', 37444, 'b17018cb70007a194f10b2aaf5ec3631329db20cf853ddc9ce4088e6b4373ab1'],
  ['model-runtime.d.ts', 10000, '9afd3e379b8fa12030075dbc6c983cc8652bd7c3a41ccd7e4d9e10b8c5017758'],
] as const;
function verifySelectedModules() {
  // Compiled dist/src/workers only; no caller/cwd/environment-selected SDK roots.
  const app = new URL('../../../', import.meta.url);
  const base = '.scratch/factory-development-sdk-v3/';
  const root = new URL(base, app);
  const ownedFile = (url: URL) => {
    const path = fileURLToPath(url), info = lstatSync(path);
    requireCondition(info.isFile() && info.uid === process.getuid?.() && info.nlink === 1 && realpathSync(path) === path);
    return info;
  };
  const profileURL = new URL('profile.json', root);
  ownedFile(profileURL);
  let profile: Record<string, unknown>;
  try { profile = JSON.parse(readFileSync(profileURL, 'utf8')); } catch { throw unavailable(); }
  for (const [key, value] of Object.entries(sdkProfile)) requireCondition(profile[key] === value);
  let manifest: { imports?: Record<string, { types?: string; default?: string }> };
  try { manifest = JSON.parse(readFileSync(new URL('package.json', app), 'utf8')); } catch { throw unavailable(); }
  for (const [alias, module] of [['#factory-pi-auth-storage', 'auth-storage'], ['#factory-pi-model-runtime', 'model-runtime']] as const) {
    const selected = `./${base}sdk/dist/core/${module}`;
    requireCondition(manifest.imports?.[alias]?.default === `${selected}.js` && manifest.imports[alias]?.types === `${selected}.d.ts`);
    requireCondition(import.meta.resolve(alias) === new URL(`${selected}.js`, app).href);
  }
  for (const [name, size, hash] of selectedModules) {
    const url = new URL(`sdk/dist/core/${name}`, root);
    requireCondition(ownedFile(url).size === size);
    const bytes = readFileSync(url);
    requireCondition(bytes.length === size && createHash('sha256').update(bytes).digest('hex') === hash);
  }
}

/** Trusted, non-hostile ancestors and same-UID host premise; NOT atomic confinement. */
function validatePath(options: FactoryOAuthOptions): string {
  const root = options.factoryRoot;
  requireCondition(canonical(root) && root !== parse(root).root);
  const excluded = [options.excludedRoots.source, options.excludedRoots.guest, ...options.excludedRoots.profiles];
  requireCondition(options.excludedRoots.profiles.length > 0);
  for (const path of excluded) requireCondition(canonical(path) && realpathSync(path) === path &&
    lstatSync(path).isDirectory() && !intersects(root, path));
  const path = join(root, 'credentials', 'chatgpt.json');
  let ancestor = path;
  while (true) {
    const info = lstatSync(ancestor);
    requireCondition(!info.isSymbolicLink() && realpathSync(ancestor) === ancestor);
    if (ancestor === root || ancestor === dirname(path)) {
      requireCondition(info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o7777) === 0o700);
    } else if (ancestor === path) {
      requireCondition(info.isFile() && info.uid === process.getuid?.() && info.nlink === 1 && (info.mode & 0o7777) === 0o600);
    } else requireCondition(info.isDirectory());
    if (ancestor === dirname(ancestor)) break;
    ancestor = dirname(ancestor);
  }
  return path;
}
function credential(value: unknown): Credential {
  requireCondition(typeof value === 'object' && value !== null && !Array.isArray(value));
  const c = value as Record<string, unknown>;
  requireCondition(Object.keys(c).every(key => ['type', 'access', 'refresh', 'expires', 'clientId', 'scopes'].includes(key)));
  requireCondition(c.type === 'oauth' && typeof c.access === 'string' && c.access.trim().length > 0 &&
    typeof c.refresh === 'string' && c.refresh.trim().length > 0 && typeof c.expires === 'number' && Number.isFinite(c.expires) &&
    typeof c.clientId === 'string' && c.clientId.trim().length > 0 && Array.isArray(c.scopes) &&
    c.scopes.every(scope => typeof scope === 'string') && c.scopes.includes('chatgpt.tokens.use.direct'));
  return c as Credential;
}
function documentCredential(raw: string | undefined): Credential {
  requireCondition(typeof raw === 'string' && raw.length > 0);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unavailable(); }
  requireCondition(typeof value === 'object' && value !== null && !Array.isArray(value));
  requireCondition(Object.keys(value).length === 1 && Object.hasOwn(value, 'openai'));
  return credential((value as Record<string, unknown>).openai);
}
function sensitive(c: Credential): readonly string[] {
  requireCondition(c.type === 'oauth');
  return [c.access, c.refresh, c.clientId as string];
}

/** Deep PRIVATE store seam. Never exported from Workers/index or selected by the active runtime. */
export async function openFactoryOAuth(options: FactoryOAuthOptions): Promise<{ credentials: CredentialStore; getAuth(): Promise<{ apiKey: string }>; settleCredentialWrites(): Promise<void> }> {
  try {
    options.signal.throwIfAborted();
    const path = validatePath(options); // BEFORE native construction/open (which otherwise creates missing files).
    // Native store is not a root SDK export. Resolve the adopted profile, never home/global/default SDK.
    verifySelectedModules();
    const native = await import('#factory-pi-auth-storage');
    options.signal.throwIfAborted();
    const file = new native.FileAuthStorageBackend(path);
    const register = (c: Credential) => { for (const value of sensitive(c)) options.records.registerSecret(value); };
    const inspect = (raw: string | undefined) => { const c = documentCredential(raw); register(c); };
    let backendFailed = false;
    const backend: Backend = {
      withLock(fn) {
        try {
          validatePath(options);
          return file.withLock(raw => {
            inspect(raw);
            const next = fn(raw);
            if (next.next !== undefined) inspect(next.next);
            return next;
          });
        } catch { backendFailed = true; throw unavailable(); }
      },
      async withLockAsync(fn, operation) {
        try {
          validatePath(options);
          return await file.withLockAsync(async raw => {
            validatePath(options); inspect(raw);
            const next = await fn(raw);
            // No scope check here: an already-started native refresh must preserve rotation after abort.
            validatePath(options);
            if (next.next !== undefined) inspect(next.next);
            return next;
          }, operation);
        } catch { backendFailed = true; throw unavailable(); }
      },
    };
    // AuthStorage constructor/reload can swallow parse errors. Explicit validation must not.
    backend.withLock(() => ({ result: undefined }));
    const store = native.AuthStorage.fromStorage(backend);
    let publicationFailed = false;
    const active = (provider = 'openai', operation?: Operation) => {
      requireCondition(provider === 'openai' && !publicationFailed && !backendFailed);
      options.signal.throwIfAborted(); operation?.signal?.throwIfAborted();
    };
    const publish = async (value: Credential | undefined, operation?: Operation) => {
      requireCondition(!backendFailed && !publicationFailed); // SDK reload/read fallback cannot mask a backend failure.
      const c = credential(value); register(c);
      try { await options.acknowledgeSecrets(Object.freeze([...sensitive(c)])); }
      catch { publicationFailed = true; throw unavailable(); }
      active('openai', operation);
      return structuredClone(c);
    };
    const credentials: CredentialStore = {
      async read(provider, operation) {
        try {
          active(provider, operation);
          const value = await store.read(provider, { signal: operation?.signal ?? options.signal });
          return await publish(value, operation);
        } catch { throw unavailable(); }
      },
      async modify(provider, fn, operation) {
        try {
          active(provider, operation);
          const value = await store.modify(provider, async current => {
            active(provider, operation);
            const c = await publish(current, operation);
            const next = await fn(c);
            if (next !== undefined) register(credential(next)); // BEFORE native private commit.
            return next;
          }, operation);
          return await publish(value, operation); // AFTER commit, BEFORE SDK toAuth/use.
        } catch { throw unavailable(); }
      },
      async list(operation) {
        try { active('openai', operation); await credentials.read('openai', operation); return [{ providerId: 'openai', type: 'oauth' }]; }
        catch { throw unavailable(); }
      },
      async delete() { throw unavailable(); }, // This qualification module does not implement logout/login.
    };
    let runtime: ModelRuntime | undefined;
    let creating: Promise<ModelRuntime> | undefined;
    const getRuntime = async () => {
      active();
      if (!creating) creating = (async () => {
        const profile = options.profileDirectory;
        requireCondition(canonical(profile) && !intersects(options.factoryRoot, profile) &&
          options.excludedRoots.profiles.some(root => profile === root || profile.startsWith(root + sep)));
        let ancestor = profile;
        while (true) {
          const info = lstatSync(ancestor);
          requireCondition(info.isDirectory() && !info.isSymbolicLink() && realpathSync(ancestor) === ancestor);
          if (ancestor === profile) requireCondition(info.uid === process.getuid?.() && (info.mode & 0o7777) === 0o700);
          if (ancestor === dirname(ancestor)) break;
          ancestor = dirname(ancestor);
        }
        verifySelectedModules();
        const sdk = await import('#factory-pi-model-runtime');
        active();
        runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null,
          modelsStorePath: join(profile, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
        const model = runtime.getModel('openai', 'gpt-6-luna');
        requireCondition(model?.provider === 'openai' && model.id === 'gpt-6-luna' && model.api === 'openai-responses');
        active();
        return runtime;
      })();
      return creating;
    };
    return {
      credentials,
      async getAuth() {
        try {
          const nativeRuntime = await getRuntime();
          active();
          const result = await nativeRuntime.getAuth('openai', { signal: options.signal });
          active();
          requireCondition(result?.source === 'OAuth' && result.auth &&
            Object.keys(result.auth).length === 1 && typeof result.auth.apiKey === 'string');
          options.records.registerSecret(result.auth.apiKey);
          try { await options.acknowledgeSecrets(Object.freeze([result.auth.apiKey])); }
          catch { publicationFailed = true; throw unavailable(); }
          active();
          return { apiKey: result.auth.apiKey };
        } catch { throw unavailable(); } // Includes unknown raw SDK HTTP errors, never serialize their cause/stack/body.
      },
      async settleCredentialWrites() {
        try { if (creating) await creating.catch(() => {}); await runtime?.settleCredentialWrites(); }
        catch { throw unavailable(); }
      },
    };
  } catch { throw unavailable(); }
}
