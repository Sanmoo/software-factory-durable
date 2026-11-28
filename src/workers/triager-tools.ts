import type { ToolDefinition } from '#factory-pi';
import type { InvestigationShell } from '../sandbox/index.js';

/**
 * What a Triager session asks of the Control. Both answers are data for the session: a refusal is returned to the model,
 * which corrects its call or goes on without the clone.
 */
export type TriagerHost = {
  requestClone(
    repository: string,
  ): Promise<{ status: 'cloned'; repository: string; path: string; commit: string } | { status: 'refused'; code: string; message: string }>;
  conclude(verdict: Record<string, unknown>): Promise<{ status: 'recorded' } | { status: 'refused'; errors: { code: string; message: string }[] }>;
};
export const triagerToolNames = ['bash', 'read', 'request_clone', 'concluir_triagem'] as const;

type Hooks = {
  shell: InvestigationShell;
  host: TriagerHost;
  /** Whether a text carries a value the session must never hand to the model. */
  withheld(text: string): boolean;
  concluded(): boolean;
  onConcluded(): void;
  /** A call of a session tool reached its implementation (operator metadata: how many times each tool ran). */
  onCall?(tool: string): void;
};
const schema = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object', additionalProperties: false, required, properties }) as unknown as ToolDefinition['parameters'];
const text = (value: string, details: Record<string, unknown> = {}) => ({ content: [{ type: 'text' as const, text: value }], details });
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** One command in a new confinement. A killed or unavailable command is an error of that call only: the session goes on. */
async function run(hooks: Hooks, request: { command: string; cwd?: string }) {
  const result = await hooks.shell.exec(request);
  const output = result.output + (result.notice ? `\n[${result.notice}]` : '');
  if (hooks.withheld(output)) throw new Error('TOOL_OUTPUT_WITHHELD: the output carried a Factory credential and was not delivered.');
  if (result.status === 'failed') throw new Error(`${result.code}${output ? `\n${output}` : ''}`);
  return { output, exitCode: result.exitCode, signal: result.signal };
}

function bash(hooks: Hooks): ToolDefinition {
  return {
    name: 'bash',
    label: 'bash',
    executionMode: 'sequential',
    description:
      'Run one shell command in the Investigation Environment to read the cloned repositories (search with rg, read files, read history ' +
      'with git log/show/blame). Each call is a new confinement: no network, the clones are read-only, only the temporary directory ' +
      'is writable, and no state but that directory survives between calls. A command over its time limit is killed and its output is cut with a notice.',
    parameters: schema(
      {
        command: { type: 'string', minLength: 1, maxLength: 16384, description: 'The command line, run by the shell.' },
        cwd: { type: 'string', maxLength: 4096, description: 'Absolute working directory (default: the temporary directory).' },
      },
      ['command'],
    ),
    async execute(_id, args) {
      const input = args as { command?: unknown; cwd?: unknown };
      if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('COMMAND_INVALID');
      const result = await run(hooks, { command: input.command, ...(typeof input.cwd === 'string' && input.cwd ? { cwd: input.cwd } : {}) });
      const status = result.signal ? `killed by ${result.signal}` : `exit code ${result.exitCode}`;
      return text(`${result.output}${result.output.endsWith('\n') || !result.output ? '' : '\n'}[${status}]`, {
        exitCode: result.exitCode,
        signal: result.signal,
      });
    },
  };
}

