import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfiguration } from '../../src/entrypoints/configuration.js';
import { doctor } from '../../src/entrypoints/doctor.js';
import { createTriageHostProbe, triageSources, type TriageHostProbe } from '../../src/entrypoints/triage-prerequisites.js';
import { productionModelChecks, productionProfile } from '../../src/entrypoints/release.js';

// Spec #68 §2 (ticket #69): config.yaml schema 3 carries the Triage configuration; the host prerequisites decide whether it turns on.
const base = `operators: [operator-one]
githubApp: {appId: 123, privateKeyFile: credentials/app.pem}
sandbox: {schemaVersion: 1, profile: gondolin-qemu-alpine-dev-v1}
repositories:
  - {repository: equipe/checkout-web, base: main, installationId: 456, workflows: false}
  - {repository: equipe/payments-api, base: main, installationId: 456, workflows: false, label: implement-me}
`;
const roles = `  builder: {provider: example, model: builder-model}
  standards: {provider: example, model: standards-model}
  spec: {provider: example, model: spec-model}
`;
const jiraSource = (extra = '') => `  - tracker: jira
    discover: true
    siteId: site-A
    url: https://equipe.atlassian.net
    email: fabrica@example.org
    tokenFile: credentials/jira-token
    projectId: '10010'
    label: factory-ready
    routes:
      - {componentId: '10021', repository: equipe/checkout-web}
${extra}`;
/** A schema 3 document: `triager` is the `models.triager` line, `sources` the `ticketSources` items, `rest` further top-level blocks. */
const v3 = ({
  triager = '  triager: {provider: example, model: triager-model}\n',
  sources = '  - {tracker: github, repository: equipe/payments-api, discover: true}\n',
  rest = '',
} = {}) => `schemaVersion: 3\n${base}models:\n${roles}${triager}ticketSources:\n${sources}${rest}`;
const older = {
  1: `schemaVersion: 1\n${base}models:\n${roles}`,
  2: `schemaVersion: 2\n${base}models:\n${roles}ticketSources:\n  - {tracker: github, repository: equipe/payments-api, discover: true}\n`,
};
const capable: TriageHostProbe = async () => [];

