// TEST ONLY. Closed parent-approved Task140 graph; never a caller-supplied allowlist.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { auditedVfsManifest as manifest } from './fixtures/audited-vfs-manifest.js';

type Hooks = Parameters<typeof Module.registerHooks>[0];
const vfs = 'dist/src/vfs/';
const vendored = vfs + 'node/vendored-node-vfs/';
const internal = vendored + 'lib/internal/vfs/';
const fixture = new URL('./adapter-diagnostics-fixture.js', import.meta.url).href;
const fileUrl = (path: string) => pathToFileURL(manifest.root + '/' + path).href;
const eager = new Set(manifest.files.filter(f => f.kind === 'approved-eager-module').map(f => fileUrl(f.path)));
const entries = new Set([fileUrl(vfs + 'rpc-service.js'), fileUrl(internal + 'providers/real.js')]);
const edges = new Map<string, Map<string, string>>();
function edge(parent: string, specifier: string, target: string) {
  const url = fileUrl(parent);
  const row = edges.get(url) ?? new Map<string, string>();
  assert.ok(!row.has(specifier)); row.set(specifier, target); edges.set(url, row);
}
function relative(parent: string, specifier: string, target: string) { edge(parent, specifier, fileUrl(target)); }
function builtins(parent: string, names: string[]) {
  for (const name of names) edge(parent, name, name.startsWith('node:') ? name : 'node:' + name);
}
function aliases(parent: string, names: string[]) {
  // Original patchRequire calls originalRequire with an ABSOLUTE generated path,
  // preserving the caller's parent URL, not the shim's. Object aliases never load.
  for (const name of names) edge(parent, manifest.root + '/' + internal + name + '.js', fileUrl(internal + name + '.js'));
}
relative(vfs + 'rpc-service.js', './errors.js', vfs + 'errors.js');
relative(vfs + 'rpc-service.js', './linux-errno.js', vfs + 'linux-errno.js');
relative(vfs + 'rpc-service.js', './statfs.js', vfs + 'statfs.js');
builtins(vfs + 'rpc-service.js', ['node:os', 'node:path']);
builtins(vfs + 'errors.js', ['node:util']);
builtins(vfs + 'statfs.js', ['node:util']);
relative(vfs + 'statfs.js', './errors.js', vfs + 'errors.js');
relative(vfs + 'statfs.js', './utils.js', vfs + 'utils.js');
builtins(vfs + 'utils.js', ['node:fs', 'node:os', 'node:path']);
relative(vfs + 'utils.js', './node/index.js', vfs + 'node/index.js');
builtins(vfs + 'node/index.js', ['node:module']);
relative(vfs + 'node/index.js', './vendored-node-vfs/lib/vfs.js', vendored + 'lib/vfs.js');
relative(vendored + 'lib/vfs.js', './internal/vfs/gondolin-shim', internal + 'gondolin-shim.js');
aliases(vendored + 'lib/vfs.js', ['file_system', 'provider', 'providers/memory', 'providers/real']);
for (const name of ['provider', 'file_handle', 'errors', 'file_system', 'router', 'fd', 'streams', 'watcher', 'stats', 'providers/real', 'providers/memory']) {
  relative(internal + name + '.js', name.startsWith('providers/') ? '../gondolin-shim' : './gondolin-shim', internal + 'gondolin-shim.js');
}
builtins(internal + 'gondolin-shim.js', ['node:url', 'module', 'node:path']);
aliases(internal + 'provider.js', ['errors']);
aliases(internal + 'file_handle.js', ['errors']); builtins(internal + 'file_handle.js', ['buffer']);
aliases(internal + 'providers/real.js', ['provider', 'file_handle', 'errors']);
builtins(internal + 'providers/real.js', ['fs', 'os', 'path']);
aliases(internal + 'file_system.js', ['providers/memory', 'router', 'fd', 'errors', 'streams']);
builtins(internal + 'file_system.js', ['path']);
aliases(internal + 'providers/memory.js', ['provider', 'file_handle', 'watcher', 'errors', 'stats']);
builtins(internal + 'providers/memory.js', ['buffer', 'path']);
builtins(internal + 'router.js', ['path']);
aliases(internal + 'streams.js', ['errors', 'fd']); builtins(internal + 'streams.js', ['stream']);
aliases(internal + 'watcher.js', ['stats']); builtins(internal + 'watcher.js', ['events', 'path', 'timers']);

