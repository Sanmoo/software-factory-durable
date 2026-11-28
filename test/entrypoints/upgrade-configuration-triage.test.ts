import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { upgrade } from '../../src/entrypoints/controller/upgrade.js';
import { storageWithPendingQuestion } from '../control/upgrade-fixture.js';
import { configuration, installation } from './upgrade-fixture.js';

// The real upgrade logic against an installation root with synthetic release trees and a real Control
// storage. A release that knows Triage keeps validating the config.yaml the operator already has; only adopting schema 3 is a change.
const configurationTwo = configuration.replace('schemaVersion: 1', 'schemaVersion: 2') + 'ticketSources: []\n';
const configurationThree =
  configuration.replace('schemaVersion: 1', 'schemaVersion: 3').replace('  spec:', '  triager: { provider: openai, model: gpt-6-luna }\n  spec:') +
  'ticketSources: []\n';

async function upgraded(t: { after(fn: () => Promise<void>): void }, yaml: string) {
  const fixture = await installation({ previousStorage: true, previousConfigurationSchema: [1, 2], configuration: yaml });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await storageWithPendingQuestion(fixture.context.storagePath);
  await chmod(fixture.context.storagePath, 0o600);
  const applied = await upgrade(fixture.context, 'apply');
  return { ...fixture, applied, yaml: () => readFile(join(fixture.root, 'config.yaml'), 'utf8') };
}

test('upgrade apply accepts a schema 1 or 2 config.yaml as it is and never edits it', async t => {
  for (const yaml of [configuration, configurationTwo]) {
    const fixture = await upgraded(t, yaml);
    assert.equal(fixture.applied.code, 'UPGRADE_COMPLETED');
    assert.equal(fixture.applied.checks.find(item => item.id === 'upgrade:configuration')?.status, 'ok');
    assert.equal(await fixture.yaml(), yaml, 'config.yaml is byte for byte what the operator wrote');
    // The old schema is still what the previous release validates: the configuration check keeps the rollback open.
    assert.equal((await upgrade(fixture.context, 'rollback')).code, 'UPGRADE_ROLLED_BACK');
    assert.equal(await fixture.yaml(), yaml);
  }
});

test('adopting schema 3 closes the rollback by the existing configuration check, without rewriting config.yaml', async t => {
  const fixture = await upgraded(t, configurationThree);
  assert.equal(fixture.applied.code, 'UPGRADE_COMPLETED');
  const refused = await upgrade(fixture.context, 'rollback');
  assert.equal(refused.code, 'ROLLBACK_CONFIGURATION_INCOMPATIBLE');
  assert.match(refused.checks.find(item => item.id === 'rollback:configuration')!.message, /schema version 3; release mvp-32\.1 validates only 1, 2/);
  assert.equal(await fixture.yaml(), configurationThree);
});
