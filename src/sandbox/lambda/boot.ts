import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ChannelReport, IndeterminateEffect } from '../../contracts/index.js';
import type { BootRef, Observation } from '../lifecycle.js';
import type { EnvironmentRef } from '../prepare.js';
import type { StartResult } from '../start.js';
import type { StopResult } from '../stop.js';
import { bootReady, bootReadyProgram, clonedHead, cloneProgram, evidenceProgram } from './guest-programs.js';
import { collectLambdaArtifacts, uploadLambdaSeeds } from './artifacts.js';
import type { ArtifactSeed } from '../artifact-seeds.js';
import { preserveEvidence } from '../../records/index.js';
import { readWorkImage } from './image.js';
import { installationTagKey, workTagKey } from './installation.js';
import { lambdaBootSize, type LambdaProfile } from './profile.js';
import type { LambdaMicrovm, LambdaService, LambdaServiceFactory, LambdaServiceFailure } from './service.js';
import { generateSessionKey, guestKeepaliveSeconds, guestSshPort, openChannel, type GuestTransport, type GuestUser, type LambdaChannel } from './transport.js';

/**
 * v2 ticket 04 (V2-02 Iniciar/Observar/Parar, V2-09, V2-10, V2-22, V2-24, V2-28, V2-34): the life of ONE boot under the Lambda adapter.
 * Start is always a new MicroVM (never the adoption of a survivor), Observe is the service's own answer and Stop is confirmed only by
 * the service. Everything a later process needs is in the boot's record on the host, so nothing depends on the process that started it.
 */

/** Time as the boot waits see it. Injected so tests move a fake clock; production uses the wall clock. */
export type LambdaBootClock = { now(): number; sleep(milliseconds: number): Promise<void> };
export const defaultLambdaBootClock: LambdaBootClock = Object.freeze({ now: () => Date.now(),
  sleep: (milliseconds: number) => new Promise<void>(resolve => { setTimeout(resolve, milliseconds); }) });

/** Bounded waits of a boot (observed: Run to SSH usable about 7 s; Terminate to `TERMINATED` 4 to 8 s). One service read per interval. */
export const lambdaBootWaits = Object.freeze({ intervalSeconds: 2, runningSeconds: 120, channelSeconds: 90, cessationSeconds: 120 });

export type LambdaBootDependencies = { root: string; service: LambdaServiceFactory; transport: GuestTransport; clock: LambdaBootClock };
export type LambdaStartResult = StartResult;

/** Why a boot began and why it ended (V2-10). A boot whose start did not complete ends with `end` and the failure code. */
export type BootBeginReason = 'start' | 'planned-swap';
export type BootEndReason = 'planned-swap' | 'loss' | 'end';

