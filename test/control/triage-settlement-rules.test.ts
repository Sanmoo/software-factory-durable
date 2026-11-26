import assert from 'node:assert/strict';
import { test } from 'node:test';
import { triageSettlement, triageUnsettled } from '../../src/control/rules/triage-settlement.js';

// Spec #68 §11 (ticket #82): what an upgrade reads of the Triage requests of a storage, from metadata only. Pure rule.
const confirmed = { end: { cessation: { cessationConfirmed: true } } };
const stopUnconfirmed = { end: { cessation: { cessationConfirmed: false } } };
const open = { end: null };

test('TR-53: an investigation under way, an unconfirmed stop and a retained unit are unsettled; a queue and a pending publication are not', () => {
  const settlement = triageSettlement([
    { state: 'queued' },
    { state: 'queued', attempts: [{ attempt: 't2-1', ...confirmed }] },
    { state: 'suspended' },
    { state: 'publishing', attempts: [{ attempt: 't4-1', ...confirmed }] },
    { state: 'concluded', attempts: [{ attempt: 't5-1', ...confirmed }] },
    {
      state: 'investigating',
      attempts: [
        { attempt: 't6-1', ...confirmed },
        { attempt: 't6-2', ...open },
      ],
    },
    // The stop of its attempt was never confirmed: the request is back in the queue and its next session cannot start.
    { state: 'queued', attempts: [{ attempt: 't7-1', ...stopUnconfirmed }] },
    // Terminal requests whose attempt still holds its unit of Triage capacity.
    { state: 'failed', attempts: [{ attempt: 't8-1', ...stopUnconfirmed }] },
    { state: 'abandoned', attempts: [{ attempt: 't9-1', ...open }] },
  ]);
  assert.deepEqual(settlement, {
    requests: { queued: 2, suspended: 1, investigating: 2, stopUnconfirmed: 2, publishing: 1, ended: 1 },
    capacity: { investigating: 2, retained: 2 },
    unsettled: ['t6-2', 't7-1', 't8-1', 't9-1'],
  });
});

test('TR-53: a storage without Triage requests, or with settled ones only, has nothing unsettled', () => {
  assert.deepEqual(triageSettlement([]), {
    requests: { queued: 0, suspended: 0, investigating: 0, stopUnconfirmed: 0, publishing: 0, ended: 0 },
    capacity: { investigating: 0, retained: 0 },
    unsettled: [],
  });
  assert.deepEqual(triageSettlement([{ state: 'failed', attempts: [{ attempt: 't1-1', ...confirmed }] }]).unsettled, []);
});

test('TR-53: a request recorded as investigating with no open attempt is still an investigation under way', () => {
  const settlement = triageSettlement([{ state: 'investigating' }]);
  assert.deepEqual([settlement.requests.investigating, settlement.unsettled, triageUnsettled(settlement)], [1, [], true]);
});
