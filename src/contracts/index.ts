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
export type RevocationResult = { kind: 'revoked' | 'not-attempted' | 'unknown'; nextStep: string };
/** Narrow composition dependency (spec §8.1/Q10), not a service, vault or universal authentication protocol. Failures throw coded errors. */
export interface BuilderCredentials {
  issue(context: BuilderCredentialContext): Promise<BuilderGrant>;
  revoke(grant: BuilderGrant): Promise<RevocationResult>;
}
/** Host-side Contents:read credential for the Factory-exclusive bare cache fetch (spec §7.3/§8). In memory only. */
export interface RepositoryFetchCredentials {
  fetch(repository: GitHubScope): Promise<{ readonly token: string; expiresAt: string }>;
}
