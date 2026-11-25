import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { createSandbox, type HostToolProbe, type LambdaServiceFactory } from '../sandbox/index.js';
import { builderBudgetMaximumFactor, builderBudgetV1, defaultWorkerThinkingLevel, workerThinkingLevels } from '../contracts/index.js';
import { createTriageHostProbe, triageAvailability, triageDiagnostics, type TriageHostProbe } from './triage-prerequisites.js';

const text = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    value =>
      // Jira ticket 01: Atlassian API tokens (ATATT…) join the refused shapes.
      !/(?:gh[pousr]_|github_pat_|sk-[a-zA-Z0-9]|ATATT[a-zA-Z0-9]|-----BEGIN.*PRIVATE KEY)/.test(value),
    'Secret values are forbidden',
  );
const positive = z.number().int().positive().safe();
const login = text.regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/);
const credentialFile = text.regex(/^credentials\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/);
// #48: `thinkingLevel` is the role's reasoning level; absent, the role runs at the release default (the maximum). There is no `off`.
const model = z.strictObject({
  provider: text,
  model: text,
  credentialFile: credentialFile.optional(),
  thinkingLevel: z.enum(workerThinkingLevels).optional(),
});
const repository = z.strictObject({
  repository: text.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  base: text.refine(
    value =>
      !/(?:\.\.|[\s~^:?*\[\\]|@\{|\/\/)/.test(value) &&
      !value.startsWith('-') &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !value.endsWith('.') &&
      !value.includes('\x7f') &&
      value !== '@' &&
      value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock')) &&
      !/[\x00-\x1f]/.test(value),
    'Invalid branch',
  ),
  installationId: positive,
  workflows: z.boolean(),
  label: text.default('ready-for-agent'),
  correctionLimit: z.number().int().nonnegative().safe().default(3),
  recoveryLimit: z.number().int().nonnegative().safe().default(3),
  timeoutSeconds: positive.optional(),
  // Ticket 48: per-repository adjustment of the Builder budget of one Execution (release values 150 requests, 300 tool calls, 60 minutes per
  // model request). Each value from 1 up to 2x the release value; above it the whole configuration is refused (BUILDER_BUDGET_ABOVE_MAXIMUM).
  builderBudget: z
    .strictObject({
      requests: z
        .number()
        .int()
        .positive()
        .max(builderBudgetV1.requests * builderBudgetMaximumFactor)
        .optional(),
      toolCalls: z
        .number()
        .int()
        .positive()
        .max(builderBudgetV1.toolCalls * builderBudgetMaximumFactor)
        .optional(),
      requestTimeoutMinutes: z
        .number()
        .int()
        .positive()
        .max(builderBudgetV1.requestTimeoutMinutes * builderBudgetMaximumFactor)
        .optional(),
    })
    .optional(),
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
/**
 * Every config.yaml schema version this release validates: 1 (repositories are the GitHub Ticket sources), 2 (`ticketSources`) and
 * 3 (spec #68 §2: Triage, with `models.triager`, the `triage` block of a source, `triager`, `mcpServers` and `mcpProfiles`).
 */
export const configurationSchemaVersions = [1, 2, 3] as const;
const common = {
  // Login, or {login, id}: the pinned immutable GitHub user id (comments then match by id only; spec §11.3 authorized operator).
  operators: z
    .array(z.union([login, z.strictObject({ login, id: positive })]))
    .refine(values => new Set(values.map(value => (typeof value === 'string' ? value : value.login).toLowerCase())).size === values.length)
    .refine(values => {
      const ids = values.flatMap(value => (typeof value === 'string' ? [] : [value.id]));
      return new Set(ids).size === ids.length;
    }),
  models: z.strictObject({ builder: model, standards: model, spec: model }),
  githubApp: z.strictObject({
    appId: positive,
    privateKeyFile: credentialFile,
  }),
  sandbox: z.unknown(),
  repositories: z.array(repository).refine(values => new Set(values.map(value => value.repository.toLowerCase())).size === values.length),
  dependencyRepositories: z
    .array(dependencyRepository)
    .default([])
    .refine(values => new Set(values.map(value => value.repository.toLowerCase())).size === values.length),
  concurrency: positive.default(1),
  pollingSeconds: positive.default(60),
  retentionDays: positive.default(30),
};
type Common = { repositories: { repository: string }[]; dependencyRepositories: { repository: string }[] };
const exclusive = <T extends Common>(value: T) =>
  !value.dependencyRepositories.some(dependency =>
    value.repositories.some(executable => executable.repository.toLowerCase() === dependency.repository.toLowerCase()),
  );
const exclusiveIssue = { path: ['dependencyRepositories'], message: 'A repository is either executable or dependency-only, never both' };

// v2 (Jira ticket 01, spec §1): Ticket sources, separate from executable destinations. IDs are numeric strings; the Jira origin is
// HTTPS and nothing but an origin; the token is a credentials/ file read on the host only (never here).
const numericId = z.string().regex(/^[1-9][0-9]{0,17}$/);
const jiraOrigin = text.refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.origin === value;
  } catch {
    return false;
  }
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
  routes: z
    .array(z.strictObject({ componentId: numericId, repository: repository.shape.repository }))
    .min(1)
    .refine(values => new Set(values.map(value => value.componentId)).size === values.length, 'Each componentId routes once'),
  // Spec §3.2: the operator's indication for a custom or ambiguous link type, by link type ID (`inward`: the inwardIssue neighbour blocks
  // the Card; `outward`: the outwardIssue neighbour does; `none`: never blocking). It never overrides the unambiguous Blocks type.
  linkTypes: z
    .array(z.strictObject({ id: numericId, blocks: z.enum(['inward', 'outward', 'none']) }))
    .default([])
    .refine(values => new Set(values.map(value => value.id)).size === values.length, 'Each link type ID is indicated once'),
});
const schemaV1 = z.strictObject({ schemaVersion: z.literal(1), ...common }).refine(exclusive, exclusiveIssue);
const schemaV2 = z
  .strictObject({ schemaVersion: z.literal(2), ...common, ticketSources: z.array(z.discriminatedUnion('tracker', [githubSource, jiraSource])) })
  .refine(exclusive, exclusiveIssue)
  .superRefine(sourceIssues);
/** Schema 2 and 3: what the Ticket sources must hold together (destinations, one source per origin, one account and catalogue per site). */
function sourceIssues(value: { repositories: { repository: string }[]; ticketSources: SourceV2[] }, context: z.RefinementCtx) {
  const executable = new Set(value.repositories.map(item => item.repository.toLowerCase()));
  const destination = (name: string, path: (string | number)[]) => {
    if (!executable.has(name.toLowerCase()))
      context.addIssue({ code: 'custom', path, message: 'Only an executable repository is a Ticket source or route destination' });
  };
  const github = new Set<string>(),
    projects = new Set<string>(),
    origins = new Map<string, string>(),
    linkTypesOf = new Map<string, string>();
  value.ticketSources.forEach((source, index) => {
    if (source.tracker === 'github') {
      destination(source.repository, ['ticketSources', index, 'repository']);
      if (github.has(source.repository.toLowerCase()))
        context.addIssue({ code: 'custom', path: ['ticketSources'], message: 'One GitHub source per repository' });
      github.add(source.repository.toLowerCase());
      return;
    }
    source.routes.forEach((route, routeIndex) => destination(route.repository, ['ticketSources', index, 'routes', routeIndex, 'repository']));
    const project = `${source.siteId}\n${source.projectId}`;
    if (projects.has(project)) context.addIssue({ code: 'custom', path: ['ticketSources'], message: 'One Jira source per site project' });
    projects.add(project);
    // One origin and one account (e-mail + token file) per site: the host transport of a site is unique.
    const account = `${source.url}\n${source.email.toLowerCase()}\n${source.tokenFile}`;
    const known = origins.get(source.siteId);
    if (known !== undefined && known !== account)
      context.addIssue({ code: 'custom', path: ['ticketSources'], message: 'A siteId names one origin and one account' });
    origins.set(source.siteId, account);
    // The link type catalogue belongs to the site: every source of a site indicates the same meanings.
    const indications = JSON.stringify([...source.linkTypes].sort((a, b) => a.id.localeCompare(b.id)));
    const knownIndications = linkTypesOf.get(source.siteId);
    if (knownIndications !== undefined && knownIndications !== indications)
      context.addIssue({ code: 'custom', path: ['ticketSources', index, 'linkTypes'], message: 'Every source of a site indicates the same link types' });
    linkTypesOf.set(source.siteId, indications);
  });
}
type SourceV2 = z.infer<typeof githubSource> | z.infer<typeof jiraSource>;

// v3 (spec #68 §2): Triage. Everything below exists only in a schema 3 config.yaml; schemas 1 and 2 keep refusing these sections.
const unique = (values: string[]) => new Set(values).size === values.length;
const byId = (values: { id: string }[]) => unique(values.map(value => value.id));
/**
 * The `triage` block of a Ticket source: present, it asks for Triage there (`triage: {}` uses the default names of
 * docs/agents/triage-labels.md). The ready-for-agent role is never named here: it is always the admission label of the destination.
 */
const triageLabels = (label: typeof text) =>
  z.strictObject({
    needsTriage: label.default('needs-triage'),
    needsInfo: label.default('needs-info'),
    readyForHuman: label.default('ready-for-human'),
    wontfix: label.default('wontfix'),
  });
const githubSourceV3 = githubSource.extend({ triage: triageLabels(text).optional() });
const jiraSourceV3 = jiraSource.extend({ triage: triageLabels(jiraSource.shape.label).optional() });
/** The `triager` role: configured like the others, with the reasoning level made explicit (default: the maximum; there is no `off`). */
const triagerModel = model.extend({ thinkingLevel: z.enum(workerThinkingLevels).default(defaultWorkerThinkingLevel) });
const identifier = text.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
/** An MCP server Ops already operates, reached by Streamable HTTP at its URL: no stdio, no command to start one, no legacy SSE transport. */
const mcpServer = z.strictObject({
  id: identifier,
  url: text.refine(value => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !url.hash;
    } catch {
      return false;
    }
  }, 'An MCP server is an http(s) URL without credentials or fragment'),
  tokenFile: credentialFile.optional(),
});
/** MCP Profile: a named selection of the tools of ONE server (`all`: its present and future catalogue). Registering activates nothing. */
const mcpProfile = z.strictObject({
  id: identifier,
  server: identifier,
  tools: z.union([z.literal('all'), z.array(text).min(1).refine(unique, 'Each tool is named once')]),
});
/** The installation `triager` block: Triage capacity, the budget of one Triage request and the Investigation Environment limits. */
const triager = z.strictObject({
  capacity: positive.default(1),
  investigationMinutes: positive.default(15),
  attempts: positive.default(2),
  environment: z.strictObject({ memoryGiB: positive.default(2), processes: positive.default(512), commandSeconds: positive.default(120) }).prefault({}),
  /** The active MCP Profiles, for every Triage of the installation. */
  mcpProfiles: z.array(identifier).default([]).refine(unique, 'Each MCP Profile is activated once'),
});
const schemaV3 = z
  .strictObject({
    schemaVersion: z.literal(3),
    ...common,
    models: z.strictObject({ ...common.models.shape, triager: triagerModel }),
    ticketSources: z.array(z.discriminatedUnion('tracker', [githubSourceV3, jiraSourceV3])),
    mcpServers: z.array(mcpServer).default([]).refine(byId, 'Each MCP server id is registered once'),
    mcpProfiles: z.array(mcpProfile).default([]).refine(byId, 'Each MCP Profile id is registered once'),
    triager: triager.prefault({}),
  })
  .refine(exclusive, exclusiveIssue)
  .superRefine(sourceIssues)
  .superRefine((value, context) => {
    value.ticketSources.forEach((source, index) => {
      if (!source.triage) return;
      // The fifth role of the source, ready-for-agent: the Card's admission label, or the one of the issue's repository.
      const admission =
        source.tracker === 'jira'
          ? [source.label]
          : value.repositories.filter(item => item.repository.toLowerCase() === source.repository.toLowerCase()).map(item => item.label);
      if (!unique([...Object.values(source.triage), ...admission].map(label => label.toLowerCase())))
        context.addIssue({ code: 'custom', path: ['ticketSources', index, 'triage'], message: 'Each triage role of a source has its own label' });
    });
    const servers = new Set(value.mcpServers.map(item => item.id));
    value.mcpProfiles.forEach((profile, index) => {
      if (!servers.has(profile.server))
        context.addIssue({ code: 'custom', path: ['mcpProfiles', index, 'server'], message: 'An MCP Profile selects tools of a registered server' });
    });
    const profiles = new Set(value.mcpProfiles.map(item => item.id));
    value.triager.mcpProfiles.forEach((id, index) => {
      if (!profiles.has(id))
        context.addIssue({ code: 'custom', path: ['triager', 'mcpProfiles', index], message: 'Only a registered MCP Profile is activated' });
    });
  });
