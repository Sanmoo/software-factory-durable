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
    /** Ticket 04: the service refused to run a MicroVM for lack of quota or capacity (shape not observed; classified in one place). */
    | 'capacity'
    | 'unknown';
  /** `access-denied`: the IAM action that was refused, when the service named it. */
  action?: string;
  /** One bounded line of service text for the Operator; never credentials. */
  detail?: string;
};
export type LambdaServiceResult<T> = { ok: true; value: T } | { ok: false; failure: LambdaServiceFailure };

export type LambdaArchitecture = 'arm64' | 'x86_64';

/** Image states the adapter decides on (observed: `CREATING`, `CREATED`, `CREATE_FAILED`); any other value is passed through as text. */
export type LambdaImage = {
  name: string;
  imageArn: string;
  state: string;
  tags: Record<string, string>;
  latestActiveImageVersion?: string;
  latestFailedImageVersion?: string;
};

/** One CreateMicrovmImage request. Size, architecture, OS capabilities and hooks are properties of the IMAGE, fixed here. */
export type LambdaImageRequest = {
  name: string;
  description: string;
  baseImageArn: string;
  baseImageVersion: string;
  buildRoleArn: string;
  /** `s3://<bucket>/<key>` of the build artifact, in the image's region. */ artifactUri: string;
  architecture: LambdaArchitecture;
  minimumMemoryMiB: number;
  additionalOsCapabilities: readonly string[];
  hooks: { port: number; runTimeoutSeconds: number; terminateTimeoutSeconds: number; readyTimeoutSeconds: number };
  tags: Readonly<Record<string, string>>;
};

/**
 * Ticket 04: one RunMicrovm request. There is deliberately no execution role and no idle policy here: the guest runs without AWS
 * credentials (V2-24) and automatic suspension stays off (V2-09), so neither can be requested through the port. Ingress is always
 * `HTTP_INGRESS` and egress `INTERNET_EGRESS` (V2-20, V2-25). The image's latest active version is the one run.
 */
export type LambdaMicrovmRequest = {
  imageArn: string;
  maximumDurationSeconds: number;
  /** The string handed to the guest's `run` hook: public material only (the session public key). */ runHookPayload: string;
  tags: Readonly<Record<string, string>>;
};
/** GetMicrovm. States the adapter decides on: `PENDING`, `RUNNING`, `TERMINATING`, `TERMINATED`; any other value is passed through. */
export type LambdaMicrovm = {
  microvmId: string;
  state: string;
  endpoint?: string;
  imageArn?: string;
  imageVersion?: string;
  stateReason?: string;
  /** ISO instants as the service gave them (with any offset); `terminatedAt` only once terminated. */ startedAt?: string;
  terminatedAt?: string;
};
/**
 * Ticket 15: one item of ListMicrovms. Observed fields: id, state, image and start; terminated MicroVMs stay listed. `tags` is present
 * only when the service lists them: the observed answer has none, and RunMicrovm takes no tags (real account, 2026-11-21; V2-33).
 */
export type LambdaListedMicrovm = { microvmId: string; state: string; imageArn?: string; startedAt?: string; tags?: Record<string, string> };
export const microvmIngress = 'HTTP_INGRESS';
export const microvmEgress = 'INTERNET_EGRESS';

export interface LambdaService {
  /** STS GetCallerIdentity: the account and principal ARN behind the named profile. */
  callerIdentity(): Promise<LambdaServiceResult<{ account: string; arn: string }>>;
  /** IAM SimulatePrincipalPolicy: whether `principalArn`'s policies allow each action on the resources, with the given request context. */
  simulatePermissions(input: {
    principalArn: string;
    actions: readonly string[];
    resources: readonly string[];
    context?: readonly { key: string; value: string }[];
  }): Promise<LambdaServiceResult<{ action: string; allowed: boolean }[]>>;
  /** IAM GetRole. */
  role(name: string): Promise<LambdaServiceResult<{ arn: string }>>;
  /** S3 GetBucketLocation. */
  bucketRegion(bucket: string): Promise<LambdaServiceResult<{ region: string }>>;
  /** Lambda MicroVMs ListMicrovmImages in the profile's region (read-only; also the proof that the service answers there). */
  listImages(): Promise<LambdaServiceResult<{ name: string; state: string; imageArn?: string }[]>>;
  /** S3 PutObject with object tags: the build artifact (a zip with the `Dockerfile` at its root) of one MicroVM image. Changes the account. */
  putBuildArtifact(input: {
    bucket: string;
    key: string;
    body: Uint8Array;
    tags: Readonly<Record<string, string>>;
  }): Promise<LambdaServiceResult<{ uri: string }>>;
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
  /** S3 DeleteObject: the build artifact of a removed image (ticket 15, explicit cleanup only). Idempotent. Changes the account. */
  deleteBuildArtifact(input: { bucket: string; key: string }): Promise<LambdaServiceResult<null>>;
  /** CloudWatch Logs DeleteLogGroup: the build log of a removed image (ticket 15, explicit cleanup only). Changes the account. */
  deleteBuildLog(logGroup: string): Promise<LambdaServiceResult<null>>;
  /** Lambda MicroVMs RunMicrovm: a NEW MicroVM of the image, with HTTP ingress and internet egress, no execution role, no idle suspension. Changes the account. */
  runMicrovm(input: LambdaMicrovmRequest): Promise<LambdaServiceResult<{ microvmId: string; endpoint: string }>>;
  /** Lambda MicroVMs GetMicrovm: the service's own view of one MicroVM, readable by any process holding the id. Eventually consistent. */
  microvm(microvmId: string): Promise<LambdaServiceResult<LambdaMicrovm>>;
  /** Lambda MicroVMs ListMicrovms: EVERY MicroVM of the account in the region, whoever created it (the caller filters by installation). */
  listMicrovms(): Promise<LambdaServiceResult<LambdaListedMicrovm[]>>;
  /** Lambda MicroVMs TerminateMicrovm: only REQUESTS the end (empty answer, idempotent); cessation is what a later `microvm` read says. Changes the account. */
  terminateMicrovm(microvmId: string): Promise<LambdaServiceResult<null>>;
  /** Lambda MicroVMs CreateMicrovmAuthToken: the ingress token of ONE port of one MicroVM. A secret; needed only to OPEN a connection. */
  createAuthToken(input: { microvmId: string; port: number; expirationMinutes: number }): Promise<LambdaServiceResult<{ token: string }>>;
  /** The account's allocated-memory quota for MicroVMs of one architecture, in MiB. */
  allocatedMemoryQuota(architecture: LambdaArchitecture): Promise<LambdaServiceResult<{ mebibytes: number }>>;
}

/** One service client per named AWS profile and region. The Factory passes the profile NAME only; credentials stay with the AWS tooling. */
export type LambdaServiceFactory = (target: { awsProfile: string; region: string }) => LambdaService;
