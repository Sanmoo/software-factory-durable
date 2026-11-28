// Unit layer: when the stop of an Investigation Environment attempt is confirmed. Pure rule, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopConfirmation, type StopFacts } from '../../src/sandbox/investigation/stop-rules.js';

const record = { attempt: 'tr-7-1', unit: 'factory-triage-tr-7-1.service', hostBoot: 'boot-a', invocation: 'a'.repeat(32) };
const cgroup = '/user.slice/user-1000.slice/user@1000.service/app.slice/factory-triage-tr-7-1.service';
const inactive: StopFacts = {
  hostBoot: 'boot-a',
  expectedCgroup: cgroup,
  manager: { activeState: 'inactive', invocation: 'a'.repeat(32), controlGroup: '' },
  cgroup: 'absent',
};

test('the stop is confirmed by an inactive unit of the same invocation with an empty cgroup', () => {
  assert.deepEqual(stopConfirmation(record, inactive), { cessationConfirmed: true, evidence: 'unit-inactive' });
  assert.deepEqual(stopConfirmation(record, { ...inactive, cgroup: 'empty' }), { cessationConfirmed: true, evidence: 'unit-inactive' });
  assert.deepEqual(stopConfirmation(record, { ...inactive, manager: { activeState: 'failed', invocation: 'a'.repeat(32), controlGroup: cgroup } }), {
    cessationConfirmed: true,
    evidence: 'unit-inactive',
  });
});

test('a unit the manager already collected (no invocation left) confirms with an empty cgroup', () => {
  assert.deepEqual(stopConfirmation(record, { ...inactive, manager: { activeState: 'inactive', invocation: '', controlGroup: '' } }), {
    cessationConfirmed: true,
    evidence: 'unit-inactive',
  });
});

test('a different Host boot confirms the stop without asking the manager', () => {
  assert.deepEqual(stopConfirmation(record, { ...inactive, hostBoot: 'boot-b', manager: 'unavailable', cgroup: 'unreadable' }), {
    cessationConfirmed: true,
    evidence: 'host-rebooted',
  });
});

test('an unanswering systemd does not confirm, whatever the cgroup shows', () => {
  assert.deepEqual(stopConfirmation(record, { ...inactive, manager: 'unavailable' }), {
    cessationConfirmed: false,
    code: 'INVESTIGATION_MANAGER_UNAVAILABLE',
  });
});

test('a divergent InvocationID does not confirm, active or inactive', () => {
  for (const activeState of ['inactive', 'failed', 'active'])
    assert.deepEqual(stopConfirmation(record, { ...inactive, manager: { activeState, invocation: 'b'.repeat(32), controlGroup: '' } }), {
      cessationConfirmed: false,
      code: 'INVESTIGATION_INVOCATION_MISMATCH',
    });
});

test('an active, activating or deactivating unit does not confirm', () => {
  for (const activeState of ['active', 'activating', 'deactivating', 'reloading', ''])
    assert.deepEqual(stopConfirmation(record, { ...inactive, manager: { activeState, invocation: 'a'.repeat(32), controlGroup: cgroup } }), {
      cessationConfirmed: false,
      code: 'INVESTIGATION_UNIT_ACTIVE',
    });
});

test('an inactive unit whose cgroup still has processes, or cannot be read, does not confirm', () => {
  assert.deepEqual(stopConfirmation(record, { ...inactive, cgroup: 'populated' }), { cessationConfirmed: false, code: 'INVESTIGATION_CGROUP_POPULATED' });
  assert.deepEqual(stopConfirmation(record, { ...inactive, cgroup: 'unreadable' }), { cessationConfirmed: false, code: 'INVESTIGATION_CGROUP_UNREADABLE' });
});

test('a unit reported under another cgroup is not the recorded attempt', () => {
  assert.deepEqual(stopConfirmation(record, { ...inactive, manager: { activeState: 'inactive', invocation: 'a'.repeat(32), controlGroup: '/elsewhere' } }), {
    cessationConfirmed: false,
    code: 'INVESTIGATION_INVOCATION_MISMATCH',
  });
});

test('a start whose invocation was never recorded confirms only by inactivity and an empty cgroup', () => {
  const intent = { attempt: record.attempt, unit: record.unit, hostBoot: record.hostBoot };
  assert.deepEqual(stopConfirmation(intent, { ...inactive, manager: { activeState: 'inactive', invocation: '', controlGroup: '' } }), {
    cessationConfirmed: true,
    evidence: 'unit-inactive',
  });
  assert.deepEqual(stopConfirmation(intent, { ...inactive, manager: { activeState: 'active', invocation: 'c'.repeat(32), controlGroup: cgroup } }), {
    cessationConfirmed: false,
    code: 'INVESTIGATION_UNIT_ACTIVE',
  });
});
