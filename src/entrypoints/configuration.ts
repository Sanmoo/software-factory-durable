import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { createSandbox, type HostToolProbe, type LambdaServiceFactory } from '../sandbox/index.js';
import { builderBudgetMaximumFactor, builderBudgetV1 } from '../contracts/index.js';

const text = z.string().trim().min(1).max(256).refine(value =>
  // Jira ticket 01: Atlassian API tokens (ATATT…) join the refused shapes.
  !/(?:gh[pousr]_|github_pat_|sk-[a-zA-Z0-9]|ATATT[a-zA-Z0-9]|-----BEGIN.*PRIVATE KEY)/.test(value), 'Secret values are forbidden');
const positive = z.number().int().positive().safe();
const login = text.regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/);
const credentialFile = text.regex(/^credentials\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/);
const model = z.strictObject({ provider: text, model: text, credentialFile: credentialFile.optional() });
const repository = z.strictObject({
  repository: text.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  base: text.refine(value => !/(?:\.\.|[\s~^:?*\[\\]|@\{|\/\/)/.test(value)
    && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/')
    && !value.endsWith('.') && !value.includes('\x7f') && value !== '@'
    && value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'))
    && !/[\x00-\x1f]/.test(value), 'Invalid branch'),
  installationId: positive,
  workflows: z.boolean(),
  label: text.default('ready-for-agent'),
  correctionLimit: z.number().int().nonnegative().safe().default(3),
  recoveryLimit: z.number().int().nonnegative().safe().default(3),
  timeoutSeconds: positive.optional(),
  // Ticket 48: per-repository adjustment of the Builder budget of one Execution (release values 150 requests, 300 tool calls, 60 minutes per
  // model request). Each value from 1 up to 2x the release value; above it the whole configuration is refused (BUILDER_BUDGET_ABOVE_MAXIMUM).
  builderBudget: z.strictObject({
    requests: z.number().int().positive().max(builderBudgetV1.requests * builderBudgetMaximumFactor).optional(),
    toolCalls: z.number().int().positive().max(builderBudgetV1.toolCalls * builderBudgetMaximumFactor).optional(),
    requestTimeoutMinutes: z.number().int().positive().max(builderBudgetV1.requestTimeoutMinutes * builderBudgetMaximumFactor).optional(),
  }).optional(),
});
// Readable ONLY for native dependency reads (spec §4.2): never a Ticket origin, never executable, no base/label/limits.
const dependencyRepository = z.strictObject({
  repository: text.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  installationId: positive,
});
/**
 * config.yaml schema version declared in the release manifest (metadata.formats.configuration) and compared by `upgrade rollback`.
 * Jira ticket 01 keeps it at 1 (the release manifest and the rollback guard are unchanged); ticket 02 replaces that single number by
 * the supported set below.
 */
export const configurationSchemaVersion = 1;
/** Every config.yaml schema version this release validates: 1 (repositories are the GitHub Ticket sources) and 2 (`ticketSources`). */
export const configurationSchemaVersions = [1, 2] as const;
const common = {
  // Login, or {login, id}: the pinned immutable GitHub user id (comments then match by id only; spec §11.3 authorized operator).
  operators: z.array(z.union([login, z.strictObject({ login, id: positive })]))
    .refine(values => new Set(values.map(value => (typeof value === 'string' ? value : value.login).toLowerCase())).size === values.length)
    .refine(values => { const ids = values.flatMap(value => typeof value === 'string' ? [] : [value.id]); return new Set(ids).size === ids.length; }),
  models: z.strictObject({ builder: model, standards: model, spec: model }),
  githubApp: z.strictObject({
    appId: positive,
    privateKeyFile: credentialFile,
  }),
  sandbox: z.unknown(),
  repositories: z.array(repository).refine(values =>
    new Set(values.map(value => value.repository.toLowerCase())).size === values.length),
  dependencyRepositories: z.array(dependencyRepository).default([]).refine(values =>
    new Set(values.map(value => value.repository.toLowerCase())).size === values.length),
  concurrency: positive.default(1),
  pollingSeconds: positive.default(60),
  retentionDays: positive.default(30),
};
type Common = { repositories: { repository: string }[]; dependencyRepositories: { repository: string }[] };
const exclusive = <T extends Common>(value: T) => !value.dependencyRepositories.some(dependency =>
  value.repositories.some(executable => executable.repository.toLowerCase() === dependency.repository.toLowerCase()));
const exclusiveIssue = { path: ['dependencyRepositories'], message: 'A repository is either executable or dependency-only, never both' };

// v2 (Jira ticket 01, spec §1): Ticket sources, separate from executable destinations. IDs are numeric strings; the Jira origin is
// HTTPS and nothing but an origin; the token is a credentials/ file read on the host only (never here).
const numericId = z.string().regex(/^[1-9][0-9]{0,17}$/);
const jiraOrigin = text.refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.origin === value;
  } catch { return false; }
}, 'Jira url must be an https origin (no path, query, fragment or credentials)');
const githubSource = z.strictObject({ tracker: z.literal('github'), repository: repository.shape.repository, discover: z.boolean() });
const jiraSource = z.strictObject({
  tracker: z.literal('jira'),
  discover: z.boolean(),
  siteId: text.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  url: jiraOrigin,
  email: text.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  tokenFile: credentialFile,
  projectId: numericId,
  label: text.regex(/^\S+$/),
  routes: z.array(z.strictObject({ componentId: numericId, repository: repository.shape.repository })).min(1)
    .refine(values => new Set(values.map(value => value.componentId)).size === values.length, 'Each componentId routes once'),
});
const schemaV1 = z.strictObject({ schemaVersion: z.literal(1), ...common }).refine(exclusive, exclusiveIssue);
const schemaV2 = z.strictObject({ schemaVersion: z.literal(2), ...common, ticketSources: z.array(z.discriminatedUnion('tracker', [githubSource, jiraSource])) })
  .refine(exclusive, exclusiveIssue)
  .superRefine((value, context) => {
    const executable = new Set(value.repositories.map(item => item.repository.toLowerCase()));
    const destination = (name: string, path: (string | number)[]) => {
      if (!executable.has(name.toLowerCase())) context.addIssue({ code: 'custom', path, message: 'Only an executable repository is a Ticket source or route destination' });
    };
    const github = new Set<string>(), projects = new Set<string>(), origins = new Map<string, string>();
    value.ticketSources.forEach((source, index) => {
      if (source.tracker === 'github') {
        destination(source.repository, ['ticketSources', index, 'repository']);
        if (github.has(source.repository.toLowerCase())) context.addIssue({ code: 'custom', path: ['ticketSources'], message: 'One GitHub source per repository' });
        github.add(source.repository.toLowerCase());
        return;
      }
      source.routes.forEach((route, routeIndex) => destination(route.repository, ['ticketSources', index, 'routes', routeIndex, 'repository']));
      const project = `${source.siteId}\n${source.projectId}`;
      if (projects.has(project)) context.addIssue({ code: 'custom', path: ['ticketSources'], message: 'One Jira source per site project' });
      projects.add(project);
      const origin = origins.get(source.siteId);
      if (origin !== undefined && origin !== source.url) context.addIssue({ code: 'custom', path: ['ticketSources'], message: 'A siteId names one origin' });
      origins.set(source.siteId, source.url);
    });
  });