type Schema = z.infer<typeof schemaV1> | z.infer<typeof schemaV2> | z.infer<typeof schemaV3>;
/** The effective configuration's Ticket sources (v1: every executable repository is a GitHub source with discovery on). */
export type TicketSourceConfiguration = z.infer<typeof githubSourceV3> | z.infer<typeof jiraSourceV3>;
/** The effective `triager` block (the release defaults under a schema 1 or 2 config.yaml, where nothing uses them). */
export type TriagerConfiguration = z.infer<typeof triager>;
export type McpServerConfiguration = z.infer<typeof mcpServer>;
export type McpProfileConfiguration = z.infer<typeof mcpProfile>;
type Models = z.infer<typeof common.models> & { triager?: z.infer<typeof triagerModel> };
/** What only schema 3 configures, as schemas 1 and 2 leave it: no `triage` block, no `triager` role, no MCP, the default limits. */
function triageSections(input: Schema): {
  models: Models;
  ticketSources: TicketSourceConfiguration[];
  triager: TriagerConfiguration;
  mcpServers: McpServerConfiguration[];
  mcpProfiles: McpProfileConfiguration[];
} {
  if (input.schemaVersion === 3) return input;
  const ticketSources =
    input.schemaVersion === 2
      ? input.ticketSources
      : input.repositories.map(item => ({ tracker: 'github' as const, repository: item.repository, discover: true }));
  return { models: input.models, ticketSources, triager: triager.parse({}), mcpServers: [], mcpProfiles: [] };
}
/** One shape for every version: `ticketSources` is derived for v1 and the Triage sections for v1 and v2, so composition never branches on the YAML version. */
function normalized(input: Schema) {
  const { models, ticketSources, triager, mcpServers, mcpProfiles } = triageSections(input);
  return { ...input, models, ticketSources, triager, mcpServers, mcpProfiles };
}
const schemas = { 2: schemaV2, 3: schemaV3 };
/** The YAML version selects ONE schema (an unknown one is read as schema 1, which refuses it); issues of the others are never reported. */
const schemaOf = (version: unknown) => (version === 2 || version === 3 ? schemas[version] : schemaV1);

