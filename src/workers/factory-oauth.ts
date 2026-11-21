import { lstatSync, realpathSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw unavailable();
}
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
    const path = fileURLToPath(url),
      info = lstatSync(path);
    requireCondition(info.isFile() && info.uid === process.getuid?.() && info.nlink === 1 && realpathSync(path) === path);
    return info;
  };
  const profileURL = new URL('profile.json', root);
  ownedFile(profileURL);
  let profile: Record<string, unknown>;
  try {
    profile = JSON.parse(readFileSync(profileURL, 'utf8'));
  } catch {
    throw unavailable();
  }
  for (const [key, value] of Object.entries(sdkProfile)) requireCondition(profile[key] === value);
  let manifest: { imports?: Record<string, { types?: string; default?: string }> };
  try {
    manifest = JSON.parse(readFileSync(new URL('package.json', app), 'utf8'));
  } catch {
    throw unavailable();
  }
  for (const [alias, module] of [
    ['#factory-pi-auth-storage', 'auth-storage'],
    ['#factory-pi-model-runtime', 'model-runtime'],
  ] as const) {
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
  const credentialsDirectory = join(root, 'credentials');
  const excluded = [options.excludedRoots.source, options.excludedRoots.guest, ...options.excludedRoots.profiles];
  requireCondition(options.excludedRoots.profiles.length > 0);
  for (const path of excluded)
    requireCondition(canonical(path) && realpathSync(path) === path && lstatSync(path).isDirectory() && !intersects(credentialsDirectory, path));
  const path = join(credentialsDirectory, 'chatgpt.json');
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
  requireCondition(
    c.type === 'oauth' &&
      typeof c.access === 'string' &&
      c.access.trim().length > 0 &&
      typeof c.refresh === 'string' &&
      c.refresh.trim().length > 0 &&
      typeof c.expires === 'number' &&
      Number.isFinite(c.expires) &&
      typeof c.clientId === 'string' &&
      c.clientId.trim().length > 0 &&
      Array.isArray(c.scopes) &&
      c.scopes.every(scope => typeof scope === 'string') &&
      c.scopes.includes('chatgpt.tokens.use.direct'),
  );
  return c as Credential;
}
function documentCredential(raw: string | undefined): Credential {
  requireCondition(typeof raw === 'string' && raw.length > 0);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw unavailable();
  }
  requireCondition(typeof value === 'object' && value !== null && !Array.isArray(value));
  requireCondition(Object.keys(value).length === 1 && Object.hasOwn(value, 'openai'));
  return credential((value as Record<string, unknown>).openai);
}
function sensitive(c: Credential): readonly string[] {
  requireCondition(c.type === 'oauth');
  return [c.access, c.refresh, c.clientId as string];
}

/** Private Factory store, shared with the actual OAuth worker's native runtime.
 * The optional getAuth helper is for deep component qualification only; worker
 * composition consumes credentials directly and never exports a bearer. */