async function read(yaml: string, triageHost: TriageHostProbe = capable) {
  const root = await mkdtemp(join(tmpdir(), 'factory-config-triage-'));
  try {
    await writeFile(join(root, 'config.yaml'), yaml);
    const result = await readConfiguration(root, undefined, { triageHost });
    return { ...result, bytes: await readFile(join(root, 'config.yaml'), 'utf8') };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function effective(yaml: string, triageHost?: TriageHostProbe) {
  const { configuration } = await read(yaml, triageHost);
  assert.equal(configuration.valid, true, JSON.stringify(configuration));
  if (!configuration.valid) throw new Error('unreachable');
  return configuration.effective;
}
const refusedPaths = async (yaml: string) => {
  const { configuration } = await read(yaml);
  assert.equal(configuration.valid, false, 'the configuration is refused');
  return configuration.valid ? [] : configuration.errors.map(error => `${error.code}:${error.path}`);
};

test('schema 3 without a triage block is valid and changes no source: Triage is off', async () => {
  const configuration = await effective(v3());
  assert.equal(configuration.schemaVersion, 3);
  assert.deepEqual(configuration.ticketSources, [{ tracker: 'github', repository: 'equipe/payments-api', discover: true }]);
  assert.deepEqual(configuration.triage, { status: 'off' });
  assert.deepEqual(triageSources(configuration), []);
});

test('`triage: {}` on a source turns Triage on there with the four default label names', async () => {
  const configuration = await effective(
    v3({
      sources: `  - {tracker: github, repository: equipe/payments-api, discover: true, triage: {}}
  - {tracker: github, repository: equipe/checkout-web, discover: true}
${jiraSource('    triage: {needsTriage: triar, wontfix: recusado}\n')}`,
    }),
  );
  assert.deepEqual(configuration.triage, { status: 'on' });
  assert.deepEqual(
    configuration.ticketSources.map(source => source.triage ?? null),
    [
      { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix' },
      null,
      { needsTriage: 'triar', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'recusado' },
    ],
  );
  assert.deepEqual(
    triageSources(configuration).map(source => source.tracker),
    ['github', 'jira'],
  );
});

test('the ready-for-agent role is never configured apart and no triage label repeats another role of the source', async () => {
  const source = (triage: string) => v3({ sources: `  - {tracker: github, repository: equipe/payments-api, discover: true, triage: ${triage}}\n` });
  assert.deepEqual(await refusedPaths(source('{readyForAgent: ready-for-agent}')), ['CONFIGURATION_INVALID:ticketSources.0.triage']);
  assert.deepEqual(await refusedPaths(source('{needsInfo: Needs-Triage}')), ['CONFIGURATION_INVALID:ticketSources.0.triage']);
  // The admission label of the destination (`repositories[].label`, here `implement-me`) is the ready-for-agent role of this source.
  assert.deepEqual(await refusedPaths(source('{wontfix: implement-me}')), ['CONFIGURATION_INVALID:ticketSources.0.triage']);
  assert.deepEqual(await refusedPaths(v3({ sources: jiraSource('    triage: {readyForHuman: factory-ready}\n') })), [
    'CONFIGURATION_INVALID:ticketSources.0.triage',
  ]);
  assert.deepEqual(await refusedPaths(v3({ sources: jiraSource('    triage: {needsInfo: "two words"}\n') })), [
    'CONFIGURATION_INVALID:ticketSources.0.triage.needsInfo',
  ]);
});

test('the installation `triager` block has the spec defaults and accepts each limit', async () => {
  assert.deepEqual((await effective(v3())).triager, {
    capacity: 1,
    investigationMinutes: 15,
    attempts: 2,
    environment: { memoryGiB: 2, processes: 512, commandSeconds: 120 },
    mcpProfiles: [],
  });
  const configured = await effective(
    v3({ rest: 'triager: {capacity: 3, investigationMinutes: 20, attempts: 1, environment: {memoryGiB: 4, commandSeconds: 60}}\n' }),
  );
  assert.deepEqual(configured.triager, {
    capacity: 3,
    investigationMinutes: 20,
    attempts: 1,
    environment: { memoryGiB: 4, processes: 512, commandSeconds: 60 },
    mcpProfiles: [],
  });
  for (const block of ['{capacity: 0}', '{attempts: 0}', '{investigationMinutes: 1.5}', '{environment: {processes: 0}}', '{slots: 2}'])
    assert.equal((await read(v3({ rest: `triager: ${block}\n` }))).configuration.valid, false, block);
});

test('TR-38: models.triager defaults thinkingLevel to max; `off` and an absent models.triager are refused', async () => {
  assert.deepEqual((await effective(v3())).models.triager, { provider: 'example', model: 'triager-model', thinkingLevel: 'max' });
  const configured = await effective(v3({ triager: '  triager: {provider: example, model: triager-model, thinkingLevel: high}\n' }));
  assert.equal(configured.models.triager?.thinkingLevel, 'high');
  assert.deepEqual(await refusedPaths(v3({ triager: '  triager: {provider: example, model: triager-model, thinkingLevel: off}\n' })), [
    'CONFIGURATION_INVALID:models.triager.thinkingLevel',
  ]);
  assert.deepEqual(await refusedPaths(v3({ triager: '' })), ['CONFIGURATION_INVALID:models.triager']);
});

test('models.triager is the release profile like every other role', () => {
  const supported = { provider: productionProfile.model.providerId, model: productionProfile.model.modelId };
  const models = { builder: supported, standards: supported, spec: supported };
  assert.deepEqual(
    productionModelChecks(models).map(check => check.id),
    ['worker-profile:builder', 'worker-profile:standards', 'worker-profile:spec'],
  );
  assert.deepEqual(
    productionModelChecks({ ...models, triager: { provider: 'example', model: 'other' } }).map(check => [check.id, check.status]),
    [
      ['worker-profile:builder', 'ok'],
      ['worker-profile:standards', 'ok'],
      ['worker-profile:spec', 'ok'],
      ['worker-profile:triager', 'blocked'],
    ],
  );
});

const mcp = `mcpServers:
  - {id: observabilidade, url: https://mcp.example.org/observabilidade, tokenFile: credentials/observabilidade-token}
  - {id: interno, url: http://mcp.internal:8080/mcp}
mcpProfiles:
  - {id: investigar-erros, server: observabilidade, tools: [buscar_erros, consultar_trace]}
  - {id: tudo, server: interno, tools: all}
`;

test('MCP servers and MCP Profiles are registered by id; only the profiles `triager.mcpProfiles` names are active', async () => {
  const registered = await effective(v3({ rest: mcp }));
  assert.deepEqual(registered.mcpServers, [
    { id: 'observabilidade', url: 'https://mcp.example.org/observabilidade', tokenFile: 'credentials/observabilidade-token' },
    { id: 'interno', url: 'http://mcp.internal:8080/mcp' },
  ]);
  assert.deepEqual(registered.mcpProfiles, [
    { id: 'investigar-erros', server: 'observabilidade', tools: ['buscar_erros', 'consultar_trace'] },
    { id: 'tudo', server: 'interno', tools: 'all' },
  ]);
  assert.deepEqual(registered.triager.mcpProfiles, [], 'registering activates nothing');
  assert.deepEqual((await effective(v3({ rest: `${mcp}triager: {mcpProfiles: [investigar-erros]}\n` }))).triager.mcpProfiles, ['investigar-erros']);
});

test('TR-34: a profile of an unknown server, an unknown active profile, stdio and legacy SSE are configuration errors', async () => {
  const refused = async (rest: string) => (await read(v3({ rest }))).configuration.valid;
  assert.deepEqual(await refusedPaths(v3({ rest: 'mcpProfiles:\n  - {id: p, server: ausente, tools: all}\n' })), [
    'CONFIGURATION_INVALID:mcpProfiles.0.server',
  ]);
  assert.deepEqual(await refusedPaths(v3({ rest: `${mcp}triager: {mcpProfiles: [ausente]}\n` })), ['CONFIGURATION_INVALID:triager.mcpProfiles.0']);
  for (const server of [
    '{id: s, command: npx, args: [server]}',
    '{id: s, url: https://mcp.example.org/x, command: npx}',
    '{id: s, url: https://mcp.example.org/sse, transport: sse}',
    '{id: s, url: https://mcp.example.org/x, type: stdio}',
    '{id: s, url: "stdio://server"}',
    '{id: s, url: "https://user:secret@mcp.example.org/x"}',
  ])
    assert.equal(await refused(`mcpServers:\n  - ${server}\n`), false, server);
  assert.equal(await refused(`${mcp}  - {id: tudo, server: interno, tools: all}\n`), false, 'profile ids are unique');
  assert.equal(await refused('mcpServers:\n  - {id: s, url: https://a.example/x}\n  - {id: s, url: https://b.example/x}\n'), false, 'server ids are unique');
  assert.equal(
    await refused('mcpServers:\n  - {id: s, url: https://a.example/x}\nmcpProfiles:\n  - {id: p, server: s, tools: []}\n'),
    false,
    'no empty selection',
  );
});

test('`factory doctor` checks the token file of a registered MCP server as a credential reference, without reading it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-triage-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  await writeFile(join(root, 'config.yaml'), v3({ rest: mcp }), { mode: 0o600 });
  const check = async () => (await doctor(root, { triageHost: capable })).checks.filter(item => item.id.startsWith('credential-file:mcpServers.'));
  // Only the server that names a token file is checked; the file does not exist yet.
  assert.deepEqual(
    (await check()).map(item => [item.id, item.status]),
    [['credential-file:mcpServers.observabilidade', 'blocked']],
  );
  await mkdir(join(root, 'credentials'), { mode: 0o700 });
  await writeFile(join(root, 'credentials', 'observabilidade-token'), 'x', { mode: 0o644 });
  assert.equal((await check())[0]?.status, 'blocked', 'a token file others can read is refused');
  await chmod(join(root, 'credentials', 'observabilidade-token'), 0o600);
  assert.equal((await check())[0]?.status, 'ok');
});

test('TR-55: a schema 1 or 2 config.yaml stays valid under this release with Triage off, and is never edited', async () => {
  for (const version of [1, 2] as const) {
    let probed = false;
    const result = await read(older[version], async () => {
      probed = true;
      return ['bwrap'];
    });
    assert.equal(result.configuration.valid, true, JSON.stringify(result.configuration));
    if (!result.configuration.valid) return;
    const configuration = result.configuration.effective;
    assert.equal(configuration.schemaVersion, version);
    assert.deepEqual(configuration.triage, { status: 'off' });
    assert.deepEqual(triageSources(configuration), []);
    assert.equal(
      configuration.ticketSources.some(source => source.triage !== undefined),
      false,
    );
    assert.equal(configuration.models.triager, undefined);
    assert.deepEqual([configuration.mcpServers, configuration.mcpProfiles, configuration.triager.mcpProfiles], [[], [], []]);
    assert.equal(probed, false, 'a host that cannot triage is not even diagnosed when no source asks for Triage');
    assert.equal(
      result.checks.some(check => check.id.startsWith('triage')),
      false,
    );
    assert.equal(result.bytes, older[version], 'config.yaml is byte for byte what the operator wrote');
  }
});

test('TR-55: the Triage sections are refused in a schema 1 or 2 config.yaml (adopting them is adopting schema 3)', async () => {
  const withTriage = '  - {tracker: github, repository: equipe/payments-api, discover: true, triage: {}}\n';
  assert.equal(
    (await read(older[2].replace('  - {tracker: github, repository: equipe/payments-api, discover: true}\n', withTriage))).configuration.valid,
    false,
  );
  for (const section of ['triager: {capacity: 1}\n', 'mcpServers: []\n', 'mcpProfiles: []\n'])
    for (const version of [1, 2] as const) assert.equal((await read(`${older[version]}${section}`)).configuration.valid, false, `${version}: ${section}`);
  assert.equal((await read(older[1].replace(roles, `${roles}  triager: {provider: example, model: triager-model}\n`))).configuration.valid, false);
});

const triaged = v3({ sources: '  - {tracker: github, repository: equipe/payments-api, discover: true, triage: {}}\n' });

/** A private PATH holding only the named executables, each a script that answers any invocation with `exit`. */
async function privatePath(t: { after(fn: () => Promise<void>): void }, tools: Record<string, number>) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-triage-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, exit] of Object.entries(tools)) {
    await writeFile(join(directory, name), `#!/bin/sh\nexit ${exit}\n`);
    await chmod(join(directory, name), 0o700);
  }
  return createTriageHostProbe({ environment: { PATH: directory } });
}
const everyTool = { bwrap: 0, systemctl: 0, git: 0, rg: 0 };

