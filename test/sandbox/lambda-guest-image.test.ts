import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestPinSha256, lambdaGuestPin, lambdaImageKey, lambdaImageName, renderGuestImage } from '../../src/sandbox/lambda/guest-image.js';
import { storedZip } from '../../src/sandbox/lambda/zip.js';

// v2 ticket 03 (V2-27): the fixed MicroVM image recipe, mounted by the host from validated values only. Pure; nothing is built here.
const declaration = { schemaVersion: 1 as const, apk: [{ name: 'openjdk21-jdk', version: '21.0.13.1_p2-r0' }, { name: 'maven', version: '3.9.11-r0' }],
  images: [{ reference: 'docker.io/testcontainers/ryuk@sha256:' + 'a'.repeat(64) }] };
const apk = 'apk add --no-cache --repositories-file /dev/null --repository https://dl-cdn.alpinelinux.org/alpine/v3.23/main --repository https://dl-cdn.alpinelinux.org/alpine/v3.23/community';
const file = (rendered: ReturnType<typeof renderGuestImage>, name: string) => {
  assert.equal(rendered.ok, true);
  return rendered.ok ? rendered.files.find(entry => entry.name === name)!.content : '';
};

test('the Dockerfile starts from the pinned Alpine, installs the template and the declared packages at exact versions and unlocks the user account', () => {
  const rendered = renderGuestImage(declaration);
  assert.deepEqual(file(rendered, 'Dockerfile').split('\n'), [
    'FROM public.ecr.aws/docker/library/alpine@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2',
    `RUN ${apk} 'docker=29.5.2-r0' 'docker-cli-compose=2.40.3-r6' 'docker-cli-buildx=0.30.1-r6' 'openssh=10.2_p1-r1' 'git=2.52.1-r0' 'python3=3.12.16-r0' 'bash=5.3.3-r1' 'websocat=1.14.0-r1' 'iptables=1.8.11-r1' 'curl=8.23.0-r0' 'github-cli=2.83.0-r0'`,
    `RUN ${apk} 'openjdk21-jdk=21.0.13.1_p2-r0' 'maven=3.9.11-r0'`,
    "RUN adduser -D -s /bin/bash builder && sed -i 's/^builder:!/builder:*/' /etc/shadow && addgroup builder docker && mkdir -p /workspace /artifacts /etc/ssh/authorized && chown builder:builder /workspace /artifacts",
    "RUN adduser -D -s /bin/bash reviewer && sed -i 's/^reviewer:!/reviewer:*/' /etc/shadow",
    'COPY hook-agent.py start.sh sshd_config declared-images /opt/factory/',
    'CMD ["python3", "-u", "/opt/factory/hook-agent.py"]',
    '']);
});

test('declared Docker images are a data file read at boot, never embedded in the image', () => {
  const rendered = renderGuestImage(declaration);
  assert.equal(file(rendered, 'declared-images'), `${declaration.images[0]!.reference}\n`);
  assert.doesNotMatch(file(rendered, 'Dockerfile'), /ryuk|docker pull|docker load/);
  assert.match(file(rendered, 'start.sh'), /docker pull "\$reference"/);
  assert.deepEqual(rendered.ok && rendered.files.map(entry => entry.name), ['Dockerfile', 'declared-images', 'hook-agent.py', 'sshd_config', 'start.sh']);
});

test('a declaration without packages has no second install step', () => {
  const lines = file(renderGuestImage({ schemaVersion: 1, apk: [] }), 'Dockerfile').split('\n');
  assert.equal(lines.filter(line => line.startsWith('RUN apk add')).length, 1);
  assert.equal(file(renderGuestImage({ schemaVersion: 1, apk: [] }), 'declared-images'), '');
});

test('no free text of the repository reaches the Dockerfile: anything outside the closed schema is refused before rendering', () => {
  for (const hostile of [
    { schemaVersion: 1, apk: [{ name: 'curl && rm -rf /', version: '8.23.0-r0' }] },
    { schemaVersion: 1, apk: [{ name: 'maven', version: "3.9.11-r0' && wget evil" }] },
    { schemaVersion: 1, apk: [{ name: 'maven', version: '3.9.11-r0\nRUN id' }] },
    { schemaVersion: 1, apk: [{ name: 'maven', version: '>=3' }] },
    { schemaVersion: 1, apk: [], images: [{ reference: 'docker.io/a/b@sha256:' + 'a'.repeat(64) + '\nRUN id' }] },
    { schemaVersion: 1, apk: [], run: ['id'] },
    null,
  ]) {
    const rendered = renderGuestImage(hostile);
    assert.equal(rendered.ok, false, JSON.stringify(hostile));
    assert.ok(!rendered.ok && rendered.errors.length > 0);
  }
});

test('the start hook brings up sshd and dockerd; none of them is started at build time', () => {
  const rendered = renderGuestImage(declaration);
  const start = file(rendered, 'start.sh');
  assert.match(start, /ssh-keygen -q -t ed25519/);
  assert.match(start, /\/usr\/sbin\/sshd -f \/opt\/factory\/sshd_config/);
  assert.match(start, /dockerd/);
  assert.doesNotMatch(file(rendered, 'Dockerfile'), /dockerd|sshd -|ssh-keygen/);
  assert.match(file(rendered, 'sshd_config'), /^AllowUsers builder reviewer$/m);
  assert.match(file(rendered, 'sshd_config'), /^PasswordAuthentication no$/m);
});

