import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, writeFile, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {finalizeProof} from './finalize.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'proof-finalize-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return {directory: join(root, 'run'), criterionIds: ['C12', 'auxiliaryEdit'], stop: async () => ({ceased: true}),
    collect: async () => ({counter: 1}), sanitize: raw => raw,
    assess: async () => ({C12: 'approved', auxiliaryEdit: 'rejected'}),
    remove: async () => {}, ...overrides};
}

test('a failed assessment preserves sanitized evidence before removing diagnostic sources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proof-finalize-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const directory = join(root, 'run');
  const calls = [];
  const result = await finalizeProof({
    directory,
    criterionIds: ['C12', 'auxiliaryEdit'],
    stop: async () => { calls.push('stop'); return {ceased: true}; },
    collect: async () => { calls.push('collect'); return {counter: 1, secret: 'SYNTHETIC_PRIVATE_VALUE'}; },
    sanitize: raw => ({counter: raw.counter, secret: '[REDACTED]'}),
    assess: async evidence => {
      calls.push('assess');
      assert.deepEqual(evidence, {counter: 1, secret: '[REDACTED]'});
      assert.equal(JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8')).observations.counter, 1);
      throw Error('SYNTHETIC_PRIVATE_VALUE');
    },
    remove: async () => {
      calls.push('remove');
      const assessment = JSON.parse(await readFile(join(directory, 'assessment.json'), 'utf8'));
      assert.equal(assessment.status, 'failed');
      assert.equal((await readFile(join(directory, 'evidence.json'), 'utf8')).includes('SYNTHETIC_PRIVATE_VALUE'), false);
    },
  });
  assert.deepEqual(calls, ['stop', 'collect', 'assess', 'remove']);
  assert.equal(result.evidence.status, 'preserved');
  assert.equal(result.assessment.status, 'failed');
  assert.equal(result.cleanup.status, 'completed');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'evidence.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_VALUE'), false);
});

test('criteria are independent, and arbitrary assessment text is never persisted', async t => {
  const options = await fixture(t);
  const valid = await finalizeProof(options);
  assert.deepEqual(valid.assessment.criteria, {C12: 'approved', auxiliaryEdit: 'rejected'});
  assert.equal(valid.cleanup.status, 'completed');
  const invalidOptions = await fixture(t, {assess: async () => ({C12: 'PRIVATE_ERROR'})});
  const invalid = await finalizeProof(invalidOptions);
  assert.equal(invalid.assessment.status, 'failed');
  assert.equal((await readFile(join(invalidOptions.directory, 'assessment.json'), 'utf8')).includes('PRIVATE_ERROR'), false);
});

test('assessment must cover exactly the criterion IDs bound to the reviewed plan', async t => {
  for (const criteria of [{C12: 'approved'}, {C12: 'approved', auxiliaryEdit: 'approved', unrelated: 'approved'}]) {
    const result = await finalizeProof(await fixture(t, {assess: async () => criteria}));
    assert.equal(result.assessment.status, 'failed');
  }
  const result = await finalizeProof(await fixture(t, {criterionIds: undefined}));
  assert.equal(result.evidence.status, 'preserved');
  assert.equal(result.assessment.code, 'RUBRIC_NOT_BOUND');
  assert.equal(result.cleanup.status, 'blocked');
});

test('changed evidence blocks destructive cleanup and is no longer claimed as preserved', async t => {
  let removed = false;
  const options = await fixture(t, {remove: async () => { removed = true; }});
  options.assess = async () => {
    await writeFile(join(options.directory, 'evidence.json'), '{}');
    return {C12: 'approved'};
  };
  const result = await finalizeProof(options);
  assert.equal(removed, false);
  assert.equal(result.evidence.status, 'unverified');
  assert.equal(result.cleanup.status, 'blocked');
});

test('deleted evidence also blocks cleanup, and stopping still happens when the output directory is unusable', async t => {
  const options = await fixture(t);
  options.assess = async () => { await rm(join(options.directory, 'evidence.json')); return {C12: 'approved'}; };
  const result = await finalizeProof(options);
  assert.equal(result.evidence.status, 'unverified');
  assert.equal(result.cleanup.status, 'blocked');
  let stopped = false;
  const unavailable = await finalizeProof({...options, stop: async () => { stopped = true; return {ceased: true}; }});
  assert.equal(stopped, true);
  assert.equal(unavailable.evidence.code, 'RUN_DIRECTORY_UNAVAILABLE');
});

test('non-JSON and oversized sanitized observations are blocked without deletion', async t => {
  for (const raw of [{value: NaN}, {value: undefined}, {value: 'x'.repeat(1024 * 1024)}]) {
    const result = await finalizeProof(await fixture(t, {collect: async () => raw}));
    assert.equal(result.evidence.code, 'SANITIZE_FAILED');
    assert.equal(result.cleanup.status, 'blocked');
  }
});

test('unconfirmed cessation preserves observations but blocks assessment and removal', async t => {
  let removed = false, assessed = false;
  const result = await finalizeProof(await fixture(t, {
    stop: async () => ({ceased: false}), assess: async () => { assessed = true; },
    remove: async () => { removed = true; },
  }));
  assert.equal(result.evidence.status, 'preserved');
  assert.equal(result.cleanup.status, 'blocked');
  assert.equal(assessed, false); assert.equal(removed, false);
});

test('cleanup failure is separate from evidence and criteria and contains no callback exception', async t => {
  const result = await finalizeProof(await fixture(t, {remove: async () => { throw Error('PRIVATE_ERROR'); }}));
  assert.equal(result.evidence.status, 'preserved');
  assert.equal(result.assessment.status, 'completed');
  assert.equal(result.cleanup.status, 'failed');
  assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR'), false);
});

test('a cleanup callback that destroys the preserved snapshot cannot report preservation success', async t => {
  const options = await fixture(t);
  options.remove = async () => { await rm(join(options.directory, 'evidence.json')); };
  const result = await finalizeProof(options);
  assert.equal(result.evidence.status, 'unverified');
  assert.equal(result.cleanup.status, 'unknown');
});

test('cleanup cannot silently make a preserved snapshot public', async t => {
  const options = await fixture(t);
  options.remove = async () => { await chmod(join(options.directory, 'evidence.json'), 0o644); };
  const result = await finalizeProof(options);
  assert.equal(result.evidence.status, 'unverified');
  assert.equal(result.cleanup.status, 'unknown');
});

test('collection and sanitization failures remain distinguishable and retain their diagnostic sources', async t => {
  for (const stage of ['collect', 'sanitize']) {
    let removed = false;
    const options = await fixture(t, {[stage]: async () => { throw Error('PRIVATE_ERROR'); }, remove: async () => { removed = true; }});
    const result = await finalizeProof(options);
    assert.equal(result.evidence.code, stage === 'collect' ? 'COLLECT_FAILED' : 'SANITIZE_FAILED');
    assert.equal(result.cleanup.status, 'blocked');
    assert.equal(removed, false);
    assert.equal((await readFile(join(options.directory, 'failure.json'), 'utf8')).includes('PRIVATE_ERROR'), false);
  }
});
