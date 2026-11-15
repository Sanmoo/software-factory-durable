import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keySource, phaseGuard, requireKeySource, verdict } from './mergeblock39-qualification.js';
import { interpretBaseRules } from '../../src/control/index.js';

// Recipe safety on controlled data only (never the real root, never a real gh). The GET-only gh wrapper is ticket 15's (checks15-recipe-safety).
const ruleset = { id: 26435808, sourceType: 'Repository', source: 'Sanmoo/java-springboot-event-sourcing' };
const rules = (types: string[]) => types.map(type => ({ type, ruleset, ...(type === 'update' ? { parameters: { kind: 'update' as const, updateAllowsFetchAndMerge: false } } : {}) }));

test('phase guard: evaluate only after a SUCCESSFUL preflight; each phase once', () => {
  assert.equal(phaseGuard('preflight', {}, new Set()), null);
  assert.equal(phaseGuard('preflight', {}, new Set(['preflight-intent'])), 'PHASE_ALREADY_RAN');
  assert.equal(phaseGuard('evaluate', {}, new Set(['preflight-intent'])), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('evaluate', { preflight: { status: 'held' } }, new Set(['preflight-intent'])), 'PREFLIGHT_SUCCESS_REQUIRED');
  assert.equal(phaseGuard('evaluate', { preflight: { status: 'success' } }, new Set(['preflight-intent'])), null);
  assert.equal(phaseGuard('evaluate', { preflight: { status: 'success' } }, new Set(['preflight-intent', 'evaluate-intent'])), 'PHASE_ALREADY_RAN');
});

test('verdict: success only when ruleset 26435808 has every expected rule and update is interpreted as merge-blocking', () => {
  const real = rules(['pull_request', 'non_fast_forward', 'deletion', 'update']);
  assert.deepEqual(verdict(real, interpretBaseRules(real)), { status: 'success', reasons: [] });
  const withoutUpdate = rules(['pull_request', 'non_fast_forward', 'deletion']);
  assert.deepEqual(verdict(withoutUpdate, interpretBaseRules(withoutUpdate)), { status: 'held', reasons: ['RULE_ABSENT:update'] }, 'update not re-enabled: held, not success');
  const asBefore = interpretBaseRules(real).map(item => item.type === 'update' ? { ...item, merge: 'not-blocking' as const } : item);
  assert.deepEqual(verdict(real, asBefore), { status: 'held', reasons: ['UNEXPECTED_INTERPRETATION:update:not-blocking'] }, 'the 15/16 interpretation would be held');
});

test('a missing App key source fails loudly with its path before any effect', async () => {
  const asked: string[] = [];
  await assert.rejects(requireKeySource(async path => { asked.push(path); throw new Error('ENOENT'); }),
    (error: Error) => error.message.startsWith('APP_KEY_SOURCE_MISSING: /home/sanmoo/software-factory-test/y5/credentials/app.pem is absent') && /nothing was created/.test(error.message));
  assert.deepEqual(asked, [keySource]);
  await requireKeySource(async () => undefined);
});
