import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { microvmEgress, microvmIngress, type LambdaArchitecture, type LambdaListedMicrovm, type LambdaMicrovmRequest, type LambdaService, type LambdaServiceFailure, type LambdaServiceResult } from './service.js';

/** One `aws` invocation: its exit and output, or `unavailable` when the executable could not be run at all. */
export type AwsCliRunner = (argv: readonly string[]) => Promise<{ status: 'exited'; exitCode: number; stdout: string; stderr: string } | { status: 'unavailable' }>;

/**
 * The environment handed to `aws`: the host's, minus every variable that would make the CLI use credentials or a profile other than the
 * one NAMED in the configuration (V2-31). The Factory adds no credential and writes none; the AWS tooling resolves the named profile.
 */
export function awsCliEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { AWS_ACCESS_KEY_ID: _id, AWS_SECRET_ACCESS_KEY: _secret, AWS_SESSION_TOKEN: _token, AWS_SECURITY_TOKEN: _legacy, AWS_PROFILE: _profile,
    AWS_DEFAULT_PROFILE: _default, AWS_REGION: _region, AWS_DEFAULT_REGION: _defaultRegion, ...rest } = environment;
  return { ...rest, AWS_PAGER: '' };
}

/** Runs the host's `aws` (no shell). `executable` is injectable so tests run a stand-in file, never the real CLI. */
export function createAwsCliRunner({ executable = 'aws', environment = process.env }: { executable?: string; environment?: NodeJS.ProcessEnv } = {}): AwsCliRunner {
  return argv => new Promise(resolve => {
    execFile(executable, [...argv], { env: awsCliEnvironment(environment), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return resolve({ status: 'unavailable' });
      resolve({ status: 'exited', exitCode: error ? error.code as number : 0, stdout, stderr });
    });
  });
}

const line = (text: string) => text.split('\n').map(part => part.trim()).find(Boolean)?.slice(0, 300);

/** AWS CLI error text to the port's failure kinds. The texts are the CLI's and botocore's stable messages. */
function classify(stderr: string): LambdaServiceFailure {
  const detail = line(stderr);
  const failure = (kind: LambdaServiceFailure['kind'], extra: { action?: string } = {}): LambdaServiceFailure => ({ kind, ...extra, ...(detail ? { detail } : {}) });
  if (/The config profile \(.*\) could not be found/.test(stderr)) return failure('profile-not-found');
  if (/argument (command|operation): Invalid choice|is not a valid (command|choice)/i.test(stderr)) return failure('cli-unavailable');
  if (/Unable to locate credentials|ExpiredToken|InvalidClientTokenId|UnrecognizedClientException|SignatureDoesNotMatch|AuthFailure|Error loading SSO Token|SSO (session|token)|token (has|is) expired|Error when retrieving (token|credentials)|Partial credentials found/i.test(stderr)) return failure('no-identity');
  if (/AccessDenied|not authorized to perform|UnauthorizedOperation|\(403\)/.test(stderr)) {
    const action = /not authorized to perform:? ([A-Za-z0-9-]+:[A-Za-z0-9*]+)/.exec(stderr)?.[1];
    return failure('access-denied', action ? { action } : {});
  }
  // Not observed: the proofs never created an image whose name existed. The names are the service's documented exception names.
  if (/ConflictException|ResourceConflict|AlreadyExists|ResourceInUse/.test(stderr)) return failure('conflict');
  // Not observed (ticket 04): the proofs never hit the quota. `InsufficientCapacityException` is documented; the quota refusal's name is not.
  if (/InsufficientCapacity|ServiceQuotaExceeded|LimitExceeded|QuotaExceeded/i.test(stderr)) return failure('capacity');
  if (/NoSuchEntity|NoSuchBucket|ResourceNotFound|NotFoundException|\(404\)/.test(stderr)) return failure('not-found');
  if (/Could not connect to the endpoint URL|UnknownEndpoint|Invalid endpoint|Could not resolve host/i.test(stderr)) return failure('region-unavailable');
  return failure('unknown');
}

/**
 * The production `LambdaService`: the `aws` CLI with `--profile <name> --region <region>`, as the proofs used it (no AWS SDK dependency).
 * Proven shapes: `sts get-caller-identity`, `lambda-microvms list-microvm-images` (`items[]`). `iam simulate-principal-policy`,
 * `iam get-role` and `s3api get-bucket-location` are long-standing AWS APIs that the proofs did not call. The quota read is NOT proven:
 * see `allocatedMemoryQuota`.
 */
