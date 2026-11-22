import { z } from 'zod';
import type { SandboxCapabilities } from '../contracts/index.js';
import { lambdaCapabilities, lambdaProfileSchema, type LambdaProfile } from './lambda/profile.js';

// Development profile identity only: no distributed assets or qualified release yet.
export const configurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.literal('gondolin-qemu-alpine-dev-v1'),
  memoryMiB: z.number().int().positive().safe().default(2048),
  vcpus: z.number().int().positive().safe().default(2),
  diskGiB: z.number().int().positive().safe().default(40),
  shutdownGraceSeconds: z.number().int().positive().safe().default(30),
  minFreeSpaceGiB: z.number().int().positive().safe().default(4),
  /** Host MemAvailable floor above the guest memory at each boot (ticket 24). Read here only (backward compatibility with environments that
   * recorded it); optional WITHOUT a schema default, so the effective configuration and the identity of environments prepared without it
   * are unchanged. Ticket 24 applies it as a boot precondition (`capacity.ts`), never a reservation. */
  minFreeMemoryMiB: z.number().int().positive().safe().optional(),
});
/** Ticket 24: the floor applied when `minFreeMemoryMiB` is absent (boot memory precondition in `capacity.ts`). */
export const defaultMinFreeMemoryMiB = 1024;

/** v2 (V2-01): the sandbox adapters an installation can name in `sandbox.adapter`. Absent = `gondolin` (every installation before v2). */
export const sandboxAdapters = ['gondolin', 'lambda'] as const;
export type SandboxAdapter = (typeof sandboxAdapters)[number];

/** V2-03: what the Gondolin adapter declares. Docker in the guest, a root disk and workspace that survive the boot (so `stop` preserves
 * them), no maximum boot duration (no rotation) and the MVP egress: public HTTP(S) through the adapter's mediation only. */
export const gondolinCapabilities: SandboxCapabilities = Object.freeze({
  docker: true,
  persistentDisk: true,
  bootDuration: null,
  egress: Object.freeze({ mediation: 'http', publicTcp: false, udp: false, ipv6: false, privateNetwork: false }),
});

export type SandboxAdapterSelection =
  | { status: 'selected'; adapter: 'gondolin'; capabilities: SandboxCapabilities; configuration: SandboxConfiguration }
  /** v2 ticket 02: the effective Lambda profile keeps `adapter: 'lambda'` (it is what tells the two effective configurations apart). */
  | { status: 'selected'; adapter: 'lambda'; capabilities: SandboxCapabilities; configuration: LambdaProfile }
  | {
      status: 'refused';
      /** The adapter the configuration names (`null`: it names none that exists). */ adapter: SandboxAdapter | null;
      errors: { code: 'SANDBOX_CONFIGURATION_INVALID'; path: string }[];
    };

/**
 * V2-01 (pure): the ONE adapter the installation configuration selects, statically, for every repository, with its declared capabilities
 * and its own effective profile. `sandbox.adapter` is the only selector (no per-repository or per-Work choice, no automatic selection, no
 * list); it is never part of an adapter's profile, so a Gondolin configuration written before v2 keeps its effective configuration and the
 * identity of the environments prepared from it. There is never a fallback from one adapter to another.
 */
export function selectSandboxAdapter(configuration: unknown): SandboxAdapterSelection {
  let adapter: unknown = 'gondolin';
  let profile = configuration;
  if (configuration && typeof configuration === 'object' && !Array.isArray(configuration) && 'adapter' in configuration) {
    const { adapter: named, ...rest } = configuration as Record<string, unknown>;
    adapter = named;
    profile = rest;
  }
  if (adapter === 'lambda') {
    const parsed = lambdaProfileSchema.safeParse(configuration);
    if (!parsed.success) return { status: 'refused', adapter, errors: invalid(parsed.error.issues) };
    return { status: 'selected', adapter, capabilities: lambdaCapabilities(parsed.data), configuration: parsed.data };
  }
  if (adapter !== 'gondolin') return { status: 'refused', adapter: null, errors: [{ code: 'SANDBOX_CONFIGURATION_INVALID', path: 'sandbox.adapter' }] };
  const parsed = configurationSchema.safeParse(profile);
  if (!parsed.success) return { status: 'refused', adapter, errors: invalid(parsed.error.issues) };
  return { status: 'selected', adapter, capabilities: gondolinCapabilities, configuration: parsed.data };
}
function invalid(issues: readonly { path: PropertyKey[] }[]) {
  return issues.map(issue => ({ code: 'SANDBOX_CONFIGURATION_INVALID' as const, path: ['sandbox', ...issue.path.map(String)].join('.') }));
}

/**
 * The GONDOLIN lifecycle's view of the configuration (prepare/start and the host diagnostics). A valid Lambda selection is
 * `SANDBOX_ADAPTER_UNAVAILABLE` here: the Lambda adapter's own validate, prepare and start (tickets 02 to 04) are dispatched before this
 * function is reached, and a Lambda Work is never prepared or started under Gondolin.
 */
export function validateConfiguration(configuration: unknown) {
  const selection = selectSandboxAdapter(configuration);
  if (selection.status !== 'selected') return { valid: false as const, errors: selection.errors };
  if (selection.adapter !== 'gondolin') return { valid: false as const, errors: [{ code: 'SANDBOX_ADAPTER_UNAVAILABLE' as const, path: 'sandbox.adapter' }] };
  return { valid: true as const, effective: selection.configuration };
}

export type SandboxConfiguration = z.infer<typeof configurationSchema>;

/**
 * Ticket 50: what identifies a prepared environment's DISK and PROFILE — the profile, the virtual disk size and the guest asset pin it was
 * built from. Guest resources (`memoryMiB`, `vcpus`) and host admission/stop settings (`minFreeSpaceGiB`, `minFreeMemoryMiB`,
 * `shutdownGraceSeconds`) are read from the CURRENT configuration at each boot (recorded per boot in its `identity.json`), so changing them
 * never invalidates a prepared environment. Returns the changed identity fields, human readable; empty = the environment stays usable.
 */
export function environmentIdentityChanges(
  prepared: { configuration: Pick<SandboxConfiguration, 'profile' | 'diskGiB'>; guestAssets: { directory: string; manifestSha256: string } },
  current: { configuration: Pick<SandboxConfiguration, 'profile' | 'diskGiB'>; guestAssets: { directory: string; manifestSha256: string } | undefined },
): string[] {
  const changes: string[] = [];
  if (prepared.configuration.profile !== current.configuration.profile)
    changes.push(`sandbox.profile ${prepared.configuration.profile} -> ${current.configuration.profile}`);
  if (prepared.configuration.diskGiB !== current.configuration.diskGiB)
    changes.push(`sandbox.diskGiB ${prepared.configuration.diskGiB} -> ${current.configuration.diskGiB}`);
  const pin = current.guestAssets;
  if (!pin || pin.directory !== prepared.guestAssets.directory || pin.manifestSha256 !== prepared.guestAssets.manifestSha256) {
    changes.push(`guest assets ${prepared.guestAssets.manifestSha256.slice(0, 12)} -> ${pin ? pin.manifestSha256.slice(0, 12) : 'none'}`);
  }
  return changes;
}
