export interface Diagnostic {
  id: string;
  status: 'ok' | 'blocked' | 'unverified';
  message: string;
  nextStep: string;
}

export interface GitHubScope {
  repository: string;
  installationId: number;
  workflows: boolean;
}
export type AccessDiagnostic = {
  source: 'github-rest';
  purpose: 'tracker' | 'repository' | 'dependency';
  observedAt: string;
  repository: string;
  status: 'ok' | 'blocked';
  code: string;
  completeness: 'complete' | 'incomplete';
  certifiesMergeSafety: false;
  nextStep: string;
  waitSeconds?: number;
  workflows?: boolean;
  limitations?: string[];
  identity?: { appId: number; installationId: number; repositoryId: number };
  grant?: { role: 'controller'; purpose: 'tracker' | 'repository' | 'dependency'; permissions: Readonly<Record<string, 'read' | 'write'>>; expiresAt: string };
}

/**
 * Fixed Builder grant purposes (spec §8 table, §2.1): `builder-start` reads the Ticket and sources (implementation, reviews, recovery);
 * `builder-publish` (ticket 14) is the ONLY one with Contents W + Pull requests W, issued only to a publication activation that Control
 * requested after the end-of-Execution verification, for the Builder to push its own branch and open its own draft PR directly (Git/API).
 * Never Workflows, never another repository; the model never chooses it.
 */
export type BuilderGrantPurpose = 'builder-start' | 'builder-publish';
/** Token-free metadata of one reduced Builder grant (spec §8.1): the ONLY part that may enter durable state. */
export type BuilderGrantMetadata = { role: 'builder'; purpose: BuilderGrantPurpose; repository: string; repositoryId: number; installationId: number;
  permissions: Readonly<Record<string, 'read' | 'write'>>; issuedAt: string; expiresAt: string };
/** Active Work/Execution/repository; the composition already binds the authorized configuration. `purpose` is Control's choice for the
 * activity (absent = `builder-start`), never the model's. */
export type BuilderCredentialContext = { workId: string; executionId: string; repository: GitHubScope; purpose?: BuilderGrantPurpose };
/** Transient delivery + metadata. `delivery` is never serialized, persisted, prompted, logged or put in a Git remote. */
export type BuilderGrant = { metadata: BuilderGrantMetadata; delivery: { readonly token: string } };
/**
 * Outcome of ONE revocation attempt of a known grant (spec §8/§8.1, ticket 20). `revoked`: the provider confirmed it; `already-invalid`: the
 * provider no longer accepts the value (expired or revoked earlier), which is NOT proof of cessation; `failed`: a complete known rejection;
 * `unknown`: no conclusive response (never repeated automatically); `impossible`: the value is not available (e.g. lost after a crash), so
 * no request can be made and the grant may stay valid externally until its expiry; `not-attempted`: deliberately not tried.
 */
export type RevocationResult = { kind: 'revoked' | 'already-invalid' | 'failed' | 'unknown' | 'impossible' | 'not-attempted'; code?: string; nextStep: string };
/** Narrow composition dependency (spec §8.1/Q10), not a service, vault or universal authentication protocol. Failures throw coded errors. */
export interface BuilderCredentials {
  issue(context: BuilderCredentialContext): Promise<BuilderGrant>;
  revoke(grant: BuilderGrant): Promise<RevocationResult>;
}
/** Host-side Contents:read credential for the Factory-exclusive bare cache fetch (spec §7.3/§8). In memory only. */
export interface RepositoryFetchCredentials {
  fetch(repository: GitHubScope): Promise<{ readonly token: string; expiresAt: string }>;
  /** One self-revocation attempt right after the fetch (ticket 20 review); never retried, never claims cessation. */
  revoke(grant: { readonly token: string }): Promise<RevocationResult>;
}