export function createLambdaCliService({ awsProfile, region }: { awsProfile: string; region: string }, run: AwsCliRunner = createAwsCliRunner()): LambdaService {
  async function call<T>(argv: readonly string[], read: (output: Record<string, unknown>) => T | undefined): Promise<LambdaServiceResult<T>> {
    const result = await run(['--profile', awsProfile, '--region', region, '--output', 'json', '--no-cli-pager', ...argv]);
    if (result.status === 'unavailable') return { ok: false, failure: { kind: 'cli-unavailable' } };
    if (result.exitCode !== 0) return { ok: false, failure: classify(result.stderr) };
    try {
      // Operations without a body (the deletes) print nothing.
      const parsed: unknown = result.stdout.trim() ? JSON.parse(result.stdout) : {};
      const value = parsed && typeof parsed === 'object' ? read(parsed as Record<string, unknown>) : undefined;
      if (value !== undefined) return { ok: true, value };
    } catch { /* Reported below as an unreadable answer. */ }
    return { ok: false, failure: { kind: 'unknown', detail: `Unreadable answer from aws ${argv.slice(0, 2).join(' ')}` } };
  }
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
  return {
    callerIdentity: () => call(['sts', 'get-caller-identity'], output => {
      const account = text(output.Account), arn = text(output.Arn);
      return account && arn ? { account, arn } : undefined;
    }),
    simulatePermissions: ({ principalArn, actions, resources, context = [] }) => call(['iam', 'simulate-principal-policy', '--policy-source-arn', principalArn,
      '--action-names', ...actions, '--resource-arns', ...resources,
      ...(context.length > 0 ? ['--context-entries', ...context.map(entry => `ContextKeyName=${entry.key},ContextKeyValues=${entry.value},ContextKeyType=string`)] : [])], output => {
      if (!Array.isArray(output.EvaluationResults)) return undefined;
      const evaluations = output.EvaluationResults as { EvalActionName?: unknown; EvalDecision?: unknown }[];
      // An action is allowed only when every evaluated resource allows it; an action the answer does not mention is not allowed.
      return actions.map(action => {
        const own = evaluations.filter(evaluation => evaluation.EvalActionName === action);
        return { action, allowed: own.length > 0 && own.every(evaluation => evaluation.EvalDecision === 'allowed') };
      });
    }),
    role: name => call(['iam', 'get-role', '--role-name', name], output => {
      const arn = text((output.Role as { Arn?: unknown } | undefined)?.Arn);
      return arn ? { arn } : undefined;
    }),
    // S3 answers `null` for us-east-1 and the legacy `EU` for eu-west-1.
    bucketRegion: bucket => call(['s3api', 'get-bucket-location', '--bucket', bucket], output => 'LocationConstraint' in output
      ? { region: output.LocationConstraint === null ? 'us-east-1' : output.LocationConstraint === 'EU' ? 'eu-west-1' : String(output.LocationConstraint) } : undefined),
    listImages: () => call(['lambda-microvms', 'list-microvm-images'], output => Array.isArray(output.items)
      ? (output.items as { name?: unknown; state?: unknown; imageArn?: unknown }[]).map(item => ({ name: String(item.name), state: String(item.state),
        ...(text(item.imageArn) ? { imageArn: text(item.imageArn)! } : {}) })) : undefined),
    // Proven shape of the proof was `aws s3 cp`; `s3api put-object` is the long-standing API that also takes the object tags in one call.
    putBuildArtifact: async ({ bucket, key, body, tags }) => {
      const directory = await mkdtemp(join(tmpdir(), 'factory-lambda-artifact-'));
      try {
        const file = join(directory, 'artifact.zip');
        await writeFile(file, body, { mode: 0o600 });
        return await call(['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', file, '--tagging', new URLSearchParams(tags).toString()],
          () => ({ uri: `s3://${bucket}/${key}` }));
      } finally { await rm(directory, { recursive: true, force: true }); }
    },
    // Proven shape (Alpine proof, `bin/build`), except `--tags` given as a JSON map instead of the single `key=value` the proof passed.
    createImage: input => call(['lambda-microvms', 'create-microvm-image', '--name', input.name, '--description', input.description,
      '--base-image-arn', input.baseImageArn, '--base-image-version', input.baseImageVersion, '--build-role-arn', input.buildRoleArn,
      '--code-artifact', `uri=${input.artifactUri}`, '--cpu-configurations', `architecture=${input.architecture === 'arm64' ? 'ARM_64' : 'X86_64'}`,
      '--resources', `minimumMemoryInMiB=${input.minimumMemoryMiB}`, '--additional-os-capabilities', ...input.additionalOsCapabilities,
      '--hooks', JSON.stringify({ port: input.hooks.port,
        microvmHooks: { run: 'ENABLED', runTimeoutInSeconds: input.hooks.runTimeoutSeconds, terminate: 'ENABLED', terminateTimeoutInSeconds: input.hooks.terminateTimeoutSeconds },
        microvmImageHooks: { ready: 'ENABLED', readyTimeoutInSeconds: input.hooks.readyTimeoutSeconds } }),
      '--tags', JSON.stringify(input.tags)], output => {
      const imageArn = text(output.imageArn), state = text(output.state);
      return imageArn && state ? { imageArn, state } : undefined;
    }),
    // Proven shape (`bin/wait-image`): by ARN; the answer of a failed image has no reason.
    image: imageArn => call(['lambda-microvms', 'get-microvm-image', '--image-identifier', imageArn], output => {
      const name = text(output.name), state = text(output.state);
      if (!name || !state) return undefined;
      const tags = output.tags && typeof output.tags === 'object' ? Object.fromEntries(Object.entries(output.tags).map(([key, value]) => [key, String(value)])) : {};
      const active = text(output.latestActiveImageVersion), failed = text(output.latestFailedImageVersion);
      return { name, imageArn: text(output.imageArn) ?? imageArn, state, tags, ...(active ? { latestActiveImageVersion: active } : {}), ...(failed ? { latestFailedImageVersion: failed } : {}) };
    }),
    imageBuilds: imageArn => call(imageBuildsCommand(imageArn), output => Array.isArray(output.items)
      ? (output.items as Record<string, unknown>[]).map(item => ({ buildId: String(item.buildId), imageVersion: String(item.imageVersion), state: String(item.buildState),
        ...(text(item.stateReason) ? { stateReason: text(item.stateReason)! } : {}) })) : undefined),
    buildLog: logGroup => call(buildLogCommand(logGroup), buildLogLines),
    // Proven shapes (`bin/cleanup`).
    deleteImageVersion: ({ imageArn, version }) => call(['lambda-microvms', 'delete-microvm-image-version', '--image-identifier', imageArn, '--image-version', version], () => null),
    deleteImage: imageArn => call(['lambda-microvms', 'delete-microvm-image', '--image-identifier', imageArn], () => null),
    // Long-standing S3 and CloudWatch Logs APIs; the proofs' cleanup removed the bucket and the groups with an administrative identity.
    deleteBuildArtifact: ({ bucket, key }) => call(['s3api', 'delete-object', '--bucket', bucket, '--key', key], () => null),
    deleteBuildLog: logGroup => call(['logs', 'delete-log-group', '--log-group-name', logGroup], () => null),
    listMicrovms: () => call(listMicrovmsCommand, listedMicrovms),
    runMicrovm: input => call(runMicrovmCommand(input, region), output => {
      const microvmId = text(output.microvmId), endpoint = text(output.endpoint);
      return microvmId && endpoint ? { microvmId, endpoint } : undefined;
    }),
    // Proven shape (`bin/down`, evidence `l1-final.json`).
    microvm: microvmId => call(['lambda-microvms', 'get-microvm', '--microvm-identifier', microvmId], output => {
      const state = text(output.state);
      if (!state) return undefined;
      const optional = Object.fromEntries((['endpoint', 'imageArn', 'imageVersion', 'stateReason', 'startedAt', 'terminatedAt'] as const)
        .flatMap(key => text(output[key]) ? [[key, text(output[key])!]] : []));
      return { microvmId: text(output.microvmId) ?? microvmId, state, ...optional };
    }),
    // Proven shape: an empty answer that says nothing about the state.
    terminateMicrovm: microvmId => call(['lambda-microvms', 'terminate-microvm', '--microvm-identifier', microvmId], () => null),
    // Proven shape (`bin/tok`): one token per port, at response path `authToken."X-aws-proxy-auth"`.
    createAuthToken: ({ microvmId, port, expirationMinutes }) => call(['lambda-microvms', 'create-microvm-auth-token', '--microvm-identifier', microvmId,
      '--expiration-in-minutes', String(expirationMinutes), '--allowed-ports', JSON.stringify([{ port }])], output => {
      const token = text((output.authToken as Record<string, unknown> | undefined)?.['X-aws-proxy-auth']);
      return token ? { token } : undefined;
    }),
    allocatedMemoryQuota: architecture => call(['service-quotas', 'list-service-quotas', '--service-code', 'lambda'], output => memoryQuota(output, architecture)),
  };
}

