import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { connect, listen, protocolVersion, type Channel, type Envelope } from '../protocol/index.js';
import type { InvestigationAgent, InvestigationShell } from '../sandbox/index.js';
import { loadSkillPack, skillPacks, triagerActivationPrompt, type SkillPackId, type TriagerActivation } from './skill-pack.js';
import { activeMcpSources, triagerMcpSchema, type McpRegistration } from './triager-mcp.js';
import type { TriagerHost } from './triager-tools.js';
import type { ReviewerProfile } from './worker-start.js';

export type { McpRegistration } from './triager-mcp.js';
export type { TriagerHost } from './triager-tools.js';
export { triagerToolNames } from './triager-tools.js';

// Spec #68 §7 (ticket #75): the Host side of one Triager attempt and the agent process it talks to. The agent runs inside the attempt's
// Investigation Environment unit, outside the command confinement; it is started by the environment, never forked by the Control, so its
// bootstrap is a private file and its tool calls travel over a private socket of the attempt. Nothing secret is on a command line.

type Profile = ReviewerProfile extends infer P ? (P extends unknown ? Omit<P, 'directory'> : never) : never;
const attemptName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const bootstrapSchema = z.object({
  version: z.literal(1),
  attempt: z.string().regex(attemptName).max(64),
  endpoint: z.string().min(1),
  factoryRoot: z.string().min(1),
  prompt: z.string().min(1),
  profile: z.record(z.string(), z.unknown()),
  mcp: triagerMcpSchema.optional(),
});
const sessionResult = z.strictObject({
  status: z.enum(['completed', 'interrupted']),
  concluded: z.boolean(),
  sessionFile: z.string().nullable(),
  sessionTools: z.array(z.string()),
  toolCalls: z.record(z.string().max(128), z.number().int().nonnegative()),
  closedBy: z.enum(['requests', 'tools', 'provider']).nullable(),
});
const completionSchema = z.union([sessionResult, z.strictObject({ status: z.literal('failure'), code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/) })]);

/** How one attempt's session ended, as the agent reported it. `transcript`: the session file, relative to the installation root. */
export type TriagerCompletion =
  | {
      status: 'completed' | 'interrupted';
      concluded: boolean;
      transcript: string | null;
      sessionTools: string[];
      /** Calls per session tool, by name (an MCP tool is `mcp__<server>__<tool>`). */
      toolCalls: Record<string, number>;
      closedBy: 'requests' | 'tools' | 'provider' | null;
    }
  /** The agent could not run a session, or its channel ended before it reported one. */
  | { status: 'failure'; code: string };
/** A Triager activated for one attempt of a Triage request (the Control's own record of that attempt is `TriageAttempt`). */
type ActivatedTriager = {
  /** What the Investigation Environment starts as the attempt's main process. */
  agent: InvestigationAgent;
  /** The pack whose `triage` skill this attempt runs (operator metadata). */
  skillPack: { id: string; version: string; manifestSha256: string };
  /** Ids of the MCP Profiles active in this attempt (operator metadata). */
  mcpProfiles: string[];
  completed: Promise<TriagerCompletion>;
  /** Closes the attempt's endpoint. A session still running loses its channel and ends without a Verdict. */
  close(): Promise<void>;
};
export type TriagerConfiguration = {
  /** Installation root; the attempts live under `<root>/triage/a/<attempt>` (private). */
  root: string;
  profile: Profile;
  skillPack: SkillPackId;
  /** Spec §7: the registered MCP servers and Profiles and the active ones (none: the sessions have no MCP tool). */
  mcp?: McpRegistration;
  /** The agent start for a bootstrap file: the fixed Triager entrypoint in production. */
  agent(bootstrap: string): InvestigationAgent;
};

const send = (channel: Channel, kind: string, payload: Envelope['payload'], reply_to: string | null = null) =>
  channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id: randomUUID(), reply_to, kind, payload });
const privateDirectory = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};
export const triagerAttemptDirectory = (root: string, attempt: string) => join(root, 'triage', 'a', attempt);

