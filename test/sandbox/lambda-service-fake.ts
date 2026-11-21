import { installationResources, type LambdaArchitecture, type LambdaService, type LambdaServiceFactory, type LambdaServiceFailure,
  type LambdaServiceResult } from '../../src/sandbox/index.js';

/**
 * v2 Lambda tickets: the in-memory AWS account behind the `LambdaService` port, shared by every test that needs the service (the CI has
 * no AWS account). It models an ACCOUNT, not call scripts: tests mutate `account` (delete a role, deny an action, lower the quota) and
 * read `calls`. Ticket 02 covers identity, region, permissions, installation resources and quota; tickets 03, 04, 14 and 15 extend the
 * same account with images, MicroVMs, tokens and tags. `mutations` lists every state-changing operation: it must stay empty for any
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
  images: { name: string; state: string; imageArn: string }[];
};

export type FakeLambdaCall = { operation: keyof LambdaService; awsProfile: string; region: string; input?: unknown };

/** A correctly installed account for `installation` in `region`, reached through the AWS profile `factory` as the operation role. */
export function lambdaAccountFake({ installation = 'acme', region = 'us-east-1', account = '123456789012' } = {}) {
  const resources = installationResources({ installation, region }, account);
  const world: FakeLambdaAccount = {
    cli: true, account,
    profiles: { factory: { arn: `arn:aws:sts::${account}:assumed-role/${resources.operationRole}/factory-session` } },
    regions: [region], roles: [resources.operationRole, resources.buildRole], buckets: { [resources.artifactBucket]: region },
    denied: [], memoryQuotaMiB: { arm64: 8192, x86_64: 8192 }, images: [],
  };
  const calls: FakeLambdaCall[] = [];
  const mutations: FakeLambdaCall[] = [];
  const fail = (kind: LambdaServiceFailure['kind'], extra: Omit<LambdaServiceFailure, 'kind'> = {}) => ({ ok: false as const, failure: { kind, ...extra } });
  const service: LambdaServiceFactory = ({ awsProfile, region: target }) => {
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
    return {
      callerIdentity: () => reach('callerIdentity', null, undefined, () => ({ ok: true, value: { account: world.account, arn: (world.profiles[awsProfile] as { arn: string }).arn } })),
      simulatePermissions: input => reach('simulatePermissions', 'iam:SimulatePrincipalPolicy', input, () => ({ ok: true,
        value: input.actions.map(action => ({ action, allowed: !world.denied.includes(action) })) })),
      role: name => reach('role', 'iam:GetRole', name, () => world.roles.includes(name)
        ? { ok: true, value: { arn: `arn:aws:iam::${world.account}:role/${name}` } } : fail('not-found')),
      bucketRegion: bucket => reach('bucketRegion', 's3:GetBucketLocation', bucket, () => world.buckets[bucket]
        ? { ok: true, value: { region: world.buckets[bucket] } } : fail('not-found')),
      listImages: () => reach('listImages', 'lambda:ListMicrovmImages', undefined, () => world.regions.includes(target)
        ? { ok: true, value: world.images.map(image => ({ ...image })) } : fail('region-unavailable')),
      allocatedMemoryQuota: architecture => reach('allocatedMemoryQuota', 'servicequotas:ListServiceQuotas', architecture, () => world.memoryQuotaMiB
        ? { ok: true, value: { mebibytes: world.memoryQuotaMiB[architecture] } } : fail('unknown', { detail: 'No MicroVM memory quota was listed' })),
    };
  };
  return { account: world, resources, calls, mutations, service };
}
