// This command can only run a built-in fake harness. No SDK, auth, network, shell commands or providers.
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeProof } from './finalize.mjs';
import { readApprovedRubric } from './rubric.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let scenario = 'success',
  output;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--scenario' && args[i + 1]) scenario = args[++i];
  else if (args[i] === '--output' && args[i + 1]) output = resolve(args[++i]);
  else {
    console.log(JSON.stringify({ error: 'INVALID_ARGUMENTS' }));
    process.exit(2);
  }
}
if (
  !output ||
  ![
    'success',
    'auxiliary-edit-failure',
    'missing-tool',
    'missing-capture',
    'empty-scan',
    'model-drift',
    'budget-exhausted',
    'collection-failure',
    'sanitization-failure',
    'assessment-failure',
    'cleanup-failure',
    'cessation-unconfirmed',
    'effect-replay',
    'activity-after-stop',
  ].includes(scenario)
) {
  console.log(JSON.stringify({ error: 'INVALID_ARGUMENTS' }));
  process.exit(2);
}
try {
  const plan = await readApprovedRubric(here, 'fixtures/rehearsal-rubric.json', 'fixtures/rehearsal-approval.json');
  await mkdir(output, { mode: 0o700 }); // Refuse reusing an existing output; never reset counters.
  const sources = join(output, 'sources');
  await mkdir(sources, { mode: 0o700 });
  const trace = [];
  let simulatedActivations = 0,
    running = false,
    counter = 1;
  const before = counter;
  const profile = {
    tools: scenario === 'missing-tool' ? [] : ['fake_read'],
    models: [{ value: 'alias', resolvedModel: scenario === 'model-drift' ? 'different' : 'synthetic-model' }],
  };
  const captureName = scenario === 'empty-scan' ? 'capture.txt' : 'capture.jsonl';
  if (scenario !== 'missing-capture') await writeFile(join(sources, captureName), '{"synthetic":true}\n', { mode: 0o600 });
  // A real file/page read and nonempty scan are part of the preflight, not a receipt interpreted as text.
  const receipt = { path: join(sources, captureName) };
  const page = await readFile(receipt.path, 'utf8').catch(() => null);
  const captures = (await readdir(sources)).filter(x => x.endsWith('.jsonl'));
  const code = !profile.tools.includes('fake_read')
    ? 'TOOLS_INACTIVE'
    : !profile.models.some(x => x.resolvedModel === 'synthetic-model')
      ? 'MODEL_DRIFT'
      : !page
        ? 'CAPTURE_MISSING'
        : !captures.length
          ? 'EMPTY_SCAN'
          : scenario === 'budget-exhausted'
            ? 'BUDGET_STOP'
            : null;
  const preflight = code ? { status: 'blocked', code } : { status: 'ready' };
  trace.push('preflight');
  if (!code) {
    simulatedActivations++;
    running = true;
    trace.push('activate');
  }
  if (scenario === 'effect-replay') {
    counter++;
    trace.push('replay');
  }
  const artifact = scenario === 'auxiliary-edit-failure' ? 'WIP\n' : 'WIP\nRESUMED\n';
  await writeFile(join(sources, 'artifact.txt'), artifact, { mode: 0o600 });
  const finalization = await finalizeProof({
    directory: join(output, 'preserved'),
    criterionIds: plan.rubric.criteria.map(x => x.id),
    stop: async () => {
      trace.push('stop');
      if (scenario === 'cessation-unconfirmed') return { ceased: false };
      if (scenario === 'activity-after-stop') return { ceased: true }; // Deliberately contradictory receipt.
      running = false;
      return { ceased: true };
    },
    collect: async () => {
      trace.push('collect');
      if (scenario === 'collection-failure') throw Error('PRIVATE_FAILURE');
      return {
        kind: 'synthetic-only',
        rubricSha256: plan.sha256,
        before,
        after: counter,
        simulatedActivations,
        captureCount: captures.length,
        running,
        artifact: await readFile(join(sources, 'artifact.txt'), 'utf8'),
        secret: 'SYNTHETIC_PRIVATE_VALUE',
      };
    },
    sanitize: raw => {
      if (scenario === 'sanitization-failure') throw Error('PRIVATE_FAILURE');
      return JSON.parse(JSON.stringify(raw).replaceAll('SYNTHETIC_PRIVATE_VALUE', '[REDACTED]'));
    },
    assess: async data => {
      trace.push('assess');
      if (scenario === 'assessment-failure') throw Error('PRIVATE_FAILURE');
      if (code) return { counter: 'inconclusive', wait: 'inconclusive', edit: 'inconclusive' };
      return {
        counter: data.before === data.after && data.simulatedActivations === 1 ? 'approved' : 'rejected',
        wait: !data.running ? 'approved' : 'rejected',
        edit: data.artifact.split('\n').includes('RESUMED') ? 'approved' : 'rejected',
      };
    },
    remove: async () => {
      trace.push('remove');
      if (scenario === 'cleanup-failure') throw Error('PRIVATE_FAILURE');
      await rm(sources, { recursive: true });
    },
  });
  const report = {
    kind: 'synthetic-structural-rehearsal',
    nativeInferences: 0,
    scenario,
    rubricSha256: plan.sha256,
    preflight,
    simulatedActivations,
    trace,
    finalization,
  };
  await writeFile(join(output, 'rehearsal.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch {
  console.log(JSON.stringify({ error: 'REHEARSAL_BLOCKED', nativeInferences: 0 }));
  process.exitCode = 1;
}