const schema = z.union([schemaV1, schemaV2]);
/** The effective configuration's Ticket sources (v1: every executable repository is a GitHub source with discovery on). */
export type TicketSourceConfiguration = z.infer<typeof githubSource> | z.infer<typeof jiraSource>;
/** One shape for both versions: `ticketSources` is derived for v1, so composition never branches on the YAML version. */
function normalized(input: z.infer<typeof schema>) {
  const ticketSources: TicketSourceConfiguration[] = input.schemaVersion === 2 ? input.ticketSources
    : input.repositories.map(item => ({ tracker: 'github' as const, repository: item.repository, discover: true }));
  return { ...input, ticketSources };
}

/** `guestAssets`: the pin of a verified release (trusted composition data), never read from the YAML. */
/** `lambdaService` (v2 ticket 02): how a Lambda installation's AWS account is reached; the `aws` CLI by default, a double in tests.
 * `lambdaHostTool`: whether a host tool of the Lambda channel can be run; the real PATH by default, a double in tests. */
export async function readConfiguration(root: string, guestAssets?: { directory: string; manifestSha256: string },
  { lambdaService, lambdaHostTool }: { lambdaService?: LambdaServiceFactory; lambdaHostTool?: HostToolProbe } = {}) {
  const sandboxOf = () => createSandbox({ root, ...(guestAssets ? { guestAssets } : {}), ...(lambdaService ? { lambdaService } : {}), ...(lambdaHostTool ? { lambdaHostTool } : {}) });
  let input: unknown;
  try {
    const configPath = join(root, 'config.yaml');
    const info = await lstat(configPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Configuration must be a regular file');
    const document = parseDocument(await readFile(configPath, 'utf8'), { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error('Invalid YAML');
    input = document.toJS({ maxAliasCount: 0 });
  } catch {
    // Parser diagnostics can contain the offending scalar (including a secret).
    const sandbox = await sandboxOf().validate(undefined);
    return { configuration: { valid: false as const, errors: [{ code: 'CONFIGURATION_UNREADABLE', path: 'config.yaml' }] },
      checks: sandbox.checks, versions: sandbox.versions };
  }
  const version = input && typeof input === 'object' && 'schemaVersion' in input ? input.schemaVersion : undefined;
  // The YAML version selects ONE schema; issues of the other one are never reported.
  const parsed = (version === 2 ? schemaV2 : schemaV1).safeParse(input);
  // V2-30: the sandbox adapter compares the installation's Builder concurrency with its own capacity (unknown when the rest is invalid).
  const sandbox = await sandboxOf().validate(input && typeof input === 'object' && 'sandbox' in input ? input.sandbox : undefined,
    parsed.success ? { concurrency: parsed.data.concurrency } : {});
  const validatedSandbox = sandbox.configuration;
  if (!parsed.success || !validatedSandbox.valid) {
    return { checks: sandbox.checks, versions: sandbox.versions, configuration: { valid: false as const, errors: [
      ...(!parsed.success ? parsed.error.issues.map(issue => ({ code: issue.code === 'too_big' && issue.path.includes('builderBudget')
        ? 'BUILDER_BUDGET_ABOVE_MAXIMUM' : 'CONFIGURATION_INVALID', path: issue.path.join('.') })) : []),
      ...(!validatedSandbox.valid ? validatedSandbox.errors : []),
    ] } };
  }
  return { checks: sandbox.checks, versions: sandbox.versions, configuration: { valid: true as const,
    effective: { ...normalized(parsed.data), sandbox: validatedSandbox.effective, recoveryBackoffSeconds: [5, 15, 45] } } };
}