const instant = z.string().min(1);
const bootRecordSchema = z.strictObject({
  version: z.literal(1),
  boot: z.string().regex(/^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  environment: z.string().regex(/^env-[a-f0-9]{64}$/), workId: z.string().min(1),
  /** How any process reaches the account again: the profile NAME and region, never a credential. */
  awsProfile: z.string().min(1), region: z.string().min(1), installation: z.string().min(1),
  imageArn: z.string().min(1), imageVersion: z.string().min(1),
  /** The size of the boot comes from the profile the image was built with: GetMicrovm reports none. */
  size: z.strictObject({ baselineMemoryMiB: z.number(), peakMemoryMiB: z.number(), peakVcpus: z.number() }),
  maxBootSeconds: z.number().int().positive(),
  begin: z.strictObject({ reason: z.enum(['start', 'planned-swap']), requestedAt: instant }),
  /** `requested`: RunMicrovm not answered yet; `running`: a MicroVM exists; `active`: channel up and commit cloned; `ending`: stop requested. */
  phase: z.enum(['requested', 'running', 'active', 'ending', 'ended']),
  microvmId: z.string().min(1).optional(), endpoint: z.string().min(1).optional(),
  /** The guest's SSH host key, pinned by the host at first contact; every later connection accepts only this key. */
  hostKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/=]+$/).optional(),
  checkout: z.strictObject({ repository: z.string(), commit: z.string(), branch: z.string().optional() }).optional(),
  /** The service's own instants (GetMicrovm), as given. */
  startedAt: instant.optional(),
  stop: z.strictObject({ reason: z.enum(['planned-swap', 'loss', 'end']), requestedAt: instant, detail: z.string().max(256).optional() }).optional(),
  end: z.strictObject({ reason: z.enum(['planned-swap', 'loss', 'end']), at: instant, terminatedAt: instant.optional(), stateReason: z.string().optional(),
    /** The failure code of a start that did not complete. */ code: z.string().optional(),
    /** v2 ticket 14 (V2-32): the service's end minus the service's start. Absent: the service did not give both instants (unknown, never zero). */
    seconds: z.number().nonnegative().optional() }).optional(),
  /** Guest evidence the host read over the channel (files under the boot's `evidence/`); `lost` says what never was (V2-34). */
  evidence: z.strictObject({ collected: z.array(z.strictObject({ label: z.string(), at: instant, bytes: z.number().int() })), lost: z.string().nullable() }),
  /**
   * v2 ticket 06 (decision 2c, V2-34): the `/artifacts` trees (review, spec, instructions) the host collected over the channel before this
   * boot stopped, as a protected Records reference (`<root>/<work>/evidence/<id>/files/`). Ticket 08 re-sends `spec/` and `instructions/`
   * of the latest `preserved` collection to the next boot. `absent`: the guest had none; `lost`: not collected before the boot ended.
   */
  artifacts: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('preserved'), at: instant, reference: z.strictObject({ workId: z.string(), id: z.string(), manifestSha256: z.string(), files: z.number().int(), bytes: z.number().int() }) }),
    z.strictObject({ status: z.literal('absent'), at: instant }),
    z.strictObject({ status: z.literal('lost'), at: instant, code: z.string() })]).optional(),
});
export type LambdaBootRecord = z.infer<typeof bootRecordSchema>;
const currentSchema = z.strictObject({ version: z.literal(1), environment: z.string(), boot: bootRecordSchema.shape.boot });

const workDirectory = async (root: string, environment: string) => join(await realpath(root), 'lambda', 'works', environment);
const bootDirectory = async (root: string, environment: string, boot: string) => join(await workDirectory(root, environment), 'boots', boot);
const identityName = 'session_ed25519';
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) { if (missing(error)) return null; throw error; }
  return schema.parse(JSON.parse(text));
}
const saveRecord = async (root: string, record: LambdaBootRecord) => writeJson(join(await bootDirectory(root, record.environment, record.boot), 'boot.json'), record);

/** The record of one boot; `null` when this installation has none under that reference. An unreadable record throws (never guessed). */
export async function readLambdaBoot(root: string, environment: EnvironmentRef, boot: BootRef): Promise<LambdaBootRecord | null> {
  if (!/^env-[a-f0-9]{64}$/.test(environment) || !bootRecordSchema.shape.boot.safeParse(boot).success) return null;
  return readJson(join(await bootDirectory(root, environment, boot), 'boot.json'), bootRecordSchema);
}
/** The latest boot of the environment (the one an observation without an explicit boot means); `null` when it never booted. */
export async function currentLambdaBoot(root: string, environment: EnvironmentRef): Promise<BootRef | null> {
  if (!/^env-[a-f0-9]{64}$/.test(environment)) return null;
  return ((await readJson(join(await workDirectory(root, environment), 'current.json'), currentSchema))?.boot ?? null) as BootRef | null;
}
/** Every boot recorded for the environment, oldest first: identity, reasons, size, start and end (V2-10; consumption is ticket 14). */
export async function listLambdaBoots(root: string, environment: EnvironmentRef): Promise<LambdaBootRecord[]> {
  let names: string[];
  try { names = await readdir(join(await workDirectory(root, environment), 'boots')); } catch (error) { if (missing(error)) return []; throw error; }
  const records = await Promise.all(names.map(name => readLambdaBoot(root, environment, name as BootRef)));
  return records.filter((record): record is LambdaBootRecord => record !== null).sort((left, right) => left.begin.requestedAt.localeCompare(right.begin.requestedAt));
}

const iso = (clock: LambdaBootClock) => new Date(clock.now()).toISOString();

