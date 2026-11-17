// Experiment support only. Callbacks belong to trusted test composition, never model arguments.
import {mkdir, open, readFile, lstat} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => {
  const text = JSON.stringify(value, (_key, item) => {
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) ||
        (typeof item === 'number' && !Number.isFinite(item))) throw Error('NOT_JSON');
    return item;
  }, 2);
  if (text === undefined || Buffer.byteLength(text) > 1024 * 1024) throw Error('INVALID_OR_OVERSIZED_JSON');
  return `${text}\n`;
};

async function durableWrite(directory, name, value) {
  const bytes = encode(value);
  const file = await open(join(directory, name), 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const folder = await open(directory, 'r');
  try { await folder.sync(); } finally { await folder.close(); }
  return digest(bytes);
}

async function verifyEvidence(directory, sha256) {
  const path = join(directory, 'evidence.json'), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) ||
      digest(await readFile(path)) !== sha256) throw Error('EVIDENCE_CHANGED');
}

/** stop withdraws execution capacity; remove deletes diagnostic sources only after preservation.
 * sanitize is required caller policy, not automatic DLP. Error messages/raw callback outputs are never persisted.
 * Existing run directories are refused; this helper never retries a model or interprets exit codes.
 */
export async function finalizeProof({directory, criterionIds, stop, collect, sanitize, assess, remove}) {
  const result = {
    cessationConfirmed: false,
    evidence: {status: 'failed'},
    assessment: {status: 'skipped'},
    cleanup: {status: 'blocked'},
  };
  try { result.cessationConfirmed = (await stop())?.ceased === true; } catch { /* Safe metadata only. */ }
  try {
    await mkdir(directory, {mode: 0o700});
    const parent = await open(dirname(directory), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } catch {
    result.evidence.code = 'RUN_DIRECTORY_UNAVAILABLE';
    return result;
  }
  let observations, stage = 'COLLECT';
  try {
    const raw = await collect();
    stage = 'SANITIZE';
    observations = JSON.parse(encode(await sanitize(raw)));
    stage = 'PERSIST';
    const sha256 = await durableWrite(directory, 'evidence.json', {schemaVersion: 1, observations});
    result.evidence = {status: 'preserved', sha256};
  } catch {
    result.evidence.code = `${stage}_FAILED`;
    await durableWrite(directory, 'failure.json', result).catch(() => {});
    return result;
  }
  if (!Array.isArray(criterionIds) || !criterionIds.length || new Set(criterionIds).size !== criterionIds.length ||
      criterionIds.some(id => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))) {
    result.assessment = {status: 'blocked', code: 'RUBRIC_NOT_BOUND'};
    await durableWrite(directory, 'failure.json', result).catch(() => {});
    return result;
  }
  if (!result.cessationConfirmed) {
    result.cleanup.code = 'CESSATION_UNCONFIRMED';
    await durableWrite(directory, 'failure.json', result).catch(() => {});
    return result;
  }
  try {
    const criteria = await assess(observations);
    if (!criteria || Array.isArray(criteria) || Object.getPrototypeOf(criteria) !== Object.prototype ||
        Object.keys(criteria).length !== criterionIds.length || criterionIds.some(id => !Object.hasOwn(criteria, id)) ||
        Object.entries(criteria).some(([id, outcome]) =>
          !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || !['approved', 'rejected', 'inconclusive'].includes(outcome))) {
      throw Error('INVALID_CRITERIA');
    }
    result.assessment = {status: 'completed', criteria: {...criteria}};
  } catch { result.assessment = {status: 'failed', code: 'ASSESSMENT_FAILED'}; }
  try {
    await verifyEvidence(directory, result.evidence.sha256);
  } catch {
    result.evidence = {status: 'unverified', code: 'EVIDENCE_CHANGED'};
    result.cleanup.code = 'PRESERVATION_UNCONFIRMED';
    return result;
  }
  try {
    await durableWrite(directory, 'assessment.json', result.assessment);
    await durableWrite(directory, 'cleanup-intent.json', {evidenceSha256: result.evidence.sha256});
  } catch {
    result.cleanup.code = 'PRESERVATION_UNCONFIRMED';
    return result;
  }
  try { await remove(); result.cleanup = {status: 'completed'}; }
  catch { result.cleanup = {status: 'failed', code: 'REMOVE_FAILED'}; }
  try {
    await verifyEvidence(directory, result.evidence.sha256);
  } catch {
    result.evidence = {status: 'unverified', code: 'EVIDENCE_CHANGED_DURING_CLEANUP'};
    result.cleanup = {status: 'unknown', code: 'EVIDENCE_CHANGED_DURING_CLEANUP'};
  }
  try { await durableWrite(directory, 'cleanup.json', result.cleanup); }
  catch { result.cleanup = {status: 'unknown', code: 'CLEANUP_RECORD_FAILED'}; }
  return result;
}