/** A top-level field of the parsed YAML, before any schema (undefined when the document is not an object or lacks it). */
const fieldOf = (input: unknown, key: string): unknown =>
  input && typeof input === 'object' && key in input ? (input as Record<string, unknown>)[key] : undefined;

/** `guestAssets`: the pin of a verified release (trusted composition data), never read from the YAML. */
/** `triageHost` (spec #68 §2): what the Host lacks to triage; the real PATH and user systemd by default, a double in tests. */
/** `lambdaService` (v2 ticket 02): how a Lambda installation's AWS account is reached; the `aws` CLI by default, a double in tests.
 * `lambdaHostTool`: whether a host tool of the Lambda channel can be run; the real PATH by default, a double in tests. */
export async function readConfiguration(
  root: string,
  guestAssets?: { directory: string; manifestSha256: string },
  { lambdaService, lambdaHostTool, triageHost }: { lambdaService?: LambdaServiceFactory; lambdaHostTool?: HostToolProbe; triageHost?: TriageHostProbe } = {},
) {
  const sandboxOf = () =>
    createSandbox({
      root,
      ...(guestAssets ? { guestAssets } : {}),
      ...(lambdaService ? { lambdaService } : {}),
      ...(lambdaHostTool ? { lambdaHostTool } : {}),
    });
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
    return {
      configuration: { valid: false as const, errors: [{ code: 'CONFIGURATION_UNREADABLE', path: 'config.yaml' }] },
      checks: sandbox.checks,
      versions: sandbox.versions,
    };
  }
  const version = fieldOf(input, 'schemaVersion');
  const parsed = schemaOf(version).safeParse(input);
  // V2-30: the sandbox adapter compares the installation's Builder concurrency with its own capacity (unknown when the rest is invalid).
  const sandbox = await sandboxOf().validate(fieldOf(input, 'sandbox'), parsed.success ? { concurrency: parsed.data.concurrency } : {});
  const validatedSandbox = sandbox.configuration;
  if (!parsed.success || !validatedSandbox.valid) {
    return {
      checks: sandbox.checks,
      versions: sandbox.versions,
      configuration: {
        valid: false as const,
        errors: [
          ...(!parsed.success
            ? parsed.error.issues.map(issue => ({
                code: issue.code === 'too_big' && issue.path.includes('builderBudget') ? 'BUILDER_BUDGET_ABOVE_MAXIMUM' : 'CONFIGURATION_INVALID',
                path: issue.path.join('.'),
              }))
            : []),
          ...(!validatedSandbox.valid ? validatedSandbox.errors : []),
        ],
      },
    };
  }
  const effective = normalized(parsed.data);
  // Spec #68 §2: a `triage` block only turns on where the Host can run the Investigation Environment; the diagnostic says what is missing.
  const triage = await triageAvailability(effective.ticketSources.filter(source => source.triage).length, triageHost ?? createTriageHostProbe());
  return {
    checks: [...sandbox.checks, ...triageDiagnostics(triage)],
    versions: sandbox.versions,
    configuration: {
      valid: true as const,
      effective: { ...effective, sandbox: validatedSandbox.effective, recoveryBackoffSeconds: [5, 15, 45], triage },
    },
  };
}
