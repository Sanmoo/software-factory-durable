import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { imageReferenceParts, type EnvironmentBaseIdentity } from '../../contracts/index.js';
import type { EnvironmentRequest } from '../environment-base.js';
import type { EnvironmentRef, PrepareResult } from '../prepare.js';
import { guestPinSha256, lambdaGuestPin, lambdaImageKey, lambdaImageName, managedBaseImageArn, renderGuestImage } from './guest-image.js';
import { installationResources, installationTagKey, workTagKey } from './installation.js';
import type { LambdaProfile } from './profile.js';
import type { LambdaImage, LambdaService, LambdaServiceFailure } from './service.js';
import { storedZip } from './zip.js';
import { recordLambdaImageBuild } from './image-ledger.js';

/**
 * How Prepare waits for a build: one read of the image every `intervalSeconds`, for at most `maxSeconds` (observed builds: 2 min 10 s to
 * succeed, 53 s to fail). `sleep` is injected so tests move a fake clock. A build that outlives the wait is not cancelled: Prepare returns
 * incomplete and the next Prepare finds the same image by its derived name.
 */
export type LambdaImageWait = { intervalSeconds: number; maxSeconds: number; sleep: (milliseconds: number) => Promise<void> };
export const defaultLambdaImageWait: LambdaImageWait = Object.freeze({ intervalSeconds: 10, maxSeconds: 900,
  sleep: (milliseconds: number) => new Promise<void>(resolve => { setTimeout(resolve, milliseconds); }) });

/**
 * The image a Work started with, recorded on the host when its first Prepare succeeded (`<root>/lambda/works/<environment>/image.json`).
 * It is what later Prepares of that Work and its boots (ticket 04) use, whatever the declaration or the release pin became meanwhile, and
 * what tells which images still have a Work (ticket 15). Adapter-owned resource metadata, not a second authority for Work state.
 */
const workImageSchema = z.strictObject({ version: z.literal(1), workId: z.string().min(1), environment: z.string().regex(/^env-[a-f0-9]{64}$/),
  key: z.string().regex(/^[a-f0-9]{64}$/), imageName: z.string().min(1), imageArn: z.string().min(1), imageVersion: z.string().min(1),
  repositoryId: z.number().int(), declarationSha256: z.string().regex(/^[a-f0-9]{64}$/), pinSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/), packages: z.record(z.string(), z.string()),
  images: z.array(z.strictObject({ reference: z.string(), digest: z.string() })) });
export type WorkImage = z.infer<typeof workImageSchema>;

const workImagePath = (root: string, environment: string) => join(root, 'lambda', 'works', environment, 'image.json');

