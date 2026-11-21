import type { LambdaProfile } from './profile.js';

/** V2-33: every AWS resource the Factory creates carries the installation tag and, when it belongs to one, the Work tag. */
export const installationTagKey = 'software-factory-installation';
export const workTagKey = 'software-factory-work';

/**
 * V2-31: the account resources of one installation. The Operator creates them by applying the release's account template
 * (`assets/lambda/account-template.yaml`) with the same installation name; the Factory never creates IAM. Names are derived, never
 * configured, so the template and `validate` cannot drift apart.
 */
export function installationResources(profile: Pick<LambdaProfile, 'installation' | 'region'>, account: string) {
  const prefix = `factory-${profile.installation}`;
  return {
    operationRole: `${prefix}-operation`, operationRoleArn: `arn:aws:iam::${account}:role/${prefix}-operation`,
    buildRole: `${prefix}-build`, buildRoleArn: `arn:aws:iam::${account}:role/${prefix}-build`,
    artifactBucket: `${prefix}-build-${account}-${profile.region}`,
    /** Every MicroVM image of the installation is named with this prefix: the operation role is scoped to it. */
    imagePrefix: `${prefix}-`,
    imageArnPattern: `arn:aws:lambda:${profile.region}:${account}:microvm-image:${prefix}-*`,
    logGroupArnPattern: `arn:aws:logs:${profile.region}:${account}:log-group:/aws/lambda-microvms/${prefix}-*`,
    networkConnectorArnPattern: `arn:aws:lambda:${profile.region}:aws:network-connector:aws-network-connector*`,
  };
}

export type PolicyStatement = { sid: string; actions: string[]; resources: string[];
  /** `StringEquals` on one request-context key. */ condition?: { key: string; value: string } };

/**
 * The minimal policy of the operation role: the ONE list both the account template and `validate` are checked against. Known limit
 * (V2-31): `lambda:CreateMicrovmImage` and `lambda:TagResource` do not accept a resource restriction, so they sit on `*`, the second one
 * conditioned on the installation tag. Scoping the remaining MicroVM actions to the installation's image ARNs follows the service
 * documentation (MicroVM actions are authorized by the image ARN); the proofs ran with every action on `*`.
 */
export function operationPolicy(profile: Pick<LambdaProfile, 'installation' | 'region'>, account: string): PolicyStatement[] {
  const resources = installationResources(profile, account);
  return [
    { sid: 'ListMicrovmResources', actions: ['lambda:ListMicrovmImages', 'lambda:ListMicrovms'], resources: ['*'] },
    { sid: 'CreateMicrovmImage', actions: ['lambda:CreateMicrovmImage'], resources: ['*'] },
    { sid: 'TagInstallationResources', actions: ['lambda:TagResource'], resources: ['*'],
      condition: { key: `aws:RequestTag/${installationTagKey}`, value: profile.installation } },
    { sid: 'InstallationImagesAndMicrovms', actions: ['lambda:GetMicrovmImage', 'lambda:GetMicrovmImageVersion', 'lambda:ListMicrovmImageVersions',
      'lambda:ListMicrovmImageBuilds', 'lambda:DeleteMicrovmImage', 'lambda:DeleteMicrovmImageVersion', 'lambda:RunMicrovm', 'lambda:GetMicrovm',
      'lambda:TerminateMicrovm', 'lambda:CreateMicrovmAuthToken', 'lambda:ListTags'], resources: [resources.imageArnPattern] },
    { sid: 'NetworkConnectors', actions: ['lambda:PassNetworkConnector'], resources: [resources.networkConnectorArnPattern] },
    { sid: 'PassBuildRole', actions: ['iam:PassRole', 'iam:GetRole'], resources: [resources.buildRoleArn] },
    { sid: 'SimulateOwnPolicy', actions: ['iam:SimulatePrincipalPolicy'], resources: [resources.operationRoleArn] },
    { sid: 'BuildArtifactBucket', actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: [`arn:aws:s3:::${resources.artifactBucket}`] },
    { sid: 'BuildArtifacts', actions: ['s3:PutObject', 's3:PutObjectTagging', 's3:GetObject', 's3:DeleteObject'], resources: [`arn:aws:s3:::${resources.artifactBucket}/*`] },
    { sid: 'BuildLogs', actions: ['logs:DescribeLogStreams', 'logs:GetLogEvents', 'logs:FilterLogEvents', 'logs:DeleteLogGroup'],
      resources: [resources.logGroupArnPattern, `${resources.logGroupArnPattern}:*`] },
    { sid: 'ReadQuotas', actions: ['servicequotas:ListServiceQuotas'], resources: ['*'] },
  ];
}
