import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionRefusal, receiptEffects, releaseObservation } from '../../src/control/rules/triage-intervention.js';
import { holdsTriageCapacity, triageImpediments, triageStarts } from '../../src/control/rules/triage.js';
import { triageSettlement, triageUnsettled } from '../../src/control/rules/triage-settlement.js';
import type { PublicationStep } from '../../src/control/rules/triage-publication.js';
import type { TriageIntendedEffect } from '../../src/control/rules/triage-verdict.js';

// Spec #68 §10 (ticket #81): the pure rules of `triage cancel | release | complete`.
const at = '2026-01-01T00:00:00.000Z';
const unconfirmed = { at, code: 'TRIAGER_INTERRUPTED', cessation: { cessationConfirmed: false, code: 'INVESTIGATION_MANAGER_UNAVAILABLE' } };
const attestation = { author: 'local-operator', reason: 'the host was rebuilt', at, observed: 'INVESTIGATION_MANAGER_UNAVAILABLE', request_id: 'r' };

test('TR-49: `triage release` never frees a unit against evidence of life, and takes the attestation only when nothing can be observed', () => {
  assert.equal(releaseObservation({ cessationConfirmed: true }), 'confirmed');
  assert.equal(releaseObservation({ cessationConfirmed: false, code: 'INVESTIGATION_UNIT_ACTIVE' }), 'alive');
  assert.equal(releaseObservation({ cessationConfirmed: false, code: 'INVESTIGATION_CGROUP_POPULATED' }), 'alive');
  for (const code of ['INVESTIGATION_MANAGER_UNAVAILABLE', 'INVESTIGATION_CGROUP_UNREADABLE', 'INVESTIGATION_INVOCATION_MISMATCH'])
    assert.equal(releaseObservation({ cessationConfirmed: false, code }), 'unobservable', code);
});

test('TR-49: an attested attempt holds no Triage capacity, is no Impediment, lets its request start again and no longer blocks an upgrade', () => {
  const retained = { attempt: 't1-1', end: unconfirmed };
  const attested = { attempt: 't1-1', end: { ...unconfirmed, attestation } };
  assert.equal(holdsTriageCapacity(retained), true);
  assert.equal(holdsTriageCapacity(attested), false);
  assert.equal(holdsTriageCapacity({ end: null }), true, 'an open attempt holds its unit');
  assert.equal(triageImpediments({ triage_request_id: 'r1', attempts: [retained] }).length, 1);
  assert.deepEqual(triageImpediments({ triage_request_id: 'r1', attempts: [attested] }), []);
  assert.deepEqual(triageStarts({ capacity: 1, held: 0, queue: [{ triage_request_id: 'r1', attempts: [retained] }] }), []);
  assert.deepEqual(triageStarts({ capacity: 1, held: 0, queue: [{ triage_request_id: 'r1', attempts: [attested] }] }), ['r1']);
  assert.equal(triageUnsettled(triageSettlement([{ state: 'abandoned', attempts: [retained] }])), true);
  assert.equal(triageUnsettled(triageSettlement([{ state: 'abandoned', attempts: [attested] }])), false);
});

const effects: TriageIntendedEffect[] = [
  { kind: 'comment', status: 'confirmed', attempts: 1, attemptedAt: at, settledAt: at, reference: 'https://tracker.example/c/1' },
  { kind: 'add-label', label: 'needs-info', status: 'ambiguous-authorship', attempts: 1, attemptedAt: at },
  { kind: 'remove-label', label: 'needs-triage', status: 'pending' },
];
test('TR-48: the receipt of a cancellation lists the effects a read confirmed as published and every other one as discarded', () => {
  assert.deepEqual(receiptEffects(effects), {
    published: [{ index: 0, kind: 'comment', status: 'confirmed', attempted: true, reference: 'https://tracker.example/c/1' }],
    discarded: [
      { index: 1, kind: 'add-label', label: 'needs-info', status: 'ambiguous-authorship', attempted: true },
      { index: 2, kind: 'remove-label', label: 'needs-triage', status: 'pending', attempted: false },
    ],
  });
});

const owned = effects.map(effect => (effect.status === 'ambiguous-authorship' ? { ...effect, status: 'confirmed' as const } : effect));
const discarding = (code: string) => owned.map(effect => (effect.status === 'pending' ? { ...effect, status: 'no-longer-allowed' as const, code } : effect));
const ending = (code: string, to: 'abandoned' | 'concluded' = 'abandoned', after = discarding(code)): PublicationStep => ({
  effects: after,
  mode: 'verdict',
  next: { action: 'end', to, code },
});
const there = { open: true, hasWork: false };
test('TR-50: `triage complete` goes on, accepts a Ticket that closed or got a Work, and is refused when another change would discard an effect', () => {
  assert.equal(completionRefusal(effects, { effects: owned, mode: 'verdict', next: { action: 'write', mode: 'verdict', group: [2] } }, there), null);
  assert.equal(completionRefusal(effects, ending('VERDICT_PUBLISHED', 'concluded', owned), there), null);
  assert.equal(completionRefusal(effects, ending('TICKET_CLOSED'), { open: false, hasWork: false }), null);
  assert.equal(completionRefusal(effects, ending('WORK_EXISTS'), { open: true, hasWork: true }), null);
  // A Work exists only after somebody withdrew needs-triage: the publication names that change first, and the command is still accepted.
  assert.equal(completionRefusal(effects, ending('NEEDS_TRIAGE_REMOVED'), { open: true, hasWork: true }), null);
  assert.equal(completionRefusal(effects, ending('TRIAGE_LABELS_CHANGED'), there), 'TRIAGE_LABELS_CHANGED');
  assert.equal(completionRefusal(effects, ending('NEEDS_TRIAGE_REMOVED'), there), 'NEEDS_TRIAGE_REMOVED');
  assert.equal(completionRefusal(effects, { effects: owned, mode: null, next: { action: 'suspend', labels: ['wontfix'] } }, there), 'TRIAGE_LABEL_CONFLICT');
  // An informative publication whose only comment was the ambiguous effect: it ends `abandoned` as designed, discarding nothing new.
  const informative = discarding('NEEDS_TRIAGE_REMOVED').map((effect, index) =>
    index === 0 ? { ...effect, status: 'ambiguous-authorship' as const } : effect,
  );
  const done = informative.map(effect => (effect.status === 'ambiguous-authorship' ? { ...effect, status: 'confirmed' as const } : effect));
  const end: PublicationStep = { effects: done, mode: 'informative', next: { action: 'end', to: 'abandoned', code: 'NEEDS_TRIAGE_REMOVED' } };
  assert.equal(completionRefusal(informative, end, there), null);
});