/** Stable correlation marker of a published Question (spec §5.5): first line `<!-- software-factory:question:<question-id> -->`. */
export const questionMarkerPrefix = 'software-factory:question:';
/** Ticket 23: stable correlation marker of the controller's reply to a `/factory` command: `<!-- software-factory:reply:<reply-id> -->`. */
export const replyMarkerPrefix = 'software-factory:reply:';
/**
 * Ticket 41: the reference of a Builder request found in Records but not readable intact (it blocks the recovery, ticket 27), shown by
 * `factory show` and named EXACTLY by `factory resume <work> --override-blocked-recovery <reference>`. One shape for Control, socket and CLI.
 */
export const blockedReferencePattern = /^request:[A-Za-z0-9][A-Za-z0-9-]{0,79}:[A-Z][A-Z0-9_]{0,63}$/;
export const blockedReferenceToken = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;
export const blockedRequestReference = (token: string, code: string) => `request:${token}:${code}`;
/**
 * Ticket 50: the boot/preparation refusal that blocked a Work's recovery (`PREPARE_<sandbox code>` / `START_<sandbox code>`), shown by
 * `factory show` and named EXACTLY by `factory resume <work> --retry-blocked-start <code>`. One shape for Control, socket and CLI.
 */
export const blockedStartCodePattern = /^(PREPARE|START)_[A-Z][A-Z0-9_]{0,95}$/;
/**
 * Ticket 50: explicit operator remedies applied together with a retry of a blocked start (`--remedy <name>`), each valid for exactly the
 * refusal codes Control maps it to. Ticket 47 adds its disk remedies for `START_PRESERVED_DISK_CHECK_REQUIRED` here.
 */
export const startRetryRemedies = ['recreate-artifact-seed', /* ticket 47 */ 'repair-disk', 'replace-disk'] as const;
export type StartRetryRemedy = typeof startRetryRemedies[number];

/**
 * Ticket 48 (operator decision 2026-11-19, pilot 35): the Builder budget of ONE Execution (`builder-v1`): model requests, tool calls and the
 * timeout of each model request (the SDK request timeout; there is no worker clock in production, spec §4.4). A repository may adjust each
 * value from 1 up to `builderBudgetMaximumFactor` times it; above that the configuration is refused (no silent fallback).
 */
export const builderBudgetV1 = Object.freeze({ requests: 150, toolCalls: 300, requestTimeoutMinutes: 60 });
export const builderBudgetMaximumFactor = 2;
/** Ticket 51 (operator decision 2026-11-19, pilot 35): the fixed reviewer budget of ONE opinion (`reviewer-v1`). Ticket 59: one source for the
 * worker limits, the release record and the owner's secret-sync bound. */
export const reviewerBudgetV1 = Object.freeze({ requests: 48, toolCalls: 160, requestTimeoutMinutes: 30 });
/** The model requests of a session launched without a Host budget policy (the bounded OAuth qualification). */
export const qualificationRequestsV1 = 2;
/** Ticket 48: per-repository Builder budget adjustment as configured (each field optional; absent = the release value). */
export type BuilderBudgetConfiguration = { requests?: number | undefined; toolCalls?: number | undefined; requestTimeoutMinutes?: number | undefined };
/** Ticket 48: a budget end WITH Host-observed progress continues in a new Execution charged to this per-Work counter, not to recoveries. */
export const continuationsPerWork = 5;
/**
 * Operator decision 2026-11-15 (ticket 28), own budget since ticket 57: automatic retries of ONE reviewer role in ONE review round (attempt 3
 * is the last). They charge nothing to the Work's `recoveries`; the next failure stops the Execution `REVIEWER_RETRY_LIMIT` (ticket 51).
 */
export const reviewerRetriesPerRound = 2;
/**
 * Ticket 48: the Host's fingerprint of a Work's checkout (confined reads, no host git, no guest command): `head` = the HEAD file, `ref` = the
 * value of the branch ref HEAD names, `git` = hash of HEAD/ref/packed-refs/index, `tree` = hash of a bounded metadata walk (path, kind, size,
 * mtime) of the working tree outside `.git` and build/cache directories, null when the walk exceeded its bound (then only Git counts).
 */
export type CheckoutFingerprint = { status: 'observed'; head: string | null; ref: string | null; git: string; tree: string | null; entries: number; observedAt: string } |
  { status: 'unavailable'; code: string };
