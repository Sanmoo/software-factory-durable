import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { composeOpinion } from '../../src/workers/review.js';
import { reviewVerdictFormat } from '../../src/contracts/index.js';

// Rules over the reviewer's FINAL message. Fixtures are the two real final assistant texts of the q12-review-v2 run (no secrets).
const input = (role: 'spec' | 'standards', finalText: string) => composeOpinion({ role, invocationId: `${role}-x`, status: 'completed', finalText, sessionFile: null,
  review: { round: 1, attempt: 1, handoffIndexSha256: 'e'.repeat(64), required: [], missing: [] }, model: { providerId: 'openai', modelId: 'gpt-6-luna' },
  profile: { id: 'p', modelBudget: 'reviewer-v1' }, host: { reads: 3, failedReads: [], requiredNotFullyRead: [] } });
const clean = { role: 'spec', conclusion: 'clean', coverage: { scope: 'broad', justification: 'j', examined: ['/workspace/checkout/a.md'] }, findings: [], limitations: [] };

test('real-run q12-review-v2 fix: the Spec final message (one fenced json block, checkout-relative examined path) now parses; the Standards prose+block stays invalid', async () => {
  const spec = input('spec', await readFile('test/workers/fixtures/real-run-q12v2-spec-final.txt', 'utf8'));
  assert.deepEqual([spec.conclusion, spec.code], ['clean', null]);
  assert.deepEqual(spec.coverage!.examined, ['/workspace/checkout/docs/factory-smoke.md'], 'relative paths are read as checkout paths');
  const standards = input('standards', await readFile('test/workers/fixtures/real-run-q12v2-standards-final.txt', 'utf8'));
  assert.deepEqual([standards.conclusion, standards.code, standards.findings], ['failure', 'REVIEW_VERDICT_INVALID', []], 'prose around the verdict is never accepted');
});

test('verdict format: a bare object or exactly one fenced block is the whole message; anything else is invalid, never extracted from prose', () => {
  const json = JSON.stringify(clean);
  for (const ok of [json, `  ${json}\n`, '```json\n' + json + '\n```', '\n```\n' + JSON.stringify(clean, null, 2) + '\n```\n']) assert.equal(input('spec', ok).conclusion, 'clean', ok);
  for (const bad of ['All good, no findings.', `Verdict: ${json}`, `${json}\nDone.`, '```json\n' + json + '\n```\nThanks', '```json\n' + json + '\n```\n```json\n' + json + '\n```',
    '```json\n{"role":"spec"}\n```', '```json\n' + JSON.stringify({ ...clean, coverage: { ...clean.coverage, examined: ['../etc/passwd'] } }) + '\n```']) {
    assert.deepEqual([input('spec', bad).conclusion, input('spec', bad).code], ['failure', 'REVIEW_VERDICT_INVALID'], bad);
  }
});

test('reviewer prompt contract: the final message must be ONLY the verdict object, with clean and findings examples', () => {
  assert.match(reviewVerdictFormat, /Your FINAL message must be ONLY the JSON verdict object/);
  assert.match(reviewVerdictFormat, /no prose before or after/);
  const examples = [...reviewVerdictFormat.matchAll(/Example \((clean|with findings)\): (\{.*?\})(?= Example| Paths|$)/g)];
  assert.deepEqual(examples.map(match => match[1]), ['clean', 'with findings']);
  for (const [, , example] of examples) assert.equal(input(JSON.parse(example!).role, example!).code, null, 'the examples themselves parse');
});
