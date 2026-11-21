/**
 * v2 (V2-03): what a sandbox adapter DECLARES about itself. Control decides from these values only; it never learns which adapter or
 * service is behind them. One adapter serves the whole installation (V2-01), so the declaration is fixed for a controller run.
 */
export type SandboxCapabilities = {
  /** The guest runs its own Docker daemon (declared container images can be pulled and run). */
  docker: boolean;
  /**
   * The environment's disk and workspace survive a boot. "Stop preserves the disk/workspace" is a consequence of THIS capability, never a
   * universal contract of `stop`: without it every boot starts from the Git remote and unpublished work dies with the boot.
   */
  persistentDisk: boolean;
  /**
   * Maximum duration of one boot and the margin before it at which the boot must be rotated, in seconds. `null`: a boot has no maximum
   * duration and is never rotated.
   */
  bootDuration: { maxSeconds: number; rotationMarginSeconds: number } | null;
  /** Network egress of the guest. `mediation: 'http'`: only HTTP(S) through the adapter's mediation; `'none'`: unmediated, unfiltered. */
  egress: { mediation: 'http' | 'none';
    /** Any public IPv4 TCP destination is reachable directly from the guest. */
    publicTcp: boolean;
    /** v2 ticket 04 (V2-25): outbound UDP and outbound IPv6 exist; the guest reaches a private network of the Operator (a VPC). */
    udp: boolean; ipv6: boolean; privateNetwork: boolean };
  /**
   * v2 ticket 11 (V2-21): a dropped tool channel does not end the activation while the environment lives. The sandbox reconnects, ends
   * the orphan call and returns it to the session as "indeterminate"; what it could not confirm is in its channel report of the boot.
   * Absent or `false`: a lost channel ends the activation (the MVP rule) and there is no report to read.
   */
  channelRecovery?: boolean;
  /**
   * v2 ticket 10 (V2-15): the sandbox watches the environment of a boot through its service, at an interval of its own, and tells Control
   * when its cessation is confirmed; it has by then cancelled the tool call in flight and denies every later one. Absent or `false`:
   * nobody watches the environment (the MVP rule; a guest that is a process of the host ends with its boot owner).
   */
  environmentWatch?: boolean;
};

/** The capabilities a repository can REQUIRE (V2-04). Names are shown to the operator in diagnostics. */
export const sandboxCapabilityNames = ['docker', 'persistent-disk'] as const;
export type SandboxCapabilityName = typeof sandboxCapabilityNames[number];

/** Whether `capabilities` declares the named capability. */
export function declaresCapability(capabilities: SandboxCapabilities, name: SandboxCapabilityName): boolean {
  return name === 'docker' ? capabilities.docker : capabilities.persistentDisk;
}