/** The image recorded for a Work's environment; `null` when it never completed a Prepare. An unreadable record throws (never guessed). */
export async function readWorkImage(root: string, environment: EnvironmentRef): Promise<WorkImage | null> {
  let text: string;
  try { text = await readFile(workImagePath(await realpath(root), environment), 'utf8'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  return workImageSchema.parse(JSON.parse(text));
}

async function recordWorkImage(root: string, record: WorkImage) {
  const path = workImagePath(await realpath(root), record.environment);
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

const causeLimit = 400;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The cause of a failed build, from its log (BuildKit output). The API only says "The container image build failed."; the log ends with
 * a block ` > [n/m] RUN ...:` followed by the output of the failing step, which is what the Operator needs (the package and version apk
 * refused). Without such a block, the last `error:`/`ERROR:` line. `null` when the log names no failure. One bounded line.
 */
export function buildFailureCause(lines: readonly string[]): string | null {
  const text = lines.flatMap(line => line.split('\n')).map(line => line.trimEnd());
  const marker = text.findLastIndex(line => /^\s*> \[/.test(line));
  let cause: string | undefined;
  if (marker >= 0) {
    const end = text.findIndex((line, index) => index > marker && /^-{4,}$/.test(line.trim()));
    const output = text.slice(marker + 1, end < 0 ? undefined : end).map(line => line.replace(/^\d+\.\d+ /, '')).filter(line => line.trim());
    cause = oneLine([text[marker]!.replace(/^\s*> /, ''), ...output].join(' '));
  } else {
    const error = text.findLast(line => /(^|\s)error:/i.test(line));
    if (error) cause = oneLine(error.replace(/^#\d+ (\d+\.\d+ )?/, ''));
  }
  return cause ? cause.slice(0, causeLimit) : null;
}

const describe = (failure: LambdaServiceFailure) => [failure.kind, failure.action, failure.detail].filter(Boolean).join(' ');

/**
 * V2-02 "Preparar" under the Lambda adapter (V2-27, V2-33): guarantees the MicroVM image of the Work's environment key.
 *
 * - The image name is derived from the key, so every Prepare finds what any earlier one did: an image that exists is reused (`reused`),
 *   one still being built is waited for, and only a missing one is built. Repeating Prepare never starts a second build.
 * - A Work that already completed a Prepare keeps the image recorded for it, whatever declaration or release pin it is given now; if that
 *   image is gone the Work is refused, never moved to another image.
 * - A failed build is a refusal with the cause read from the build log. No other version or image is tried and nothing is retried here:
 *   only `retry` (the Operator's explicit retry) deletes the failed image and builds the same key again.
 * - The build artifact and the image carry the installation tag and the tag of the Work whose Prepare created them. Later Works with the
 *   same key share the image; which Works use an image is on the host, in their records.
 *
 * Refusal codes are the environment-preparation ones Control already treats (the adapter is not named to Control):
 * `ENVIRONMENT_BASE_PREPARATION_FAILED` (definitive for this key) and `ENVIRONMENT_BASE_PREPARATION_INCOMPLETE` (not concluded: the
 * account could not be read or changed, or the build is still running). Both return after every local step ended.
 */
export async function prepareLambdaImage({ root, workId, profile, service, environment, retry = false, wait = defaultLambdaImageWait, now = Date.now }:
  { root: string; workId: string; profile: LambdaProfile; service: LambdaService; environment?: EnvironmentRequest | undefined; retry?: boolean | undefined;
    wait?: LambdaImageWait | undefined; /** v2 ticket 14: the instant written in the build ledger (tests give the fake clock). */ now?: (() => number) | undefined }): Promise<PrepareResult> {
  if (typeof workId !== 'string' || !workId || workId.length > 256) return { status: 'failure', code: 'WORK_ID_INVALID' };
  if (!environment) return { status: 'failure', code: 'ENVIRONMENT_NOT_PINNED', detail: 'The Lambda adapter builds the MicroVM image from the pinned .factory/environment.yaml; this Work has none.' };
  const rendered = renderGuestImage(environment.declaration);
  if (!rendered.ok || !/^[a-f0-9]{64}$/.test(environment.sha256) || !Number.isSafeInteger(environment.repositoryId)) {
    return { status: 'failure', code: 'ENVIRONMENT_DECLARATION_INVALID',
      detail: rendered.ok ? 'declaration identity invalid' : rendered.errors.map(error => `${error.path}: ${error.message}`).join('; ').slice(0, causeLimit) };
  }
  const failed = (detail: string): PrepareResult => ({ status: 'failure', code: 'ENVIRONMENT_BASE_PREPARATION_FAILED', detail: detail.slice(0, causeLimit) });
  const incomplete = (detail: string): PrepareResult => ({ status: 'failure', code: 'ENVIRONMENT_BASE_PREPARATION_INCOMPLETE', detail: detail.slice(0, causeLimit) });
  const unreachable = (step: string, failure: LambdaServiceFailure) => incomplete(`${step}: ${failure.kind === 'no-identity' ? 'the AWS profile yields no identity ' : ''}${describe(failure)}`);
  const environmentRef = `env-${createHash('sha256').update(workId).digest('hex')}` as EnvironmentRef;
  const success = (record: WorkImage, reused: boolean): PrepareResult => ({ status: 'success', environment: environmentRef, base: identityOf(record, reused) });

  let recorded: WorkImage | null;
  try { recorded = await readWorkImage(root, environmentRef); }
  catch { return { status: 'failure', code: 'ENVIRONMENT_CONFIGURATION_MISMATCH', detail: 'the image record of this Work is unreadable' }; }
  if (recorded && recorded.workId !== workId) return { status: 'failure', code: 'ENVIRONMENT_CONFIGURATION_MISMATCH', detail: 'the image record does not belong to this Work' };
  if (recorded) {
    const current = await service.image(recorded.imageArn);
    if (current.ok && current.value.state === 'CREATED') return success(recorded, true);
    if (!current.ok && current.failure.kind !== 'not-found') return unreachable('reading the image of this Work', current.failure);
    return failed(`The MicroVM image this Work started with (${recorded.imageName}) ${current.ok ? `is ${current.value.state}` : 'no longer exists'}; a Work is never moved to another image.`);
  }

  const identity = await service.callerIdentity();
  if (!identity.ok) return unreachable('reading the account identity', identity.failure);
  const resources = installationResources(profile, identity.value.account);
  const pinSha256 = guestPinSha256();
  const key = lambdaImageKey({ repositoryId: environment.repositoryId, declarationSha256: environment.sha256, profile, pinSha256 });
  const name = lambdaImageName(profile.installation, key);
  const imageArn = `arn:aws:lambda:${profile.region}:${identity.value.account}:microvm-image:${name}`;
  const artifact = storedZip(rendered.files);
  const tags = { [installationTagKey]: profile.installation, [workTagKey]: workId };
  const record = (image: LambdaImage): WorkImage => ({ version: 1, workId, environment: environmentRef, key, imageName: name, imageArn,
    imageVersion: image.latestActiveImageVersion ?? '1.0', repositoryId: environment.repositoryId, declarationSha256: environment.sha256, pinSha256,
    artifactSha256: createHash('sha256').update(artifact).digest('hex'),
    packages: Object.fromEntries(rendered.declaration.apk.map(entry => [entry.name, entry.version])),
    images: rendered.declaration.images.map(image => ({ reference: image.reference, digest: imageReferenceParts(image.reference)?.digest ?? '' })) });

  // The ledger is consumption evidence, not a step of Prepare: a line that cannot be written never fails or repeats a build.
  const ledger = (event: 'requested' | 'created' | 'failed') =>
    recordLambdaImageBuild(root, { at: new Date(now()).toISOString(), event, key, name, workId }).catch(() => {});
  /** Uploads the artifact and asks for ONE build. `conflict`: another Prepare created the image meanwhile, which is then simply read. */
  const build = async (): Promise<PrepareResult | null> => {
    const uploaded = await service.putBuildArtifact({ bucket: resources.artifactBucket, key: `${name}.zip`, body: artifact, tags });
    if (!uploaded.ok) return unreachable('uploading the build artifact', uploaded.failure);
    const created = await service.createImage({ name, description: `Software Factory ${profile.installation}: environment ${key.slice(0, 12)} of repository ${environment.repositoryId}`,
      baseImageArn: managedBaseImageArn(profile.region), baseImageVersion: lambdaGuestPin.baseImage.version, buildRoleArn: resources.buildRoleArn,
      artifactUri: uploaded.value.uri, architecture: profile.architecture, minimumMemoryMiB: profile.baselineMemoryMiB,
      additionalOsCapabilities: [...profile.additionalOsCapabilities], hooks: { ...lambdaGuestPin.hooks }, tags });
    if (!created.ok && created.failure.kind !== 'conflict') return unreachable('requesting the image build', created.failure);
    // v2 ticket 14 (V2-32): the build THIS Prepare requested, under its environment key. A conflict is another Prepare's build.
    if (created.ok) await ledger('requested');
    return null;
  };
  /** Reads the image until it leaves `state` or the wait ends; `null`: still in that state. */
  const leaves = async (state: 'CREATING' | 'DELETING', first: Awaited<ReturnType<LambdaService['image']>>) => {
    let current = first;
    for (let waited = 0; current.ok && current.value.state === state; waited += wait.intervalSeconds) {
      if (waited >= wait.maxSeconds) return null;
      await wait.sleep(wait.intervalSeconds * 1000);
      current = await service.image(imageArn);
    }
    return current;
  };

  let builtHere = false;
  let retried = false;
  let current = await service.image(imageArn);
  for (;;) {
    if (!current.ok && current.failure.kind !== 'not-found') return unreachable('reading the image', current.failure);
    if (!current.ok) {
      if (builtHere) return incomplete(`The image ${name} was requested but the service does not show it yet; Prepare again recognises it.`);
      const refusal = await build();
      if (refusal) return refusal;
      builtHere = true;
      current = await service.image(imageArn);
      continue;
    }
    const image = current.value;
    if (image.tags[installationTagKey] !== profile.installation) return failed(`An image named ${name} exists without this installation's tag; it is not used.`);
    if (image.state === 'CREATED') {
      await ledger('created');
      const own = record(image);
      try { await recordWorkImage(root, own); }
      catch { return { status: 'indeterminate', code: 'ENVIRONMENT_PREPARATION_INCOMPLETE', detail: 'the image is ready but its record for this Work could not be written' }; }
      return success(own, !builtHere);
    }
    if (image.state === 'CREATING') {
      const settled = await leaves('CREATING', current);
      if (!settled) return incomplete(`The image ${name} is still being built after ${wait.maxSeconds} s; the build continues and Prepare again recognises it (no second build).`);
      current = settled;
      continue;
    }
    if (image.state !== 'CREATE_FAILED') return incomplete(`The image ${name} is ${image.state}; Prepare again once the service settles it.`);
    await ledger('failed');
    if (!retry || builtHere || retried) return failed(await failureCause(service, image));
    // The Operator's explicit retry: the failed image is replaced under the same key (the service keeps one image per name).
    retried = true;
    const version = image.latestFailedImageVersion ? await service.deleteImageVersion({ imageArn, version: image.latestFailedImageVersion }) : null;
    if (version && !version.ok && version.failure.kind !== 'not-found') return unreachable('removing the failed image version', version.failure);
    const removed = await service.deleteImage(imageArn);
    if (!removed.ok && removed.failure.kind !== 'not-found') return unreachable('removing the failed image', removed.failure);
    const gone = await leaves('DELETING', await service.image(imageArn));
    if (!gone || (gone.ok && gone.value.state === 'CREATE_FAILED')) return incomplete(`The failed image ${name} is still being removed; retry again once it is gone.`);
    current = gone;
  }
}

async function failureCause(service: LambdaService, image: LambdaImage): Promise<string> {
  const builds = await service.imageBuilds(image.imageArn);
  const reason = (builds.ok ? builds.value.find(build => build.stateReason)?.stateReason : undefined) ?? 'The image build failed.';
  const logGroup = `/aws/lambda-microvms/${image.name}`;
  const log = await service.buildLog(logGroup);
  if (!log.ok) return `MicroVM image build failed: ${reason} The build log ${logGroup} could not be read (${describe(log.failure)}), so the cause is not known here.`;
  const cause = buildFailureCause(log.value);
  return cause ? `MicroVM image build failed: ${cause}` : `MicroVM image build failed: ${reason} The build log ${logGroup} names no failing step.`;
}

const identityOf = (record: WorkImage, reused: boolean): EnvironmentBaseIdentity => ({ base: record.key, declarationSha256: record.declarationSha256,
  manifestSha256: record.artifactSha256, reused, packages: record.packages, images: record.images });
