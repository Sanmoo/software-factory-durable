// Manual, read-only artifact check. No VM, guest executable or package script is run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const root = process.argv[2];
assert.ok(root && isAbsolute(root), 'EXTRACTED_ARTIFACT_ROOT_REQUIRED');
const database = readFileSync(join(root, 'lib/apk/db/installed'), 'utf8');
const blocks = database.split('\n\n').filter(block => block.startsWith('C:') || block.includes('\nP:'));
const packages = new Map(blocks.map(block => [block.match(/^P:(.+)$/m)?.[1], block]));
const versions = { docker: '29.5.2-r0', 'docker-engine': '29.5.2-r0', git: '2.52.1-r0',
  'git-init-template': '2.52.1-r0', 'python3-pycache-pyc0': '3.12.16-r0', zlib: '1.4-r0' };
for (const [name, version] of Object.entries(versions)) {
  assert.equal(packages.get(name)?.match(/^V:(.+)$/m)?.[1], version, `APK_DATABASE_MISSING_OR_WRONG_VERSION:${name}`);
}
assert.equal([...packages.keys()].some(name => name?.startsWith('linux-')), false, 'UNEXPECTED_SECOND_KERNEL_PACKAGE');

function recordedDigest(owner: string, file: string) {
  let directory = '';
  let current = '';
  for (const line of packages.get(owner)?.split('\n') ?? []) {
    if (line.startsWith('F:')) directory = line.slice(2);
    if (line.startsWith('R:')) current = join(directory, line.slice(2));
    if (line.startsWith('Z:') && current === file) return line.slice(2);
  }
  throw new Error(`APK_FILE_HASH_MISSING:${owner}:${file}`);
}
const checked = [];
for (const [owner, file] of [
  ['docker-engine', 'usr/bin/dockerd'], ['git', 'usr/bin/git'], ['zlib', 'usr/lib/libz.so.1.4'],
] as const) {
  assert.ok(lstatSync(join(root, file)).isFile(), `NOT_REGULAR:${file}`);
  const digest = recordedDigest(owner, file);
  assert.ok(digest.startsWith('Q1'), `UNSUPPORTED_APK_FILE_DIGEST:${file}`);
  assert.equal(createHash('sha1').update(readFileSync(join(root, file))).digest('base64'), digest.slice(2), `APK_FILE_HASH_MISMATCH:${file}`);
  checked.push({ owner, file, digest });
}
assert.equal(readlinkSync(join(root, 'usr/lib/libz.so.1')), 'libz.so.1.4');
assert.equal(lstatSync(join(root, 'usr/lib/libz.so.1.3.2'), { throwIfNoEntry: false }), undefined, 'OBSOLETE_LIBRARY_RESURRECTED_BY_OVERLAY');
console.log(JSON.stringify({ status: 'APK_INVENTORY_AND_SELECTED_FILE_HASHES_MATCH', packages: packages.size,
  versions, checked, runtimeQualified: false, limits: 'Static selected-file checks, not complete file/ABI/runtime qualification' }, null, 2));
