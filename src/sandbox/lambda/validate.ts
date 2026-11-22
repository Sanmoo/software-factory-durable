import type { Diagnostic } from '../../contracts/index.js';
import { actionsTheIamSimulatorDoesNotEvaluate, installationResources, operationPolicy } from './installation.js';
import { acceptanceProfile, lambdaBootSize, provenMaxBootSeconds, type LambdaProfile } from './profile.js';
import type { LambdaService, LambdaServiceFailure } from './service.js';
import { lambdaHostTools, type HostToolProbe } from './host-tools.js';

const template = 'the release account template (assets/lambda/account-template.yaml, docs/lambda-installation.md)';
const describe = (failure: LambdaServiceFailure) => (failure.detail ? ` (${failure.detail})` : '');

/**
 * V2-02 "Validar" for a Lambda installation (V2-30, V2-31): the host tools of the channel, then identity, region, permissions, quota and installation resources, each with
 * its own cause. Read-only: it never creates, tags or starts anything, and what it could not read is `unverified`, never presumed.
 * `concurrency` is the installation's Builder concurrency (the existing `concurrency` setting); absent when it is not known.
 */
export async function validateLambdaInstallation({
  profile,
  concurrency,
  service,
  hostTool,
}: {
  profile: LambdaProfile;
  concurrency?: number | undefined;
  service: LambdaService;
  hostTool: HostToolProbe;
}): Promise<Diagnostic[]> {
  return [...(await hostToolChecks(hostTool)), ...(await accountChecks({ profile, concurrency, service }))];
}

/**
 * The host executables of the channel (`ssh-transport.ts`), each with its own cause: without them the first boot fails, whatever the account
 * allows. Only "can it be run from the PATH of this process" is checked; the channel itself is proven by a real boot (`lambda-runtime`).
 */
async function hostToolChecks(hostTool: HostToolProbe): Promise<Diagnostic[]> {
  const purpose = {
    ssh: 'the Lambda adapter reaches the guest over SSH with the system OpenSSH client',
    websocat: 'the SSH connection to the guest is carried in a WebSocket by `websocat`',
  };
  const checks: Diagnostic[] = [];
  for (const executable of lambdaHostTools) {
    checks.push(
      (await hostTool(executable).catch(() => false))
        ? { id: `lambda-${executable}`, status: 'ok', message: `The \`${executable}\` executable can be run from the PATH of this process.`, nextStep: 'None.' }
        : {
            id: `lambda-${executable}`,
            status: 'blocked',
            message: `The \`${executable}\` executable cannot be run from the PATH of this process; ${purpose[executable]}.`,
            nextStep: `Administrator must install \`${executable}\` on this host and put it in the PATH of the account that runs the Factory; validate never installs packages.`,
          },
    );
  }
  return checks;
}

