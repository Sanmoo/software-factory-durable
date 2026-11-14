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
