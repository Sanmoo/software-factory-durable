import { createHash } from 'node:crypto';
import { isAlias, isNode, parseDocument, visit } from 'yaml';
import { z } from 'zod';
import { environmentDeclarationMaxBytes, environmentDeclarationPath, validateEnvironmentDeclaration, type EnvironmentDeclarationObservation,
  type GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess } from '../platform/github/index.js';

/**
 * Ticket 44: parse + closed validation of the bytes of `.factory/environment.yaml` (host side: the YAML is DATA, never executed). One document,
 * no anchors/aliases/custom tags, unique keys; then the contracts' closed schema. Errors name the path.
 */
export function parseEnvironmentDeclaration(bytes: Buffer): ReturnType<typeof validateEnvironmentDeclaration> {
  if (bytes.length > environmentDeclarationMaxBytes) return { valid: false, errors: [{ path: '$', message: `file larger than ${environmentDeclarationMaxBytes} bytes` }] };
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { valid: false, errors: [{ path: '$', message: 'file is not valid UTF-8' }] };
  const document = parseDocument(text, { uniqueKeys: true, merge: false, prettyErrors: false, strict: true });
  if (document.errors.length) {
    const first = document.errors[0]!;
    return { valid: false, errors: [{ path: '$', message: `YAML syntax: ${first.code} ${first.message.split('\n')[0]!.slice(0, 160)}` }] };
  }
  let decorated = false;
  visit(document, { Node(_key, node) { if (isAlias(node) || (isNode(node) && (node.anchor !== undefined || node.tag !== undefined))) { decorated = true; return visit.BREAK; } return undefined; } });
  if (decorated) return { valid: false, errors: [{ path: '$', message: 'YAML anchors, aliases and explicit tags are not allowed' }] };
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 0 }); } catch { return { valid: false, errors: [{ path: '$', message: 'YAML could not be converted to plain data' }] }; }
  return validateEnvironmentDeclaration(value);
}

const contentSchema = z.object({ type: z.literal('file'), encoding: z.literal('base64'), content: z.string().max(4 * environmentDeclarationMaxBytes),
  size: z.number().int().nonnegative().safe(), path: z.literal(environmentDeclarationPath) });

export function environmentOperations(options: { github: GitHubAccess }) {
  return {
    /**
     * Ticket 44: the CURRENT tip of `base` (complete matching-refs listing, exact ref) and `.factory/environment.yaml` AT THAT COMMIT (contents
     * API with `ref=<sha>`), under the narrow `environment-read` grant (Contents R). A 404 of the file at a known commit is `missing`; any
     * failure to observe is `unavailable` (never absence). The file is parsed and validated here; nothing in it is executed.
     */
    async readEnvironmentDeclaration(input: { repo: GitHubScope; base: string }): Promise<EnvironmentDeclarationObservation> {
      const observedAt = new Date().toISOString();
      if (!/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/.test(input.base)) {
        return { kind: 'unavailable', observedAt, code: 'INVALID_BRANCH', nextStep: 'The configured base branch name was rejected locally; nothing was read.' };
      }
      const read = await options.github.read(input.repo, 'environment-read', async session => {
        const refs = z.array(z.object({ ref: z.string(), object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), type: z.string() }) }))
          .safeParse(await session.list(`/repos/${input.repo.repository}/git/matching-refs/heads/${input.base.split('/').map(encodeURIComponent).join('/')}`, { maxPages: 2 }));
        if (!refs.success) throw new InvalidGitHubObservation();
        const exact = refs.data.filter(item => item.ref === `refs/heads/${input.base}`);
        if (exact.length !== 1 || exact[0]!.object.type !== 'commit') return { kind: 'no-base' as const };
        const commit = exact[0]!.object.sha;
        let raw: unknown;
        try { raw = await session.get(`/repos/${input.repo.repository}/contents/${environmentDeclarationPath}?ref=${commit}`); }
        catch (error) {
          if (error instanceof Error && error.message === 'GITHUB_NOT_FOUND_OR_HIDDEN') return { kind: 'missing' as const, commit };
          throw error;
        }
        // A directory listing (array) or a symlink/submodule at the path is not a declaration file.
        const parsed = contentSchema.safeParse(raw);
        if (!parsed.success) return { kind: 'not-a-file' as const, commit };
        const bytes = Buffer.from(parsed.data.content.replace(/\s+/g, ''), 'base64');
        if (bytes.length !== parsed.data.size) throw new InvalidGitHubObservation();
        // Returned as base64 text: a read result is plain data (the access layer serializes it).
        return { kind: 'file' as const, commit, content: bytes.toString('base64') };
      });
      if (!read.ok) return { kind: 'unavailable', observedAt: read.observedAt, code: read.code, ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}),
        nextStep: `The environment declaration could not be read; nothing is concluded (the Work does not start until it is). ${read.nextStep}` };
      const value = read.value;
      if (value.kind === 'no-base') return { kind: 'unavailable', observedAt: read.observedAt, code: 'BASE_BRANCH_NOT_FOUND',
        nextStep: `The configured base branch ${input.base} was not found in ${input.repo.repository}; fix the repository configuration.` };
      if (value.kind === 'missing') return { kind: 'missing', observedAt: read.observedAt, commit: value.commit };
      if (value.kind === 'not-a-file') return { kind: 'invalid', observedAt: read.observedAt, commit: value.commit, sha256: null,
        errors: [{ path: '$', message: `${environmentDeclarationPath} is not a regular file` }] };
      const bytes = Buffer.from(value.content, 'base64');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const result = parseEnvironmentDeclaration(bytes);
      return result.valid ? { kind: 'declared', observedAt: read.observedAt, commit: value.commit, sha256, declaration: result.declaration }
        : { kind: 'invalid', observedAt: read.observedAt, commit: value.commit, sha256, errors: result.errors };
    },
  };
}