export async function openFactoryOAuth(
  options: FactoryOAuthOptions,
): Promise<{ credentials: CredentialStore; getAuth(): Promise<{ apiKey: string }>; settleCredentialWrites(): Promise<void> }> {
  try {
    options.signal.throwIfAborted();
    const path = validatePath(options); // BEFORE native construction/open (which otherwise creates missing files).
    // Native store is not a root SDK export. Resolve the adopted profile, never home/global/default SDK.
    verifySelectedModules();
    const native = await import('#factory-pi-auth-storage');
    options.signal.throwIfAborted();
    const file = new native.FileAuthStorageBackend(path);
    const register = (c: Credential) => {
      for (const value of sensitive(c)) options.records.registerSecret(value);
    };
    const inspect = (raw: string | undefined) => {
      const c = documentCredential(raw);
      register(c);
    };
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
        } catch {
          backendFailed = true;
          throw unavailable();
        }
      },
      async withLockAsync(fn, operation) {
        try {
          validatePath(options);
          return await file.withLockAsync(async raw => {
            validatePath(options);
            inspect(raw);
            const next = await fn(raw);
            // No scope check here: an already-started native refresh must preserve rotation after abort.
            validatePath(options);
            if (next.next !== undefined) inspect(next.next);
            return next;
          }, operation);
        } catch {
          backendFailed = true;
          throw unavailable();
        }
      },
    };
    // AuthStorage constructor/reload can swallow parse errors. Explicit validation must not.
    backend.withLock(() => ({ result: undefined }));
    const store = native.AuthStorage.fromStorage(backend);
    let publicationFailed = false;
    const active = (provider = 'openai', operation?: Operation) => {
      requireCondition(provider === 'openai' && !publicationFailed && !backendFailed);
      options.signal.throwIfAborted();
      operation?.signal?.throwIfAborted();
    };
    const publish = async (value: Credential | undefined, operation?: Operation) => {
      requireCondition(!backendFailed && !publicationFailed); // SDK reload/read fallback cannot mask a backend failure.
      const c = credential(value);
      register(c);
      try {
        await options.acknowledgeSecrets(Object.freeze([...sensitive(c)]));
      } catch {
        publicationFailed = true;
        throw unavailable();
      }
      active('openai', operation);
      return structuredClone(c);
    };
    const credentials: CredentialStore = {
      async read(provider, operation) {
        try {
          active(provider, operation);
          const value = await store.read(provider, { signal: operation?.signal ?? options.signal });
          return await publish(value, operation);
        } catch {
          throw unavailable();
        }
      },
      async modify(provider, fn, operation) {
        try {
          active(provider, operation);
          const value = await store.modify(
            provider,
            async current => {
              active(provider, operation);
              const c = await publish(current, operation);
              const next = await fn(c);
              if (next !== undefined) register(credential(next)); // BEFORE native private commit.
              return next;
            },
            operation,
          );
          return await publish(value, operation); // AFTER commit, BEFORE SDK toAuth/use.
        } catch {
          throw unavailable();
        }
      },
      async list(operation) {
        try {
          active('openai', operation);
          await credentials.read('openai', operation);
          return [{ providerId: 'openai', type: 'oauth' }];
        } catch {
          throw unavailable();
        }
      },
      async delete() {
        throw unavailable();
      }, // This qualification module does not implement logout/login.
    };
    let runtime: ModelRuntime | undefined;
    let creating: Promise<ModelRuntime> | undefined;
    const getRuntime = async () => {
      active();
      if (!creating)
        creating = (async () => {
          const profile = options.profileDirectory;
          requireCondition(
            canonical(profile) &&
              !intersects(join(options.factoryRoot, 'credentials'), profile) &&
              options.excludedRoots.profiles.some(root => profile === root || profile.startsWith(root + sep)),
          );
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
          runtime = await sdk.ModelRuntime.create({
            credentials,
            modelsPath: null,
            modelsStorePath: join(profile, 'models-store.json'),
            allowModelNetwork: false,
            refreshOnCreate: false,
          });
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
          requireCondition(result?.source === 'OAuth' && result.auth && Object.keys(result.auth).length === 1 && typeof result.auth.apiKey === 'string');
          options.records.registerSecret(result.auth.apiKey);
          try {
            await options.acknowledgeSecrets(Object.freeze([result.auth.apiKey]));
          } catch {
            publicationFailed = true;
            throw unavailable();
          }
          active();
          return { apiKey: result.auth.apiKey };
        } catch {
          throw unavailable();
        } // Includes unknown raw SDK HTTP errors, never serialize their cause/stack/body.
      },
      async settleCredentialWrites() {
        try {
          if (creating) await creating.catch(() => {});
          await runtime?.settleCredentialWrites();
        } catch {
          throw unavailable();
        }
      },
    };
  } catch {
    throw unavailable();
  }
}

/** Fixed standalone setup only. Not worker activation, auth CRUD or owner ACK.
 * The trusted TTY adapter must deliver URLs only to the human terminal, never
 * Records, captured stdio or a session. It has no input/code/token operation. */
export type FirstFactoryOAuthLoginOptions = {
  factoryRoot: string;
  records: { registerSecret(value: string): void };
  signal: AbortSignal;
  tty: { isTTY: boolean; authorizationURL(url: string): void };
};

function privateSetupDirectory(path: string, create = false) {
  if (create) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      requireCondition(error instanceof Error && 'code' in error && error.code === 'EEXIST');
    }
  }
  let ancestor = path;
  while (true) {
    const info = lstatSync(ancestor);
    requireCondition(info.isDirectory() && !info.isSymbolicLink() && realpathSync(ancestor) === ancestor);
    if (ancestor === path) requireCondition(info.uid === process.getuid?.() && (info.mode & 0o7777) === 0o700);
    if (ancestor === dirname(ancestor)) break;
    ancestor = dirname(ancestor);
  }
}
function absent(path: string) {
  try {
    lstatSync(path);
  } catch (error) {
    requireCondition(error instanceof Error && 'code' in error && error.code === 'ENOENT');
    return;
  }
  throw unavailable();
}
function privateSetupFile(path: string) {
  const info = lstatSync(path);
  requireCondition(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid?.() &&
      info.nlink === 1 &&
      (info.mode & 0o7777) === 0o600 &&
      realpathSync(path) === path,
  );
}

/** One native memory login, then one exclusive fixed-file native locked commit.
 * Native writes in place: failures retain a private partial file, with no repair,
 * retry, rollback or unlink. Return metadata only, never a credential/bearer. */