/** Ticket 48: what the Host established about progress between the start and the end of a Builder Execution. */
export type BudgetEndProgress = { kind: 'progress'; commits: boolean; checkout: boolean } | { kind: 'none' } | { kind: 'unknown'; code: string };
/** Stable correlation marker of a Work's own pull request (spec §9.1, ticket 14): first line of its body `<!-- software-factory:work:<work-id> -->`. */
export const publicationMarkerPrefix = 'software-factory:work:';
/** Reviewer roles bound by the Host (spec §5.6/§6.4); never chosen by a model. */
export type ReviewerRole = 'standards' | 'spec';
/** One finding identifiable by its basis: a documented rule (preserved instruction), a requirement (preserved request) or a heuristic. */
export type ReviewFinding = { id: string; basis: 'rule' | 'requirement' | 'heuristic'; reference: string;
  location: { path: string; line?: number }; summary: string };
export type ReviewLimitation = { code: 'SOURCE_UNREADABLE' | 'TRUNCATION_NOT_OVERCOME' | 'CONTEXT_INSUFFICIENT' | 'OTHER'; detail: string };
/**
 * Complete reviewer opinion (spec §6.4), preserved durably by the reviewer worker BEFORE its completion is notified. A failure or a
 * cancellation is an opinion outcome, never zero findings. `hostChecks` are the Host's own observations (inputs actually read, read
 * failures, outstanding truncation, missing context) that can only downgrade a clean conclusion, never upgrade one.
 */
export type ReviewOpinion = {
  version: 1; role: ReviewerRole; round: number; attempt: number;
  invocationId: string; reference: { workId: string; id: string };
  /** Ticket 13: `continued` = a later round continued the reviewer's earlier session (copy, same boot); `replaced` = a new session, with why. */
  session: { file: string | null; mode?: 'new' | 'continued' | 'replaced'; from?: string | null; code?: string | null }; model: { providerId: string; modelId: string }; profile: { id: string; modelBudget: string | null };
  input: { handoffIndexSha256: string; required: string[]; missing: string[] };
  conclusion: 'clean' | 'findings' | 'incomplete' | 'failure' | 'cancelled'; code: string | null;
  coverage: { scope: 'incremental' | 'broad'; justification: string; examined: string[] } | null;
  findings: ReviewFinding[]; limitations: ReviewLimitation[];
  hostChecks: { reads: number; failedReads: { path: string; code: string; offset?: number }[]; requiredNotFullyRead: string[]; downgraded: string[] };
  finalMessageSha256: string | null; recordedAt: string;
};
/** Small Builder handoff summary sent to Control; the full index/diffs live in the Work's artifact area for the reviewers. */
export type ProposalHandoff = {
  version: 1; round: number; index: string; indexSha256: string; head: string; branch: string | null; base: string; mergeBase: string | null;
  counts: { entries: number; committed: number; staged: number; unstaged: number; untracked: number; removed: number };
  /** `own` (reconciliation captures only, the authorized remote tip an ancestor of HEAD): the Builder's own changes, authorized tip..HEAD. */
  patches: Record<'committed' | 'staged' | 'unstaged', { path: string; bytes: number; sha256: string }> & { own?: { path: string; bytes: number; sha256: string } };
  spec: { version: string; sources: string; sha256: string } | null; instructions: { version: string; sources: string; sha256: string } | null;
  /** Guest paths of the present changed files (sorted, at most 20) the reviewers must read in full; the index lists all of them. */
  changed: string[]; changedTruncated: boolean;
  /** Reconciliation captures only (with `patches.own`): the present changed files of the Builder's OWN work — changed since the authorized
   * remote tip, or in the working tree — never the operator-authorized human commits, which stay context (q34-ghadv-v2/v3). */
  ownChanged?: string[]; ownChangedTruncated?: boolean;
  /**
   * Ticket 13: content identity of the proposal independent of Git metadata (sha256 over path/presence/kind/mode/content of every indexed
   * path), whether the tree is clean (nothing staged/unstaged/untracked) and whether the HEAD commit holds exactly that content (blobs of
   * HEAD hashed by content). Absent in captures of earlier Factory versions: then no exemption can be demonstrated.
   */
  content?: { sha256: string; clean: boolean; headMatches: boolean };
  /**
   * Ticket 21: present only when the Host asked (a reconciliation Execution): whether the remote tip whose divergence the operator authorized
   * to incorporate is an ancestor of HEAD — the human commits are preserved, never rewritten or dropped. Computed by the capture program.
   */
  preserved?: { commit: string; ancestor: boolean };
};
/**
 * Ticket 13 (spec §6.3/§6.4): a concrete PRIOR authorization referenced by a treatment or a gate waiver: an answered Factory Question
 * (correlated by Control to this Work) or a preserved request source (`/artifacts/spec/vN/...`, presence checked, never interpreted).
 */
