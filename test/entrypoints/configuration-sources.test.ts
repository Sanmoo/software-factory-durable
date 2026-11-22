import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfiguration } from '../../src/entrypoints/configuration.js';

// Jira ticket 01 (spec §1): YAML v1 keeps its meaning; v2 separates Ticket sources from executable destinations.
const common = `operators: [operator-one]
models:
  builder: {provider: example, model: builder-model}
  standards: {provider: example, model: standards-model}
  spec: {provider: example, model: spec-model}
githubApp: {appId: 123, privateKeyFile: credentials/app.pem}
sandbox: {schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}
repositories:
  - {repository: equipe/checkout-web, base: main, installationId: 456, workflows: false}
  - {repository: equipe/payments-api, base: main, installationId: 456, workflows: false, label: implement-me}
dependencyRepositories:
  - {repository: equipe/shared-docs, installationId: 456}
`;
const v1 = `schemaVersion: 1\n${common}`;
const jira = `  - tracker: jira
    discover: true
    siteId: site-A
    url: https://equipe.atlassian.net
    email: fabrica@example.org
    tokenFile: credentials/jira-token
    projectId: '10010'
    label: factory-ready
    routes:
      - {componentId: '10021', repository: equipe/checkout-web}
      - {componentId: '10022', repository: equipe/payments-api}
`;
const v2 = `schemaVersion: 2\n${common}ticketSources:\n  - {tracker: github, repository: equipe/payments-api, discover: true}\n${jira}`;

