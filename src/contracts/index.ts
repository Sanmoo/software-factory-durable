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
