import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readlink, realpath, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const sdkProfile = Object.freeze({ id: 'factory-development-pi-1.5.2-read-operations-v1', version: '1.5.2',
  integrity: 'sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA==',
  upstreamSHA256: 'e6159de5e4d94ae22968b6524237ef3d4f0374a107e2321ed5c29e93d66c8efc',
  upstreamTreeSHA256: '7d0961cce25f6c802b22aaa028206cd610de386442d2e6b732d71367ef006391',
  patchSHA256: '5e45a7c2953db293a14db0138bb31f8ac9e95eb13512afd42f1f49b77c98e066',
  resultSHA256: '06867a067ebbadca2e06f75ccb4e682cd7e37b9683d41a71562f770b3105a209' });

// Factory-owned composition, not an additional SDK source patch or index export.
export const imageMimeFacade = Object.freeze({ file: 'image-mime.js',
  bytes: 'export { detectSupportedImageMimeType } from "./sdk/dist/utils/mime.js";\n',
  sha256: '514aaf1a9e0ba039af4a07b1dfed53f9e6935ced7b1cd70a08b3fdc0ab46a669',
  provenance: '@earendil-works/pi-coding-agent@1.5.2/dist/utils/mime.js#detectSupportedImageMimeType' });

async function ownedTree(path: string, root = path): Promise<void> {
  const info = await lstat(path);
  if (info.uid !== process.getuid?.()) throw new Error('SDK_STAGING_NOT_OWNED');
  if (info.isSymbolicLink() && !(await realpath(path)).startsWith(`${root}/`)) throw new Error('SDK_STAGING_NOT_OWNED');
  if (info.isDirectory()) for (const name of await readdir(path)) await ownedTree(join(path, name), root);
}

/** Offline development build only. Never modifies the installed upstream package. */
export async function prepareDevelopmentSdk() {
  const base = await realpath('.');
  const installed = await realpath('node_modules/@earendil-works/pi-coding-agent');
  if (!installed.startsWith(`${base}/node_modules/`)) throw new Error('SDK_INSTALL_NOT_PRIVATE');
  await ownedTree(installed);
  const treeHash = createHash('sha256');
  async function hashTree(relative = ''): Promise<void> {
    const path = join(installed, relative), info = await lstat(path);
    if (info.isDirectory()) {
      treeHash.update(JSON.stringify([relative, 'directory']) + '\n');
      for (const name of (await readdir(path)).sort()) await hashTree(join(relative, name));
    } else if (info.isSymbolicLink()) treeHash.update(JSON.stringify([relative, 'symlink', await readlink(path)]) + '\n');
    else treeHash.update(JSON.stringify([relative, 'file', sha(await readFile(path))]) + '\n');
  }
  await hashTree();
  if (treeHash.digest('hex') !== sdkProfile.upstreamTreeSHA256) throw new Error('SDK_UPSTREAM_DRIFT');
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const pin = lock.packages['node_modules/@earendil-works/pi-coding-agent'];
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  const source = await readFile(join(installed, 'dist/core/tools/read.js'), 'utf8');
  const patch = await readFile('docs/evidence/05-sdk-read-operations-candidate.patch');
  if (pin.version !== sdkProfile.version || pin.integrity !== sdkProfile.integrity || manifest.version !== sdkProfile.version ||
      sha(source) !== sdkProfile.upstreamSHA256 || sha(patch) !== sdkProfile.patchSHA256) throw new Error('SDK_UPSTREAM_DRIFT');
  const patched = source.replace('import { resolveReadPathAsync }', 'import { resolveReadPathAsync, resolveToCwd }')
    .replace('const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);',
      'const absolutePath = options?.operations\n                            ? resolveToCwd(path, ctx?.cwd || cwd)\n                            : await resolveReadPathAsync(path, ctx?.cwd || cwd);');
  const resultSHA256 = sha(patched);
  if (resultSHA256 !== sdkProfile.resultSHA256) throw new Error('SDK_PATCH_DRIFT');
  const scratch = resolve('.scratch');
  if (await realpath(scratch) !== scratch) throw new Error('SDK_STAGING_NOT_PRIVATE');
  const staging = join(scratch, 'factory-development-sdk');
  await mkdir(staging, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await ownedTree(staging);
  if ((await readdir(staging)).some(name => !['sdk', 'profile.json', imageMimeFacade.file].includes(name))) throw new Error('SDK_STAGING_DRIFT');
  if (await realpath(staging) !== staging || ((await lstat(staging)).mode & 0o077)) throw new Error('SDK_STAGING_NOT_PRIVATE');
  const target = join(staging, 'sdk');
  let exists = true;
  try { await lstat(target); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; exists = false; }
  if (exists) {
    await ownedTree(target);
    async function verify(relative = ''): Promise<void> {
      const upstream = join(installed, relative), destination = join(target, relative);
      const info = await lstat(upstream), copy = await lstat(destination);
      if (info.isDirectory()) {
        if (!copy.isDirectory()) throw new Error('SDK_STAGING_DRIFT');
        const names = (await readdir(upstream)).sort();
        if (JSON.stringify(names) !== JSON.stringify((await readdir(destination)).sort())) throw new Error('SDK_STAGING_DRIFT');
        for (const name of names) await verify(join(relative, name));
      } else if (info.isSymbolicLink()) {
        if (!copy.isSymbolicLink() || await readlink(upstream) !== await readlink(destination)) throw new Error('SDK_STAGING_DRIFT');
      } else if (!copy.isFile() || sha(await readFile(destination)) !==
          (relative === 'dist/core/tools/read.js' ? resultSHA256 : sha(await readFile(upstream)))) throw new Error('SDK_STAGING_DRIFT');
    }
    await verify();
  } else {
    await cp(installed, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await writeFile(join(target, 'dist/core/tools/read.js'), patched);
  }
  if (sha(imageMimeFacade.bytes) !== imageMimeFacade.sha256) throw new Error('SDK_FACADE_DRIFT');
  const facadePath = join(staging, imageMimeFacade.file);
  try { await writeFile(facadePath, imageMimeFacade.bytes, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const info = await lstat(facadePath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) ||
        sha(await readFile(facadePath)) !== imageMimeFacade.sha256) throw new Error('SDK_FACADE_DRIFT');
  }
  const evidence = { ...sdkProfile, resultSHA256, license: manifest.license, upstreamPackage: manifest.name };
  const profilePath = join(staging, 'profile.json');
  const profileBytes = JSON.stringify(evidence, null, 2) + '\n';
  try {
    await writeFile(profilePath, profileBytes, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    if (!(await lstat(profilePath)).isFile() || await readFile(profilePath, 'utf8') !== profileBytes) throw new Error('SDK_STAGING_DRIFT');
  }
  return evidence;
}
if (process.argv[1]?.endsWith('/sdk-profile.js')) console.log(JSON.stringify(await prepareDevelopmentSdk()));
