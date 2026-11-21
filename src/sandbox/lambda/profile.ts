import { z } from 'zod';
import type { SandboxCapabilities } from '../../contracts/index.js';

/**
 * v2 ticket 02 (V2-29, V2-12, V2-31): the Lambda adapter's OWN profile. Region, architecture, size, boot duration, rotation margin and
 * observation interval live here, inside the adapter; Control receives only the declared capabilities (`lambdaCapabilities`).
 * `awsProfile` is the NAME of an AWS CLI profile the Operator configured outside the Factory: the Factory never stores or accepts
 * credentials, so the schema is strict (no credential key exists) and a value shaped like an access key id is refused.
 * Defaults are the acceptance profile: us-east-1, ARM64, baseline 1 GB / 0.5 vCPU with a 4 GB / 2 vCPU peak, every additional OS
 * capability, 3600 s boots rotated 600 s before the end.
 */
export const lambdaProfileSchema = z.strictObject({
  adapter: z.literal('lambda'),
  schemaVersion: z.literal(1),
  awsProfile: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,63}$/).refine(value => !/^A[KS]IA[A-Z0-9]{12,}$/.test(value), 'An access key id is not a profile name'),
  /** Names the installation's account resources (roles, bucket, image prefix) and is the value of the installation tag (V2-33). */
  installation: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[0-9]{1,2}$/).default('us-east-1'),
  architecture: z.enum(['arm64', 'x86_64']).default('arm64'),
  /** Baseline memory of one MicroVM (a property of the MicroVM image). The guest sees the peak: see `lambdaBootSize`. */
  baselineMemoryMiB: z.number().int().positive().safe().default(1024),
  additionalOsCapabilities: z.array(z.string().regex(/^[A-Z_]{1,64}$/)).default(['ALL']),
  /** V2-12: maximum duration of one boot. The service accepts 1..28800; only values up to 3600 are proven (`validate` says so). */
  maxBootSeconds: z.number().int().min(1).max(28800).default(3600),
  rotationMarginSeconds: z.number().int().positive().safe().default(600),
  observationIntervalSeconds: z.number().int().positive().max(3600).default(30),
}).refine(profile => profile.maxBootSeconds < 1 || profile.rotationMarginSeconds < profile.maxBootSeconds, { path: ['rotationMarginSeconds'], message: 'The margin must leave a boot' });
export type LambdaProfile = z.infer<typeof lambdaProfileSchema>;

/** The boot duration up to which the profile is proven (proof L2); above it the profile is accepted and reported as not proven (V2-12). */
export const provenMaxBootSeconds = 3600;
/** The acceptance profile (V2-29): the only region/architecture/size the proofs exercised. */
export const acceptanceProfile = Object.freeze({ region: 'us-east-1', architecture: 'arm64', baselineMemoryMiB: 1024 });

/** V2-03: what the Lambda adapter declares. Nothing else of the profile reaches Control. */
export function lambdaCapabilities(profile: LambdaProfile): SandboxCapabilities {
  return Object.freeze({ docker: true, persistentDisk: false,
    bootDuration: Object.freeze({ maxSeconds: profile.maxBootSeconds, rotationMarginSeconds: profile.rotationMarginSeconds }),
    // V2-25, `INTERNET_EGRESS`: any public IPv4 destination by TCP, unmediated and unfiltered; no outbound UDP or IPv6; no VPC.
    egress: Object.freeze({ mediation: 'none', publicTcp: true, udp: false, ipv6: false, privateNetwork: false }),
    // V2-21: a dropped channel is recovered while the MicroVM lives (`lambda/tools.ts`).
    channelRecovery: true,
    // V2-15: the boot owner asks the service about the environment every `observationIntervalSeconds` (`lambda/tools.ts`).
    environmentWatch: true });
}

/**
 * Size of one boot (V2-29, V2-30). The service takes the BASELINE memory; the guest sees, and the account quota counts, the PEAK, four
 * times the baseline (observed: 1 GB baseline = 4 GB / 2 vCPU guest, 8 GB quota = two MicroVMs). 1 vCPU per 2 GB.
 */
export function lambdaBootSize(profile: Pick<LambdaProfile, 'baselineMemoryMiB'>) {
  const peakMemoryMiB = profile.baselineMemoryMiB * 4;
  return { baselineMemoryMiB: profile.baselineMemoryMiB, baselineVcpus: profile.baselineMemoryMiB / 2048, peakMemoryMiB, peakVcpus: peakMemoryMiB / 2048 };
}
