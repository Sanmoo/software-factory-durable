import { z } from 'zod';
import type { AccessDiagnostic, GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess } from '../platform/github/index.js';

export interface CodeRepository {
  checkAccess(repo: GitHubScope, base: string): Promise<AccessDiagnostic>;
}
export function createCodeRepository(options: { github: GitHubAccess }): CodeRepository {
  return { checkAccess(repo, base) {
    return options.github.diagnose(repo, 'repository', async session => {
      if (!base || /[\x00-\x20\x7f]/.test(base)) throw new InvalidGitHubObservation();
      const branch = await session.get(`/repos/${repo.repository}/branches/${encodeURIComponent(base)}`);
      if (!z.object({ name: z.literal(base), commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) }).safeParse(branch).success) throw new InvalidGitHubObservation();
    });
  } };
}
