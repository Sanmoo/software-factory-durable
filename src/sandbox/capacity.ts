import { availableParallelism } from 'node:os';
import type { Diagnostic } from '../contracts/index.js';
import { inspectMemory, inspectStorage, listActiveSandboxUnits } from '../platform/host/index.js';
import { defaultMinFreeMemoryMiB, type SandboxConfiguration } from './configuration.js';

// Ticket 24 (spec §4.3, §7.4, §12.1): host capacity as OBSERVED facts versus the configured virtual limits. The rules are pure (callers pass
// the host observation); `observeHostCapacity` is the only read. A guest's memory/vCPU/disk size is a limit, never a physical reservation: QEMU allocates guest RAM lazily, qcow2 grows on
// demand and Docker `vfs` deep-copies layers, so a precondition that holds at one boot proves nothing for the next one or for the whole run.

const mib = 1048576n;
export const memoryFloorMiB = (configuration: Pick<SandboxConfiguration, 'minFreeMemoryMiB'>) => configuration.minFreeMemoryMiB ?? defaultMinFreeMemoryMiB;
const gib = 1073741824n;
export type HostCapacity = { memory: { totalBytes: string; availableBytes: string } | undefined; storage: { availableBytes: string } | undefined; cpus: number;
  /** Own `factory-sandbox-*` units active now (systemd user manager); null = unknown. */
  runningGuests: number | null };

/**
 * Free-memory precondition of ONE boot: the host's MemAvailable must cover the guest's configured memory, the guest limits of the OTHER
 * Factory boots still LAUNCHING (admitted, not yet observed operational or failed: their RAM is not visible in the observation yet) and
 * the configured floor. A precondition, not a reservation of physical memory.
 */
export function bootMemoryAllows(input: { availableBytes: string | undefined; configuration: Pick<SandboxConfiguration, 'memoryMiB' | 'minFreeMemoryMiB'>; launchingMiB?: number }): boolean {
  if (input.availableBytes === undefined || !/^\d+$/.test(input.availableBytes)) return false;
  return BigInt(input.availableBytes) >= BigInt((input.launchingMiB ?? 0) + input.configuration.memoryMiB + memoryFloorMiB(input.configuration)) * mib;
}

/**
 * Ticket 24 decision 4 (after review): ONE coherent model. The ledger (one per composed Sandbox) holds the boots LAUNCHING, across dispatch
 * passes: a boot enters it when admitted and leaves it when its start returns (operational confirmed, failed or indeterminate). A running
 * guest is then accounted only by the host's MemAvailable, never also by the ledger, so a later boot is not refused by a double
 * subtraction. Decisions are serialized, so simultaneous boots never share one observation. Nothing is evicted: an entry leaves only by
 * its own release (idempotent). Accepted limit: a guest's RAM that the kernel has not yet faulted in after its boot became operational is
 * not counted (QEMU allocates lazily) — the observation of that moment is the criterion; the run's registry measures the real peak.
 */
export function createBootLedger(available: () => Promise<string | undefined>) {
  const entries = new Map<number, number>();
  let next = 0;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    /** Admits one launch: the release handle (call it when the start returned), or null when the precondition fails now. */
    admit(configuration: Pick<SandboxConfiguration, 'memoryMiB' | 'minFreeMemoryMiB'>): Promise<(() => void) | null> {
      const decision = chain.then(async () => {
        const launchingMiB = [...entries.values()].reduce((sum, value) => sum + value, 0);
        if (!bootMemoryAllows({ availableBytes: await available().catch(() => undefined), configuration, launchingMiB })) return null;
        const id = next++;
        entries.set(id, configuration.memoryMiB);
        return () => { entries.delete(id); };
      });
      chain = decision.catch(() => {});
      return decision;
    },
    /** Guest limits (MiB) of the boots still launching. */
    launching: () => [...entries.values()],
  };
}

