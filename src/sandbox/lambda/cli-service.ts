import { execFile } from 'node:child_process';
import type { LambdaArchitecture, LambdaService, LambdaServiceFailure, LambdaServiceResult } from './service.js';

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
      const parsed: unknown = JSON.parse(result.stdout);
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
    allocatedMemoryQuota: architecture => call(['service-quotas', 'list-service-quotas', '--service-code', 'lambda'], output => memoryQuota(output, architecture)),
  };
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
