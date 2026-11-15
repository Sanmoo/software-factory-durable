import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readlink, realpath, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const sdkProfile = Object.freeze({ id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3', version: '1.5.2',
  integrity: 'sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA==',
  upstreamSHA256: 'e6159de5e4d94ae22968b6524237ef3d4f0374a107e2321ed5c29e93d66c8efc',
  upstreamTreeSHA256: '7d0961cce25f6c802b22aaa028206cd610de386442d2e6b732d71367ef006391',
  patchSHA256: '5e45a7c2953db293a14db0138bb31f8ac9e95eb13512afd42f1f49b77c98e066',
  resultSHA256: '06867a067ebbadca2e06f75ccb4e682cd7e37b9683d41a71562f770b3105a209',
  asyncPatchSHA256: '1ee38f2bdb71480b5b6206e72dbed32ac9214acbe0afe9b7e5137ea8f63cdc1e',
  candidatePatchSHA256: 'fd85bbd3c22fff3cb90dd990cb2608f18884d15dcd3820fb2f790b6e42a4dd01',
  candidateManifestSHA256: 'b6aaa5391d251867e41e8fc80973a1da79c7df3e38cdd18d11e705d939809b69',
  lexicalPatchSHA256: 'e3e88f8e6a53c9b58164c85c9866cfcf5a31b9fd415fdad7ce136976d8fd96d0',
  lexicalCandidateManifestSHA256: '923d916bae558e6d21978593b2effb716dec80398bb5b0a66271fefcfc0f42a2' });

// Exact adopted SDK-only candidate bytes. Default upstream declarations are not augmented.
export const asyncBashFiles: Readonly<Record<string, { before: string; after: string }>> = Object.freeze({
  'dist/core/tools/bash.js': { before: 'afc4f829b3da2e7d8cc31296ccceb26bbc8e35018eb3f352791b651866cc2040', after: '2a6f7dc6b16357e8927a8f82cd895a9f6c96d98401eddf1e925cd74a64094e9d' },
  'dist/core/tools/bash.d.ts': { before: '78d2558fa0d81296004aed0b0c939b6c44a14a60e792eb363d08a2e4a6a5726b', after: 'ab7d399fecde1446eb92c231a4a83567e658b0e580caff939d259b3fa4572f24' },
  'dist/core/tools/output-accumulator.js': { before: '5416cd0ef5a8edc984093ed67053ae27ebfc7ed42699c452daddf94dd6217858', after: '6ce6e014c2fd47f094626cf9ba0860403db9b49b4333486e9394c8eaeea05ae5' },
  'dist/core/tools/output-accumulator.d.ts': { before: '363987be1771e96d16805df4e13300ced5e701375ed9e156f7562141e0c0a2e2', after: 'febeb4e32a161e5af81cb5c3484861f972f58339923abe23a0959720e14f2006' },
});
// Exact six-file parent-adopted native queue correction; no other SDK source changes.
export const lexicalQueueFiles: Readonly<Record<string, { before: string; after: string }>> = Object.freeze({
  'dist/core/tools/edit.d.ts': { before: '8e84eb3492e5b6a683d064cabf5ed4cb121753704e2f3d4099bae13be244e8d2', after: '345512ff4023036624325aa7cd7b913062496e5b302641803f7a6624fc6b9518' },
  'dist/core/tools/edit.js': { before: '6e7fa99a8ac15e8a42d56158f52bd49c68a977a530a143f162858f755af572c5', after: 'b0944caf868d6a3e8377cdcd2de1092255fc36f3990f25dcc173f6d78a5f8157' },
  'dist/core/tools/file-mutation-queue.d.ts': { before: '3e7a344dbfe8ab0c825cac1a6a420969a9a82ff85b2479a9de1d93eec12ed885', after: 'ce049dee22fb3bc35c683e980f3a5e2f54312facb567b5d3d5eb3bcada4b3d14' },
  'dist/core/tools/file-mutation-queue.js': { before: 'cd300f1ecae2b8d45a7c69011221f4f2e4e289865bf879df537c859889f26e5b', after: 'b2a6983a73e85dca3043b95d09b507e758e115d39b356319795148404a7bb3f7' },
  'dist/core/tools/write.d.ts': { before: '039017adffeeb080af53ec53b191ca88ea109591556cbeea0da21104cd8ef087', after: '71fa3593814c75da99ba36ed0b1e615b2b5b5dc4adf644cf36b320996705077d' },
  'dist/core/tools/write.js': { before: '0e9daec15a5001cafe651db391aed63a463c346d29b60e6dc91ef09477fd22f5', after: '41730ddf128824f6c0a0950033933514c8cdfbf33d67c7ae6b834ecb376684cb' },
});
const correctedFiles = { ...asyncBashFiles, ...lexicalQueueFiles };
export const sdkStagingDirectory = '.scratch/factory-development-sdk-v3';

