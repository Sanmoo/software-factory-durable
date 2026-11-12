#!/bin/sh
# GUEST ONLY. Stage in this Work's /workspace and invoke via approved executeTool.
# No installation, pull, boot or host execution is authorized by this fixture.
set -efu
case "$(pwd -P)" in /workspace/*) ;; *) echo '06: run from staged guest workspace' >&2; exit 1;; esac
case "${FACTORY_06_IMAGE:-}" in *@sha256:*) ;; *) echo '06: digest-pinned Node Alpine image required' >&2; exit 1;; esac
case "${RYUK_CONTAINER_IMAGE:-}" in *@sha256:*) ;; *) echo '06: digest-pinned Ryuk image required' >&2; exit 1;; esac
test "${TESTCONTAINERS_RYUK_DISABLED:-false}" = false
test "${NODE_TLS_REJECT_UNAUTHORIZED:-1}" = 1
test "${DOCKER_HOST:-unix:///run/docker.sock}" = unix:///run/docker.sock
test "$(docker info --format '{{.Driver}}')" = vfs
test "$(docker info --format '{{.DockerRootDir}}')" = /var/lib/docker
test -r tls/ca.pem
test -r tls/server.pem
test -r tls/server-key.pem
test -r https-server.mjs
# CA/server material must be prepared inside this guest under the closed grant.
# SANs: localhost and fixture-service. Never use a personal CA or host key.
openssl verify -CAfile tls/ca.pem tls/server.pem
node --input-type=module <<'JAVASCRIPT'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { GenericContainer, Network, Wait } from 'testcontainers';

const fixture = process.cwd();
const image = process.env.FACTORY_06_IMAGE;
assert.match(image, /@sha256:[0-9a-f]{64}$/);
assert.match(process.env.RYUK_CONTAINER_IMAGE, /@sha256:[0-9a-f]{64}$/);
// Use normal Testcontainers networking, discovery and Ryuk. No host-network,
// mapped-port override, privileged container or alternate Docker socket fallback.
const network = await new Network().start();
console.log('06 owned network', network.getId());
let server;
let client;
try {
  server = await new GenericContainer(image)
    .withNetwork(network)
    .withNetworkAliases('fixture-service')
    .withBindMounts([{ source: fixture, target: '/fixture', mode: 'ro' }])
    .withCommand(['node', '/fixture/https-server.mjs'])
    .withExposedPorts(8443)
    .withWaitStrategy(Wait.forLogMessage('06 HTTPS ready'))
    .start();
  console.log('06 owned server', server.getId(), server.getHost(), server.getMappedPort(8443));
  const ca = await readFile('tls/ca.pem');
  const body = await new Promise((resolve, reject) => {
    const request = https.get({ hostname: server.getHost(), port: server.getMappedPort(8443),
      servername: 'localhost', ca, rejectUnauthorized: true, timeout: 10000 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('06 HTTPS status')); return; }
      let bytes = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { bytes += chunk; if (bytes.length > 128) response.destroy(new Error('06 oversized reply')); });
      response.on('error', reject);
      response.on('end', () => resolve(bytes));
    });
    request.on('timeout', () => request.destroy(new Error('06 HTTPS timeout')));
    request.on('error', reject);
  });
  assert.equal(body, 'factory06 verified TLS\n');
  // An application in a second real container must resolve the network alias
  // and validate TLS using its own Node trust configuration, not the run wrapper.
  client = await new GenericContainer(image)
    .withNetwork(network)
    .withBindMounts([{ source: fixture + '/tls/ca.pem', target: '/fixture-ca.pem', mode: 'ro' }])
    .withEnvironment({ NODE_EXTRA_CA_CERTS: '/fixture-ca.pem' })
    .withCommand(['node', '-e', `require('node:https').get('https://fixture-service:8443', r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => {
        if (r.statusCode !== 200 || b !== 'factory06 verified TLS\\n') process.exit(1);
        console.log('06 container TLS verified');
        setInterval(() => {}, 1000); // Stay owned/running until explicit stop below.
      });
    }).on('error', e => { console.error(e.message); process.exit(1); });`])
    .withWaitStrategy(Wait.forLogMessage('06 container TLS verified'))
    .start();
  console.log('06 owned client', client.getId());
  console.log('06 representative Testcontainers/binds/DNS/ports/application-TLS assertions passed; not pilot acceptance');
} finally {
  // Attempt all owned cleanup; do not let one failure hide other resources.
  const results = await Promise.allSettled([client?.stop(), server?.stop()]);
  const networkResult = await Promise.allSettled([network.stop()]);
  if ([...results, ...networkResult].some(result => result.status === 'rejected')) {
    throw new Error('06 owned cleanup incomplete; preserve identities and reconcile, never prune globally');
  }
}
JAVASCRIPT
