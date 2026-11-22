import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { installationResources, type LambdaArchitecture, type LambdaImageRequest, type LambdaMicrovmRequest, type LambdaService, type LambdaServiceFactory, type LambdaServiceFailure,
  type LambdaServiceResult } from '../../src/sandbox/index.js';

/**
 * v2 Lambda tickets: the in-memory AWS account behind the `LambdaService` port, shared by every test that needs the service (the CI has
 * no AWS account). It models an ACCOUNT, not call scripts: tests mutate `account` (delete a role, deny an action, lower the quota) and
 * read `calls`. Ticket 02 covers identity, region, permissions, installation resources and quota; tickets 03, 04, 14 and 15 extend the
 * same account with images, MicroVMs, tokens and tags (ticket 03: images, their builds and build logs, build artifacts). `mutations` lists every state-changing operation: it must stay empty for any
 * read-only flow (`validate` never starts a MicroVM).
 */
export type FakeLambdaAccount = {
  /** Whether the `aws` executable exists on the host. */
  cli: boolean;
  account: string;
  /** Named AWS profiles of the Operator: the principal each one resolves to, or a profile with no usable credentials. */
  profiles: Record<string, { arn: string } | { expired: true }>;
  /** Regions where the Lambda MicroVMs service answers. */
  regions: string[];
  /** IAM role names. */
  roles: string[];
  /** S3 buckets and the region each one lives in. */
  buckets: Record<string, string>;
  /** IAM actions the identity lacks: refused by the policy simulation AND by the direct call that needs them. */
  denied: string[];
  /**
   * IAM actions the policy SIMULATOR does not evaluate: it answers `implicitDeny` for them whatever the policy grants, while the real call
   * is allowed. Observed in a real account on 2026-11-21 for `lambda:PassNetworkConnector` (the role had the statement and a real
   * RunMicrovm worked). The default is that observation, so that a "correct account" here answers what a real correct account answers.
   */
  simulatorDoesNotEvaluate: string[];
  /** Allocated-memory quota per architecture, MiB; `null`: the quota cannot be read. */
  memoryQuotaMiB: Record<LambdaArchitecture, number> | null;
  /** MicroVM images. A `CREATING` image settles at `readyAt` (account time) into `CREATED`, or `CREATE_FAILED` when its build log is a failing one. */
  images: FakeLambdaImage[];
  /** Account time in milliseconds: only the test moves it (a fake clock, never a real wait). */
  clock: { now: number };
  /** How long a successful build takes; a failing one ends after `failedBuildSeconds`. Observed in the Alpine proof: 130 s and 53 s. */
  buildSeconds: number; failedBuildSeconds: number;
  /** When set, every build STARTED from now on fails and this is its build log (BuildKit lines). */
  buildFailure: string[] | null;
  /** S3 objects per bucket and key. */
  objects: Record<string, Record<string, { body: Uint8Array; tags: Record<string, string> }>>;
  /** CloudWatch log groups written by the build role: lines per group. */
  logs: Record<string, string[]>;
  /**
   * Ticket 04: MicroVMs, including terminated ones (the service keeps listing them). A requested end becomes `TERMINATED` only
   * `terminateSeconds` later (observed 4 to 8 s); `null`: the service never confirms within any wait. A MicroVM that outlives its maximum
   * duration is ended by the service itself. `kill(id)` ends one at once, as a loss.
   */
  microvms: FakeLambdaMicrovm[];
  terminateSeconds: number | null;
  /** Seconds a new MicroVM stays `PENDING`. */
  pendingSeconds: number;
  /** When set, the `run` hook of every MicroVM started from now on fails: it goes to `TERMINATING` without ever being `RUNNING`. */
  runHookFails: boolean;
  /** When set, RunMicrovm is refused with this failure (quota, capacity). */
  runRefusal: LambdaServiceFailure | null;
  /** Ingress tokens issued: one MicroVM, one port, an expiry in account time. */
  tokens: { token: string; microvmId: string; port: number; expiresAt: number }[];
  /**
   * Ticket 15: whether ListMicrovms shows the tags a MicroVM was run with. `false` is the OBSERVED answer (no tags on an item); `true`
   * models a service that lists them. The inventory must find the installation's MicroVMs either way.
   */
  listsMicrovmTags: boolean;
};
export type FakeLambdaMicrovm = { microvmId: string; endpoint: string; imageArn: string; imageVersion: string; state: string; stateReason?: string;
  request: LambdaMicrovmRequest; startedAt: number; runningAt: number; terminatedAt?: number; terminatesAt?: number;
  /** The proofs never saw these on a Factory MicroVM; the fake has them so a test can assert they stay absent. */ executionRole: null; idlePolicy: null;
  ingress: string[]; egress: string[] };