test('TR-29: with every prerequisite on the private PATH the triage block turns on', async t => {
  const result = await read(triaged, await privatePath(t, everyTool));
  assert.equal(result.configuration.valid, true, JSON.stringify(result.configuration));
  if (!result.configuration.valid) return;
  assert.deepEqual(result.configuration.effective.triage, { status: 'on' });
  assert.equal(triageSources(result.configuration.effective).length, 1);
  assert.equal(result.checks.find(check => check.id === 'triage:prerequisites')?.status, 'ok');
});

test('TR-29: without bwrap, user systemd, git or rg the triage block does not turn on and the diagnostic names what is missing', async t => {
  for (const [absent, named] of [
    ['bwrap', 'bwrap'],
    ['systemctl', 'systemd-user'],
    ['git', 'git'],
    ['rg', 'rg'],
  ] as const) {
    const { [absent]: _absent, ...present } = everyTool;
    const result = await read(triaged, await privatePath(t, present));
    // The installation stays valid: Works are admitted as before; only Triage stays off.
    assert.equal(result.configuration.valid, true, JSON.stringify(result.configuration));
    if (!result.configuration.valid) return;
    assert.deepEqual(result.configuration.effective.triage, { status: 'unavailable', missing: [named] }, absent);
    assert.deepEqual(triageSources(result.configuration.effective), [], `${absent}: no source starts a Triage`);
    assert.notEqual(result.configuration.effective.ticketSources[0]!.triage, undefined, 'the configured block stays readable');
    const check = result.checks.find(item => item.id === 'triage:prerequisites');
    assert.equal(check?.status, 'blocked', absent);
    assert.match(check!.message, new RegExp(`Triage is off.*\\b${named}\\b`), absent);
  }
});