/**
 * RunMicrovm as the proofs called it (`bin/up`): image by ARN, the two AWS-managed network connectors, the maximum duration and the run
 * hook payload. No `--execution-role-arn` (the guest has no AWS credentials) and no `--idle-policy`: omitting it is what kept automatic
 * suspension off in the proofs (inferred from the documentation, V2-09).
 *
 * NOT PROVEN, isolated here: `--tags`. RunMicrovm has no documented tags field and no proof ever tagged a MicroVM (V2-33 asks for
 * installation and Work tags on every resource). If the service refuses the flag, this is the one place to change, and the inventory of
 * ticket 15 falls back to the image tags plus the host's boot records.
 */
export function runMicrovmCommand(input: LambdaMicrovmRequest, region: string): string[] {
  const connector = (name: string) => `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${name}`;
  return ['lambda-microvms', 'run-microvm', '--image-identifier', input.imageArn,
    '--ingress-network-connectors', connector(microvmIngress), '--egress-network-connectors', connector(microvmEgress),
    '--maximum-duration-in-seconds', String(input.maximumDurationSeconds), '--run-hook-payload', input.runHookPayload,
    ...(Object.keys(input.tags).length > 0 ? ['--tags', JSON.stringify(input.tags)] : [])];
}

/**
 * ListMicrovms as the proofs called it (`items[]` with `microvmId`, `state`, `imageArn`, `imageVersion`, `startedAt`; terminated MicroVMs
 * stay listed). The CLI follows the pages (50 items each); more than one page was never exercised.
 *
 * NOT PROVEN, isolated here: `tags` on an item. The observed answer has none; an item that carries a `tags` map is read, so that the
 * inventory of ticket 15 decides by the MicroVM's own tags if the service ever lists them, and by the tags of its image otherwise.
 */