export type FakeLambdaImage = { name: string; state: string; imageArn: string; tags?: Record<string, string>; version?: string; request?: LambdaImageRequest;
  readyAt?: number; failure?: string[] | null;
  /** One CreateMicrovmImage request gives two build records (Graviton 3 and 4), as observed. */
  builds?: { buildId: string; imageVersion: string; state: string; stateReason?: string }[] };

export type FakeLambdaCall = { operation: keyof LambdaService; awsProfile: string; region: string; input?: unknown };

const encode = (world: FakeLambdaAccount) => JSON.stringify(world, (_key, value: unknown) => value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString('base64') }
  : value === Number.POSITIVE_INFINITY ? { $infinity: true } : value);
const decode = (text: string) => JSON.parse(text, (_key, value: unknown) => {
  if (value && typeof value === 'object' && '$bytes' in value) return Uint8Array.from(Buffer.from((value as { $bytes: string }).$bytes, 'base64'));
  if (value && typeof value === 'object' && '$infinity' in value) return Number.POSITIVE_INFINITY;
  return value;
}) as FakeLambdaAccount;

/**
 * A correctly installed account for `installation` in `region`, reached through the AWS profile `factory` as the operation role.
 *
 * `stateFile` (ticket 15): the account outlives the process, as the real one does. The state is read from the file when the fake is
 * created (if the file exists) and written back, atomically, after every service operation and on `persist()`: a process killed with
 * SIGKILL leaves the account exactly as its last operation left it, and its successor composes a new fake over the same file. The path is
 * the test's own temporary one; without it the account is in memory only.
 */
