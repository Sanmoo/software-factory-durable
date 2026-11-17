import {readFile, realpath, lstat} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';

function fail(code) { throw Object.assign(Error(code), {code}); }
async function read(root, path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) fail('INVALID_RUBRIC_PATH');
  const full = resolve(root, path), canonical = await realpath(full), info = await lstat(full);
  if (!canonical.startsWith(`${root}${sep}`) || !info.isFile() || info.isSymbolicLink() || info.size > 65536) fail('INVALID_RUBRIC_FILE');
  return readFile(full);
}
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Hash matching records a reviewed input; it does not authenticate a human or authorize spending. */
export async function readApprovedRubric(root, rubricPath, approvalPath) {
  try {
    root = await realpath(root);
    const decode = bytes => new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    const bytes = await read(root, rubricPath), approval = JSON.parse(decode(await read(root, approvalPath)));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (approval.rubricSha256 !== sha256) fail('RUBRIC_HASH_MISMATCH');
    if (!text(approval.approvedBy)) fail('RUBRIC_APPROVAL_MISSING');
    const rubric = JSON.parse(decode(bytes)), ids = new Set();
    if (rubric.schemaVersion !== 1 || !text(rubric.id) || !Number.isInteger(rubric.version) || rubric.version < 1 ||
        !text(rubric.scope) || !Array.isArray(rubric.criteria) || !rubric.criteria.length) fail('INVALID_RUBRIC');
    for (const criterion of rubric.criteria) {
      if (!criterion || typeof criterion.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(criterion.id) || ids.has(criterion.id) ||
          !['contract', 'auxiliary'].includes(criterion.kind) || !text(criterion.requirement) || !text(criterion.witness) ||
          !Array.isArray(criterion.fixtures) || !criterion.fixtures.every(text) ||
          !Array.isArray(criterion.excludes) || !criterion.excludes.every(text)) fail('INVALID_RUBRIC');
      ids.add(criterion.id);
    }
    return {rubric, sha256};
  } catch (error) {
    if (['INVALID_RUBRIC_PATH', 'INVALID_RUBRIC_FILE', 'RUBRIC_HASH_MISMATCH', 'RUBRIC_APPROVAL_MISSING', 'INVALID_RUBRIC'].includes(error.code)) throw error;
    fail('RUBRIC_UNAVAILABLE');
  }
}