export const listMicrovmsCommand: readonly string[] = ['lambda-microvms', 'list-microvms'];
export function listedMicrovms(output: Record<string, unknown>): LambdaListedMicrovm[] | undefined {
  if (!Array.isArray(output.items)) return undefined;
  const items: LambdaListedMicrovm[] = [];
  for (const item of output.items as Record<string, unknown>[]) {
    // An item without id or state makes the whole listing unreadable: an inventory is never silently partial.
    if (!item || typeof item.microvmId !== 'string' || !item.microvmId || typeof item.state !== 'string' || !item.state) return undefined;
    const tags = item.tags && typeof item.tags === 'object' && !Array.isArray(item.tags)
      ? Object.fromEntries(Object.entries(item.tags).map(([key, value]) => [key, String(value)])) : undefined;
    items.push({ microvmId: item.microvmId, state: item.state, ...(typeof item.imageArn === 'string' && item.imageArn ? { imageArn: item.imageArn } : {}),
      ...(typeof item.startedAt === 'string' && item.startedAt ? { startedAt: item.startedAt } : {}), ...(tags ? { tags } : {}) });
  }
  return items;
}

/**
 * NOT PROVEN, the one place for the unobserved read shapes of ticket 03. The Alpine proof kept the RESULTS (the build records and the
 * build log lines) but not the commands that read them:
 * - `list-microvm-image-builds` is assumed to take the image ARN alone and answer `items[]` with `buildState`/`stateReason` (the answer
 *   shape is the observed one). It may require the image version.
 * - The build log is read with `logs filter-log-events` over the WHOLE log group `/aws/lambda-microvms/<image name>` (the CLI follows the
 *   pages), `events[].message` in the order returned. How the service names the log streams, and how to select the stream of one build, is
 *   unknown; an image of the Factory has a single version, so its group holds only that version's builds (one per chip generation).
 */
export const imageBuildsCommand = (imageArn: string): string[] => ['lambda-microvms', 'list-microvm-image-builds', '--image-identifier', imageArn];
export const buildLogCommand = (logGroup: string): string[] => ['logs', 'filter-log-events', '--log-group-name', logGroup];
export function buildLogLines(output: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(output.events)) return undefined;
  return (output.events as { message?: unknown }[]).flatMap(event => typeof event.message === 'string' ? [event.message] : []);
}

/**
 * NOT PROVEN (the proofs recorded the quota VALUE, 8 GB for ARM, but neither the command nor the quota code or name): the MicroVM
 * allocated-memory quota is looked up among the `lambda` service quotas by NAME (a MicroVM quota about memory, for the architecture when
 * the name tells architectures apart) and its value is read as GiB. Anything else (no such quota, several candidates, a non-numeric
 * value) is an unreadable quota, which `validate` reports as unverified. This function is the one place to correct once the real shape
 * is observed in an account.
 */
export function memoryQuota(output: Record<string, unknown>, architecture: LambdaArchitecture): { mebibytes: number } | undefined {
  if (!Array.isArray(output.Quotas)) return undefined;
  const memory = (output.Quotas as { QuotaName?: unknown; Value?: unknown }[]).filter(quota => typeof quota.QuotaName === 'string'
    && /microvm/i.test(quota.QuotaName) && /memory/i.test(quota.QuotaName));
  const own = architecture === 'arm64' ? /arm|graviton/i : /x86|intel|amd/i;
  const named = memory.filter(quota => own.test(quota.QuotaName as string));
  const candidates = named.length > 0 ? named : memory.filter(quota => !/arm|graviton|x86|intel|amd/i.test(quota.QuotaName as string));
  const value = candidates.length === 1 ? candidates[0]!.Value : undefined;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? { mebibytes: Math.round(value * 1024) } : undefined;
}
