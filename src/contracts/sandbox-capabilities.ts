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
    /** Any public TCP destination is reachable directly from the guest. */
    publicTcp: boolean };
};

/** The capabilities a repository can REQUIRE (V2-04). Names are shown to the operator in diagnostics. */
export const sandboxCapabilityNames = ['docker', 'persistent-disk'] as const;
export type SandboxCapabilityName = typeof sandboxCapabilityNames[number];

/** Whether `capabilities` declares the named capability. */
export function declaresCapability(capabilities: SandboxCapabilities, name: SandboxCapabilityName): boolean {
  return name === 'docker' ? capabilities.docker : capabilities.persistentDisk;
}