test('the template packages are pinned to exact Alpine versions in the release pin', () => {
  assert.deepEqual(lambdaGuestPin.packages.map(entry => entry.name), ['docker', 'docker-cli-compose', 'docker-cli-buildx', 'openssh', 'git', 'python3', 'bash', 'websocat', 'iptables', 'curl', 'github-cli']);
  for (const entry of lambdaGuestPin.packages) assert.match(entry.version, /^[0-9][0-9a-z._]*-r[0-9]+$/, entry.name);
});

const profile = { installation: 'acme', architecture: 'arm64' as const, baselineMemoryMiB: 1024, additionalOsCapabilities: ['ALL'] };
const keyOf = (change: Partial<Parameters<typeof lambdaImageKey>[0]> = {}) => lambdaImageKey({ repositoryId: 42, declarationSha256: 'd'.repeat(64), profile, ...change });

test('the image key is (repository, declaration hash, release pin): the same inputs give the same key, any change gives a new one', () => {
  assert.match(keyOf(), /^[a-f0-9]{64}$/);
  assert.equal(keyOf(), keyOf());
  assert.notEqual(keyOf({ repositoryId: 43 }), keyOf());
  assert.notEqual(keyOf({ declarationSha256: 'e'.repeat(64) }), keyOf());
  assert.notEqual(keyOf({ pinSha256: 'f'.repeat(64) }), keyOf());
  assert.equal(keyOf({ pinSha256: guestPinSha256() }), keyOf());
  // The size and architecture are properties of the image, so they are part of what the image is built for.
  assert.notEqual(keyOf({ profile: { ...profile, baselineMemoryMiB: 2048 } }), keyOf());
  assert.notEqual(keyOf({ profile: { ...profile, architecture: 'x86_64' } }), keyOf());
});

test('the release pin hash covers the template packages and the fixed guest files', () => {
  assert.match(guestPinSha256(), /^[a-f0-9]{64}$/);
  assert.notEqual(guestPinSha256({ ...lambdaGuestPin, packages: [{ name: 'docker', version: '29.5.3-r0' }] }), guestPinSha256());
  assert.notEqual(guestPinSha256(lambdaGuestPin, { 'start.sh': '#!/bin/bash\n' }), guestPinSha256());
});

test('images are named under the installation prefix the operation role is scoped to', () => {
  assert.equal(lambdaImageName('acme', 'ab'.repeat(32)), `factory-acme-${'ab'.repeat(16)}`);
});

test('the build artifact is a zip with the Dockerfile at its root, byte-identical for the same files', () => {
  const files = [{ name: 'Dockerfile', content: 'FROM scratch\n' }, { name: 'start.sh', content: '#!/bin/bash\n' }];
  const zip = storedZip(files);
  assert.deepEqual(Buffer.from(storedZip(files)), Buffer.from(zip));
  // Independent reading of the archive: end-of-central-directory record, then each central entry and its stored bytes.
  const view = Buffer.from(zip);
  const end = view.length - 22;
  assert.equal(view.readUInt32LE(end), 0x06054b50);
  assert.equal(view.readUInt16LE(end + 10), 2);
  let offset = view.readUInt32LE(end + 16);
  const read: { name: string; content: string; crc: number }[] = [];
  for (let index = 0; index < 2; index++) {
    assert.equal(view.readUInt32LE(offset), 0x02014b50);
    assert.equal(view.readUInt16LE(offset + 10), 0, 'stored');
    const crc = view.readUInt32LE(offset + 16), size = view.readUInt32LE(offset + 24), nameLength = view.readUInt16LE(offset + 28), local = view.readUInt32LE(offset + 42);
    const name = view.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.equal(view.readUInt32LE(local), 0x04034b50);
    const data = local + 30 + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28);
    read.push({ name, content: view.subarray(data, data + size).toString('utf8'), crc });
    offset += 46 + nameLength + view.readUInt16LE(offset + 30) + view.readUInt16LE(offset + 32);
  }
  // CRC-32 of 'FROM scratch\n' computed with `python3 -c "import zlib;print(hex(zlib.crc32(b'FROM scratch\n')))"`.
  assert.deepEqual(read.map(entry => [entry.name, entry.content]), [['Dockerfile', 'FROM scratch\n'], ['start.sh', '#!/bin/bash\n']]);
  assert.equal(read[0]!.crc, 0xf75d57c2);
});

test('the guest listens only for the lifecycle hooks, sshd on loopback and the WebSocket carrying it: there is no diagnostics port', () => {
  const rendered = renderGuestImage(declaration);
  const everything = ['hook-agent.py', 'start.sh', 'sshd_config', 'Dockerfile'].map(name => file(rendered, name)).join('\n');
  // Every listener of the guest files, by the forms they use to open one.
  const listeners = [...everything.matchAll(/ws-l:([0-9.]+:[0-9]+)|ThreadingHTTPServer\(\("([0-9.]+)", ([0-9]+)\)|^ListenAddress ([0-9.]+)\n|^Port ([0-9]+)$/gm)]
    .map(match => match[1] ?? (match[2] ? `${match[2]}:${match[3]}` : match[4] ?? `port ${match[5]}`)).sort();
  assert.deepEqual(listeners, ['0.0.0.0:8022', '0.0.0.0:9000', '127.0.0.1', 'port 22']);
  // Nothing publishes the Docker daemon over TCP either.
  assert.doesNotMatch(everything, /EXPOSE|-H tcp:|tcp:\/\/0\.0\.0\.0/);
});