/** Seconds between two instants of the SERVICE; `null` when either is missing or they do not form an interval (never a guess, never zero). */
export function serviceSeconds(startedAt: string | undefined, terminatedAt: string | undefined): number | null {
  if (!startedAt || !terminatedAt) return null;
  const milliseconds = Date.parse(terminatedAt) - Date.parse(startedAt);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1000 : null;
}
const failureDetail = (failure: LambdaServiceFailure) => [failure.kind, failure.action, failure.detail].filter(Boolean).join(': ').slice(0, 400);
const serviceOf = (dependencies: LambdaBootDependencies, record: Pick<LambdaBootRecord, 'awsProfile' | 'region'>): LambdaService =>
  dependencies.service({ awsProfile: record.awsProfile, region: record.region });

function ended(record: LambdaBootRecord, reason: BootEndReason, clock: LambdaBootClock, microvm?: LambdaMicrovm, code?: string): LambdaBootRecord {
  const last = record.evidence.collected.at(-1);
  // What the host did not read before a death no longer exists anywhere: there are no runtime logs without an execution role (V2-34).
  const lost = reason === 'loss' && record.evidence.lost === null
    ? `The boot ended before a final collection: guest evidence after ${last ? `the collection of ${last.at}` : 'its start'} is lost.` : record.evidence.lost;
  const startedAt = record.startedAt ?? microvm?.startedAt;
  const seconds = serviceSeconds(startedAt, microvm?.terminatedAt);
  return { ...record, phase: 'ended', evidence: { ...record.evidence, lost },
    // Decision 2c: what was not collected before a death is declared lost, never reconstructed.
    ...(record.artifacts ? {} : { artifacts: { status: 'lost' as const, at: iso(clock), code: reason === 'loss' ? 'BOOT_LOST_BEFORE_COLLECTION' : 'NOT_COLLECTED' } }),
    ...(startedAt ? { startedAt } : {}),
    end: { reason, at: iso(clock), ...(microvm?.terminatedAt ? { terminatedAt: microvm.terminatedAt } : {}),
      ...(microvm?.stateReason ? { stateReason: microvm.stateReason } : {}), ...(code ? { code } : {}), ...(seconds === null ? {} : { seconds }) } };
}

/** TerminateMicrovm only asks; cessation is a later GetMicrovm saying `TERMINATED`. Not seen within the wait: NOT confirmed. */
async function terminateAndConfirm(service: LambdaService, microvmId: string, clock: LambdaBootClock): Promise<{ confirmed: true; microvm: LambdaMicrovm } | { confirmed: false }> {
  await service.terminateMicrovm(microvmId);
  const deadline = clock.now() + lambdaBootWaits.cessationSeconds * 1000;
  for (;;) {
    const read = await service.microvm(microvmId);
    if (read.ok && read.value.state === 'TERMINATED') return { confirmed: true, microvm: read.value };
    if (clock.now() >= deadline) return { confirmed: false };
    await clock.sleep(lambdaBootWaits.intervalSeconds * 1000);
  }
}

const evidenceLimit = 512 * 1024;
/** Reads the guest's boot logs over the channel into the boot's private directory. `false`: nothing was collected this time. */
async function collectEvidence(dependencies: LambdaBootDependencies, record: LambdaBootRecord, channel: LambdaChannel, label: string): Promise<LambdaBootRecord | null> {
  const result = await channel.exec(evidenceProgram());
  if (result.status !== 'exited' || result.exitCode !== 0) return null;
  const directory = join(await bootDirectory(dependencies.root, record.environment, record.boot), 'evidence');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const text = Buffer.from(result.stdout, 'utf8').subarray(0, evidenceLimit);
  await writeFile(join(directory, `${label}.log`), text, { mode: 0o600 });
  return { ...record, evidence: { ...record.evidence, collected: [...record.evidence.collected.filter(entry => entry.label !== label), { label, at: iso(dependencies.clock), bytes: text.byteLength }] } };
}

/**
 * Decision 2c: the `/artifacts` evidence trees of a living boot, staged into the protected Records area of its Work. One collection per
 * stop; a boot that already has a preserved collection keeps it when a repeated stop finds nothing more.
 */