/**
 * Doctor view of the configured concurrency against the observed host (spec §12.1: the operator sees real capacity instead of inferring it
 * from the virtual configuration). The Factory's OWN running guests already occupy Slots and are already inside MemAvailable: only the
 * FREE Slots are judged, so healthy running capacity is never reported as blocked. `blocked` only when a free Slot exists and even ONE
 * boot's own preconditions fail now; unknown host facts (memory, storage or running guests) are `unverified` with the reason, never
 * `blocked` or a number; the sum of free Slots exceeding the observation is only `unverified`. Nothing here is proven capacity or an SLA.
 */
export function capacityDiagnostic(input: { concurrency: number; configuration: SandboxConfiguration; host: HostCapacity }): Diagnostic {
  const { concurrency, configuration, host } = input;
  const guestMemory = BigInt(configuration.memoryMiB) * mib;
  const bootDisk = (BigInt(configuration.diskGiB) + BigInt(configuration.minFreeSpaceGiB)) * gib;
  const running = host.runningGuests;
  const free = running === null ? null : Math.max(0, concurrency - running);
  const facts = [
    `concurrency ${concurrency} Slot(s) x guest ${configuration.memoryMiB} MiB / ${configuration.vcpus} vCPU / ${configuration.diskGiB} GiB virtual disk`,
    `virtual totals ${BigInt(concurrency) * guestMemory} B memory, ${concurrency * configuration.vcpus} vCPU, ${BigInt(concurrency) * BigInt(configuration.diskGiB) * gib} B disk`,
    running === null ? 'own running guests unknown' : `own running guests ${running} (free Slots ${free})`,
    host.memory ? `host MemTotal ${host.memory.totalBytes} B, MemAvailable ${host.memory.availableBytes} B` : 'host memory unknown (unreadable)',
    host.storage ? `storage available ${host.storage.availableBytes} B` : 'storage unknown (unreadable)',
    `host CPUs ${host.cpus}`,
  ];
  const tail = 'Configured guest limits are virtual, not reserved; each boot re-checks free memory (minus the other own boots still launching) and disk; ' +
    'adapter, VMM, workers, reviewers and Docker vfs overhead are not included.';
  const measured = 'Capacity is proven only by a measured authorized run of this configuration (RAM/CPU/I/O/disk recorded per Work); adjust concurrency or guest limits explicitly.';
  if (!host.memory || !host.storage || free === null) return { id: 'capacity', status: 'unverified', message: `${facts.join('; ')}. Capacity unknown: a host fact is unreadable. ${tail}`,
    nextStep: 'Make the unreadable host fact observable (meminfo, statfs of the root, systemd user units); a boot with unknown memory is refused, never guessed.' };
  if (free === 0) return { id: 'capacity', status: 'unverified', message: `${facts.join('; ')}. Every Slot has a running own guest; no new boot is judged until one ends. ${tail}`, nextStep: measured };
  const oneBoot = bootMemoryAllows({ availableBytes: host.memory.availableBytes, configuration }) && BigInt(host.storage.availableBytes) >= bootDisk;
  const allFree = BigInt(host.memory.availableBytes) >= BigInt(free) * guestMemory + BigInt(memoryFloorMiB(configuration)) * mib &&
    BigInt(host.storage.availableBytes) >= BigInt(free) * BigInt(configuration.diskGiB) * gib + BigInt(configuration.minFreeSpaceGiB) * gib &&
    host.cpus >= concurrency * configuration.vcpus;
  return { id: 'capacity', status: oneBoot ? 'unverified' : 'blocked',
    message: `${facts.join('; ')}. ${allFree ? 'The current observation covers every free Slot at its full virtual size'
      : 'The current observation does NOT cover every free Slot at its full virtual size (guests may still fit: memory and disk are allocated on demand)'}. ${tail}`,
    nextStep: oneBoot ? measured : 'Free host memory/disk (or lower guest memory/disk or the floors) before dispatch: a boot below its preconditions is refused, never retried.' };
}

/** Read-only host observation at this instant (memory, storage of the installation root, CPUs, own active sandbox units); unreadable = undefined/null. */
export async function observeHostCapacity(root: string): Promise<HostCapacity> {
  const storage = await inspectStorage(root);
  const units = await listActiveSandboxUnits();
  return { memory: await inspectMemory(), storage: storage ? { availableBytes: storage.availableBytes } : undefined, cpus: availableParallelism(),
    runningGuests: units ? units.length : null };
}
