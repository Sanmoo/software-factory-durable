// TEST ONLY. Import/--plan is inert. Calling an effectful phase requires a NEW
// operator grant after source review; these observations confer NO admission.
import { bodyLimit, copyPattern, largeBytes, startProvider, type Case } from './finite-qualification-provider.js';
import type { EnvironmentRef, BootRef } from '../../src/sandbox/index.js';

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q05-qualification-v1`;
const revision = 'task184-finite-v1';
const phases = ['prepare', 'start', 'w1', 'w2', 'w3', 'w4', 'model', 'stop'] as const;
type Phase = typeof phases[number];
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 2048, vcpus: 2, diskGiB: 40, shutdownGraceSeconds: 30, minFreeSpaceGiB: 4 };
const guestAssets = { directory: '/home/sanmoo/software-factory-test/assets32/assets', manifestSha256: '4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1' };
const syntheticSource = 'Qualification synthetic source only.\n';
// Fixed identity emitted by the accepted startWorker sdkProfile, not an SDK import.
const expectedSdkProfile = Object.freeze({ id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3', version: '1.5.2',
  integrity: 'sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA==',
  upstreamSHA256: 'e6159de5e4d94ae22968b6524237ef3d4f0374a107e2321ed5c29e93d66c8efc',
  upstreamTreeSHA256: '7d0961cce25f6c802b22aaa028206cd610de386442d2e6b732d71367ef006391',
  patchSHA256: '5e45a7c2953db293a14db0138bb31f8ac9e95eb13512afd42f1f49b77c98e066',
  resultSHA256: '06867a067ebbadca2e06f75ccb4e682cd7e37b9683d41a71562f770b3105a209',
  asyncPatchSHA256: '1ee38f2bdb71480b5b6206e72dbed32ac9214acbe0afe9b7e5137ea8f63cdc1e',
  candidatePatchSHA256: 'fd85bbd3c22fff3cb90dd990cb2608f18884d15dcd3820fb2f790b6e42a4dd01',
  candidateManifestSHA256: 'b6aaa5391d251867e41e8fc80973a1da79c7df3e38cdd18d11e705d939809b69',
  lexicalPatchSHA256: 'e3e88f8e6a53c9b58164c85c9866cfcf5a31b9fd415fdad7ce136976d8fd96d0',
  lexicalCandidateManifestSHA256: '923d916bae558e6d21978593b2effb716dec80398bb5b0a66271fefcfc0f42a2' });
function matchesSdkProfile(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return Object.keys(profile).length === Object.keys(expectedSdkProfile).length &&
    Object.entries(expectedSdkProfile).every(([key, expected]) => profile[key] === expected);
}

export function plan() {
  return { revision, root, sdkProfile: expectedSdkProfile, login: 'OPERATOR-REPORTED only; credentials untouched by plan/tests', phases, configuration, guestAssets, nativeCalls: 11, providerPosts: 15,
    realModel: { provider: 'openai', model: 'gpt-6-luna', api: 'openai-responses', maxRequests: 2, reads: 1, estimatedUSD: 10, providerBillingHardCap: false },
    transport: { address: '127.0.0.1', port: 18705, path: '/q05-qual-v1/chat/completions', bodyLimit, headers: 8192, response: 65536, activeRequestsPerPhase: 1, connectionsPerPhase: { w1: 9, w2: 2, w3: 2, w4: 2 }, simultaneousSocketsPerPhase: { w1: 9, w2: 2, w3: 2, w4: 2 } },
    // Fixed ASCII schedule: 1MiB native Bash continuation + four <=50KiB
    // Read pages + commands/prompts/tool schemas (<128KiB) + escaping. Bash
    // digits/newlines expand <=2x; SDK's 1MiB result ceiling includes line data.
    // 2MiB parser limit is fitting for THIS schedule, not arbitrary tool output.
    httpFit: { bashResult: 1048576, newlineEscapeOverhead: 65538, otherResults: 4 * 51200, schemaPromptEnvelope: 131072, total: 1449986, limit: bodyLimit },
    bounds: {
      // Reservations include failed partial tails; not a production disk quota.
      rawAndFilteredCaptureText: { bytes: 16 * 1024 * 1024, reason: '5*1114130 whole large captures + small/edit/write/model captures; raw transient counted separately from protected retained copies' },
      editSourceSnapshots: { bytes: 4 * 8192, reason: 'one8192-byte trusted Edit source budget; source/version/validation/replacement staging, including failed tail; NOT each Read page' },
      guestCopy: { bytes: largeBytes, files: 1 },
      nativeSpill: { bytes: 2 * 1024 * 1024, files: 1 },
      nativeJSONL: { bytes: 64 * 1024 * 1024, reason: '11 offline+1 OAuth tools: <=2MiB native results +17*64KiB assistant/provider data +128KiB prompts/schema; <=6x JSON escaping <20MiB; remaining44MiB covers session headers/usage/partial failed entries. Native session appends each message, not whole HTTP history.' },
      recordsAndMetadata: { bytes: 256 * 1024 * 1024, reason: '4096*65536 reservation: <=256 private data operations (188 large Read capture/pages +3 denials +<=16 write/edit/Bash/copy stages +1 model Read+5 owner starts), generously16 metadata/event/partial files per operation. Pages do not create captures; progress chunks append to existing captures. Includes failed temporary metadata files; exact actual Q5/VM totals are observations, not native11.' },
      httpTransient: { bytes: 4 * bodyLimit + 65536 + 8192, perRequestWire: bodyLimit, retainedBodies: 0, reason: 'chunks+concat+decoded JSON/escaping allowance; not a Node RSS theorem' },
      supervisoryAndRecipe: { bytes: 4 * 1024 * 1024 },
      retainedEnvelopeMiB: 512, operationalRetainedGiB: 80, pressureGiB: 79, floorGiB: 4, preparationTemporaryGiB: 84,
      enforcement: 'Reserve512MiB before future grant: <16MiB captures +256MiB metadata +64MiB sessions +2MiB spill +2MiB guest copy +4MiB supervision, rounded up for allocation/failed tails. Bounds follow fixed schedule, not measured usage. Product has no aggregate quota; only next recipe-controlled phase can be refused. No runtime inflation.',
    },
    effects: [
      'prepare: exclusive observation directory + new UUID Work/Execution; public prepare hashes assets/copies/grows/checks/converts disk; seed only owned new workspace/source.txt, wx',
      'start: public persistent start; preserved-disk read-only qcow2 checks and private raw snapshot; systemd-run fixed owner; KVM/QEMU/Alpine/Docker-vfs; startup30/grace30/readiness10 unchanged',
      'guest lifecycle commands: existing adapter readiness /bin/sh -c guestStorageReadiness (Docker-vfs check, fixed profile markers/probes under root/tmp/cache/log/workspace/artifacts, sync); existing adapter stop /bin/sh -c fixed Docker/dockerd finalizer then sync. SDK boot/init internals are trusted dependency categories, not native tool calls.',
      'guest tool exec categories: Write + Edit capture/version/commit fixed guest Python FD helpers; exactly2 /usr/bin/env -i /bin/bash -c commands in provider schedule; copy-output fixed guest Python stdin helper once; four successful large Read helpers + denial-policy helpers; real small Read helper once. No direct driver VM.exec/helper, third Bash, host guest-program execution or fault signal.',
      'w1: production Workers activation; native Write/Edit/denied Read; exactly two Bash; auto-copy; three whole-source Read captures/pages',
      'w2/w3/w4: fresh Builder denied / default reviewer denied / exact Host-selected reviewer Read; one provider bind per phase, own sockets only',
      'model: built-in FactoryStore OAuth path; protected start/ACK then <=2 real requests+1 Read of synthetic source; no provider fixture or credential copies',
      'stop: observe exact new owned boot then public stop (guest Docker/dockerd stop, sync, VM.close, exact systemd termination); no remove or cleanup',
    ],
    unknowns: ['Capacity/reservations UNKNOWN; no current probes', 'Public prepare/start/stop aggregate walltime is not <=60s guaranteed; no cancellation/cessation from timeout. Future execution arrangement must explicitly cover this before grant.',
      'prepare e2fsck/resize2fs/e2fsck each30s, convert30s/info10s/resize10s; hashing/copy/fsync non-hard-bounded; start filesystem checks +60s operational polling; stop grace30s+manager observation may exceed60s',
      'Native11 != private Q5/VM.exec counts; Read<=4*(1+46) paging plus3 denied captures; write/edit/Bash/copy/owner internal categories distinct, exact totals UNKNOWN',
      '512MiB excludes40GiB virtualdisk/image tools. Preparation needs84GiB temporary available per product; start may hold another40GiB private snapshot; failed candidates/snapshots remain, potentially above80GiB pressure policy. 80retained/79pressure/4floor is NOT a hard quota. Filesystem allocation, metadata overhead/free and other reservations need future permitted preflight; no cleanup/fallback.',
      '512MiB is a fixed-schedule conservative logical-byte envelope, not a filesystem hard quota, RSS bound or exact record count; capacity UNKNOWN now',
      'Split printf is NOT physical chunk-cut proof; reuse component split-filter evidence', 'AC7 in-flight EOF/capture faults HELD; worker.close below observes owned Host close request only; SDK completion is not physical cessation or provider billing'],
  };
}

type Identity = { revision: string; source: string; workId: string; executionId: string; environment: string };
type Result = { status: 'success'; identity: Identity; boot?: string; path?: string; observation?: unknown };

/** No arbitrary root/command/env/callback fields. Failure/partial intent is consumed.
 * Existing R is known created by183, login OPERATOR-REPORTED; never inspect it
 * or credentials here. Only effectful FUTURE phases open their own observations.
 */
export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const fs = await import('node:fs/promises');
  const { createHash, randomUUID } = await import('node:crypto');
  const source = createHash('sha256').update(await fs.readFile(new URL(import.meta.url))).update(await fs.readFile(new URL('./finite-qualification-provider.js', import.meta.url))).digest('hex');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data); if (Buffer.byteLength(text) > 65536) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    const directory = await fs.open(observations, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const load = async (name: string): Promise<Result> => {
    const bytes = await fs.readFile(`${observations}/${name}.json`, 'utf8');
    if (Buffer.byteLength(bytes) > 65536) throw new Error('OBSERVATION_LIMIT');
    const result = JSON.parse(bytes) as Result;
    if (result.status !== 'success' || result.identity.revision !== revision || result.identity.source !== source ||
        !/^q05-[0-9a-f-]{36}$/.test(result.identity.workId) || !/^q05-[0-9a-f-]{36}$/.test(result.identity.executionId) ||
        result.identity.environment !== 'env-' + createHash('sha256').update(result.identity.workId).digest('hex')) throw new Error('IDENTITY_HELD');
    return result;
  };
  if (phase === 'prepare') await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt/replay existing qualification
  const initial = phase === 'prepare' ? undefined : await load('prepare-result');
  const workId = initial?.identity.workId ?? `q05-${randomUUID()}`;
  const identity: Identity = initial?.identity ?? { revision, source, workId, executionId: `q05-${randomUUID()}`, environment: 'env-' + createHash('sha256').update(workId).digest('hex') };
  // Exact one-shot tombstone precedes public imports and all actual effects.
  await save(`${phase}-intent`, { identity, phase });
  try {
    if (phase !== 'prepare' && phase !== 'stop') {
      try { await fs.readFile(`${observations}/stop-intent.json`); throw new Error('STOP_CONSUMED'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    const { createSandbox } = await import('../../src/sandbox/index.js');
    const sandbox = createSandbox({ root, guestAssets });
    if (phase === 'prepare') {
      // A UUID is not permission to adopt any pre-existing environment.
      try { await fs.lstat(`${root}/environments/${identity.environment}`); throw new Error('ENVIRONMENT_ALREADY_EXISTS'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      const result = await sandbox.prepare({ workId, configuration });
      if (result.status !== 'success' || result.environment !== identity.environment) throw new Error('PREPARATION_HELD');
      const file = await fs.open(`${root}/environments/${identity.environment}/workspace/source.txt`, 'wx', 0o600);
      try { await file.writeFile(syntheticSource); await file.sync(); } finally { await file.close(); }
      await save('prepare-result', { status: 'success', identity }); return;
    }
    if (phase === 'start') {
      const result = await sandbox.start({ environment: identity.environment as EnvironmentRef, configuration });
      // Preserve boot even on indeterminate, but never use it as a successful new boot.
      await save('start-observation', { identity, result });
      if (result.status !== 'success' || !/^boot-[0-9a-f-]{36}$/.test(result.boot)) throw new Error('START_HELD');
      await save('start-result', { status: 'success', identity, boot: result.boot }); return;
    }
    const started = await load('start-result');
    if (JSON.stringify(started.identity) !== JSON.stringify(identity) || !/^boot-[0-9a-f-]{36}$/.test(started.boot ?? '')) throw new Error('BOOT_IDENTITY_HELD');
    const boot = started.boot as BootRef;
    if (phase === 'stop') {
      const observed = await sandbox.observe({ environment: identity.environment as EnvironmentRef, boot });
      await save('stop-before', { identity, boot, observed });
      if (observed.condition !== 'active' && !observed.cessationConfirmed) throw new Error('STOP_IDENTITY_UNCERTAIN');
      const result = await sandbox.stop({ environment: identity.environment as EnvironmentRef, boot, reason: 'q05 finite qualification explicit stop' });
      await save('stop-observation', { identity, boot, result });
      if (!result.cessationConfirmed) throw new Error('CESSATION_UNKNOWN');
      await save('stop-result', { status: 'success', identity, boot }); return;
    }
    const previous: Record<string, string> = { w1: 'start', w2: 'w1', w3: 'w2', w4: 'w3', model: 'w4' };
    const prior = await load(`${previous[phase]}-result`);
    if (JSON.stringify(prior.identity) !== JSON.stringify(identity) || prior.boot !== boot) throw new Error('PHASE_IDENTITY_HELD');
    const first = phase === 'w1' ? undefined : await load('w1-result');
    const path = first?.path ?? '';
    if (phase !== 'w1' && !copyPattern.test(path)) throw new Error('COPY_IDENTITY_HELD');
    const { createWorkers } = await import('../../src/workers/index.js');
    const profileId = expectedSdkProfile.id;
    const real = phase === 'model';
    const workers = createWorkers({ root, knownSecrets: real ? [] : ['q05-secret-v1', 'q05-dummy-key-v1'], profile: real ? {
      id: profileId, systemPrompt: 'Read source.txt once and report only its synthetic text.', auth: 'factory-oauth', providerId: 'openai', modelId: 'gpt-6-luna', api: 'openai-responses',
    } : { id: profileId, systemPrompt: 'Finite qualification. Follow the tool schedule.', providerId: 'q05-qualification-fixture', modelId: 'qual-model', apiKey: 'q05-dummy-key-v1',
      provider: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:18705/q05-qual-v1', models: [{ id: 'qual-model', name: 'Qualification', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] } } });
    const provider = real ? undefined : await startProvider(phase as Case, path);
    const controller = new AbortController();
    let expire!: (reason: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => { expire = reject; });
    const timer = setTimeout(() => { controller.abort(); expire(new Error('OBSERVATION_DEADLINE_NOT_CESSATION')); }, 45000);
    // Timeout requests abort/owned close and consumes this phase; it is NEVER
    // permission to retry or a physical-writer cessation observation.
    const bounded = <T>(operation: Promise<T>) => Promise.race([operation, deadline]);
    let closeRequested = false;
    let worker: Awaited<ReturnType<typeof workers.activate>> | undefined;
    let successResult: unknown;
    try {
      const activating = workers.activate({ context: { workId, executionId: identity.executionId, invocationId: `q05-${phase}`, phaseId: `q05-${phase}`, role: phase === 'w1' || phase === 'w2' ? 'builder' : 'standards', environmentRef: identity.environment, bootRef: boot },
        prompt: real ? 'Read source.txt once then report.' : `q05-${phase}`, signal: controller.signal,
        ...(phase === 'w1' || phase === 'w2' ? { copyOutput: true, editSourceMaxBytes: 8192 } : phase === 'w4' ? { selectedOutputCopies: [path] } : {}) });
      void activating.then(handle => { if (controller.signal.aborted) handle.close(); }, () => {});
      worker = await bounded(activating);
      const receipt = await bounded(worker.started);
      await save(`${phase}-started`, { identity, boot, receipt });
      const completed = await bounded(worker.completed);
      const observation = provider?.observation();
      await save(`${phase}-completed`, { identity, boot, completed, observation });
      if (completed.status !== 'success' || (observation && (observation.held || observation.accepted !== (phase === 'w1' ? 9 : 2)))) throw new Error('WORKER_HELD');
      // Read only exact new boot's native session, bounded before SDK parsing.
      const runtime = `${root}/r/${Buffer.from(boot.slice(5).replaceAll('-', ''), 'hex').toString('base64url')}`;
      const launches = (await fs.readdir(runtime)).filter(name => name.startsWith('w-'));
      if (launches.length > 5) throw new Error('LAUNCH_LIMIT');
      const matches: string[] = [];
      let sessionBytes = 0;
      for (const launch of launches) {
        const sessionRoot = `${runtime}/${launch}/profile/sessions`;
        const names = await fs.readdir(sessionRoot, { recursive: true });
        if (names.length > 16) throw new Error('SESSION_FILE_LIMIT');
        for (const name of names) if (name.endsWith('.jsonl')) {
          const file = `${sessionRoot}/${name}`;
          const info = await fs.lstat(file);
          sessionBytes += info.size;
          if (!info.isFile() || info.isSymbolicLink() || sessionBytes > 64 * 1024 * 1024) throw new Error('SESSION_LIMIT');
          const text = await fs.readFile(file, 'utf8');
          if (text.includes(real ? 'Read source.txt once then report.' : `q05-${phase}`)) matches.push(file);
        }
      }
      if (matches.length !== 1) throw new Error('SESSION_IDENTITY_HELD');
      const { SessionManager } = await import('#factory-pi');
      const transcript = await fs.readFile(matches[0]!, 'utf8');
      if (!real && /q05-secret-v1|q05-dummy-key-v1/.test(transcript)) throw new Error('SESSION_UNPROTECTED');
      const messages = SessionManager.open(matches[0]!).buildSessionContext().messages;
      const results = messages.filter(m => m.role === 'toolResult');
      const assistants = messages.filter(m => m.role === 'assistant');
      if (real && (assistants.length !== 2 || assistants.some(m => m.provider !== 'openai' || m.model !== 'gpt-6-luna' || m.api !== 'openai-responses'))) throw new Error('REAL_MODEL_OBSERVATION_HELD');
      const usage = real ? assistants.map(m => ({ input: m.usage.input, output: m.usage.output, totalTokens: m.usage.totalTokens, estimatedCost: m.usage.cost.total })) : [];
      if (usage.some(item => Object.values(item).some(value => !Number.isFinite(value) || value < 0))) throw new Error('USAGE_OBSERVATION_HELD');
      if (results.length !== (real ? 1 : phase === 'w1' ? 8 : 1) || (real && (results[0]?.toolName !== 'read' || results[0].isError || !JSON.stringify(results[0]).includes(syntheticSource.trim())))) throw new Error('NATIVE_RESULT_HELD');
      if (!real) {
        const expected = phase === 'w1' ? ['write', 'edit', 'read', 'bash', 'bash', 'read', 'read', 'read'] : ['read'];
        for (const [index, result] of results.entries()) {
          const denied = phase === 'w2' || phase === 'w3' || (phase === 'w1' && index === 2);
          if (result.toolName !== expected[index] || Boolean(result.isError) !== denied || (denied && !JSON.stringify(result).includes('READ_PATH_DENIED'))) throw new Error('NATIVE_SEQUENCE_HELD');
        }
      }
      // Correlated protected start, not SDK success alone. Never retain its body.
      const startOutput = `${root}/${workId}/evidence/${receipt.receipt.id}/output`;
      const receiptInfo = await fs.lstat(startOutput);
      if (!receiptInfo.isFile() || receiptInfo.size > 65536) throw new Error('START_RECEIPT_LIMIT');
      const event = JSON.parse(await fs.readFile(startOutput, 'utf8')).event;
      if (event.suppliedContext?.invocationId !== `q05-${phase}` || event.suppliedContext?.bootRef !== boot || event.suppliedContext?.workId !== workId || !matchesSdkProfile(event.profile) || event.providerId !== (real ? 'openai' : 'q05-qualification-fixture') || event.modelId !== (real ? 'gpt-6-luna' : 'qual-model') || event.observedProcess?.pid === process.pid || !Number.isSafeInteger(event.observedProcess?.pid)) throw new Error('START_RECEIPT_HELD');
      let published = path;
      if (phase === 'w1') {
        if (!JSON.stringify(results[0]).includes('Successfully wrote 6 bytes') || !JSON.stringify(results[1]).includes('Successfully replaced') || !JSON.stringify(results[1]).includes('beta')) throw new Error('WRITE_EDIT_HELD');
        const bash = results.filter(m => m.toolName === 'bash');
        published = (bash[1]?.details as { fullOutputPath?: string })?.fullOutputPath ?? '';
        if (!copyPattern.test(published) || published !== observation?.path || !(bash[1]?.details as { truncation?: { truncated?: boolean } })?.truncation?.truncated) throw new Error('NATIVE_COPY_HELD');
      }
      // Whole-source proof: bounded named protected captures, including all
      // recaptures BEFORE Read pagination. No guest helper/direct VM.exec added.
      let wholeCaptures = 0, copyReceipts = 0;
      const evidenceRoot = `${root}/${workId}/evidence`;
      const evidenceIds = await fs.readdir(evidenceRoot);
      if (evidenceIds.length > 1024) throw new Error('RECORD_COUNT_LIMIT');
      let captureBytes = 0;
      const expectedLarge = 'Q05-BEGIN\n' + '0123456789abcdef\n'.repeat(65536) + 'Q05-END\n';
      const expectedHash = createHash('sha256').update(expectedLarge).digest('hex');
      for (const id of evidenceIds) {
        if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('EVIDENCE_ID_HELD');
        const directory = `${evidenceRoot}/${id}`;
        const captureInfo = await fs.lstat(`${directory}/capture.json`);
        if (!captureInfo.isFile() || captureInfo.size > 65536) throw new Error('CAPTURE_METADATA_LIMIT');
        const capture = JSON.parse(await fs.readFile(`${directory}/capture.json`, 'utf8'));
        const outputInfo = await fs.lstat(`${directory}/output`);
        captureBytes += outputInfo.size;
        if (!outputInfo.isFile() || captureBytes > 16 * 1024 * 1024) throw new Error('CAPTURE_BYTES_LIMIT');
        if (capture.context?.invocationId !== `q05-${phase}`) continue;
        if (capture.context?.workId !== workId || capture.context?.executionId !== identity.executionId || capture.context?.bootRef !== boot) throw new Error('CAPTURE_CONTEXT_HELD');
        if (phase === 'w1' && outputInfo.size <= 65536) {
          const text = await fs.readFile(`${directory}/output`, 'utf8');
          let record;
          try { record = JSON.parse(text); } catch { /* Ordinary text is not a metadata event. */ }
          const event = record?.event;
          if (event?.kind === 'mutation-result' && event.operation === 'copy-output') {
            if (event.status !== 'guest-receipt-observed' || event.path !== published || event.bytes !== largeBytes || event.sha256 !== expectedHash) throw new Error('COPY_RECEIPT_HELD');
            copyReceipts++;
          }
        }
        if (outputInfo.size !== largeBytes) continue;
        const completeInfo = await fs.lstat(`${directory}/complete.json`);
        if (!completeInfo.isFile() || completeInfo.size > 65536) throw new Error('COMPLETION_METADATA_LIMIT');
        const complete = JSON.parse(await fs.readFile(`${directory}/complete.json`, 'utf8'));
        const output = await fs.readFile(`${directory}/output`);
        if (complete.bytes !== largeBytes || createHash('sha256').update(output).digest('hex') !== expectedHash) throw new Error('WHOLE_CAPTURE_HELD');
        wholeCaptures++;
      }
      if (wholeCaptures !== (phase === 'w1' ? 4 : phase === 'w4' ? 1 : 0) || copyReceipts !== (phase === 'w1' ? 1 : 0)) throw new Error('WHOLE_CAPTURE_COUNT_HELD');
      // Do not retain native raw/session/auth data in recipe observations.
      successResult = { status: 'success', identity, boot, path: published, observation: { nativeResults: results.length, modelRequestsObserved: real ? assistants.length : observation?.accepted, usage, wholeCaptures, copyReceipts, expectedLargeHash: expectedHash, provider: observation, sessionVerified: true, physicalCessation: 'unknown' } };
    } finally {
      clearTimeout(timer);
      if (worker) { closeRequested = true; worker.close(); }
      await provider?.close();
      await save(`${phase}-close`, { identity, boot, ownedHostCloseRequested: closeRequested, activeGuestAtClose: 'unknown', physicalCessation: 'unknown' });
    }
    // A transport violation during asynchronous evidence checks/close must not
    // publish success from the earlier completion snapshot.
    if (provider?.observation().held) throw new Error('LATE_TRANSPORT_HELD');
    await save(`${phase}-result`, successResult);
  } catch {
    await save(`${phase}-held`, { identity, phase, status: 'held', note: 'Consumed; no retry/fallback. Inspect protected product observations; physical cessation unknown.' });
    throw new Error('QUALIFICATION_HELD');
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch(() => { console.error('Qualification held; no retry.'); process.exitCode = 1; });
}
