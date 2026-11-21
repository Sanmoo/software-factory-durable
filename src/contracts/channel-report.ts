/**
 * v2 ticket 11 (V2-21): what a sandbox that recovers a dropped tool channel reports about one boot. Neutral data: the sandbox writes it,
 * Control records it durably (the package of a substitute session reads it there, V2-19).
 */

/** How the adapter left a tool call whose channel dropped before the program's exit status arrived. */
export type ChannelDropOutcome =
  /** The environment lives: the adapter reconnected and ended the call's process group. Nothing more will come from that call. */
  | 'orphan-ended'
  /** The service reported the environment ended: the call died with it. */
  | 'environment-ended'
  /** The environment lives but the channel could not be re-established within the limit: the call's process may still be running. */
  | 'channel-unrecoverable';

/**
 * One tool call that STARTED in the guest and whose result never arrived. Its effect may have happened, wholly or in part; it is never
 * "not executed" and must never be repeated on the assumption that it did not run.
 */
export type IndeterminateEffect = {
  at: string; executionId: string; invocationId: string; role: string;
  tool: 'bash' | 'write' | 'edit-source';
  callId: string;
  /** What the call asked for, bounded: the Bash command text, or the operation and path of a write. Never file content. */
  description: string;
  outcome: ChannelDropOutcome };

export type ChannelReport = {
  indeterminateEffects: IndeterminateEffect[];
  /** Set once reconnection failed repeatedly with the environment alive: the boot serves no more tool calls. */
  unrecoverable: { at: string; attempts: number } | null };

/** Bound of one effect description (a Bash command may be 16 KiB). */
export const effectDescriptionLimit = 512;
