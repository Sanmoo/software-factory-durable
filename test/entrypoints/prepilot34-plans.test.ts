import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Import and --plan of the three pre-pilot real-run recipes (R-REL, R-CAND, R-INSPECT) must be inert: no process, socket, filesystem or
// network effect; and R-CAND refuses every phase while its issue number is not pinned (0).
let forbidden = 0;
const deny = () => { forbidden++; throw new Error('FORBIDDEN_EFFECT'); };
for (const name of ['node:net', 'node:tls', 'node:dns', 'node:child_process', 'node:fs/promises', 'node:https', '@earendil-works/gondolin']) {
  mock.module(name, { namedExports: { connect: deny, createServer: deny, execFile: deny, execFileSync: deny, spawn: deny, spawnSync: deny, request: deny, open: deny, mkdir: deny,
    readFile: deny, writeFile: deny, access: deny, readdir: deny, lstat: deny, stat: deny, copyFile: deny, chmod: deny, rm: deny, unlink: deny, rename: deny, statfs: deny, readlink: deny,
    rmdir: deny, realpath: deny }, defaultExport: {} });
}
const rel = await import('./rrel34-qualification.js');
const cand = await import('./rcand34-qualification.js');
const inspect = await import('./rinspect34-qualification.js');
const upg = await import('./rupg34-qualification.js');

async function planOf(main: (args: string[]) => Promise<void>) {
  const logged: string[] = [];
  const log = mock.method(console, 'log', (text: string) => { logged.push(text); });
  try { await main(['--plan']); } finally { log.mock.restore(); }
  return JSON.parse(logged[0]!);
}

test('R-REL plan: inert; fresh namespace under y5, 38-byte root, the exact unit and its host effects, removal of only what it installed', async () => {
  const plan = await planOf(rel.main);
  assert.equal(forbidden, 0);
  assert.equal(plan.base, '/home/sanmoo/software-factory-test/y5/prel34-v2');
  assert.equal(plan.root, '/home/sanmoo/software-factory-test/pr2');
  assert.ok(Buffer.byteLength(plan.root) <= 38, 'guest session socket <root>/r/<22>/s/<41> must fit 107 bytes');
  assert.deepEqual(plan.phases, ['build', 'verify', 'install', 'setup', 'doctor', 'service', 'uninstall-service', 'remove-root']);
  assert.ok(plan.hostEffects.paths.some((item: string) => item.startsWith('/home/sanmoo/.config/systemd/user/software-factory-') && item.includes('.service')));
  assert.ok(plan.hostEffects.systemdUser.some((item: string) => /never enabled/.test(item)));
  assert.ok(plan.hostEffects.never.includes('systemctl enable / loginctl enable-linger'));
  assert.deepEqual([plan.bounds.network, plan.bounds.github, plan.bounds.model, plan.bounds.vm, plan.bounds.retries], ['none', 'none', 'none', 'none', 0]);
  for (const phase of plan.phases) assert.equal(rel.tombstonePath(phase), `${plan.base}/intent-${phase}.json`);
  await assert.rejects(rel.main(['retry']), /EXACT_PHASE_REQUIRED/);
  await assert.rejects(rel.main(['build', 'verify']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('R-CAND plan: inert; runs the INSTALLED release; issue 0 refuses every phase; human steps by the operator with exact commands; GET-only recipe reads', async () => {
  const plan = await planOf(cand.main);
  assert.equal(forbidden, 0);
  assert.equal(plan.observations, '/home/sanmoo/software-factory-test/y5/qcand34-v4');
  assert.equal(plan.root, '/home/sanmoo/software-factory-test/pr2');
  assert.equal(plan.identityFile, '/home/sanmoo/software-factory-test/y5/prel34-v3/observations/release-identity.json');
  assert.match(plan.release, /RE-VERIFIED at each phase/);
  assert.equal(plan.ticket.pinned, false);
  assert.equal(plan.ticket.number, 0);
  assert.deepEqual(plan.phases, ['preflight', 'run', 'answer', 'review', 'repair', 'ready', 'deliver', 'inspect', 'verdict', 'stop-environment']);
  assert.equal(plan.controllerMode.run, 'foreground');
  assert.ok(['answer', 'review', 'repair', 'ready', 'deliver', 'inspect'].every(phase => plan.controllerMode[phase] === 'service'));
  assert.ok(plan.github.human.every((item: string) => /the operator/.test(item)));
  assert.ok(plan.github.never.includes('any GitHub write by this recipe'));
  assert.ok(plan.humanStepMinutes >= 60);
  assert.ok(!/java|mvn|gradle/i.test(plan.ticket.body), 'no Java assumed on the guest');
  for (const phase of plan.phases) await assert.rejects(cand.main([phase]), /TICKET_NOT_PINNED/, phase);
  await assert.rejects(cand.main(['retry']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('R-INSPECT plan: inert; local copy of q23-feedback-v3 only, never its run/ mount, no GitHub/VM/model', async () => {
  const plan = await planOf(inspect.main);
  assert.equal(forbidden, 0);
  assert.equal(plan.namespace, '/home/sanmoo/software-factory-test/y5/qinspect34-v1');
  assert.equal(plan.source, 'q23-feedback-v3');
  assert.ok(plan.never.some((item: string) => item.includes('q23-feedback-v3/run (stale mount)')));
  assert.deepEqual([plan.bounds.network, plan.bounds.github, plan.bounds.vm, plan.bounds.model], ['none', 'none', 'none', 'none']);
  await assert.rejects(inspect.main(['again']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});

test('R-UPG plan: inert; upgrades the SAME R-REL root to mvp-34.3 with the product\'s own upgrade; never the model login; R-CAND reads its identity', async () => {
  const plan = await planOf(upg.main);
  assert.equal(forbidden, 0);
  assert.equal(plan.base, '/home/sanmoo/software-factory-test/y5/prel34-v3');
  assert.equal(plan.root, '/home/sanmoo/software-factory-test/pr2');
  assert.deepEqual([plan.release, plan.previousRelease], ['mvp-34.3', 'mvp-34.2']);
  assert.deepEqual(plan.phases, ['build', 'verify', 'extract', 'upgrade', 'unpause']);
  assert.equal(plan.identityFile, (await planOf(cand.main)).identityFile, 'R-CAND v3 proves it ran on the upgraded release');
  assert.equal(plan.releaseIdentityFile, (await planOf(rel.main)).identityFile, 'R-REL keeps its own (mvp-34.2) identity');
  assert.ok(plan.never.some((item: string) => /model login/.test(item)));
  assert.ok(plan.never.some((item: string) => /migration, rollback or resume/.test(item)));
  for (const phase of plan.phases) assert.equal(upg.tombstonePath(phase), `${plan.base}/intent-${phase}.json`);
  await assert.rejects(upg.main(['retry']), /EXACT_PHASE_REQUIRED/);
  assert.equal(forbidden, 0);
});
