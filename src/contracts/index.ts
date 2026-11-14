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

/** Token-free metadata of one reduced Builder grant (spec §8.1): the ONLY part that may enter durable state. */
export type BuilderGrantMetadata = { role: 'builder'; purpose: 'builder-start'; repository: string; repositoryId: number; installationId: number;
  permissions: Readonly<Record<string, 'read' | 'write'>>; issuedAt: string; expiresAt: string };
/** Active Work/Execution/repository; the composition already binds the authorized configuration and purpose. */
export type BuilderCredentialContext = { workId: string; executionId: string; repository: GitHubScope };
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
  session: { file: string | null }; model: { providerId: string; modelId: string }; profile: { id: string; modelBudget: string | null };
  input: { handoffIndexSha256: string; required: string[]; missing: string[] };
  conclusion: 'clean' | 'findings' | 'incomplete' | 'failure' | 'cancelled'; code: string | null;
  coverage: { scope: 'incremental' | 'broad'; justification: string; examined: string[] } | null;
  findings: ReviewFinding[]; limitations: ReviewLimitation[];
  hostChecks: { reads: number; failedReads: { path: string; code: string }[]; requiredNotFullyRead: string[]; downgraded: string[] };
  finalMessageSha256: string | null; recordedAt: string;
};
/** Small Builder handoff summary sent to Control; the full index/diffs live in the Work's artifact area for the reviewers. */
export type ProposalHandoff = {
  version: 1; round: number; index: string; indexSha256: string; head: string; branch: string | null; base: string; mergeBase: string | null;
  counts: { entries: number; committed: number; staged: number; unstaged: number; untracked: number; removed: number };
  patches: Record<'committed' | 'staged' | 'unstaged', { path: string; bytes: number; sha256: string }>;
  spec: { version: string; sources: string; sha256: string } | null; instructions: { version: string; sources: string; sha256: string } | null;
  /** Guest paths of the present changed files (sorted, at most 20) the reviewers must read in full; the index lists all of them. */
  changed: string[]; changedTruncated: boolean;
};
/** Host-side identity of a handed-off proposal (hashes of every indexed path plus Git metadata), computed with confined reads. */
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
