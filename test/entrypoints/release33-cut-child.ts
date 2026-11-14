import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { upgrade } from '../../src/entrypoints/controller/upgrade.js';
import { parseReleaseManifest, verifyReleaseTree } from '../../src/entrypoints/release.js';

// TEST ONLY child of the ticket 33 real recipe, launched under the installation's canonical-storage flock with the NEW release's private Node.
// It runs the upgrade module of THIS checkout, which the recipe first proves byte-identical to the new release's distributed JavaScript (the
// release was built from this clean checkout), and SIGKILLs itself right after the named durable step. Target facts: the verified manifest.
const [root, release, cut, command, migrate] = process.argv.slice(2) as [string, string, 'journal' | 'migrated' | 'selected', 'apply' | 'resume', string | undefined];
const verified = await verifyReleaseTree(release);
if (verified.kind !== 'release') throw new Error('TARGET_NOT_VERIFIED');
const parsed = parseReleaseManifest(await readFile(join(release, 'release-manifest.json')))!;
const result = await upgrade({ root, storagePath: join(root, 'data', 'control.sqlite'),
  target: { directory: release, manifest: parsed.manifest, manifestSha256: parsed.manifestSha256, checks: [],
    guestAssets: { directory: join(root, parsed.manifest.guestAssets.path), manifestSha256: parsed.manifest.guestAssets.manifestSha256 } },
  observe: step => { if (step === cut) process.kill(process.pid, 'SIGKILL'); } }, command, migrate ? { migrate } : {});
console.log(JSON.stringify(result));
