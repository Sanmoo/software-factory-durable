/**
 * v2 ticket 14 (V2-32): what a sandbox reports about the boots of one environment, in terms that name no service. Control sums and shows
 * these values; it never computes a duration, a size or a price itself, and there is no monetary value anywhere.
 *
 * `state` says what `seconds` is:
 * - `measured`: the sandbox's service gave both instants of the boot; `seconds` is their difference.
 * - `running`: the boot has not ended; no final figure exists yet.
 * - `unknown`: the final observation of the boot was not possible (its end was never confirmed, or whether anything ran is not known).
 *   `seconds` is `null`: never zero, and a total that includes such a boot is a lower bound.
 * - `not-run`: the start was refused before anything ran; `seconds` is 0 because nothing was consumed.
 */
export type BootUsage = {
  boot: string;
  /** Why the boot began and why it ended, as the sandbox recorded them (for example `start`, `planned-swap`, `loss`, `end`); `end` null: not ended. */
  begin: string;
  end: string | null;
  /** The sandbox's code of a start that did not complete. */ code?: string;
  /** The size of the boot as the sandbox labels it; opaque to Control. */ size: string;
  startedAt: string | null;
  endedAt: string | null;
  seconds: number | null;
  state: 'measured' | 'running' | 'unknown' | 'not-run';
};
/** `unit` names what a second of this sandbox is (shown as given). `unavailable`: this sandbox does not measure boots (never an empty list). */
export type BootUsageReport = { status: 'reported'; unit: string; boots: BootUsage[] } | { status: 'unavailable'; code: string };

/**
 * v2 ticket 14 (V2-32): builds of the environment base, per environment key. `builds` counts the builds this installation requested for
 * the key (a retry of a failed build is another build); `works` is how many Works of this installation use the key.
 */
export type EnvironmentBuilds = {
  key: string;
  name: string;
  builds: number;
  works: number;
  last: { requestedAt: string; settledAt: string | null; outcome: 'requested' | 'created' | 'failed' };
};
export type EnvironmentBuildReport = { status: 'reported'; keys: EnvironmentBuilds[] } | { status: 'unavailable'; code: string };