function sdkTarget(value: string) {
  // Reject alternate URL spellings too; only literal canonical entry/edge URLs
  // are authorized above. Decoding is string-only, never filesystem discovery.
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* Node rejects malformed URL escapes. */ }
  return decoded.includes('@earendil-works/gondolin') || decoded.includes('/gondolin/') || decoded.includes('/factory-development-gondolin-v1/');
}
function deny(parent: string | undefined, specifier: string): never {
  throw new Error(`SDK_EVALUATION_FORBIDDEN parent=${parent ?? '<none>'} specifier=${specifier}`);
}

/** Read only the22 fixed source/metadata pins as DATA, before ANY SDK evaluation.
 * Same-UID trusted namespace, not atomic validation against hostile races. */
export function verifyAuditedVfsSources() {
  assert.equal(typeof Module.registerHooks, 'function', 'PUBLIC_REGISTER_HOOKS_REQUIRED');
  assert.equal(fs.realpathSync(manifest.root), manifest.root, 'SDK_ROOT_CANONICAL_MISMATCH');
  const hashes: string[] = [];
  for (const file of manifest.files) {
    const path = manifest.root + '/' + file.path;
    const stat = fs.lstatSync(path);
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o7777) === 0o644, `SDK_METADATA_MISMATCH ${file.path}`);
    assert.equal(fs.realpathSync(path), path, `SDK_CANONICAL_MISMATCH ${file.path}`);
    const bytes = fs.readFileSync(path);
    assert.equal(bytes.length, file.bytes, `SDK_SIZE_MISMATCH ${file.path}`);
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash, file.sha256, `SDK_HASH_MISMATCH ${file.path}`);
    hashes.push(`${hash}  ${file.path}\n`);
    if (file.kind === 'metadata') {
      const data = JSON.parse(bytes.toString('utf8'));
      assert.equal(data.type, file.path === 'package.json' ? 'module' : 'commonjs');
      if (file.path === 'package.json') assert.equal(data.version, manifest.version);
    }
  }
  // Manifest order is fixed lexicographic; no tree walk or target autodiscovery.
  assert.equal(createHash('sha256').update(hashes.join('')).digest('hex'), manifest.aggregate);
  return manifest.aggregate;
}

export function createAuditedVfsGuard() {
  verifyAuditedVfsSources();
  const loaded: string[] = [];
  const resolved = new Set<string>();
  const hooks: Hooks = {
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      let target: string | undefined;
      if (parent === fixture && entries.has(specifier)) target = specifier;
      else if (parent) target = edges.get(parent)?.get(specifier);
      if (!target) {
        if (sdkTarget(specifier) || (parent && sdkTarget(parent))) deny(parent, specifier);
        const result = nextResolve(specifier, context);
        if (sdkTarget(result.url)) deny(parent, specifier);
        return result;
      }
      const result = nextResolve(specifier, context);
      assert.equal(result.url, target, `SDK_RESOLUTION_MISMATCH parent=${parent} specifier=${specifier}`);
      if (eager.has(target)) resolved.add(target);
      return result;
    },
    load(url, context, nextLoad) {
      if (!sdkTarget(url)) return nextLoad(url, context);
      if (!eager.has(url) || !resolved.has(url)) deny(undefined, url);
      const result = nextLoad(url, context);
      const file = manifest.files.find(file => fileUrl(file.path) === url)!;
      assert.equal(result.format, file.format === 'ESM' ? 'module' : 'commonjs', `SDK_FORMAT_MISMATCH ${file.path}`);
      loaded.push(file.path);
      return result;
    },
  };
  return { hooks, loaded };
}