test('TR-29: a user systemd that does not answer and namespaces bwrap cannot create are named too', async t => {
  const noSystemd = await read(triaged, await privatePath(t, { ...everyTool, systemctl: 1 }));
  assert.deepEqual(noSystemd.configuration.valid && noSystemd.configuration.effective.triage, { status: 'unavailable', missing: ['systemd-user'] });
  // The fake bwrap answers `--version` and every confinement with the same exit: here it runs, but cannot confine.
  const directory = await mkdtemp(join(tmpdir(), 'factory-triage-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['systemctl', 'git', 'rg']) await writeFile(join(directory, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(directory, 'bwrap'), '#!/bin/sh\n[ "$1" = --version ] && exit 0\nexit 1\n', { mode: 0o700 });
  const noNamespaces = await read(triaged, createTriageHostProbe({ environment: { PATH: directory } }));
  assert.deepEqual(noNamespaces.configuration.valid && noNamespaces.configuration.effective.triage, {
    status: 'unavailable',
    missing: ['unprivileged-namespaces'],
  });
  const everything = await read(triaged, createTriageHostProbe({ environment: { PATH: join(directory, 'absent') } }));
  assert.deepEqual(everything.configuration.valid && everything.configuration.effective.triage, {
    status: 'unavailable',
    missing: ['bwrap', 'systemd-user', 'git', 'rg'],
  });
});

test('TR-29: a host that is not Linux never turns Triage on', async () => {
  const probe = createTriageHostProbe({ platform: 'darwin', environment: { PATH: '/nonexistent' } });
  assert.deepEqual((await probe()).slice(0, 1), ['linux']);
});

test('TR-29: `factory doctor` reports the missing prerequisite and writes nothing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-triage-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.yaml'), triaged, { mode: 0o600 });
  const report = await doctor(root, { triageHost: async () => ['systemd-user', 'rg'] });
  assert.equal(report.configuration.valid, true);
  assert.deepEqual(report.configuration.valid && report.configuration.effective.triage, { status: 'unavailable', missing: ['systemd-user', 'rg'] });
  const check = report.checks.find(item => item.id === 'triage:prerequisites');
  assert.deepEqual([check?.status, report.code], ['blocked', 'PREREQUISITES_MISSING']);
  assert.match(check!.message, /lacks systemd-user, rg\b/);
  assert.deepEqual(await readdir(root), ['config.yaml']);
});
