import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfiguration } from '../../src/entrypoints/configuration.js';
import { composeProductionAccess, type JiraSiteAccess } from '../../src/entrypoints/controller/composition.js';
import type { GitHubAccess } from '../../src/platform/github/index.js';
import type { JiraRequest } from '../../src/issue-tracker/index.js';

// Jira ticket 01 (spec §1, §7 "Coexistência"): v1 composes GitHub only, never opening a Jira credential nor creating a Jira client; v2
// composes the Jira adapter beside it, selected by the Ticket's origin, with discovery of new Jira Tickets as configured (ticket 10).
const sentinel = 'SYNTHETIC-JIRA-TOKEN-0f6c';
const header = `operators: [operator-one]
models:
  builder: {provider: example, model: builder-model}
  standards: {provider: example, model: standards-model}
  spec: {provider: example, model: spec-model}
githubApp: {appId: 123, privateKeyFile: credentials/app.pem}
sandbox: {schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}
repositories:
  - {repository: equipe/checkout-web, base: main, installationId: 456, workflows: false}
  - {repository: equipe/payments-api, base: main, installationId: 456, workflows: false}
`;
const v1 = `schemaVersion: 1\n${header}`;
const v2 = `schemaVersion: 2\n${header}ticketSources:
  - {tracker: github, repository: equipe/payments-api, discover: true}
  - tracker: jira
    discover: true
    siteId: site-A
    url: https://equipe.atlassian.net
    email: fabrica@example.org
    tokenFile: credentials/jira-token
    projectId: '10010'
    label: factory-ready
    routes:
      - {componentId: '10022', repository: equipe/payments-api}
`;

/** GitHub boundary that records every call and answers each read as unavailable (nothing reaches the network). */
function recordingGitHub() {
  const calls: string[] = [];
  const github = new Proxy({ appId: 123 } as unknown as GitHubAccess, {
    get(target, property) {
      if (property === 'appId') return 123;
      if (property === 'then') return undefined;
      return async (...args: unknown[]) => {
        calls.push(`${String(property)}:${JSON.stringify((args[0] as { repository?: string } | undefined)?.repository ?? null)}`);
        return { ok: false, observedAt: new Date().toISOString(), code: 'GITHUB_TRANSPORT_UNAVAILABLE', nextStep: 'synthetic' };
      };
    },
  });
  return { github, calls };
}

async function installation(yaml: string) {
  const root = await mkdtemp(join(tmpdir(), 'factory-composition-sources-'));
  await chmod(root, 0o700);
  await mkdir(join(root, 'credentials'), { mode: 0o700 });
  await writeFile(join(root, 'credentials', 'jira-token'), `${sentinel}\n`, { mode: 0o600 });
  await writeFile(join(root, 'config.yaml'), yaml);
  const configuration = (await readConfiguration(root)).configuration;
  assert.equal(configuration.valid, true, JSON.stringify(configuration));
  if (!configuration.valid) throw new Error('unreachable');
  return { root, effective: configuration.effective };
}

function recordingJira() {
  const sites: JiraSiteAccess[] = [];
  const requests: { siteId: string; request: JiraRequest; credential: string }[] = [];
  return {
    sites,
    requests,
    transport: (site: JiraSiteAccess) => {
      sites.push(site);
      return {
        request: async (request: JiraRequest) => {
          requests.push({ siteId: site.siteId, request, credential: await site.credential() });
          return { ok: false as const, code: 'SYNTHETIC_UNAVAILABLE', observedAt: new Date().toISOString(), nextStep: 'synthetic' };
        },
      };
    },
  };
}

const githubTicket = {
  tracker: 'github' as const,
  repository: 'equipe/payments-api',
  repositoryId: 73,
  issueId: 9001,
  nodeId: 'I_1',
  number: 1,
  url: 'https://github.com/equipe/payments-api/issues/1',
};
const jiraTicket = { tracker: 'jira' as const, siteId: 'site-A', issueId: '81017', key: 'PAG-42', url: 'https://equipe.atlassian.net/browse/PAG-42' };

test('YAML v1 composes GitHub only: GitHub calls are recorded, no Jira client is created and no Jira credential is read', async () => {
  const { root, effective } = await installation(v1);
  try {
    const { github, calls } = recordingGitHub();
    const jira = recordingJira();
    const access = composeProductionAccess({ root, github, effective, jira: { transport: jira.transport } });
    assert.equal(access.trackers?.jira, undefined);
    assert.deepEqual(access.sources, [
      { tracker: 'github', repository: 'equipe/checkout-web', discover: true },
      { tracker: 'github', repository: 'equipe/payments-api', discover: true },
    ]);
    const observation = await access.tracker.readTicket(githubTicket);
    assert.equal(observation.kind, 'unavailable');
    assert.deepEqual(calls, ['read:"equipe/payments-api"'], 'the GitHub read went through the GitHub boundary');
    assert.deepEqual(jira.sites, []);
    assert.deepEqual(jira.requests, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('YAML v2 composes the Jira adapter beside GitHub, reads the token only on a Jira request and composes Jira discovery as configured', async () => {
  const { root, effective } = await installation(v2);
  try {
    const { github, calls } = recordingGitHub();
    const jira = recordingJira();
    const access = composeProductionAccess({ root, github, effective, jira: { transport: jira.transport } });
    assert.deepEqual(
      access.sources,
      [
        { tracker: 'github', repository: 'equipe/payments-api', discover: true },
        {
          tracker: 'jira',
          siteId: 'site-A',
          url: 'https://equipe.atlassian.net',
          projectId: '10010',
          label: 'factory-ready',
          discover: true,
          routes: [{ componentId: '10022', repository: 'equipe/payments-api' }],
          linkTypes: [],
        },
      ],
      'Jira discovery is composed as configured (ticket 10)',
    );
    assert.deepEqual(
      access.repositories.map(item => item.repository),
      ['equipe/checkout-web', 'equipe/payments-api'],
      'destinations are unchanged',
    );
    assert.ok(access.trackers?.jira);
    assert.equal(jira.sites.length, 0, 'no Jira client before a Jira request');

    // The origin selects the adapter: a Jira Ticket goes to the Jira transport only; a GitHub Ticket to GitHub only.
    await access.trackers.jira.readTicket(jiraTicket);
    assert.deepEqual(
      jira.sites.map(site => [site.siteId, site.url, site.email]),
      [['site-A', 'https://equipe.atlassian.net', 'fabrica@example.org']],
    );
    assert.deepEqual(
      jira.requests.map(item => [item.siteId, item.request.method, item.request.path]),
      [['site-A', 'GET', '/rest/api/3/issue/81017']],
    );
    assert.equal(jira.requests[0]?.credential, sentinel, 'positive control: the host reads the configured token file on a Jira request');
    assert.deepEqual(calls, []);
    await access.tracker.readTicket(githubTicket);
    assert.equal(jira.requests.length, 1);
    assert.deepEqual(calls, ['read:"equipe/payments-api"']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the Jira token file is refused when it is not a private regular file of this user', async () => {
  const { root, effective } = await installation(v2);
  try {
    await chmod(join(root, 'credentials', 'jira-token'), 0o644);
    const jira = recordingJira();
    const access = composeProductionAccess({ root, github: recordingGitHub().github, effective, jira: { transport: jira.transport } });
    await assert.rejects(access.trackers!.jira!.readTicket(jiraTicket), /UNSAFE_CREDENTIAL_FILE/);
    assert.deepEqual(jira.requests, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