async function collectArtifacts(dependencies: LambdaBootDependencies, record: LambdaBootRecord, channel: LambdaChannel): Promise<NonNullable<LambdaBootRecord['artifacts']>> {
  const at = iso(dependencies.clock);
  const earlier = record.artifacts?.status === 'preserved' ? record.artifacts : null;
  // An empty or missing tree leaves no empty Records entry behind: the stage refuses and the incomplete directory is removed.
  const preserved = await preserveEvidence({ root: dependencies.root, workId: record.workId, label: `${record.environment}/${record.boot}`, stage: async destination => {
    const collected = await collectLambdaArtifacts(channel, destination);
    if (collected.status === 'failure') throw new Error(collected.code);
    if (collected.status === 'absent' || collected.files === 0) throw new Error('EVIDENCE_ABSENT');
  } }).catch(() => ({ status: 'failed' as const, code: 'EVIDENCE_PRESERVATION_FAILED' }));
  if (preserved.status !== 'preserved') return earlier ?? (preserved.code === 'EVIDENCE_ABSENT' ? { status: 'absent', at } : { status: 'lost', at, code: preserved.code });
  return { status: 'preserved', at, reference: preserved.reference };
}

export type LambdaCheckout = { repository: string; commit: string; branch?: string;
  /** The Builder's reduced Git credential, in memory only: delivered to the clone as process environment over the channel (V2-24). */
  credential: { readonly token: string } };

/**
 * Iniciar: RunMicrovm of the Work's image (installation and Work tags, no execution role, no idle suspension, `INTERNET_EGRESS`), then
 * the channel (session key delivered in the run hook payload, host key pinned at first contact), then the clone of the starting commit
 * from `origin` in the guest. Success only with all three. Any failure after a MicroVM exists terminates it; an end the service does not
 * confirm is `indeterminate`, never a plain failure.
 */
