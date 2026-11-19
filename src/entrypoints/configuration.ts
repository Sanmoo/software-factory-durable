import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { createSandbox } from '../sandbox/index.js';
import { builderBudgetMaximumFactor, builderBudgetV1 } from '../contracts/index.js';

const text = z.string().trim().min(1).max(256).refine(value =>
  !/(?:gh[pousr]_|github_pat_|sk-[a-zA-Z0-9]|-----BEGIN.*PRIVATE KEY)/.test(value), 'Secret values are forbidden');
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
/** config.yaml schema version this release validates (declared in the release manifest as metadata.formats.configuration). */
export const configurationSchemaVersion = 1;
const schema = z.strictObject({
  schemaVersion: z.literal(configurationSchemaVersion),
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
}).refine(value => !value.dependencyRepositories.some(dependency =>
  value.repositories.some(executable => executable.repository.toLowerCase() === dependency.repository.toLowerCase())),
{ path: ['dependencyRepositories'], message: 'A repository is either executable or dependency-only, never both' });

/** `guestAssets`: the pin of a verified release (trusted composition data), never read from the YAML. */
export async function readConfiguration(root: string, guestAssets?: { directory: string; manifestSha256: string }) {
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
    const sandbox = await createSandbox({ root, ...(guestAssets ? { guestAssets } : {}) }).validate(undefined);
    return { configuration: { valid: false as const, errors: [{ code: 'CONFIGURATION_UNREADABLE', path: 'config.yaml' }] },
      checks: sandbox.checks, versions: sandbox.versions };
  }
  const parsed = schema.safeParse(input);
  const sandbox = await createSandbox({ root, ...(guestAssets ? { guestAssets } : {}) }).validate(input && typeof input === 'object' && 'sandbox' in input ? input.sandbox : undefined);
  const validatedSandbox = sandbox.configuration;
  if (!parsed.success || !validatedSandbox.valid) {
    return { checks: sandbox.checks, versions: sandbox.versions, configuration: { valid: false as const, errors: [
      ...(!parsed.success ? parsed.error.issues.map(issue => ({ code: issue.code === 'too_big' && issue.path.includes('builderBudget')
        ? 'BUILDER_BUDGET_ABOVE_MAXIMUM' : 'CONFIGURATION_INVALID', path: issue.path.join('.') })) : []),
      ...(!validatedSandbox.valid ? validatedSandbox.errors : []),
    ] } };
  }
  return { checks: sandbox.checks, versions: sandbox.versions, configuration: { valid: true as const,
    effective: { ...parsed.data, sandbox: validatedSandbox.effective, recoveryBackoffSeconds: [5, 15, 45] } } };
}
