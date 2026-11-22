import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideFormat, migrationPath, migrationPathId, supportedMigrations } from '../../src/control/durable/format.js';

// Pure rules of the storage format decision and the migration path (Jira ticket 02). The real storages are in storage-format*.test.ts.
const v1 = { 'factory.request': { 1: 3 }, 'factory.ticket-index': { 1: 1 }, 'factory.work': { 1: 2 }, 'factory.slots': { 1: 1 }, 'factory.question': { 1: 1 } };

test('the installation version names the format; every other kind must belong to it at its exact version', () => {
  assert.deepEqual(decideFormat(2, { 'factory.installation': { 2: 1 }, ...v1 }), { format: 2, problems: [] });
  assert.deepEqual(decideFormat(3, { 'factory.installation': { 3: 1 }, ...v1 }), { format: 3, problems: [] });
  assert.deepEqual(decideFormat(1, { 'factory.installation': { 1: 1 }, ...v1 }), { format: 1, problems: [] });
  assert.deepEqual(decideFormat(null, {}), { format: null, problems: [] });
  assert.deepEqual(
    decideFormat(9, { 'factory.installation': { 9: 1 } }),
    { format: null, problems: [] },
    'an unknown version is reported per document, not as a format',
  );
  // Unknown kinds are not this rule's business (STORAGE_DOCUMENT_UNKNOWN is reported per document).
  assert.deepEqual(decideFormat(3, { 'factory.installation': { 3: 1 }, 'factory.future': { 1: 1 } }), { format: 3, problems: [] });
});

test('mixed: a kind only a newer format defines, or a version of another format, inside an older format', () => {
  const table = { 2: { 'factory.installation': 2, 'factory.work': 1 }, 3: { 'factory.installation': 3, 'factory.work': 2, 'factory.jira-effect': 1 } };
  assert.deepEqual(decideFormat(2, { 'factory.installation': { 2: 1 }, 'factory.work': { 1: 2 }, 'factory.jira-effect': { 1: 1 } }, table).problems, [
    { code: 'STORAGE_FORMAT_MIXED', detail: 'factory.jira-effect is not part of format 2.' },
  ]);
  assert.deepEqual(
    decideFormat(3, { 'factory.installation': { 3: 1 }, 'factory.work': { 1: 1, 2: 1 } }, table).problems,
    [{ code: 'STORAGE_FORMAT_MIXED', detail: 'factory.work version 1 does not belong to format 3.' }],
    'a family partly converted is mixed',
  );
});

test('the migration path is the explicit chain of supported steps: 2→3, and 1→2 then 2→3; nothing is skipped or reversed', () => {
  assert.deepEqual(
    supportedMigrations.map(item => [item.id, item.from, item.to]),
    [
      ['factory-storage-1-to-2', 1, 2],
      ['factory-storage-2-to-3', 2, 3],
    ],
  );
  assert.deepEqual(
    migrationPath(2, 3)?.map(item => item.id),
    ['factory-storage-2-to-3'],
  );
  assert.deepEqual(
    migrationPath(1, 3)?.map(item => item.id),
    ['factory-storage-1-to-2', 'factory-storage-2-to-3'],
  );
  assert.deepEqual(
    migrationPath(1, 2)?.map(item => item.id),
    ['factory-storage-1-to-2'],
  );
  assert.equal(migrationPath(3, 3), null);
  assert.equal(migrationPath(3, 2), null, 'no reverse migration');
  assert.equal(migrationPath(0, 3), null);
  assert.equal(migrationPath(1, 3, [{ id: 'only-2-to-3', from: 2, to: 3 }]), null, 'a missing step is never skipped');
  assert.equal(migrationPathId(migrationPath(1, 3)!), 'factory-storage-1-to-2,factory-storage-2-to-3');
});

test('the release manifest declares exactly the migrations and the document matrix Control enforces', async () => {
  const { controlStorageCompatibility } = await import('../../src/contracts/index.js');
  assert.deepEqual([controlStorageCompatibility.format, [...controlStorageCompatibility.migratesFrom]], [3, [1, 2]]);
  assert.deepEqual(
    [...controlStorageCompatibility.migrations],
    supportedMigrations.map(item => item.id),
  );
  const v3 = Object.fromEntries(Object.entries(controlStorageCompatibility.documents).map(([kind, version]) => [kind, { [version]: 1 }]));
  assert.deepEqual(decideFormat(3, v3), { format: 3, problems: [] });
  assert.equal(controlStorageCompatibility.documents['factory.installation'], 3);
});
