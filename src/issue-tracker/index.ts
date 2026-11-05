import { z } from 'zod';
import type { AccessDiagnostic, GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess } from '../platform/github/index.js';

export interface IssueTracker {
  checkAccess(scope: GitHubScope & { label: string }): Promise<AccessDiagnostic>;
}
export function createIssueTracker(options: { github: GitHubAccess }): IssueTracker {
  return { checkAccess(scope) {
    return options.github.diagnose(scope, 'tracker', async session => {
      const issues = await session.list(`/repos/${scope.repository}/issues`);
      const issue = z.object({ id: z.number().int().positive(), number: z.number().int().positive(), repository_url: z.literal(`https://api.github.com/repos/${scope.repository}`) });
      const parsed = z.array(issue.passthrough()).safeParse(issues);
      if (!parsed.success) throw new InvalidGitHubObservation();
      const sample = parsed.data.find(item => !item.pull_request);
      if (sample) {
        const dependencies = await session.list(`/repos/${scope.repository}/issues/${sample.number}/dependencies/blocked_by`);
        if (!z.array(z.object({ id: z.number().int().positive(), number: z.number().int().positive(), repository_url: z.string().url(), state: z.enum(['open', 'closed']) })).safeParse(dependencies).success) throw new InvalidGitHubObservation();
      }
      const comments = await session.list(`/repos/${scope.repository}/issues/comments`);
      const comment = z.object({ id: z.number().int().positive(), user: z.object({ id: z.number().int().positive(), login: z.string(), type: z.string() }) });
      if (!z.array(comment).safeParse(comments).success) throw new InvalidGitHubObservation();
      return sample ? ['Native dependencies probed on one accessible issue only; hidden relations and other repositories are not certified.'] :
        ['No issue available for a native dependency probe; native dependency access remains unverified.'];
    });
  } };
}
