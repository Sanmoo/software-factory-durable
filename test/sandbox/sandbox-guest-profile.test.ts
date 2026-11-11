import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = join(process.cwd(), 'src/sandbox/guest-profile');
const recipe = JSON.parse(readFileSync(join(directory, 'alpine-docker-vfs.json'), 'utf8'));
const daemon = JSON.parse(readFileSync(join(directory, 'docker-daemon.json'), 'utf8'));
const hook = readFileSync(join(directory, 'alpine-docker-vfs.sh'), 'utf8');

test('guest recipe uses one explicit ISO kernel/module cohort without a second kernel package', () => {
  assert.equal(recipe.arch, 'x86_64');
  assert.equal(recipe.distro, 'alpine');
  assert.equal(recipe.alpine.version, '3.23.7');
  assert.equal(recipe.alpine.branch, 'v3.23');
  assert.equal(recipe.alpine.mirror, 'https://dl-cdn.alpinelinux.org/alpine');
  assert.ok(recipe.alpine.rootfsPackages.includes('docker'));
  assert.equal(recipe.alpine.rootfsPackages.some((name: string) => name.startsWith('linux-')), false);
  assert.deepEqual(recipe.alpine.initramfsPackages, []);
  assert.equal(recipe.oci, undefined);
  assert.equal(recipe.container, undefined);
  assert.equal(recipe.postBuild.commands, undefined);
  assert.deepEqual(recipe.postBuild.copy, [
    { src: '/home/sanmoo/software-factory-test/assets29/iso-boot/vmlinuz-virt', dest: '/boot/vmlinuz-virt' },
    { src: '/home/sanmoo/software-factory-test/assets29/cohort/6.18.58-0-virt', dest: '/lib/modules/6.18.58-0-virt' },
    { src: 'docker-daemon.json', dest: '/etc/docker/daemon.json' },
  ]);
  for (const name of ['sandboxd', 'sandboxfs', 'sandboxssh', 'sandboxingress']) {
    assert.equal(recipe[name + 'Path'], '/home/sanmoo/software-factory-test/assets29/helpers/' + name);
  }
});

test('Docker-vfs profile uses guest cgroupfs and a guest-local Unix socket only', () => {
  assert.equal(daemon['storage-driver'], 'vfs');
  assert.deepEqual(daemon.features, { 'containerd-snapshotter': false });
  assert.deepEqual(daemon['exec-opts'], ['native.cgroupdriver=cgroupfs']);
  assert.deepEqual(daemon.hosts, ['unix:///run/docker.sock']);
  assert.equal(daemon.group, 'root');
  assert.equal(daemon.bridge, 'none');
  for (const name of ['iptables', 'ip6tables', 'ip-forward', 'ip-masq', 'userland-proxy']) {
    assert.equal(daemon[name], false);
  }
});

test('guest-only hook has bounded readiness and is syntax-checked, never executed on host', () => {
  assert.equal(recipe.init.rootfsInitExtra, 'alpine-docker-vfs.sh');
  assert.match(hook, /mount -t cgroup2 cgroup2 \/sys\/fs\/cgroup/);
  assert.match(hook, /test -r \/sys\/fs\/cgroup\/cgroup.controllers/);
  assert.equal(hook.match(/^dockerd /gm)?.length, 1);
  assert.match(hook, /timeout 10 \/bin\/sh -c/);
  assert.match(hook, /docker info --format "{{.Driver}}"/);
  assert.match(hook, / = vfs/);
  execFileSync('/bin/sh', ['-n', join(directory, 'alpine-docker-vfs.sh')], { timeout: 2000 });
});