export type ConcreteAuthorization = { kind: 'question'; questionId: string } | { kind: 'preserved-source'; reference: string };
/** The Builder's treatment of one finding of an earlier round: fixed, or not adopted with its justification/evidence. */
export type FindingTreatment = { round: number; role: ReviewerRole; findingId: string; outcome: 'fixed' | 'not-adopted'; justification: string;
  evidence: string | null; authorization: ConcreteAuthorization | null };
/**
 * One documented gate as evidenced by the Builder HOST from its own protected Bash result (exit code + protected output reference), never
 * from output or status declared by the model. `declared` is what the Builder said; `outcome` is what the Host could establish:
 * `passed`/`failed` from the real exit code, `unknown` when the result was lost (effects/capture unknown), `unverified` when no matching
 * protected result exists, `not-run`/`waived` as declared. `current`: the declared cwd is the Host's real Bash cwd, both content snapshots
 * exist, the command itself changed nothing (before === after) and the captured proposal still has exactly that content (after === capture);
 * never decided by tool names/start order. `requiredCheck` names a GitHub required check the gate corresponds to: a waiver never satisfies it.
 */
export type GateEvidence = { id: string; source: string; command: string; cwd: string; requiredCheck: string | null;
  declared: 'run' | 'not-run' | 'waived'; outcome: 'passed' | 'failed' | 'unknown' | 'unverified' | 'not-run' | 'waived'; code: string | null;
  exitCode: number | null; output: { workId: string; id: string } | null; sequence: number | null; current: boolean;
  reason: string | null; authorization: ConcreteAuthorization | null };
/** Treatments and gate evidence attached by the Builder host to one capture (handoff or closing). */
export type HandoffDeclarations = { treatments: FindingTreatment[]; gates: GateEvidence[] };
/** Host-side identity of a handed-off proposal (hashes of every indexed path plus Git metadata), computed with confined reads. */
/**
 * v2 ticket 07 (V2-06): what the fixed preservation program saw IN the guest: HEAD, the tracked changes, the untracked files that are not
 * ignored, the stash, and the Work branch tip as `ls-remote` of `origin` answered it (never the local tracking ref). Guest-attested: the
 * caller confirms the tip with its own read of `origin` before it treats anything as preserved.
 */
export type PreservationObservation = { status: 'observed'; head: string; modified: number; untracked: number; stashes: number;
  remote: { state: 'present'; sha: string } | { state: 'absent' } | { state: 'unavailable' } } | { status: 'unavailable'; code: string };
