import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { upgrade } from '../../src/entrypoints/controller/upgrade.js';
import { parseReleaseManifest } from '../../src/entrypoints/release.js';
import { assetsSha256 } from './upgrade-fixture.js';

// TEST ONLY child (ticket 33): runs `upgrade apply` as the target release of a fixture root and SIGKILLs ITSELF right after the named
// durable step (journal written, migration committed, selection switched): a real process death, no cleanup handler runs.
const [root, cut, command = 'apply', migrate] = process.argv.slice(2) as [string, 'journal' | 'migrated' | 'selected', 'apply' | 'resume', string | undefined];
const parsed = parseReleaseManifest(await readFile(join(root, 'releases', 'mvp-33.1', 'release-manifest.json')))!;
const result = await upgrade({ root, storagePath: join(root, 'data', 'control.sqlite'),
  target: { directory: join(root, 'releases', 'mvp-33.1'), manifest: parsed.manifest, manifestSha256: parsed.manifestSha256, checks: [],
    guestAssets: { directory: join(root, 'assets', 'guest', assetsSha256), manifestSha256: assetsSha256 } },
  observe: step => { if (step === cut) process.kill(process.pid, 'SIGKILL'); } }, command, migrate ? { migrate } : {});
console.log(JSON.stringify(result));