async function accountChecks({
  profile,
  concurrency,
  service,
}: {
  profile: LambdaProfile;
  concurrency?: number | undefined;
  service: LambdaService;
}): Promise<Diagnostic[]> {
  const checks: Diagnostic[] = [];
  const identity = await service.callerIdentity();
  if (!identity.ok) {
    const { failure } = identity;
    if (failure.kind === 'cli-unavailable') {
      checks.push({
        id: 'lambda-aws-cli',
        status: 'blocked',
        message: 'The `aws` executable is unavailable; the Lambda adapter reaches the account through the AWS CLI.',
        nextStep: 'Administrator must install an AWS CLI that provides the `lambda-microvms` commands; validate never installs packages.',
      });
    } else if (failure.kind === 'profile-not-found') {
      checks.push({
        id: 'lambda-aws-profile',
        status: 'blocked',
        message: `The AWS profile named in sandbox.awsProfile (${profile.awsProfile}) does not exist in this account's AWS configuration.`,
        nextStep: `Create the AWS CLI profile ${profile.awsProfile} that assumes the installation operation role, or name the existing one. The Factory stores no credentials.`,
      });
    } else {
      checks.push({
        id: 'lambda-aws-profile',
        status: 'ok',
        message: `AWS profile ${profile.awsProfile} found; the Factory passes its name only.`,
        nextStep: 'None.',
      });
      checks.push({
        id: 'lambda-identity',
        status: 'blocked',
        message: `The AWS profile ${profile.awsProfile} yields no identity${describe(failure)}.`,
        nextStep: 'Renew or configure the credentials of that profile with the AWS tooling (for example its login command); the Factory never holds them.',
      });
    }
    checks.push({
      id: 'lambda-account',
      status: 'unverified',
      message: 'Region, permissions, quota and installation resources were not checked: there is no identity to check them with.',
      nextStep: 'Resolve the identity diagnostic and run doctor again.',
    });
    return [...checks, ...profileProof(profile)];
  }
  const { account, arn } = identity.value;
  const resources = installationResources(profile, account);
  /** IAM actions a direct read was refused for; merged with the simulated ones below. */
  const denied: string[] = [];
  const refused = (failure: LambdaServiceFailure, fallback: string) => {
    const action = failure.action ?? fallback;
    if (!denied.includes(action)) denied.push(action);
  };
  checks.push({
    id: 'lambda-aws-profile',
    status: 'ok',
    message: `AWS profile ${profile.awsProfile} found; the Factory passes its name only.`,
    nextStep: 'None.',
  });
  checks.push({ id: 'lambda-identity', status: 'ok', message: `Account ${account}, principal ${arn}.`, nextStep: 'None.' });
  const operates = arn.startsWith(`arn:aws:sts::${account}:assumed-role/${resources.operationRole}/`);
  checks.push(
    operates
      ? {
          id: 'lambda-operation-role',
          status: 'ok',
          message: `The profile assumes the installation operation role ${resources.operationRole}.`,
          nextStep: 'None.',
        }
      : {
          id: 'lambda-operation-role',
          status: 'blocked',
          message: `The profile does not assume the installation operation role ${resources.operationRole}: it is ${arn}. The role is missing or the profile uses another identity.`,
          nextStep: `Apply ${template} with installation name ${profile.installation} and point the AWS profile at the role it creates. The Factory never creates IAM.`,
        },
  );

  // Region: the service answers there, and the build bucket lives there (the build artifact must be in the image's region).
  const regionProblems: string[] = [];
  let regionKnown = true;
  const images = await service.listImages();
  if (!images.ok) {
    if (images.failure.kind === 'region-unavailable') regionProblems.push(`the Lambda MicroVMs service does not answer in ${profile.region}`);
    else {
      regionKnown = false;
      if (images.failure.kind === 'access-denied') refused(images.failure, 'lambda:ListMicrovmImages');
      if (images.failure.kind === 'cli-unavailable')
        checks.push({
          id: 'lambda-aws-cli',
          status: 'blocked',
          message: 'The installed `aws` executable does not provide the `lambda-microvms` commands.',
          nextStep: 'Administrator must install an AWS CLI version that provides `aws lambda-microvms`; validate never installs packages.',
        });
    }
  }
  const role = await service.role(resources.buildRole);
  if (role.ok) checks.push({ id: 'lambda-build-role', status: 'ok', message: `Build role ${resources.buildRole} exists.`, nextStep: 'None.' });
  else if (role.failure.kind === 'not-found')
    checks.push({
      id: 'lambda-build-role',
      status: 'blocked',
      message: `The installation build role ${resources.buildRole} does not exist in account ${account}.`,
      nextStep: `Apply ${template} with installation name ${profile.installation}. The Factory never creates IAM.`,
    });
  else {
    if (role.failure.kind === 'access-denied') refused(role.failure, 'iam:GetRole');
    checks.push({
      id: 'lambda-build-role',
      status: 'unverified',
      message: `The build role ${resources.buildRole} could not be read${describe(role.failure)}.`,
      nextStep: 'Resolve the permission diagnostics and run doctor again.',
    });
  }
  const bucket = await service.bucketRegion(resources.artifactBucket);
  if (bucket.ok) {
    checks.push({ id: 'lambda-artifact-bucket', status: 'ok', message: `Build artifact bucket ${resources.artifactBucket} exists.`, nextStep: 'None.' });
    if (bucket.value.region !== profile.region)
      regionProblems.push(`the build artifact bucket ${resources.artifactBucket} lives in ${bucket.value.region}, not in ${profile.region}`);
  } else if (bucket.failure.kind === 'not-found')
    checks.push({
      id: 'lambda-artifact-bucket',
      status: 'blocked',
      message: `The installation build artifact bucket ${resources.artifactBucket} does not exist.`,
      nextStep: `Apply ${template} with installation name ${profile.installation} in region ${profile.region}.`,
    });
  else {
    if (bucket.failure.kind === 'access-denied') refused(bucket.failure, 's3:GetBucketLocation');
    checks.push({
      id: 'lambda-artifact-bucket',
      status: 'unverified',
      message: `The build artifact bucket ${resources.artifactBucket} could not be read${describe(bucket.failure)}.`,
      nextStep: 'Resolve the permission diagnostics and run doctor again.',
    });
  }
  checks.splice(
    checks.findIndex(check => check.id === 'lambda-build-role'),
    0,
    regionProblems.length > 0
      ? {
          id: 'lambda-region',
          status: 'blocked',
          message: `Wrong region ${profile.region}: ${regionProblems.join('; ')}.`,
          nextStep: 'Set sandbox.region to the region where the account template was applied and the service is offered; nothing is moved or created.',
        }
      : regionKnown
        ? { id: 'lambda-region', status: 'ok', message: `The Lambda MicroVMs service answers in ${profile.region}.`, nextStep: 'None.' }
        : {
            id: 'lambda-region',
            status: 'unverified',
            message: `The Lambda MicroVMs service could not be read in ${profile.region}.`,
            nextStep: 'Resolve the permission diagnostics and run doctor again.',
          },
  );

  // V2-30: Builder concurrency x boot size against the quota READ from the account; reported, never adjusted.
  let capacity: Diagnostic;
  const size = lambdaBootSize(profile);
  const quota = await service.allocatedMemoryQuota(profile.architecture);
  if (!quota.ok || concurrency === undefined) {
    if (!quota.ok && quota.failure.kind === 'access-denied') refused(quota.failure, 'servicequotas:ListServiceQuotas');
    capacity = {
      id: 'lambda-quota',
      status: 'unverified',
      message: !quota.ok
        ? `The account memory quota for ${profile.architecture} MicroVMs could not be read${describe(quota.failure)}; concurrency was not compared with it.`
        : 'Builder concurrency is unknown (invalid configuration); it was not compared with the account quota.',
      nextStep:
        'Read the quota in the Service Quotas console and keep concurrency x peak memory under it; a quota refusal at start is a visible capacity wait, retried by itself.',
    };
  } else {
    const needed = concurrency * size.peakMemoryMiB;
    const sentence = `Builder concurrency ${concurrency} x ${size.peakMemoryMiB} MiB peak per MicroVM = ${needed} MiB; account quota ${quota.value.mebibytes} MiB of allocated memory (${profile.architecture}, ${profile.region}).`;
    capacity =
      needed > quota.value.mebibytes
        ? {
            id: 'lambda-quota',
            status: 'blocked',
            message: `${sentence} The quota is exceeded.`,
            nextStep: 'Lower `concurrency`, lower sandbox.baselineMemoryMiB or request a quota increase from AWS. Nothing is adjusted automatically.',
          }
        : { id: 'lambda-quota', status: 'ok', message: sentence, nextStep: 'None. The quota is shared with anything else running in the account.' };
  }

  // Permissions: the operation role's policy simulated statement by statement (each action named), plus what the reads above were refused.
  let simulated = operates;
  /** Simulated denials of actions the simulator is known not to evaluate (`actionsTheIamSimulatorDoesNotEvaluate`): said, never blocking. */
  const unevaluated: string[] = [];
  if (operates) {
    for (const statement of operationPolicy(profile, account)) {
      const result = await service.simulatePermissions({
        principalArn: resources.operationRoleArn,
        actions: statement.actions,
        resources: statement.resources,
        ...(statement.condition ? { context: [statement.condition] } : {}),
      });
      if (!result.ok) {
        simulated = false;
        if (result.failure.kind === 'access-denied') refused(result.failure, 'iam:SimulatePrincipalPolicy');
        break;
      }
      for (const evaluated of result.value) {
        if (evaluated.allowed) continue;
        const list = actionsTheIamSimulatorDoesNotEvaluate.includes(evaluated.action) ? unevaluated : denied;
        if (!list.includes(evaluated.action)) list.push(evaluated.action);
      }
    }
  }
  for (const action of denied)
    checks.push({
      id: `lambda-permission:${action}`,
      status: 'blocked',
      message: `The operation role lacks the permission ${action}.`,
      nextStep: `Apply the current ${template}; it grants ${action} with the minimal scope. The Factory never edits IAM.`,
    });
  // A direct read refused for the same action is a real denial and already blocks above.
  const unproven = unevaluated.filter(action => !denied.includes(action));
  for (const action of unproven)
    checks.push({
      id: `lambda-permission:${action}`,
      status: 'unverified',
      message: `The IAM policy simulator does not evaluate ${action}: it answers a denial whatever the operation role grants, so the permission was not checked.`,
      nextStep: `None if the current ${template} is applied: it grants ${action}. Only a real RunMicrovm in the account proves it.`,
    });
  if (!simulated)
    checks.push({
      id: 'lambda-permissions',
      status: 'unverified',
      message: operates
        ? 'The operation role policy could not be simulated; its permissions were not evaluated.'
        : 'Permissions were not evaluated: the profile is not the installation operation role.',
      nextStep: 'Resolve the diagnostics above and run doctor again.',
    });
  else if (denied.length === 0)
    checks.push({
      id: 'lambda-permissions',
      status: 'ok',
      message: `Policy simulation allows every action of the minimal operation policy${unproven.length > 0 ? ` except ${unproven.join(', ')}, which the simulator does not evaluate` : ''}. A simulation is not proof of each call.`,
      nextStep: 'None.',
    });
  checks.push(capacity);
  return [...checks, ...profileProof(profile)];
}