export type ProposalIdentity = { status: 'observed'; sha256: string; indexSha256: string; entries: number; consistent: boolean; observedAt: string } | { status: 'unavailable' | 'refused'; code: string };
/** The exact reviewer output contract (the prompt is Control's; the parser is the reviewer worker's). */
export const reviewVerdictFormat = 'Your FINAL message must be ONLY the JSON verdict object (bare, or alone inside one ```json fenced block): no prose before or after, ' +
  'no second block; anything else is recorded as an invalid review. Schema: {"role":"standards"|"spec","conclusion":"clean"|"findings"|"incomplete",' +
  '"coverage":{"scope":"incremental"|"broad","justification":"...","examined":["<guest paths>"]},"findings":[{"id":"S1","basis":"rule"|"requirement"|"heuristic",' +
  '"reference":"<preserved source path#section, or heuristic name>","location":{"path":"<guest path>","line":1},"summary":"..."}],' +
  '"limitations":[{"code":"SOURCE_UNREADABLE"|"TRUNCATION_NOT_OVERCOME"|"CONTEXT_INSUFFICIENT"|"OTHER","detail":"..."}]}. ' +
  'Example (clean): {"role":"spec","conclusion":"clean","coverage":{"scope":"broad","justification":"Read the index, every patch and changed file in full against the preserved request.",' +
  '"examined":["/workspace/checkout/docs/a.md","/artifacts/spec/v1/ticket.json"]},"findings":[],"limitations":[]} ' +
  'Example (with findings): {"role":"standards","conclusion":"findings","coverage":{"scope":"incremental","justification":"Only the changed files and their preserved instructions.",' +
  '"examined":["/workspace/checkout/src/a.ts"]},"findings":[{"id":"S1","basis":"rule","reference":"/artifacts/instructions/v1/AGENTS.md#naming",' +
  '"location":{"path":"/workspace/checkout/src/a.ts","line":3},"summary":"Name violates the documented convention."}],"limitations":[]} ' +
  'Paths are guest paths: /workspace/checkout/... or /artifacts/....';

/**
 * Versioned Factory Builder skill packs shipped with this release. A published pack is never edited: a change appends a new id (the pack
 * decides its own guest paths and, in its manifest, which session protocols it supports). Consumers derive their enum/registry from this
 * list, so renumbering or adding a version is a data change here plus the pack directory.
 */
export const factorySkillPackIds = ['factory-skills-v1', 'factory-skills-v2', 'factory-skills-v3', 'factory-skills-v4', 'factory-skills-v5', 'factory-skills-v6', 'factory-skills-v7', 'factory-skills-v8', 'factory-skills-v9', 'factory-skills-v10', 'factory-skills-v11'] as const;
export type FactorySkillPackId = typeof factorySkillPackIds[number];

/**
 * Ticket 33: the Control storage format this release operates and the formats its explicit upgrade migrates from. Owned by Control
 * (which enforces it); declared in each release manifest so an upgrade or rollback can decide, BEFORE changing anything, whether a release
 * may operate a given storage. A release manifest without this declaration predates ticket 33 and operates format 1 only.
 */
// Jira ticket 02: format 3 (installation v3) marks every storage that may hold state of the Jira origin, so a format-2 release refuses it.
// `documents` is the document kind → version matrix of that format (Control's format table uses it as is; later Jira tickets add their kinds here).
export const controlStorageCompatibility = Object.freeze({ format: 3, migratesFrom: Object.freeze([1, 2]),
  migrations: Object.freeze(['factory-storage-1-to-2', 'factory-storage-2-to-3']),
  documents: Object.freeze({ 'factory.installation': 3, 'factory.request': 1, 'factory.ticket-index': 1, 'factory.work': 1, 'factory.slots': 1, 'factory.question': 1 }) });

// Ticket 44: the per-repository environment declaration (`.factory/environment.yaml`), its observation, pin and prepared identity.
export { apkPackageNamePattern, apkVersionPattern, environmentDeclarationLimits, environmentDeclarationMaxBytes, environmentDeclarationPath, imageReferencePattern,
  imageReferenceParts, validateEnvironmentDeclaration, type EnvironmentBaseIdentity, type EnvironmentDeclaration, type EnvironmentDeclarationError,
  type EnvironmentDeclarationObservation, type PinnedEnvironment } from './environment.js';
// v2 ticket 01 (V2-03/V2-04): the capabilities a sandbox adapter declares; Control reads these, never the adapter or its service.
export { declaresCapability, sandboxCapabilityNames, type SandboxCapabilities, type SandboxCapabilityName } from './sandbox-capabilities.js';
export { effectDescriptionLimit, effectTextWithheld, type ChannelDropOutcome, type ChannelReport, type IndeterminateEffect } from './channel-report.js';
export { lostMarkerPattern, lostMarkerPrefix, lostMarkerRef } from './loss-marker.js';
export type { BootUsage, BootUsageReport, EnvironmentBuildReport, EnvironmentBuilds } from './boot-usage.js';
