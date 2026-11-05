import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { createSandbox } from '../sandbox/index.js';

const text = z.string().trim().min(1).max(256).refine(value =>
  !/(?:gh[pousr]_|github_pat_|sk-[a-zA-Z0-9]|-----BEGIN.*PRIVATE KEY)/.test(value), 'Secret values are forbidden');
const positive = z.number().int().positive().safe();
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
});
const schema = z.strictObject({
  schemaVersion: z.literal(1),
  operators: z.array(text.regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/))
    .refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length),
  models: z.strictObject({ builder: model, standards: model, spec: model }),
  githubApp: z.strictObject({
    appId: positive,
    privateKeyFile: credentialFile,
  }),
  sandbox: z.unknown(),
  repositories: z.array(repository).refine(values =>
    new Set(values.map(value => value.repository.toLowerCase())).size === values.length),
  concurrency: positive.default(1),
  pollingSeconds: positive.default(60),
  retentionDays: positive.default(30),
});

export async function readConfiguration(root: string) {
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
    const sandbox = await createSandbox({ root }).validate(undefined);
    return { configuration: { valid: false as const, errors: [{ code: 'CONFIGURATION_UNREADABLE', path: 'config.yaml' }] },
      checks: sandbox.checks, versions: sandbox.versions };
  }
  const parsed = schema.safeParse(input);
  const sandbox = await createSandbox({ root }).validate(input && typeof input === 'object' && 'sandbox' in input ? input.sandbox : undefined);
  const validatedSandbox = sandbox.configuration;
  if (!parsed.success || !validatedSandbox.valid) {
    return { checks: sandbox.checks, versions: sandbox.versions, configuration: { valid: false as const, errors: [
      ...(!parsed.success ? parsed.error.issues.map(issue => ({ code: 'CONFIGURATION_INVALID', path: issue.path.join('.') })) : []),
      ...(!validatedSandbox.valid ? validatedSandbox.errors : []),
    ] } };
  }
  return { checks: sandbox.checks, versions: sandbox.versions, configuration: { valid: true as const,
    effective: { ...parsed.data, sandbox: validatedSandbox.effective, recoveryBackoffSeconds: [5, 15, 45] } } };
}