function read(hooks: Hooks): ToolDefinition {
  return {
    name: 'read',
    label: 'read',
    executionMode: 'sequential',
    description:
      'Read a text file of a cloned repository (or of the temporary directory) by absolute path, with its line numbers. ' +
      '`offset` is the first line (1-based) and `limit` the number of lines (default 400).',
    parameters: schema(
      {
        path: { type: 'string', minLength: 1, maxLength: 4096, description: 'Absolute path of the file.' },
        offset: { type: 'integer', minimum: 1, maximum: 10000000 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
      },
      ['path'],
    ),
    async execute(_id, args) {
      const input = args as { path?: unknown; offset?: unknown; limit?: unknown };
      const whole = (value: unknown, fallback: number, max: number) =>
        Number.isSafeInteger(value) && (value as number) >= 1 ? Math.min(value as number, max) : fallback;
      if (typeof input.path !== 'string' || !input.path.startsWith('/') || /[\u0000\n]/.test(input.path))
        throw new Error('READ_PATH_INVALID: an absolute path is required.');
      const first = whole(input.offset, 1, 10000000);
      const last = first + whole(input.limit, 400, 2000) - 1;
      const result = await run(hooks, { command: `cat -n -- ${quoted(input.path)} | sed -n '${first},${last}p'`, cwd: hooks.shell.temporary });
      return text(result.output || '[no line in that range]', { path: input.path, offset: first });
    },
  };
}

function requestClone(hooks: Hooks): ToolDefinition {
  return {
    name: 'request_clone',
    label: 'request_clone',
    executionMode: 'sequential',
    description:
      'Ask the Factory for a read-only clone of ONE candidate repository of this Triage (call it again for another). The clone is the default ' +
      'branch with its history, without a remote. Only the candidates listed in the activation data can be cloned: any other repository is refused.',
    parameters: schema({ repository: { type: 'string', minLength: 1, maxLength: 256, description: 'The candidate, as `owner/name`.' } }, ['repository']),
    async execute(_id, args) {
      const repository = (args as { repository?: unknown }).repository;
      if (typeof repository !== 'string' || !repository.trim()) throw new Error('CLONE_REQUEST_INVALID: `repository` is required, as `owner/name`.');
      const answer = await hooks.host.requestClone(repository.trim());
      if (answer.status === 'refused') throw new Error(`${answer.code}: ${answer.message}`);
      return text(`Cloned ${answer.repository} at commit ${answer.commit}. Read it at ${answer.path} (read-only).`, { ...answer });
    },
  };
}

function conclude(hooks: Hooks): ToolDefinition {
  return {
    name: 'concluir_triagem',
    label: 'concluir_triagem',
    executionMode: 'sequential',
    description:
      'Record the Verdict of this Triage, once. An error means it was NOT recorded: correct what the error names and call it again. ' +
      'Once accepted the investigation is over: the Verdict is recorded (not yet published) and nothing else runs in this session.',
    parameters: schema(
      {
        outcome: { type: 'string', description: 'One of: ready-for-agent, needs-info, ready-for-human, wontfix.' },
        category: { type: 'string', description: 'One of: bug, enhancement.' },
        text: { type: 'string', description: 'The Verdict, in the language of the Ticket; it must stand alone.' },
        component: { type: 'string', description: 'Jira Card only: the ID of the single component the evidence identifies. Leave out for a GitHub issue.' },
      },
      ['outcome', 'category', 'text'],
    ),
    async execute(_id, args) {
      if (hooks.concluded()) throw new Error('TRIAGE_ALREADY_CONCLUDED');
      const verdict = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
      if (typeof verdict.text === 'string' && hooks.withheld(verdict.text)) throw new Error('VERDICT_CONTAINS_SECRET: remove the credential from the text.');
      const answer = await hooks.host.conclude(verdict);
      if (answer.status === 'refused')
        throw new Error(
          `The Verdict was NOT recorded. Correct and call concluir_triagem again:\n${answer.errors.map(error => `- ${error.code}: ${error.message}`).join('\n')}`,
        );
      hooks.onConcluded();
      return {
        ...text('Verdict recorded by the Factory (not yet published). The investigation is over: do not continue.', { status: 'recorded' }),
        terminate: true,
      };
    },
  };
}

const withheldOutput = 'TOOL_OUTPUT_WITHHELD: the output carried a Factory credential and was not delivered.';
/** A tool of an MCP Profile: what its source answers, result or error, never carries a credential of the Factory to the model. */
function external(hooks: Hooks, tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    async execute(...args: Parameters<ToolDefinition['execute']>) {
      const result = await tool.execute(...args).catch((error: unknown) => {
        throw hooks.withheld(error instanceof Error ? error.message : String(error)) ? new Error(withheldOutput) : error;
      });
      if (hooks.withheld(JSON.stringify(result))) throw new Error(withheldOutput);
      return result;
    },
  };
}

/** The whole tool set of a Triager session: its own four tools and `mcp`, the tools of the active MCP Profiles. */
export function triagerTools(hooks: Hooks, mcp: ToolDefinition[] = []): ToolDefinition[] {
  return [bash(hooks), read(hooks), requestClone(hooks), conclude(hooks), ...mcp.map(tool => external(hooks, tool))].map(tool => ({
    ...tool,
    async execute(...args: Parameters<ToolDefinition['execute']>) {
      // No call starts after the accepted Verdict, whatever the tool (`concluir_triagem` answers that itself).
      if (tool.name !== 'concluir_triagem' && hooks.concluded()) throw new Error('TRIAGE_CONCLUDED');
      hooks.onCall?.(tool.name);
      return tool.execute(...args);
    },
  }));
}
