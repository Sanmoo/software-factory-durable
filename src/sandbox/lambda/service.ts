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
    /** The resource already exists or is in a state that refuses the operation (ticket 03: an image of that name already exists). */
    | 'conflict'
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

/** Image states the adapter decides on (observed: `CREATING`, `CREATED`, `CREATE_FAILED`); any other value is passed through as text. */
export type LambdaImage = { name: string; imageArn: string; state: string; tags: Record<string, string>;
  latestActiveImageVersion?: string; latestFailedImageVersion?: string };

/** One CreateMicrovmImage request. Size, architecture, OS capabilities and hooks are properties of the IMAGE, fixed here. */
export type LambdaImageRequest = { name: string; description: string; baseImageArn: string; baseImageVersion: string; buildRoleArn: string;
  /** `s3://<bucket>/<key>` of the build artifact, in the image's region. */ artifactUri: string;
  architecture: LambdaArchitecture; minimumMemoryMiB: number; additionalOsCapabilities: readonly string[];
  hooks: { port: number; runTimeoutSeconds: number; terminateTimeoutSeconds: number; readyTimeoutSeconds: number };
  tags: Readonly<Record<string, string>> };

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
  /** S3 PutObject with object tags: the build artifact (a zip with the `Dockerfile` at its root) of one MicroVM image. Changes the account. */
  putBuildArtifact(input: { bucket: string; key: string; body: Uint8Array; tags: Readonly<Record<string, string>> }): Promise<LambdaServiceResult<{ uri: string }>>;
  /** Lambda MicroVMs CreateMicrovmImage: starts ONE build and returns at once (`CREATING`). `conflict`: an image of that name exists. Changes the account. */
  createImage(input: LambdaImageRequest): Promise<LambdaServiceResult<{ imageArn: string; state: string }>>;
  /** Lambda MicroVMs GetMicrovmImage, by ARN (the service refuses the name). `not-found`: no such image. */
  image(imageArn: string): Promise<LambdaServiceResult<LambdaImage>>;
  /** Lambda MicroVMs ListMicrovmImageBuilds: the build records of an image (one request gives one record per chip generation). */
  imageBuilds(imageArn: string): Promise<LambdaServiceResult<{ buildId: string; imageVersion: string; state: string; stateReason?: string }[]>>;
  /** The build log of an image, oldest line first: the only place the cause of a failed build is written (the API gives a generic reason). */
  buildLog(logGroup: string): Promise<LambdaServiceResult<string[]>>;
  /** Lambda MicroVMs DeleteMicrovmImageVersion. Changes the account. */
  deleteImageVersion(input: { imageArn: string; version: string }): Promise<LambdaServiceResult<null>>;
  /** Lambda MicroVMs DeleteMicrovmImage (its versions first). Changes the account. */
  deleteImage(imageArn: string): Promise<LambdaServiceResult<null>>;
  /** The account's allocated-memory quota for MicroVMs of one architecture, in MiB. */
  allocatedMemoryQuota(architecture: LambdaArchitecture): Promise<LambdaServiceResult<{ mebibytes: number }>>;
}

/** One service client per named AWS profile and region. The Factory passes the profile NAME only; credentials stay with the AWS tooling. */
export type LambdaServiceFactory = (target: { awsProfile: string; region: string }) => LambdaService;
