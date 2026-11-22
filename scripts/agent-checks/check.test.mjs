import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const cli = fileURLToPath(new URL('./check.mjs', import.meta.url));
async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'proof-docs-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  execFileSync('git', ['init', '-q', root]);
  await mkdir(join(root, 'docs/agents'), {recursive: true});
  return root;
}
const check = (root, args = []) => spawnSync(process.execPath, [cli, '--docs-only', '--root', root, ...args], {encoding: 'utf8'});
const sha = text => createHash('sha256').update(text).digest('hex');

async function importedEvidence(root) {
  const directory = '.scratch/software-factory-v2/research';
  await mkdir(join(root, directory), {recursive: true});
  const path = `${directory}/observed.json`, bytes = '{"counter":1}\n';
  await writeFile(join(root, path), bytes);
  const manifest = {sourceFileCount: 1, rawEvidenceJsonCount: 1, files: [
    {path, sourceSha256: sha(bytes), integratedSha256: sha(bytes), byteIdentical: true},
  ], addedIntegrationMetadata: []};
  const manifestPath = join(root, directory, 'sample-documentary-import.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return {path: join(root, path), manifestPath, manifest};
}

test('documentary manifests validate retained bytes without requiring unpublished source commits', async t => {
  const root = await repository(t), fixture = await importedEvidence(root);
  assert.equal(check(root).status, 0);
  await writeFile(fixture.path, '{"counter":0}\n');
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /EVIDENCE_HASH_MISMATCH/);
});

test('evidence integrity is over actual bytes and invalid UTF-8 is not repaired silently', async t => {
  const root = await repository(t), data = await importedEvidence(root);
  const bytes = Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  await writeFile(data.path, bytes);
  data.manifest.files[0].sourceSha256 = sha(bytes);
  data.manifest.files[0].integratedSha256 = sha(bytes);
  await writeFile(data.manifestPath, JSON.stringify(data.manifest));
  assert.match(check(root).stdout, /INVALID_MANIFEST/);
});

test('an import manifest freezes raw evidence, not the future evolution of its Markdown index', async t => {
  const root = await repository(t), data = await importedEvidence(root);
  const path = 'docs/agents/current.md';
  await writeFile(join(root, path), '# Updated index\n');
  data.manifest.files.push({path, sourceSha256: sha('# Old index\n'), integratedSha256: sha('# Old index\n'), byteIdentical: true});
  data.manifest.sourceFileCount++;
  await writeFile(data.manifestPath, JSON.stringify(data.manifest));
  assert.equal(check(root).status, 0);
});

test('approved rubrics freeze property-specific requirements before a rehearsal', async t => {
  const root = await repository(t);
  const rubric = {schemaVersion: 1, id: 'local-proof', version: 1, scope: 'synthetic only', criteria: [
    {id: 'counter', kind: 'contract', requirement: 'no replay', witness: 'independent counter unchanged', fixtures: ['local service'], excludes: ['global idempotency']},
    {id: 'edit', kind: 'auxiliary', requirement: 'edit completed', witness: 'artifact marker', fixtures: [], excludes: ['no-replay']},
  ]};
  const bytes = JSON.stringify(rubric);
  await writeFile(join(root, 'rubric.json'), bytes);
  await writeFile(join(root, 'approval.json'), JSON.stringify({rubricSha256: sha(bytes), approvedBy: 'synthetic fixture, not an operator grant'}));
  const args = ['--rubric', 'rubric.json', '--approval', 'approval.json'];
  assert.equal(check(root, args).status, 0);
  await writeFile(join(root, 'rubric.json'), bytes.replace('no replay', 'edit succeeded'));
  const result = check(root, args);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /RUBRIC_HASH_MISMATCH/);
});

test('unsafe or duplicate manifest paths and disposable execution files are rejected', async t => {
  const root = await repository(t), data = await importedEvidence(root);
  data.manifest.files.push({...data.manifest.files[0]}); data.manifest.sourceFileCount = 2;
  await writeFile(data.manifestPath, JSON.stringify(data.manifest));
  assert.match(check(root).stdout, /INVALID_MANIFEST/);
  data.manifest.files = [{...data.manifest.files[0], path: '../../outside.json'}]; data.manifest.sourceFileCount = 1;
  await writeFile(data.manifestPath, JSON.stringify(data.manifest));
  assert.match(check(root).stdout, /INVALID_MANIFEST/);
  await mkdir(join(root, '.scratch/software-factory-v2/prototype'), {recursive: true});
  await writeFile(join(root, '.scratch/software-factory-v2/prototype/leak.mjs'), '// disposable');
  assert.match(check(root).stdout, /DISPOSABLE_CODE_IN_DOCUMENTARY_TREE/);
});

