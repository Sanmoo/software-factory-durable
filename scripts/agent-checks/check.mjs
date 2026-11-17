// Offline repository checks. Never imports a harness, uses auth, or fetches a URL.
import {readFile, realpath, lstat, readdir, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {resolve, dirname, sep, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readApprovedRubric} from './rubric.mjs';

const args = process.argv.slice(2);
let root = process.cwd(), docsOnly = false, rubric, approval;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i]);
  else if (args[i] === '--docs-only') docsOnly = true;
  else if (args[i] === '--rubric' && args[i + 1]) rubric = args[++i];
  else if (args[i] === '--approval' && args[i + 1]) approval = args[++i];
  else { console.log(JSON.stringify({ok: false, findings: [{code: 'INVALID_ARGUMENTS'}]})); process.exit(2); }
}
try { root = await realpath(root); } catch {
  console.log(JSON.stringify({ok: false, findings: [{code: 'ROOT_UNAVAILABLE'}]})); process.exit(1);
}
const findings = [];
const add = (code, path) => findings.push({code, path});
const active = path => path === 'AGENTS.md' || path.startsWith('docs/agents/') || path.startsWith('.scratch/software-factory-v2/');
async function localFile(path, raw = false) {
  const full = resolve(root, path), canonical = await realpath(full), info = await lstat(full);
  if (!canonical.startsWith(`${root}${sep}`) || !info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw Error('UNSAFE_FILE');
  const bytes = await readFile(full);
  return raw ? bytes : new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}
const sha = text => createHash('sha256').update(text).digest('hex');
const safePath = path => typeof path === 'string' && !path.startsWith('/') &&
  !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..') && /\.(md|json)$/.test(path);
async function checkManifest(path, files) {
  let manifest;
  try {
    manifest = JSON.parse(await localFile(path));
    if (!Array.isArray(manifest.files) || manifest.files.length === 0 ||
        manifest.sourceFileCount !== manifest.files.length || !Array.isArray(manifest.addedIntegrationMetadata)) throw Error('SHAPE');
    const seen = new Set();
    for (const row of manifest.files) {
      if (!safePath(row.path) || seen.has(row.path) || !files.includes(row.path) ||
          !/^[a-f0-9]{64}$/.test(row.sourceSha256) || !/^[a-f0-9]{64}$/.test(row.integratedSha256)) throw Error('ROW');
      seen.add(row.path);
      const bytes = await localFile(row.path, true);
      const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      if (row.path.endsWith('.json')) {
        // Import hashes for Markdown are provenance, not a permanent lock on maps/tickets.
        if (sha(bytes) !== row.integratedSha256) add('EVIDENCE_HASH_MISMATCH', row.path);
        JSON.parse(text);
        if (row.byteIdentical !== true || row.sourceSha256 !== row.integratedSha256) add('EVIDENCE_SOURCE_MISMATCH', row.path);
      }
    }
    if (manifest.rawEvidenceJsonCount !== manifest.files.filter(row => row.path.endsWith('.json')).length) throw Error('COUNT');
    for (const item of manifest.addedIntegrationMetadata) {
      if (!safePath(item) || !files.includes(item)) throw Error('METADATA');
      await localFile(item);
    }
  } catch { add('INVALID_MANIFEST', path); }
}
function withoutCode(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) { if (!fence) fence = mark[0]; else if (mark[0] === fence) fence = null; return ''; }
    return fence ? '' : line.replace(/`[^`]*`/g, '');
  }).join('\n');
}
if (rubric || approval) {
  try { await readApprovedRubric(root, rubric, approval); } catch (error) { add(error.code ?? 'INVALID_RUBRIC', 'rubric'); }
}
try {
  const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {encoding: 'utf8'}).trim();
  if (await realpath(top) !== root) throw Error('NOT_REPOSITORY_ROOT');
  const files = [...new Set(execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean))];
  const defaultRubric = 'scripts/agent-checks/fixtures/rehearsal-rubric.json';
  const defaultApproval = 'scripts/agent-checks/fixtures/rehearsal-approval.json';
  if (files.includes(defaultRubric) || files.includes(defaultApproval)) {
    try { await readApprovedRubric(root, defaultRubric, defaultApproval); }
    catch (error) { add(error.code ?? 'INVALID_RUBRIC', defaultRubric); }
  }
  for (const path of files.filter(p => p.startsWith('.scratch/software-factory-v2/prototype/') || p.startsWith('.runtime/'))) add('DISPOSABLE_CODE_IN_DOCUMENTARY_TREE', path);
  for (const path of files.filter(p => active(p) && p.endsWith('-documentary-import.json')))  await checkManifest(path, files);
  for (const path of files.filter(p => active(p) && p.endsWith('.md'))) {
    let text;
    try { text = withoutCode(await localFile(path)); } catch { add('FILE_UNAVAILABLE', path); continue; }
    const links = [...text.matchAll(/\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)].map(x => x[1] ?? x[2]);
    links.push(...[...text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)].map(x => x[1] ?? x[2]));
    for (const link of links) {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(link) || link.startsWith('#')) continue;
      try {
        const target = resolve(root, dirname(path), decodeURIComponent(link.split('#')[0]));
        const canonical = await realpath(target);
        if (!canonical.startsWith(`${root}${sep}`)) throw Error('OUTSIDE_REPO');
      } catch { add('BROKEN_LINK', path); }
    }
  }
} catch { add('REPOSITORY_UNAVAILABLE', '.'); }
if (!docsOnly) {
  let temporary;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // One suite-owned directory on the repository filesystem; never delete a shared /tmp tree.
    const parent = join(root, '.agent-check-tmp');
    await mkdir(parent, {recursive: true, mode: 0o700});
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('UNSAFE_TEMP');
    temporary = await mkdtemp(join(parent, 'suite-'));
    const tests = (await readdir(here)).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(here, name));
    if (!tests.length) throw Error('NO_TESTS');
    const result = spawnSync(process.execPath, ['--test', ...tests], {stdio: 'inherit', env: {...process.env, TMPDIR: temporary}, timeout: 120000});
    if (result.status !== 0) add('TESTS_FAILED', 'scripts/agent-checks');
  } catch { add('TEST_EXECUTION_FAILED', 'scripts/agent-checks'); }
  finally { if (temporary) await rm(temporary, {recursive: true, force: true}); }
}
console.log(JSON.stringify({ok: findings.length === 0, checks: docsOnly ? 'documentation' : 'documentation-and-tests', findings}, null, 2));
process.exitCode = findings.length ? 1 : 0;
