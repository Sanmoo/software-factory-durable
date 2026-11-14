/**
 * Ticket 11 (spec §5.5/§6.1): the Host-observed identity of a Builder session preserved by its boot owner after the worker ended (Pi
 * SessionManager JSONL v3). `ref` is relative to the installation root (a host runtime path, never guest-writable); no content. `profile`
 * is what a continuation must match: SDK profile, provider/model, skill pack and the exact tool set of that session.
 */
export type SessionProfile = { sdkProfile: string; providerId: string; modelId: string; skillPack: string | null; tools: string[] };
export type WorkerSessionRef = { ref: string; sessionId: string; sha256: string; bytes: number; format: 'pi-session-jsonl-v3'; profile: SessionProfile };
/** Q6 `observe` of a preserved session for a planned continuation: available and compatible, or why it cannot be continued. */
export type SessionObservation = { state: 'compatible'; session: WorkerSessionRef } |
  { state: 'lost' | 'altered' | 'incompatible' | 'unavailable'; code: string; differences: string[] };