// Factory-owned composition, not an additional SDK source patch or index export.
export const imageMimeFacade = Object.freeze({ file: 'image-mime.js',
  bytes: 'export { detectSupportedImageMimeType } from "./sdk/dist/utils/mime.js";\n',
  sha256: '514aaf1a9e0ba039af4a07b1dfed53f9e6935ced7b1cd70a08b3fdc0ab46a669',
  provenance: '@earendil-works/pi-coding-agent@1.5.2/dist/utils/mime.js#detectSupportedImageMimeType' });

async function ownedTree(path: string, root = path): Promise<void> {
  const info = await lstat(path);
  if ((!info.isDirectory() && !info.isSymbolicLink() && (!info.isFile() || info.nlink !== 1)) || info.uid !== process.getuid?.()) throw new Error('SDK_STAGING_NOT_OWNED');
  if (info.isSymbolicLink() && !(await realpath(path)).startsWith(`${root}/`)) throw new Error('SDK_STAGING_NOT_OWNED');
  if (info.isDirectory()) for (const name of await readdir(path)) await ownedTree(join(path, name), root);
}

/** Offline development build only. Never modifies the installed upstream package. `project` defaults to the working directory. */
export async function prepareDevelopmentSdk(project = process.cwd()) {
  const base = await realpath(project);
  const installed = await realpath(join(base, 'node_modules/@earendil-works/pi-coding-agent'));
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
  const lock = JSON.parse(await readFile(join(base, 'package-lock.json'), 'utf8'));
  const pin = lock.packages['node_modules/@earendil-works/pi-coding-agent'];
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  const source = await readFile(join(installed, 'dist/core/tools/read.js'), 'utf8');
  const patch = await readFile(join(base, 'docs/evidence/05-sdk-read-operations-candidate.patch'));
  if (pin.version !== sdkProfile.version || pin.integrity !== sdkProfile.integrity || manifest.version !== sdkProfile.version ||
      sha(source) !== sdkProfile.upstreamSHA256 || sha(patch) !== sdkProfile.patchSHA256) throw new Error('SDK_UPSTREAM_DRIFT');
  const patched = source.replace('import { resolveReadPathAsync }', 'import { resolveReadPathAsync, resolveToCwd }')
    .replace('const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);',
      'const absolutePath = options?.operations\n                            ? resolveToCwd(path, ctx?.cwd || cwd)\n                            : await resolveReadPathAsync(path, ctx?.cwd || cwd);');
  const resultSHA256 = sha(patched);
  if (resultSHA256 !== sdkProfile.resultSHA256) throw new Error('SDK_PATCH_DRIFT');
  const asyncPatch = join(base, 'docs/evidence/05-sdk-async-bash-v2.patch');
  if (sha(await readFile(asyncPatch)) !== sdkProfile.asyncPatchSHA256) throw new Error('SDK_PATCH_DRIFT');
  for (const [file, hashes] of Object.entries(correctedFiles)) {
    if (sha(await readFile(join(installed, file))) !== hashes.before) throw new Error('SDK_UPSTREAM_DRIFT');
  }
  const lexicalPatch = join(base, 'docs/evidence/05-sdk-lexical-queue-v3.patch');
  if (sha(await readFile(lexicalPatch)) !== sdkProfile.lexicalPatchSHA256) throw new Error('SDK_PATCH_DRIFT');
  await run('git', ['apply', '--check', `--directory=${installed}`, '--unsafe-paths', lexicalPatch], { cwd: base, timeout: 10000 });
  // Existing standard patch tooling, never a custom patch interpreter or an install.
  await run('git', ['apply', '--check', `--directory=${installed}`, '--unsafe-paths', asyncPatch], { cwd: base, timeout: 10000 });
  const evidence = { ...sdkProfile, resultSHA256, asyncBashFiles, lexicalQueueFiles, license: manifest.license,
    standaloneLicense: (await readdir(installed)).includes('LICENSE'), upstreamPackage: manifest.name };
  const profileBytes = JSON.stringify(evidence, null, 2) + '\n';
  const scratch = join(base, '.scratch');
  if (await realpath(scratch) !== scratch) throw new Error('SDK_STAGING_NOT_PRIVATE');
  const staging = join(base, sdkStagingDirectory);
  let exists = false;
  await mkdir(staging, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; exists = true; });
  await ownedTree(staging);
  if ((await readdir(staging)).some(name => !['sdk', 'profile.json', imageMimeFacade.file].includes(name))) throw new Error('SDK_STAGING_DRIFT');
  if (await realpath(staging) !== staging || ((await lstat(staging)).mode & 0o077)) throw new Error('SDK_STAGING_NOT_PRIVATE');
  const target = join(staging, 'sdk');
  async function verify(relative = ''): Promise<void> {
      const upstream = join(installed, relative), destination = join(target, relative);
      const info = await lstat(upstream), copy = await lstat(destination);
      if (info.isDirectory()) {
        if (copy.isSymbolicLink() || !copy.isDirectory()) throw new Error('SDK_STAGING_DRIFT');
        const names = (await readdir(upstream)).sort();
        if (JSON.stringify(names) !== JSON.stringify((await readdir(destination)).sort())) throw new Error('SDK_STAGING_DRIFT');
        for (const name of names) await verify(join(relative, name));
      } else if (info.isSymbolicLink()) {
        if (!copy.isSymbolicLink() || await readlink(upstream) !== await readlink(destination)) throw new Error('SDK_STAGING_DRIFT');
      } else if (!copy.isFile() || copy.nlink !== 1 || sha(await readFile(destination)) !==
          (relative === 'dist/core/tools/read.js' ? resultSHA256 : correctedFiles[relative]?.after ?? sha(await readFile(upstream)))) throw new Error('SDK_STAGING_DRIFT');
    }
  if (!exists) {
    await cp(installed, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await writeFile(join(target, 'dist/core/tools/read.js'), patched);
    await run('git', ['apply', `--directory=${target}`, '--unsafe-paths', asyncPatch], { cwd: base, timeout: 10000 });
    await run('git', ['apply', `--directory=${target}`, '--unsafe-paths', lexicalPatch], { cwd: base, timeout: 10000 });
    for (const [file, hashes] of Object.entries(correctedFiles)) {
      if (sha(await readFile(join(target, file))) !== hashes.after) throw new Error('SDK_PATCH_DRIFT');
    }
  }
  await ownedTree(target);
  await verify();
  if (sha(imageMimeFacade.bytes) !== imageMimeFacade.sha256) throw new Error('SDK_FACADE_DRIFT');
  const facadePath = join(staging, imageMimeFacade.file);
  const profilePath = join(staging, 'profile.json');
  if (exists) {
    for (const [path, bytes, code] of [[facadePath, imageMimeFacade.bytes, 'SDK_FACADE_DRIFT'],
      [profilePath, profileBytes, 'SDK_STAGING_DRIFT']]) {
      if (!path || bytes === undefined || !code) throw new Error('SDK_STAGING_DRIFT');
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || await readFile(path, 'utf8') !== bytes) throw new Error(code);
    }
    return evidence;
  }
  await writeFile(facadePath, imageMimeFacade.bytes, { mode: 0o600, flag: 'wx' });
  await writeFile(profilePath, profileBytes, { mode: 0o600, flag: 'wx' });
  return evidence;
}
if (process.argv[1]?.endsWith('/sdk-profile.js')) console.log(JSON.stringify(await prepareDevelopmentSdk()));