/** Host facade of the Triager role: one `activate` per attempt, always a new session. It grants nothing: the Control validates each call. */
export function createTriager(configuration: TriagerConfiguration) {
  return {
    async activate(request: { attempt: string; activation: TriagerActivation; host: TriagerHost }): Promise<ActivatedTriager> {
      if (!attemptName.test(request.attempt) || request.attempt.length > 64) throw new Error('TRIAGER_ATTEMPT_INVALID');
      const pack = await loadSkillPack(skillPacks[configuration.skillPack].directory, configuration.skillPack);
      const prompt = await triagerActivationPrompt(pack, request.activation);
      const mcp = configuration.mcp?.active.length ? activeMcpSources(configuration.root, configuration.mcp) : undefined;
      const directory = triagerAttemptDirectory(configuration.root, request.attempt);
      for (const path of [join(configuration.root, 'triage'), join(configuration.root, 'triage', 'a'), directory, join(directory, 'profile', 'sessions')])
        await privateDirectory(path);
      await chmod(join(directory, 'profile'), 0o700);
      const endpoint = join(directory, 't.sock');
      let settle!: (completion: TriagerCompletion) => void;
      const completed = new Promise<TriagerCompletion>(resolve => (settle = resolve));
      const completionOf = (reported: z.infer<typeof completionSchema>): TriagerCompletion => {
        if (reported.status === 'failure') return reported;
        const { sessionFile, ...result } = reported;
        return { ...result, transcript: sessionFile?.startsWith(`${directory}/`) ? relative(configuration.root, sessionFile) : null };
      };
      const answer = async (envelope: Envelope, channel: Channel) => {
        if (envelope.kind === 'triager-clone') {
          const repository = typeof envelope.payload.repository === 'string' ? envelope.payload.repository : '';
          await send(channel, 'triager-result', await request.host.requestClone(repository), envelope.message_id);
        } else if (envelope.kind === 'triager-conclude') {
          await send(channel, 'triager-result', await request.host.conclude(envelope.payload), envelope.message_id);
        } else if (envelope.kind === 'triager-completed') {
          const parsed = completionSchema.safeParse(envelope.payload);
          settle(completionOf(parsed.success ? parsed.data : { status: 'failure', code: 'TRIAGER_COMPLETION_INVALID' }));
          // Acknowledged so the agent only closes its end once the completion was taken (a close racing it would read as a lost channel).
          await send(channel, 'triager-result', {}, envelope.message_id);
        } else throw new Error('TRIAGER_FRAME_UNEXPECTED');
      };
      const server = await listen(
        endpoint,
        { message: (envelope, channel) => answer(envelope, channel), closed: () => settle({ status: 'failure', code: 'TRIAGER_CHANNEL_CLOSED' }) },
        { kind: 'worker-tool', binding: { attempt: request.attempt } },
      );
      const bootstrap = join(directory, 'bootstrap.json');
      await writeFile(
        bootstrap,
        JSON.stringify({
          version: 1,
          attempt: request.attempt,
          endpoint,
          factoryRoot: configuration.root,
          prompt,
          profile: { ...configuration.profile, directory: join(directory, 'profile') },
          // Where the agent finds each server and its token FILE: the token itself is read by the agent, never copied here.
          ...(mcp ? { mcp } : {}),
        }),
        { mode: 0o600, flag: 'wx' },
      );
      return {
        agent: configuration.agent(bootstrap),
        skillPack: { id: pack.id, version: pack.version, manifestSha256: pack.manifestSha256 },
        mcpProfiles: [...(configuration.mcp?.active ?? [])],
        completed,
        async close() {
          await server.close().catch(() => {});
          settle({ status: 'failure', code: 'TRIAGER_CHANNEL_CLOSED' });
        },
      };
    },
  };
}

/** One request to the Control over the attempt's channel; the channel serves one call at a time (the session's tools are sequential). */
function asker(channel: Channel) {
  const replies = channel.messages[Symbol.asyncIterator]();
  return async (kind: string, payload: Envelope['payload']) => {
    const message_id = randomUUID();
    await channel.send({ protocol_version: protocolVersion, controller_run_id: null, message_id, reply_to: null, kind, payload });
    const reply = await replies.next();
    if (reply.done || reply.value.kind !== 'triager-result' || reply.value.reply_to !== message_id) throw new Error('TRIAGER_CHANNEL_CLOSED');
    return reply.value.payload;
  };
}
function hostOf(ask: ReturnType<typeof asker>): TriagerHost {
  return {
    requestClone: async repository => (await ask('triager-clone', { repository })) as Awaited<ReturnType<TriagerHost['requestClone']>>,
    conclude: async verdict => (await ask('triager-conclude', z.record(z.string(), z.json()).parse(verdict))) as Awaited<ReturnType<TriagerHost['conclude']>>,
  };
}

/**
 * The agent of one attempt: reads its private bootstrap, runs ONE Triager session with the given shell and reports how it ended. The
 * process inside the unit holds the shell (the port only gives it there), which is why it is an argument and not something built here.
 */
export async function runTriagerAgent(
  bootstrapPath: string,
  options: { shell(attempt: string, factoryRoot: string): Promise<InvestigationShell>; signal: AbortSignal },
) {
  const bootstrap = bootstrapSchema.parse(JSON.parse(await readFile(bootstrapPath, 'utf8')));
  const channel = await connect(bootstrap.endpoint, { kind: 'worker-tool', binding: { attempt: bootstrap.attempt } });
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const ask = asker(channel);
  try {
    let completion: z.infer<typeof completionSchema>;
    try {
      const { runTriagerSession } = await import('./triager-session.js');
      completion = await runTriagerSession({
        profile: bootstrap.profile as unknown as ReviewerProfile,
        prompt: bootstrap.prompt,
        shell: await options.shell(bootstrap.attempt, bootstrap.factoryRoot),
        host: hostOf(ask),
        signal,
        factoryRoot: bootstrap.factoryRoot,
        mcp: bootstrap.mcp,
      });
    } catch (error) {
      // Allowlisted codes only: never an exception text, provider output or a path.
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message) ? error.message : 'TRIAGER_SESSION_FAILED';
      completion = { status: 'failure', code };
    }
    await ask('triager-completed', completion).catch(() => {});
  } finally {
    lifetime.abort();
    channel.close();
  }
}