test('a matching hash cannot make malformed or duplicate criterion definitions valid', async t => {
  const root = await repository(t);
  const criterion = {id: 'counter', kind: 'contract', requirement: 'r', witness: 'w', fixtures: [], excludes: []};
  const rubric = {schemaVersion: 1, id: 'test', version: 1, scope: 'synthetic', criteria: [criterion, criterion]};
  const bytes = JSON.stringify(rubric);
  await writeFile(join(root, 'rubric.json'), bytes);
  await writeFile(join(root, 'approval.json'), JSON.stringify({rubricSha256: sha(bytes), approvedBy: 'fixture'}));
  assert.match(check(root, ['--rubric', 'rubric.json', '--approval', 'approval.json']).stdout, /INVALID_RUBRIC/);
  rubric.criteria = [{...criterion, id: null}];
  const invalidId = JSON.stringify(rubric);
  await writeFile(join(root, 'rubric.json'), invalidId);
  await writeFile(join(root, 'approval.json'), JSON.stringify({rubricSha256: sha(invalidId), approvedBy: 'fixture'}));
  assert.match(check(root, ['--rubric', 'rubric.json', '--approval', 'approval.json']).stdout, /INVALID_RUBRIC/);
});

test('a subdirectory cannot silently pass as an empty repository scan', async t => {
  const root = await repository(t);
  const result = check(join(root, 'docs/agents'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /REPOSITORY_UNAVAILABLE/);
});

test('the public check command rejects a broken active-document link', async t => {
  const root = await repository(t);
  await writeFile(join(root, 'docs/agents/run.md'), '[missing](absent.md)');
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /BROKEN_LINK/);
});

test('Guide pointers: links in GLOSSARY.md, docs/guides/ and docs/adr/ must resolve, and the finding names the target', async t => {
  const root = await repository(t);
  for (const directory of ['docs/guides', 'docs/adr']) await mkdir(join(root, directory), {recursive: true});
  await writeFile(join(root, 'GLOSSARY.md'), '# G\n[spec](docs/spec.md)\n');
  await writeFile(join(root, 'docs/guides/a.md'), '[up](../../GLOSSARY.md)\n');
  await writeFile(join(root, 'docs/adr/0001-x.md'), '[guide](../guides/a.md)\n');
  let result = check(root);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings, [{code: 'BROKEN_LINK', path: 'GLOSSARY.md', target: 'docs/spec.md'}]);
  await writeFile(join(root, 'docs/spec.md'), 'x\n');
  result = check(root);
  assert.equal(result.status, 0, result.stdout);
});

test('Guide pointers: a backticked repository path in a Guide must exist; placeholders, globs and untracked roots are not paths', async t => {
  const root = await repository(t);
  await mkdir(join(root, 'docs/guides'), {recursive: true});
  await mkdir(join(root, 'src'), {recursive: true});
  await writeFile(join(root, 'src/a.ts'), 'x\n');
  await writeFile(join(root, 'docs/guides/g.md'), 'See `src/a.ts`, `src/<module>/index.ts`, `src/**`, `node_modules/.cache/x.json` and `src/gone.ts`.\n');
  const result = check(root);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings, [{code: 'MISSING_PATH', path: 'docs/guides/g.md', target: 'src/gone.ts'}]);
});

test('Guide pointers: a Guide names only the Entry Points and the full Entry Point modes as commands', async t => {
  const root = await repository(t);
  await mkdir(join(root, 'docs/guides'), {recursive: true});
  await writeFile(join(root, 'AGENTS.md'), 'Run `npm run test:fast`, `npm run test:ci` or `npm run test:full`; then `git push origin main`.\n');
  await writeFile(join(root, 'docs/guides/g.md'), 'Never `npx eslint src`; `node --test dist/x.js` neither.\n\n```sh\nnpm run lint\n```\n');
  const result = check(root);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings, [
    {code: 'NON_ENTRY_POINT_COMMAND', path: 'docs/guides/g.md', target: 'npx eslint src'},
    {code: 'NON_ENTRY_POINT_COMMAND', path: 'docs/guides/g.md', target: 'node --test dist/x.js'},
    {code: 'NON_ENTRY_POINT_COMMAND', path: 'docs/guides/g.md', target: 'npm run lint'},
  ]);
});