export function lambdaAccountFake({ installation = 'acme', region = 'us-east-1', account = '123456789012', stateFile }: { installation?: string; region?: string; account?: string; stateFile?: string } = {}) {
  const resources = installationResources({ installation, region }, account);
  const world: FakeLambdaAccount = {
    cli: true, account,
    profiles: { factory: { arn: `arn:aws:sts::${account}:assumed-role/${resources.operationRole}/factory-session` } },
    regions: [region], roles: [resources.operationRole, resources.buildRole], buckets: { [resources.artifactBucket]: region },
    denied: [], simulatorDoesNotEvaluate: ['lambda:PassNetworkConnector'], memoryQuotaMiB: { arm64: 8192, x86_64: 8192 }, images: [],
    clock: { now: Date.UTC(2026, 10, 21) }, buildSeconds: 130, failedBuildSeconds: 53, buildFailure: null, objects: {}, logs: {},
    microvms: [], terminateSeconds: 5, pendingSeconds: 1, runHookFails: false, runRefusal: null, tokens: [], listsMicrovmTags: false,
  };
  if (stateFile && existsSync(stateFile)) Object.assign(world, decode(readFileSync(stateFile, 'utf8')));
  /** File-backed account only: writes the account as it is now (after a test changed `account` directly). */
  const persist = () => {
    if (!stateFile) return;
    writeFileSync(`${stateFile}.tmp`, encode(world), { mode: 0o600 });
    renameSync(`${stateFile}.tmp`, stateFile);
  };
  const calls: FakeLambdaCall[] = [];
  const mutations: FakeLambdaCall[] = [];
  const fail = (kind: LambdaServiceFailure['kind'], extra: Omit<LambdaServiceFailure, 'kind'> = {}) => ({ ok: false as const, failure: { kind, ...extra } });
  const genericFailure = 'The container image build failed.';
  /** Builds end when the account's time passes their `readyAt`: the service is asynchronous, the caller only sees it on a later read. */
  const settle = () => {
    for (const image of world.images) {
      if (image.state !== 'CREATING' || image.readyAt === undefined || world.clock.now < image.readyAt) continue;
      const failed = Boolean(image.failure);
      image.state = failed ? 'CREATE_FAILED' : 'CREATED';
      image.builds = (image.builds ?? []).map(build => ({ ...build, state: failed ? 'FAILED' : 'SUCCESSFUL', ...(failed ? { stateReason: genericFailure } : {}) }));
      world.logs[`/aws/lambda-microvms/${image.name}`] = image.failure ?? ['#1 [internal] load build definition from Dockerfile\n', '#1 DONE 0.0s\n'];
    }
    for (const microvm of world.microvms) {
      if (microvm.state === 'TERMINATED') continue;
      const lifetimeEnd = microvm.startedAt + microvm.request.maximumDurationSeconds * 1000;
      if (microvm.terminatesAt !== undefined && world.clock.now >= microvm.terminatesAt) {
        Object.assign(microvm, { state: 'TERMINATED', terminatedAt: microvm.terminatesAt, stateReason: microvm.stateReason ?? 'Success.' });
      } else if (microvm.terminatesAt === undefined && world.clock.now >= lifetimeEnd) {
        Object.assign(microvm, { state: 'TERMINATED', terminatedAt: lifetimeEnd, stateReason: 'MicroVM exceeded maximum lifetime.' });
      } else if (microvm.state === 'PENDING' && world.clock.now >= microvm.runningAt) microvm.state = 'RUNNING';
    }
  };
  /** The MicroVM dies now without anyone asking (a loss): the service reports it terminated on the next read. */
  const kill = (microvmId: string, stateReason = 'MicroVM exceeded maximum lifetime.') => {
    const microvm = world.microvms.find(candidate => candidate.microvmId === microvmId);
    if (microvm && microvm.state !== 'TERMINATED') Object.assign(microvm, { state: 'TERMINATED', terminatedAt: world.clock.now, stateReason });
  };
  /** What the service's ingress proxy decides for a NEW connection: the MicroVM must be running and the token valid for that port. */
  const admits = (input: { endpoint: string; port: number; token: string }): 'admitted' | 'forbidden' | 'gone' => {
    settle();
    const microvm = world.microvms.find(candidate => candidate.endpoint === input.endpoint);
    if (!microvm || microvm.state !== 'RUNNING') return 'gone';
    return world.tokens.some(token => token.token === input.token && token.microvmId === microvm.microvmId && token.port === input.port && world.clock.now < token.expiresAt)
      ? 'admitted' : 'forbidden';
  };
  const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
  const service: LambdaServiceFactory = ({ awsProfile, region: target }) => {
    const arnOf = (name: string) => `arn:aws:lambda:${target}:${world.account}:microvm-image:${name}`;
    const find = (imageArn: string) => { settle(); return world.images.find(image => image.imageArn === imageArn); };
    /** A state-changing operation: recorded in `mutations` whatever its outcome. */
    const change = <T>(operation: keyof LambdaService, action: string, input: unknown, answer: () => LambdaServiceResult<T>) => {
      mutations.push({ operation, awsProfile, region: target, input });
      return reach(operation, action, input, answer);
    };
    /** Every operation first needs the CLI, the profile and its identity; then the action it is authorized by. */
    const reach = <T>(operation: keyof LambdaService, action: string | null, input: unknown, answer: () => LambdaServiceResult<T>): Promise<LambdaServiceResult<T>> => {
      calls.push({ operation, awsProfile, region: target, ...(input === undefined ? {} : { input }) });
      if (!world.cli) return Promise.resolve(fail('cli-unavailable'));
      const profile = world.profiles[awsProfile];
      if (!profile) return Promise.resolve(fail('profile-not-found', { detail: `The config profile (${awsProfile}) could not be found` }));
      if ('expired' in profile) return Promise.resolve(fail('no-identity', { detail: 'The security token included in the request is expired' }));
      if (action && world.denied.includes(action)) return Promise.resolve(fail('access-denied', { action }));
      const answered = answer();
      persist();
      return Promise.resolve(answered);
    };
    const images: Pick<LambdaService, 'putBuildArtifact' | 'createImage' | 'image' | 'imageBuilds' | 'buildLog' | 'deleteImageVersion' | 'deleteImage' | 'deleteBuildArtifact' | 'deleteBuildLog'> = {
      deleteBuildArtifact: input => change('deleteBuildArtifact', 's3:DeleteObject', input, () => {
        if (!world.buckets[input.bucket]) return fail('not-found', { detail: 'NoSuchBucket' });
        delete world.objects[input.bucket]?.[input.key];
        return { ok: true, value: null };
      }),
      deleteBuildLog: logGroup => change('deleteBuildLog', 'logs:DeleteLogGroup', logGroup, () => {
        if (!world.logs[logGroup]) return fail('not-found', { detail: 'The specified log group does not exist' });
        delete world.logs[logGroup];
        return { ok: true, value: null };
      }),
      putBuildArtifact: input => change('putBuildArtifact', 's3:PutObject', { bucket: input.bucket, key: input.key, bytes: input.body.byteLength, tags: input.tags }, () => {
        if (!world.buckets[input.bucket]) return fail('not-found', { detail: 'NoSuchBucket' });
        if (world.denied.includes('s3:PutObjectTagging')) return fail('access-denied', { action: 's3:PutObjectTagging' });
        (world.objects[input.bucket] ??= {})[input.key] = { body: Uint8Array.from(input.body), tags: { ...input.tags } };
        return { ok: true, value: { uri: `s3://${input.bucket}/${input.key}` } };
      }),
      createImage: input => change('createImage', 'lambda:CreateMicrovmImage', input, () => {
        if (!world.regions.includes(target)) return fail('region-unavailable');
        // Assumed (not observed): tagging at creation needs TagResource, as for other Lambda resources.
        if (Object.keys(input.tags).length > 0 && world.denied.includes('lambda:TagResource')) return fail('access-denied', { action: 'lambda:TagResource' });
        if (world.images.some(image => image.name === input.name)) return fail('conflict', { detail: `An image named ${input.name} already exists` });
        const [, bucket, key] = /^s3:\/\/([^/]+)\/(.+)$/.exec(input.artifactUri) ?? [];
        if (!bucket || !key || !world.objects[bucket]?.[key]) return fail('not-found', { detail: 'The code artifact does not exist' });
        if (world.buckets[bucket] !== target) return fail('unknown', { detail: 'The code artifact must be in the same region as the image' });
        if (!world.roles.some(role => input.buildRoleArn.endsWith(`:role/${role}`))) return fail('not-found', { detail: 'The build role does not exist' });
        const failure = world.buildFailure ? [...world.buildFailure] : null;
        const serial = world.images.length + mutations.length;
        world.images.push({ name: input.name, imageArn: arnOf(input.name), state: 'CREATING', tags: { ...input.tags }, version: '1.0', request: input, failure,
          readyAt: world.clock.now + (failure ? world.failedBuildSeconds : world.buildSeconds) * 1000,
          builds: ['3', '4'].map(generation => ({ buildId: `build-${serial}-graviton${generation}`, imageVersion: '1.0', state: 'IN_PROGRESS' })) });
        return { ok: true, value: { imageArn: arnOf(input.name), state: 'CREATING' } };
      }),
      image: imageArn => reach('image', 'lambda:GetMicrovmImage', imageArn, () => {
        const image = find(imageArn);
        if (!image) return fail('not-found');
        return { ok: true, value: { name: image.name, imageArn: image.imageArn, state: image.state, tags: { ...image.tags },
          ...(image.state === 'CREATED' ? { latestActiveImageVersion: image.version ?? '1.0' } : {}),
          ...(image.state === 'CREATE_FAILED' ? { latestFailedImageVersion: image.version ?? '1.0' } : {}) } };
      }),
      imageBuilds: imageArn => reach('imageBuilds', 'lambda:ListMicrovmImageBuilds', imageArn, () => {
        const image = find(imageArn);
        return image ? { ok: true, value: (image.builds ?? []).map(build => ({ ...build })) } : fail('not-found');
      }),
      buildLog: logGroup => reach('buildLog', 'logs:FilterLogEvents', logGroup, () => {
        settle();
        return world.logs[logGroup] ? { ok: true, value: [...world.logs[logGroup]] } : fail('not-found', { detail: 'The specified log group does not exist' });
      }),
      deleteImageVersion: input => change('deleteImageVersion', 'lambda:DeleteMicrovmImageVersion', input, () => {
        const image = find(input.imageArn);
        if (!image || image.version !== input.version) return fail('not-found');
        delete image.version;
        return { ok: true, value: null };
      }),
      deleteImage: imageArn => change('deleteImage', 'lambda:DeleteMicrovmImage', imageArn, () => {
        const image = find(imageArn);
        if (!image) return fail('not-found');
        if (image.version !== undefined) return fail('conflict', { detail: 'The image still has versions' });
        world.images.splice(world.images.indexOf(image), 1);
        return { ok: true, value: null };
      }),
    };
    const findMicrovm = (microvmId: string) => { settle(); return world.microvms.find(microvm => microvm.microvmId === microvmId); };
    const microvms: Pick<LambdaService, 'runMicrovm' | 'microvm' | 'terminateMicrovm' | 'createAuthToken' | 'listMicrovms'> = {
      // Every MicroVM of the account, terminated ones included, whoever ran it; tags only when the modelled service lists them.
      listMicrovms: () => reach('listMicrovms', 'lambda:ListMicrovms', undefined, () => {
        settle();
        return { ok: true, value: world.microvms.map(microvm => ({ microvmId: microvm.microvmId, state: microvm.state, imageArn: microvm.imageArn, startedAt: iso(microvm.startedAt),
          ...(world.listsMicrovmTags ? { tags: { ...microvm.request.tags } } : {}) })) };
      }),
      runMicrovm: input => change('runMicrovm', 'lambda:RunMicrovm', input, () => {
        if (world.runRefusal) return { ok: false, failure: world.runRefusal };
        const image = find(input.imageArn);
        if (!image || image.state !== 'CREATED') return fail('not-found', { detail: 'The image has no active version' });
        if (Object.keys(input.tags).length > 0 && world.denied.includes('lambda:TagResource')) return fail('access-denied', { action: 'lambda:TagResource' });
        const serial = String(world.microvms.length + 1).padStart(12, '0');
        const microvmId = `microvm-00000000-0000-4000-8000-${serial}`;
        const failed = world.runHookFails;
        world.microvms.push({ microvmId, endpoint: `${microvmId}.lambda-microvm.${target}.on.aws`, imageArn: input.imageArn, imageVersion: image.version ?? '1.0',
          state: failed ? 'TERMINATING' : 'PENDING', request: { ...input, tags: { ...input.tags } }, startedAt: world.clock.now,
          runningAt: world.clock.now + world.pendingSeconds * 1000, executionRole: null, idlePolicy: null,
          ...(failed ? { terminatesAt: world.clock.now + 2000, stateReason: 'The run hook failed.' } : {}),
          ingress: [`arn:aws:lambda:${target}:aws:network-connector:aws-network-connector:HTTP_INGRESS`],
          egress: [`arn:aws:lambda:${target}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`] });
        return { ok: true, value: { microvmId, endpoint: `${microvmId}.lambda-microvm.${target}.on.aws` } };
      }),
      microvm: microvmId => reach('microvm', 'lambda:GetMicrovm', microvmId, () => {
        const microvm = findMicrovm(microvmId);
        if (!microvm) return fail('not-found');
        return { ok: true, value: { microvmId, state: microvm.state, endpoint: microvm.endpoint, imageArn: microvm.imageArn, imageVersion: microvm.imageVersion,
          startedAt: iso(microvm.startedAt), ...(microvm.stateReason ? { stateReason: microvm.stateReason } : {}),
          ...(microvm.terminatedAt !== undefined ? { terminatedAt: iso(microvm.terminatedAt) } : {}) } };
      }),
      terminateMicrovm: microvmId => change('terminateMicrovm', 'lambda:TerminateMicrovm', microvmId, () => {
        const microvm = findMicrovm(microvmId);
        if (!microvm) return fail('not-found');
        // Idempotent and empty: the answer says nothing about the state.
        if (microvm.state !== 'TERMINATED' && microvm.state !== 'TERMINATING') {
          microvm.state = 'TERMINATING';
          if (world.terminateSeconds !== null) microvm.terminatesAt = world.clock.now + world.terminateSeconds * 1000;
          else microvm.terminatesAt = Number.POSITIVE_INFINITY;
        }
        return { ok: true, value: null };
      }),
      createAuthToken: input => reach('createAuthToken', 'lambda:CreateMicrovmAuthToken', { microvmId: input.microvmId, port: input.port, expirationMinutes: input.expirationMinutes }, () => {
        const microvm = findMicrovm(input.microvmId);
        if (!microvm) return fail('not-found');
        // Assumed (not observed): no token is issued for a MicroVM that ended.
        if (microvm.state === 'TERMINATED') return fail('conflict', { detail: 'The MicroVM is terminated' });
        if (input.expirationMinutes < 1 || input.expirationMinutes > 60) return fail('unknown', { detail: 'expirationInMinutes must be between 1 and 60' });
        const token = `fake-proxy-token-${world.tokens.length + 1}`;
        world.tokens.push({ token, microvmId: input.microvmId, port: input.port, expiresAt: world.clock.now + input.expirationMinutes * 60_000 });
        return { ok: true, value: { token } };
      }),
    };
    return {
      ...images, ...microvms,
      callerIdentity: () => reach('callerIdentity', null, undefined, () => ({ ok: true, value: { account: world.account, arn: (world.profiles[awsProfile] as { arn: string }).arn } })),
      simulatePermissions: input => reach('simulatePermissions', 'iam:SimulatePrincipalPolicy', input, () => ({ ok: true,
        value: input.actions.map(action => ({ action, allowed: !world.denied.includes(action) && !world.simulatorDoesNotEvaluate.includes(action) })) })),
      role: name => reach('role', 'iam:GetRole', name, () => world.roles.includes(name)
        ? { ok: true, value: { arn: `arn:aws:iam::${world.account}:role/${name}` } } : fail('not-found')),
      bucketRegion: bucket => reach('bucketRegion', 's3:GetBucketLocation', bucket, () => world.buckets[bucket]
        ? { ok: true, value: { region: world.buckets[bucket] } } : fail('not-found')),
      listImages: () => reach('listImages', 'lambda:ListMicrovmImages', undefined, () => world.regions.includes(target)
        ? { ok: true, value: (settle(), world.images.map(image => ({ name: image.name, state: image.state, imageArn: image.imageArn }))) } : fail('region-unavailable')),
      allocatedMemoryQuota: architecture => reach('allocatedMemoryQuota', 'servicequotas:ListServiceQuotas', architecture, () => world.memoryQuotaMiB
        ? { ok: true, value: { mebibytes: world.memoryQuotaMiB[architecture] } } : fail('unknown', { detail: 'No MicroVM memory quota was listed' })),
    };
  };
  /**
   * Ticket 15: a running MicroVM (and its image) of ANOTHER installation in the same account and region, as that installation's own
   * Factory would have created them. Nothing of this installation may ever touch either.
   */
  const plantOtherInstallation = (other: string) => {
    const name = `factory-${other}-${'9'.repeat(32)}`;
    const imageArn = `arn:aws:lambda:${region}:${world.account}:microvm-image:${name}`;
    const tags = { 'software-factory-installation': other, 'software-factory-work': `work-of-${other}` };
    if (!world.images.some(image => image.imageArn === imageArn)) world.images.push({ name, imageArn, state: 'CREATED', tags: { ...tags }, version: '1.0' });
    const microvmId = `microvm-00000000-0000-4000-9000-${String(world.microvms.length + 1).padStart(12, '0')}`;
    world.microvms.push({ microvmId, endpoint: `${microvmId}.lambda-microvm.${region}.on.aws`, imageArn, imageVersion: '1.0', state: 'RUNNING',
      request: { imageArn, maximumDurationSeconds: 28800, runHookPayload: '{}', tags }, startedAt: world.clock.now, runningAt: world.clock.now,
      executionRole: null, idlePolicy: null, ingress: [], egress: [] });
    persist();
    return { microvmId, imageArn };
  };
  return { account: world, resources, calls, mutations, service, kill, admits, settle, persist, plantOtherInstallation };
}

/**
 * The clock every Lambda adapter test gives the adapter: the fake account's own instant, and a `sleep` that moves it instead of waiting
 * (docs/guides/testing-strategy.md: a fake clock, never a sleep).
 */
export const accountClock = (fake: Pick<ReturnType<typeof lambdaAccountFake>, 'account'>) =>
  ({ now: () => fake.account.clock.now, sleep: async (milliseconds: number) => { fake.account.clock.now += milliseconds; } });
/** The image build wait of the composed tests, on that clock: polled every 10 s of account time, for at most 900 s. */
export const accountImageWait = (clock: { sleep(milliseconds: number): Promise<void> }) => ({ intervalSeconds: 10, maxSeconds: 900, sleep: clock.sleep });
