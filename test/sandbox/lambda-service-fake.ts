import { installationResources, type LambdaArchitecture, type LambdaImageRequest, type LambdaService, type LambdaServiceFactory, type LambdaServiceFailure,
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
};
export type FakeLambdaImage = { name: string; state: string; imageArn: string; tags?: Record<string, string>; version?: string; request?: LambdaImageRequest;
  readyAt?: number; failure?: string[] | null;
  /** One CreateMicrovmImage request gives two build records (Graviton 3 and 4), as observed. */
  builds?: { buildId: string; imageVersion: string; state: string; stateReason?: string }[] };

export type FakeLambdaCall = { operation: keyof LambdaService; awsProfile: string; region: string; input?: unknown };

/** A correctly installed account for `installation` in `region`, reached through the AWS profile `factory` as the operation role. */
export function lambdaAccountFake({ installation = 'acme', region = 'us-east-1', account = '123456789012' } = {}) {
  const resources = installationResources({ installation, region }, account);
  const world: FakeLambdaAccount = {
    cli: true, account,
    profiles: { factory: { arn: `arn:aws:sts::${account}:assumed-role/${resources.operationRole}/factory-session` } },
    regions: [region], roles: [resources.operationRole, resources.buildRole], buckets: { [resources.artifactBucket]: region },
    denied: [], memoryQuotaMiB: { arm64: 8192, x86_64: 8192 }, images: [],
    clock: { now: Date.UTC(2026, 10, 21) }, buildSeconds: 130, failedBuildSeconds: 53, buildFailure: null, objects: {}, logs: {},
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
  };
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
      return Promise.resolve(answer());
    };
    const images: Pick<LambdaService, 'putBuildArtifact' | 'createImage' | 'image' | 'imageBuilds' | 'buildLog' | 'deleteImageVersion' | 'deleteImage'> = {
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
    return {
      ...images,
      callerIdentity: () => reach('callerIdentity', null, undefined, () => ({ ok: true, value: { account: world.account, arn: (world.profiles[awsProfile] as { arn: string }).arn } })),
      simulatePermissions: input => reach('simulatePermissions', 'iam:SimulatePrincipalPolicy', input, () => ({ ok: true,
        value: input.actions.map(action => ({ action, allowed: !world.denied.includes(action) })) })),
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
  return { account: world, resources, calls, mutations, service };
}