/** V2-12, V2-29: what of the configured profile lies outside what the proofs exercised. Accepted, and said. */
function profileProof(profile: LambdaProfile): Diagnostic[] {
  const outside = [
    profile.region !== acceptanceProfile.region ? `region ${profile.region}` : '',
    profile.architecture !== acceptanceProfile.architecture ? `architecture ${profile.architecture}` : '',
    profile.baselineMemoryMiB !== acceptanceProfile.baselineMemoryMiB ? `baseline memory ${profile.baselineMemoryMiB} MiB` : '',
  ].filter(Boolean);
  return [
    profile.maxBootSeconds > provenMaxBootSeconds
      ? {
          id: 'lambda-boot-duration',
          status: 'unverified',
          message: `Maximum boot duration ${profile.maxBootSeconds} s is accepted but not proven: boots were proven up to ${provenMaxBootSeconds} s.`,
          nextStep: 'Keep sandbox.maxBootSeconds at 3600 or below until the long-boot gate is run.',
        }
      : {
          id: 'lambda-boot-duration',
          status: 'ok',
          message: `Maximum boot duration ${profile.maxBootSeconds} s with a rotation margin of ${profile.rotationMarginSeconds} s (proven up to ${provenMaxBootSeconds} s).`,
          nextStep: 'None.',
        },
    ...(outside.length > 0
      ? [
          {
            id: 'lambda-acceptance-profile',
            status: 'unverified' as const,
            message: `Outside the acceptance profile (us-east-1, ARM64, 1 GB baseline): ${outside.join(', ')}. Accepted, not proven.`,
            nextStep: 'Use the acceptance profile or qualify this one under separate authorization.',
          },
        ]
      : []),
    {
      id: 'lambda-runtime',
      status: 'unverified',
      message: 'No MicroVM image was built and no MicroVM was started: validate spends nothing in the account.',
      nextStep: 'Image build, boot and the tool channel are proven only by a separately authorized run in the account.',
    },
  ];
}