export async function startLambdaBoot(dependencies: LambdaBootDependencies, { environment, profile, checkout, reason = 'start', remoteUrl, seeds = [] }: { environment: EnvironmentRef;
  profile: LambdaProfile; checkout?: LambdaCheckout; reason?: BootBeginReason; remoteUrl: (scope: { repository: string }) => string;
  /** v2 ticket 06: Factory material written into the guest of this boot (a boot starts empty, so it is sent at every start). */ seeds?: readonly ArtifactSeed[] }): Promise<LambdaStartResult> {
  const { root, clock, transport } = dependencies;
  if (!/^env-[a-f0-9]{64}$/.test(environment)) return { status: 'failure', code: 'ENVIRONMENT_REF_INVALID' };
  const image = await readWorkImage(root, environment);
  if (!image) return { status: 'failure', code: 'ENVIRONMENT_NOT_PREPARED' };
  if (!checkout) return { status: 'failure', code: 'CHECKOUT_REQUIRED' };
  const clone = cloneProgram({ remote: remoteUrl({ repository: checkout.repository }), commit: checkout.commit, token: checkout.credential.token,
    ...(checkout.branch === undefined ? {} : { branch: checkout.branch }) });
  if (!clone || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(checkout.repository)) return { status: 'failure', code: 'CHECKOUT_INVALID' };
  // Never adopt a survivor: a previous boot that the service does not report ended must be stopped first, not reused.
  const previous = await currentLambdaBoot(root, environment);
  if (previous) {
    const observed = await observeLambdaBoot(dependencies, { environment, boot: previous });
    if (!observed.cessationConfirmed) return { status: 'failure', code: 'PREVIOUS_BOOT_NOT_CEASED', boot: previous };
  }
  const service = dependencies.service({ awsProfile: profile.awsProfile, region: profile.region });
  const boot = `boot-${randomUUID()}` as BootRef;
  const directory = await bootDirectory(root, environment, boot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = generateSessionKey();
  const identityFile = join(directory, identityName);
  await writeFile(identityFile, key.privateKey, { mode: 0o600, flag: 'wx' });
  const size = lambdaBootSize(profile);
  let record: LambdaBootRecord = { version: 1, boot, environment, workId: image.workId, awsProfile: profile.awsProfile, region: profile.region, installation: profile.installation,
    imageArn: image.imageArn, imageVersion: image.imageVersion, size: { baselineMemoryMiB: size.baselineMemoryMiB, peakMemoryMiB: size.peakMemoryMiB, peakVcpus: size.peakVcpus },
    maxBootSeconds: profile.maxBootSeconds, begin: { reason, requestedAt: iso(clock) }, phase: 'requested', evidence: { collected: [], lost: null } };
  const save = async (next: LambdaBootRecord) => { record = next; await saveRecord(root, record); };
  await save(record);
  await writeJson(join(await workDirectory(root, environment), 'current.json'), { version: 1, environment, boot });

  // The payload is public material only: the session PUBLIC key the guest authorizes for `builder`.
  const run = await service.runMicrovm({ imageArn: image.imageArn, maximumDurationSeconds: profile.maxBootSeconds,
    runHookPayload: JSON.stringify({ builder: key.publicKey }), tags: { [installationTagKey]: profile.installation, [workTagKey]: image.workId } });
  if (!run.ok) {
    await rm(identityFile, { force: true });
    // An unreadable answer does not prove that no MicroVM was created: the record stays open for the inventory by tag (ticket 15).
    if (run.failure.kind === 'unknown') return { status: 'indeterminate', code: 'MICROVM_START_UNCONFIRMED', boot, detail: failureDetail(run.failure) };
    const code = run.failure.kind === 'capacity' ? 'SERVICE_CAPACITY_REFUSED' : 'MICROVM_START_REFUSED';
    await save(ended(record, 'end', clock, undefined, code));
    return { status: 'failure', code, boot, detail: failureDetail(run.failure) };
  }
  await save({ ...record, phase: 'running', microvmId: run.value.microvmId, endpoint: run.value.endpoint });
  const { microvmId, endpoint } = run.value;
  let channel: LambdaChannel | null = null;
  const fail = async (code: string, detail?: string): Promise<StartResult> => {
    if (channel) await save(await collectEvidence(dependencies, record, channel, 'start-failure').catch(() => null) ?? record);
    channel?.close();
    await rm(identityFile, { force: true });
    const cessation = await terminateAndConfirm(service, microvmId, clock);
    if (!cessation.confirmed) {
      await save({ ...record, phase: 'ending', stop: { reason: 'end', requestedAt: iso(clock), detail: code } });
      return { status: 'indeterminate', code: 'CESSATION_NOT_CONFIRMED', boot, detail: [code, detail].filter(Boolean).join(': ') };
    }
    await save(ended(record, 'end', clock, cessation.microvm, code));
    return { status: 'failure', code, boot, ...(detail ? { detail } : {}) };
  };

  const interval = lambdaBootWaits.intervalSeconds * 1000;
  for (const deadline = clock.now() + lambdaBootWaits.runningSeconds * 1000; ;) {
    const read = await service.microvm(microvmId);
    if (read.ok && read.value.state === 'RUNNING') { await save({ ...record, ...(read.value.startedAt ? { startedAt: read.value.startedAt } : {}) }); break; }
    // A failed run hook takes the MicroVM straight to its end without ever running.
    if (read.ok && (read.value.state === 'TERMINATING' || read.value.state === 'TERMINATED')) return fail('MICROVM_RUN_HOOK_FAILED', read.value.stateReason);
    if (clock.now() >= deadline) return fail('MICROVM_NOT_RUNNING', read.ok ? read.value.state : failureDetail(read.failure));
    await clock.sleep(interval);
  }

  // First contact: the guest generated its host key in this boot; the host pins what the token-authenticated tunnel shows.
  let hostKey: string | null = null;
  for (const deadline = clock.now() + lambdaBootWaits.channelSeconds * 1000; hostKey === null;) {
    const token = await service.createAuthToken({ microvmId, port: guestSshPort, expirationMinutes: 60 });
    if (!token.ok) return fail('CHANNEL_TOKEN_REFUSED', failureDetail(token.failure));
    const contact = await transport.readHostKey({ endpoint, port: guestSshPort, token: token.value.token, user: 'builder', identityFile, keepaliveSeconds: guestKeepaliveSeconds });
    if (contact.status === 'read') { hostKey = contact.hostKey; break; }
    // `sshd` is born in the start script, a few seconds after the MicroVM runs: nothing answering yet is expected.
    if (contact.status === 'refused' && contact.code !== 'UNREACHABLE') return fail(`CHANNEL_${contact.code}`, contact.detail);
    if (clock.now() >= deadline) return fail('CHANNEL_UNREACHABLE', contact.detail);
    await clock.sleep(interval);
  }
  if (hostKey === null || !bootRecordSchema.shape.hostKey.safeParse(hostKey).success) return fail('CHANNEL_HOST_KEY_UNREADABLE');
  await save({ ...record, hostKey });
  channel = openChannel({ service, transport, microvmId, endpoint, identityFile, hostKey, now: clock.now });
  const channelCode = (result: Exclude<Awaited<ReturnType<LambdaChannel['exec']>>, { status: 'exited' }>) =>
    result.status === 'refused' ? `CHANNEL_${result.code}` : result.status === 'lost' ? 'CHANNEL_LOST' : 'CHANNEL_CLOSED';

  // Nothing comes from the snapshot: `dockerd` starts and the declared images are pulled by digest in this boot, before any work.
  const ready = await channel.exec(bootReadyProgram());
  if (ready.status !== 'exited') return fail(channelCode(ready), 'detail' in ready ? ready.detail : undefined);
  const state = ready.exitCode === 0 ? bootReady(ready.stdout) : null;
  if (!state) return fail('GUEST_START_INCOMPLETE');
  if (!state.pulled) return fail('DECLARED_IMAGE_PULL_FAILED');

  const cloned = await channel.exec(clone);
  if (cloned.status !== 'exited') return fail(channelCode(cloned), 'detail' in cloned ? cloned.detail : undefined);
  const scrub = (text: string) => text.split(checkout.credential.token).join('[credential]').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (cloned.exitCode !== 0) return fail('CLONE_FAILED', scrub(cloned.stderr) || `git exited ${cloned.exitCode}`);
  // Guest-attested (V2-26): it tells the host the boot is usable, it authorizes nothing.
  if (clonedHead(cloned.stdout) !== checkout.commit) return fail('STARTING_COMMIT_MISMATCH');
  // v2 ticket 06: the skill pack is Factory material of the release; nothing of an earlier boot exists, so it is written now.
  const seeded = await uploadLambdaSeeds(channel, seeds).catch(() => ({ status: 'failure' as const, code: 'ARTIFACT_SEED_UNAVAILABLE' }));
  if (seeded.status !== 'success') return fail('ARTIFACT_SEED_UPLOAD_FAILED', seeded.code);
  await save(await collectEvidence(dependencies, record, channel, 'start').catch(() => null) ?? record);
  await save({ ...record, phase: 'active', checkout: { repository: checkout.repository, commit: checkout.commit, ...(checkout.branch === undefined ? {} : { branch: checkout.branch }) } });
  return { status: 'success', boot, seeds: seeded.seeds };
}

export type LambdaObservation = Observation & {
  /** What the service said about the MicroVM in this observation (absent: the service was not, or could not be, read). */
  lifecycle?: { state: string; stateReason?: string; startedAt?: string; terminatedAt?: string } };

/**
 * Observar: the condition is the service's (GetMicrovm), read with the boot's record by ANY process. A MicroVM found terminated that no
 * stop was asked for is recorded as a loss, with its uncollected evidence declared lost. An unreadable or in-between answer is
 * `indeterminate`: cessation is never inferred.
 */
export async function observeLambdaBoot(dependencies: LambdaBootDependencies, { environment, boot }: { environment: EnvironmentRef; boot?: BootRef }): Promise<LambdaObservation> {
  const reference = boot ?? await currentLambdaBoot(dependencies.root, environment);
  const correlated = boot === undefined ? { boot: reference } : {};
  if (!reference) return { condition: 'not-booted', cessationConfirmed: true, consumption: 'unavailable', boot: null };
  const record = await readLambdaBoot(dependencies.root, environment, reference);
  if (!record) return { condition: 'indeterminate', cessationConfirmed: false, consumption: 'unavailable', ...correlated };
  const stopped = (lifecycle?: LambdaObservation['lifecycle']): LambdaObservation =>
    ({ condition: 'stopped', cessationConfirmed: true, consumption: 'unavailable', ...correlated, ...(lifecycle ? { lifecycle } : {}) });
  if (record.phase === 'ended') return stopped(record.end?.terminatedAt ? { state: 'TERMINATED', terminatedAt: record.end.terminatedAt,
    ...(record.end.stateReason ? { stateReason: record.end.stateReason } : {}), ...(record.startedAt ? { startedAt: record.startedAt } : {}) } : undefined);
  // RunMicrovm was never answered for this record: whether a MicroVM exists is unknown to the host (the inventory by tag is ticket 15).
  if (!record.microvmId) return { condition: 'indeterminate', cessationConfirmed: false, consumption: 'unavailable', ...correlated };
  const read = await serviceOf(dependencies, record).microvm(record.microvmId);
  if (!read.ok) return { condition: 'indeterminate', cessationConfirmed: false, consumption: 'unavailable', ...correlated };
  const { state, stateReason, startedAt, terminatedAt } = read.value;
  const lifecycle = { state, ...(stateReason ? { stateReason } : {}), ...(startedAt ? { startedAt } : {}), ...(terminatedAt ? { terminatedAt } : {}) };
  if (state === 'TERMINATED') {
    await rm(join(await bootDirectory(dependencies.root, environment, reference), identityName), { force: true });
    await saveRecord(dependencies.root, ended(record, record.stop?.reason ?? 'loss', dependencies.clock, read.value));
    return stopped(lifecycle);
  }
  if (state === 'RUNNING' || state === 'PENDING') return { condition: 'active', cessationConfirmed: false, consumption: 'unavailable', ...correlated, lifecycle };
  return { condition: 'indeterminate', cessationConfirmed: false, consumption: 'unavailable', ...correlated, lifecycle };
}

const stopReason = (reason: string): BootEndReason => reason === 'planned-swap' || reason === 'loss' ? reason : 'end';

/**
 * Parar: collects the guest evidence over the channel, withdraws access (the session key is deleted; no token expiry is awaited), asks
 * TerminateMicrovm and confirms cessation ONLY when the service reports `TERMINATED`. Nothing of the disk is kept. `reason` is
 * `planned-swap`, `loss` or anything else for the end of the boot's use.
 */
export async function stopLambdaBoot(dependencies: LambdaBootDependencies, { environment, boot, reason }: { environment: EnvironmentRef; boot: BootRef; reason: string }): Promise<StopResult> {
  const { root, clock } = dependencies;
  let record = await readLambdaBoot(root, environment, boot);
  if (!record) return { status: 'failure', code: 'BOOT_NOT_FOUND', cessationConfirmed: false };
  const confirmed: StopResult = { status: 'success', cessationConfirmed: true, termination: 'forced', guestFinalization: 'unavailable' };
  if (record.phase === 'ended') return confirmed;
  const { microvmId, endpoint } = record;
  if (!microvmId || !endpoint) return { status: 'indeterminate', code: 'BOOT_IDENTITY_UNKNOWN', cessationConfirmed: false };
  const service = serviceOf(dependencies, record);
  const identityFile = join(await bootDirectory(root, environment, boot), identityName);
  const before = await service.microvm(microvmId);
  if (before.ok && before.value.state === 'TERMINATED') {
    // It was already dead when the stop arrived: a loss unless a stop had been asked before, and nothing more can be collected.
    await rm(identityFile, { force: true });
    await saveRecord(root, ended(record, record.stop?.reason ?? 'loss', clock, before.value));
    return confirmed;
  }
  const requested = stopReason(reason);
  if (!record.stop) record = { ...record, stop: { reason: requested, requestedAt: iso(clock), ...(requested === 'end' && reason !== 'end' ? { detail: reason.slice(0, 256) } : {}) } };
  record = { ...record, phase: 'ending' };
  await saveRecord(root, record);
  const identity = await stat(identityFile).then(() => true, () => false);
  if (record.hostKey && identity) {
    const channel = openChannel({ service, transport: dependencies.transport, microvmId, endpoint, identityFile, hostKey: record.hostKey, now: clock.now });
    const collected = await collectEvidence(dependencies, record, channel, 'stop').catch(() => null);
    // Decision 2c: review captures and the preserved request/instruction versions leave the guest NOW or never (V2-34).
    const artifacts = await collectArtifacts(dependencies, record, channel);
    channel.close();
    record = { ...(collected ?? { ...record, evidence: { ...record.evidence, lost: record.evidence.lost ?? 'The final collection over the channel failed: guest evidence after the last collection is lost.' } }), artifacts };
  } else record = { ...record, artifacts: record.artifacts ?? { status: 'lost', at: iso(clock), code: 'CHANNEL_UNAVAILABLE' },
    evidence: { ...record.evidence, lost: record.evidence.lost ?? 'The channel was never established or access was already withdrawn: no final guest evidence was collected.' } };
  // Access is withdrawn by removing the session key and ending the MicroVM; a still-valid token alone opens nothing without the key.
  await rm(identityFile, { force: true });
  await saveRecord(root, record);
  const cessation = await terminateAndConfirm(service, microvmId, clock);
  if (!cessation.confirmed) return { status: 'indeterminate', code: 'CESSATION_NOT_CONFIRMED', cessationConfirmed: false };
  await saveRecord(root, ended(record, record.stop?.reason ?? requested, clock, cessation.microvm));
  return confirmed;
}

/**
 * The channel to an ACTIVE boot, opened by any host process from the boot's record (pinned host key, session key file): what tool calls
 * (ticket 05) and observation programs run over. Closing it, or stopping the boot, withdraws the access.
 */
export async function openLambdaBootChannel(dependencies: LambdaBootDependencies, { environment, boot, user = 'builder' }: { environment: EnvironmentRef; boot: BootRef;
  /** The guest Unix user every program of this channel runs as (ticket 05: chosen by the host from the bound role). */ user?: GuestUser }): Promise<{ status: 'open'; channel: LambdaChannel } | { status: 'unavailable'; code: string }> {
  const record = await readLambdaBoot(dependencies.root, environment, boot);
  if (!record) return { status: 'unavailable', code: 'BOOT_NOT_FOUND' };
  if (record.phase !== 'active' || !record.microvmId || !record.endpoint || !record.hostKey) return { status: 'unavailable', code: 'BOOT_NOT_ACTIVE' };
  const identityFile = join(await bootDirectory(dependencies.root, environment, boot), identityName);
  if (!await stat(identityFile).then(() => true, () => false)) return { status: 'unavailable', code: 'BOOT_ACCESS_WITHDRAWN' };
  return { status: 'open', channel: openChannel({ service: serviceOf(dependencies, record), transport: dependencies.transport, microvmId: record.microvmId, endpoint: record.endpoint,
    identityFile, hostKey: record.hostKey, now: dependencies.clock.now, user }) };
}

const channelFile = 'channel.jsonl';
const channelEntrySchema = z.union([
  z.strictObject({ kind: z.literal('effect'), at: instant, executionId: z.string(), invocationId: z.string(), role: z.string(), tool: z.enum(['bash', 'write', 'edit-source']),
    callId: z.string(), description: z.string(), outcome: z.enum(['orphan-ended', 'environment-ended', 'channel-unrecoverable']) }),
  z.strictObject({ kind: z.literal('unrecoverable'), at: instant, attempts: z.number().int().positive() })]);
export type LambdaChannelEntry = z.infer<typeof channelEntrySchema>;

/**
 * v2 ticket 11 (V2-21): the boot's durable record of what a dropped channel left unconfirmed, one JSON line per fact, written on the
 * host BEFORE the tool call answers. It outlives the boot and the process that served its tools; Control reads it (`readLambdaChannelReport`).
 */
export async function recordLambdaChannelEntry(root: string, environment: EnvironmentRef, boot: BootRef, entry: LambdaChannelEntry): Promise<void> {
  await appendFile(join(await bootDirectory(root, environment, boot), channelFile), `${JSON.stringify(channelEntrySchema.parse(entry))}\n`, { mode: 0o600 });
}
/** The channel report of one boot; empty when nothing was recorded. A line that cannot be read throws: an uncertain effect is never dropped silently. */
export async function readLambdaChannelReport(root: string, environment: EnvironmentRef, boot: BootRef): Promise<ChannelReport> {
  const report: ChannelReport = { indeterminateEffects: [], unrecoverable: null };
  if (!/^env-[a-f0-9]{64}$/.test(environment) || !bootRecordSchema.shape.boot.safeParse(boot).success) return report;
  let text: string;
  try { text = await readFile(join(await bootDirectory(root, environment, boot), channelFile), 'utf8'); } catch (error) { if (missing(error)) return report; throw error; }
  for (const line of text.split('\n').filter(Boolean)) {
    const entry = channelEntrySchema.parse(JSON.parse(line));
    if (entry.kind === 'effect') { const { kind: _kind, ...effect } = entry; report.indeterminateEffects.push(effect satisfies IndeterminateEffect); }
    else report.unrecoverable ??= { at: entry.at, attempts: entry.attempts };
  }
  return report;
}

/** Whether `environment` belongs to the Lambda adapter in this installation (it has a recorded image or boots). */
export async function isLambdaEnvironment(root: string, environment: EnvironmentRef): Promise<boolean> {
  if (!/^env-[a-f0-9]{64}$/.test(environment)) return false;
  return stat(await workDirectory(root, environment)).then(() => true, () => false);
}