export async function firstFactoryOAuthLogin(options: FirstFactoryOAuthLoginOptions): Promise<{
  code: 'FACTORY_OAUTH_CREATED';
  credentialPath: string;
}> {
  let runtime: ModelRuntime | undefined;
  try {
    requireCondition(options.tty.isTTY === true);
    const uiAbort = new AbortController();
    const signal = AbortSignal.any([options.signal, uiAbort.signal, AbortSignal.timeout(10 * 60_000)]);
    signal.throwIfAborted();
    const root = options.factoryRoot;
    requireCondition(canonical(root) && root !== parse(root).root);
    privateSetupDirectory(root);
    const directory = join(root, 'credentials');
    privateSetupDirectory(directory, true);
    const path = join(directory, 'chatgpt.json');
    absent(path); // Even an empty/malformed/symlink target refuses BEFORE login.
    // Native reads this variable at module evaluation; no alternative bind host.
    requireCondition(!process.env.PI_OAUTH_CALLBACK_HOST || process.env.PI_OAUTH_CALLBACK_HOST === '127.0.0.1');
    const profile = join(directory, 'setup');
    privateSetupDirectory(profile, true);
    const devicePath = join(profile, 'device-id');
    try {
      const fd = openSync(devicePath, 'wx', 0o600);
      try {
        writeFileSync(fd, randomUUID(), 'utf8');
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      requireCondition(error instanceof Error && 'code' in error && error.code === 'EEXIST');
    }
    privateSetupFile(devicePath);
    const deviceId = readFileSync(devicePath, 'utf8');
    requireCondition(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId));
    // Preflight this reserved path. With modelsPath:null and no explicit modelsStore,
    // the selected native runtime uses an in-memory catalog, not this cache file.
    const modelsStorePath = join(profile, 'models-store.json');
    try {
      privateSetupFile(modelsStorePath);
    } catch (error) {
      requireCondition(error instanceof Error && 'code' in error && error.code === 'ENOENT');
    }
    verifySelectedModules();
    const native = await import('#factory-pi-auth-storage');
    const memory = new native.InMemoryAuthStorageBackend();
    const observe = (raw: string | undefined) => {
      if (raw === undefined) return;
      const c = documentCredential(raw);
      for (const value of sensitive(c)) options.records.registerSecret(value);
    };
    // Thin observation BEFORE native memory commit and post-login synchronization.
    const credentials = native.AuthStorage.fromStorage({
      withLock(fn) {
        return memory.withLock(raw => {
          observe(raw);
          const next = fn(raw);
          observe(next.next);
          return next;
        });
      },
      withLockAsync(fn, operation) {
        return memory.withLockAsync(async raw => {
          observe(raw);
          const next = await fn(raw);
          observe(next.next);
          return next;
        }, operation);
      },
    });
    const sdk = await import('#factory-pi-model-runtime');
    signal.throwIfAborted();
    runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath, allowModelNetwork: false, refreshOnCreate: false, signal });
    type Interaction = Parameters<ModelRuntime['login']>[2];
    const interaction: Interaction = {
      signal,
      notify(event) {
        if (event.type !== 'auth_url') return; // Never expose raw progress/error messages.
        // Native establishes its cleanup try/finally AFTER notify and prompt.
        // Do not throw out of either callback before native can enter that block.
        try {
          const url = new URL(event.url);
          requireCondition(
            url.origin === 'https://auth.openai.com' &&
              url.pathname === '/api/accounts/authorize' &&
              url.username === '' &&
              url.password === '' &&
              url.hash === '' &&
              url.searchParams.get('client_id') === 'dynamic_agent_client' &&
              url.searchParams.get('redirect_uri') === 'http://127.0.0.1:1455/auth/callback' &&
              url.searchParams.get('response_type') === 'code' &&
              url.searchParams.get('code_challenge_method') === 'S256' &&
              !!url.searchParams.get('state') &&
              !!url.searchParams.get('code_challenge'),
          );
          signal.throwIfAborted();
          options.tty.authorizationURL(url.href);
        } catch {
          uiAbort.abort();
        }
      },
      async prompt(prompt) {
        // Native races this prompt with its loopback callback. Never read, echo,
        // return or capture a manually pasted redirect/code. Deadline cancellation
        // rejects this pending arm and runs native finally/listener close APIs.
        requireCondition(prompt.type === 'manual_code');
        const pending = AbortSignal.any([signal, ...(prompt.signal ? [prompt.signal] : [])]);
        return new Promise<string>((_resolve, reject) => {
          const stop = () => reject(unavailable());
          if (pending.aborted) stop();
          else pending.addEventListener('abort', stop, { once: true });
        });
      },
    };
    const issued = credential(await runtime.login('openai', 'oauth', interaction, { getDeviceId: () => deviceId, agentName: 'Software Factory' }));
    for (const value of sensitive(issued)) options.records.registerSecret(value);
    signal.throwIfAborted();
    privateSetupDirectory(root);
    privateSetupDirectory(directory);
    privateSetupDirectory(profile);
    const fd = openSync(path, 'wx', 0o600); // Concurrent appearance fails, never overwrite.
    closeSync(fd);
    privateSetupFile(path);
    const file = new native.FileAuthStorageBackend(path);
    await file.withLockAsync(
      async raw => {
        signal.throwIfAborted();
        privateSetupDirectory(root);
        privateSetupDirectory(directory);
        privateSetupFile(path);
        requireCondition(raw === '');
        const next = JSON.stringify({ openai: issued });
        observe(next); // BEFORE native locked private write.
        return { result: undefined, next };
      },
      { signal },
    );
    privateSetupFile(path);
    return { code: 'FACTORY_OAUTH_CREATED', credentialPath: path };
  } catch {
    throw unavailable();
  } finally {
    // This drains native credential writes, NOT proof of physical cessation.
    try {
      await runtime?.settleCredentialWrites();
    } catch {
      /* No raw native errors. */
    }
  }
}