async function read(yaml: string) {
  const root = await mkdtemp(join(tmpdir(), 'factory-config-sources-'));
  try {
    await writeFile(join(root, 'config.yaml'), yaml);
    return (await readConfiguration(root)).configuration;
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('YAML v1 keeps every executable repository as a GitHub Ticket source with its own label', async () => {
  const configuration = await read(v1);
  assert.equal(configuration.valid, true);
  if (!configuration.valid) return;
  assert.equal(configuration.effective.schemaVersion, 1);
  assert.deepEqual(configuration.effective.repositories.map(item => [item.repository, item.label]),
    [['equipe/checkout-web', 'ready-for-agent'], ['equipe/payments-api', 'implement-me']]);
  assert.deepEqual(configuration.effective.ticketSources, [
    { tracker: 'github', repository: 'equipe/checkout-web', discover: true },
    { tracker: 'github', repository: 'equipe/payments-api', discover: true }]);
});

test('YAML v1 refuses a ticketSources section (only v2 separates sources)', async () => {
  const configuration = await read(`${v1}ticketSources: []\n`);
  assert.equal(configuration.valid, false);
});

test('YAML v2 keeps sources and destinations independent', async () => {
  const configuration = await read(v2);
  assert.equal(configuration.valid, true, JSON.stringify(configuration));
  if (!configuration.valid) return;
  assert.equal(configuration.effective.schemaVersion, 2);
  assert.deepEqual(configuration.effective.repositories.map(item => item.repository), ['equipe/checkout-web', 'equipe/payments-api']);
  assert.deepEqual(configuration.effective.ticketSources, [
    { tracker: 'github', repository: 'equipe/payments-api', discover: true },
    { tracker: 'jira', discover: true, siteId: 'site-A', url: 'https://equipe.atlassian.net', email: 'fabrica@example.org', tokenFile: 'credentials/jira-token',
      projectId: '10010', label: 'factory-ready', routes: [{ componentId: '10021', repository: 'equipe/checkout-web' }, { componentId: '10022', repository: 'equipe/payments-api' }] }]);
});

test('YAML v2 refuses routes, IDs, origins and secrets it cannot trust, naming the path and echoing nothing', async () => {
  const cases: [string, string, string][] = [
    ['route to an unknown repository', v2.replace('repository: equipe/checkout-web}', 'repository: equipe/unknown}'), 'ticketSources.1.routes.0.repository'],
    ['route to a dependency-only repository', v2.replace('repository: equipe/checkout-web}', 'repository: equipe/shared-docs}'), 'ticketSources.1.routes.0.repository'],
    ['GitHub source on an unknown repository', v2.replace('{tracker: github, repository: equipe/payments-api', '{tracker: github, repository: equipe/unknown'), 'ticketSources.0.repository'],
    ['GitHub source on a dependency-only repository', v2.replace('{tracker: github, repository: equipe/payments-api', '{tracker: github, repository: equipe/shared-docs'), 'ticketSources.0.repository'],
    ['duplicate GitHub source', v2.replace('ticketSources:\n', 'ticketSources:\n  - {tracker: github, repository: EQUIPE/PAYMENTS-API, discover: false}\n'), 'ticketSources'],
    ['plain HTTP origin', v2.replace('https://equipe.atlassian.net', 'http://equipe.atlassian.net'), 'ticketSources.1.url'],
    ['origin with a path', v2.replace('https://equipe.atlassian.net', 'https://equipe.atlassian.net/jira'), 'ticketSources.1.url'],
    ['origin with a query', v2.replace('https://equipe.atlassian.net', 'https://equipe.atlassian.net?x=1'), 'ticketSources.1.url'],
    ['origin with credentials', v2.replace('https://equipe.atlassian.net', 'https://user:pw@equipe.atlassian.net'), 'ticketSources.1.url'],
    ['non-numeric project ID', v2.replace("projectId: '10010'", 'projectId: PAG'), 'ticketSources.1.projectId'],
    ['numeric (not string) project ID', v2.replace("projectId: '10010'", 'projectId: 10010'), 'ticketSources.1.projectId'],
    ['non-numeric component ID', v2.replace("componentId: '10021'", 'componentId: Checkout'), 'ticketSources.1.routes.0.componentId'],
    ['duplicate component', v2.replace("componentId: '10022'", "componentId: '10021'"), 'ticketSources.1.routes'],
    ['token file outside credentials/', v2.replace('tokenFile: credentials/jira-token', 'tokenFile: /etc/jira-token'), 'ticketSources.1.tokenFile'],
    ['token value instead of file', v2.replace('tokenFile: credentials/jira-token', 'tokenFile: ATATT3xFfGF0SYNTHETIC_SECRET'), 'ticketSources.1.tokenFile'],
    ['inline token', v2.replace('    label: factory-ready\n', '    label: factory-ready\n    token: ATATT3xFfGF0SYNTHETIC_SECRET\n'), 'ticketSources.1'],
    ['invalid e-mail', v2.replace('email: fabrica@example.org', 'email: fabrica'), 'ticketSources.1.email'],
    ['site with two origins', v2.replace(jira, jira + jira.replace("projectId: '10010'", "projectId: '10011'").replace('https://equipe.atlassian.net', 'https://other.atlassian.net')), 'ticketSources'],
    ['same project twice', v2.replace(jira, jira + jira), 'ticketSources'],
    ['Jira source without routes', v2.replace(/ {4}routes:\n(?: {6}- .*\n)+/, '    routes: []\n'), 'ticketSources.1.routes'],
    ['label on a GitHub source (the v2 repository keeps its label)', v2.replace('{tracker: github, repository: equipe/payments-api, discover: true}',
      '{tracker: github, repository: equipe/payments-api, discover: true, label: other}'), 'ticketSources.0'],
    ['ticketSources missing', v2.slice(0, v2.indexOf('ticketSources:')), 'ticketSources'],
  ];
  for (const [name, yaml, path] of cases) {
    assert.notEqual(yaml, v2, name);
    const configuration = await read(yaml);
    assert.equal(configuration.valid, false, name);
    if (configuration.valid) continue;
    assert.ok(configuration.errors.some(error => error.code === 'CONFIGURATION_INVALID' && error.path === path),
      `${name}: expected ${path} in ${JSON.stringify(configuration.errors)}`);
    assert.doesNotMatch(JSON.stringify(configuration), /SYNTHETIC_SECRET/, name);
  }
});

test('YAML v2 accepts sources with discovery off', async () => {
  const configuration = await read(v2.replace('    discover: true\n', '    discover: false\n')
    .replace('{tracker: github, repository: equipe/payments-api, discover: true}', '{tracker: github, repository: equipe/payments-api, discover: false}'));
  assert.equal(configuration.valid, true, JSON.stringify(configuration));
  if (!configuration.valid) return;
  assert.deepEqual(configuration.effective.ticketSources.map(source => [source.tracker, source.discover]), [['github', false], ['jira', false]]);
});
