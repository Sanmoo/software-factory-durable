/**
 * v2 ticket 02: the narrow port to the AWS account behind the Lambda adapter (Lambda MicroVMs plus the few IAM/S3/Service Quotas reads the
 * installation needs). One method per service operation, plain data in and out, so the same port is served by the `aws` CLI
 * (`cli-service.ts`, production) and by the in-memory account of the tests (`test/sandbox/lambda-service-fake.ts`). Nothing outside
 * `src/sandbox/lambda/` knows how the service is reached. Later tickets add the image, MicroVM, token and tag operations here.
 */
export type LambdaServiceFailure = {
  kind:
    /** The `aws` executable is not installed or could not be run. */
    | 'cli-unavailable'
    /** The named AWS profile does not exist in the Operator's AWS configuration. */
    | 'profile-not-found'
    /** The profile exists but yields no usable identity (no credentials, expired or invalid session). */
    | 'no-identity'
    /** The identity lacks `action`. */
    | 'access-denied'
    | 'not-found'
    /** The service has no endpoint in the profile's region. */
    | 'region-unavailable'
    | 'unknown';
  /** `access-denied`: the IAM action that was refused, when the service named it. */
  action?: string;
  /** One bounded line of service text for the Operator; never credentials. */
  detail?: string;
};
export type LambdaServiceResult<T> = { ok: true; value: T } | { ok: false; failure: LambdaServiceFailure };

export type LambdaArchitecture = 'arm64' | 'x86_64';

export interface LambdaService {
  /** STS GetCallerIdentity: the account and principal ARN behind the named profile. */
  callerIdentity(): Promise<LambdaServiceResult<{ account: string; arn: string }>>;
  /** IAM SimulatePrincipalPolicy: whether `principalArn`'s policies allow each action on the resources, with the given request context. */
  simulatePermissions(input: { principalArn: string; actions: readonly string[]; resources: readonly string[];
    context?: readonly { key: string; value: string }[] }): Promise<LambdaServiceResult<{ action: string; allowed: boolean }[]>>;
  /** IAM GetRole. */
  role(name: string): Promise<LambdaServiceResult<{ arn: string }>>;
  /** S3 GetBucketLocation. */
  bucketRegion(bucket: string): Promise<LambdaServiceResult<{ region: string }>>;
  /** Lambda MicroVMs ListMicrovmImages in the profile's region (read-only; also the proof that the service answers there). */
  listImages(): Promise<LambdaServiceResult<{ name: string; state: string; imageArn?: string }[]>>;
  /** The account's allocated-memory quota for MicroVMs of one architecture, in MiB. */
  allocatedMemoryQuota(architecture: LambdaArchitecture): Promise<LambdaServiceResult<{ mebibytes: number }>>;
}

/** One service client per named AWS profile and region. The Factory passes the profile NAME only; credentials stay with the AWS tooling. */
export type LambdaServiceFactory = (target: { awsProfile: string; region: string }) => LambdaService;
