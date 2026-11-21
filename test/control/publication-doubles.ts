// Shared doubles of the ticket 14 flow/composition tests: a scripted Builder emitting ticket 13 captures (round 1 with a gate, then the
// Host's closing capture), clean scripted reviewers, Sandbox lifecycle/identity and Builder credentials. Never a real VM/worker/model.
import type { ExecutionPorts } from '../../src/control/types.js';
import type { GateEvidence, ProposalHandoff, ProposalIdentity, ReviewOpinion } from '../../src/contracts/index.js';
import type { PullRequestCandidate } from '../../src/code-repository/index.js';
import type { BuilderDirective, HandoffEvent, Invocation, WorkerSessionRef } from '../../src/workers/index.js';
import type { Remote } from './doubles.js';

export const app = { login: 'factory-app[bot]', id: 41898282 };
export const sessionRef = (n: number): WorkerSessionRef => ({
  ref: `r/boot${n}/w-abc/profile/sessions/s${n}.jsonl`,
  sessionId: `5e55a0b0-0000-4000-8000-${String(n).padStart(12, '0')}`,
  sha256: String(n).repeat(64).slice(0, 64),
  bytes: 100 + n,
  format: 'pi-session-jsonl-v3',
  profile: {
    sdkProfile: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
    providerId: 'openai',
    modelId: 'gpt-6-luna',
    skillPack: 'factory-skills-v6',
    tools: ['ask_user', 'bash', 'edit', 'handoff', 'read', 'write'],
  },
});
export const summary = (round: number, head: string, branch: string, committed: boolean): ProposalHandoff => ({
  version: 1,
  round,
  index: `/artifacts/review/r${round}/index.json`,
  indexSha256: `${round}${head}`.slice(0, 64).padEnd(64, '0'),
  head,
  branch,
  base: 'a'.repeat(40),
  mergeBase: 'a'.repeat(40),
  counts: { entries: 1, committed: 1, staged: 0, unstaged: 0, untracked: 0, removed: 0 },
  patches: {
    committed: { path: `/artifacts/review/r${round}/committed.patch`, bytes: 4, sha256: 'c'.repeat(64) },
    staged: { path: `/artifacts/review/r${round}/staged.patch`, bytes: 0, sha256: 'c'.repeat(64) },
    unstaged: { path: `/artifacts/review/r${round}/unstaged.patch`, bytes: 0, sha256: 'c'.repeat(64) },
  },
  spec: { version: 'v1', sources: '/artifacts/spec/v1/sources.json', sha256: '1'.repeat(64) },
  instructions: { version: 'v1', sources: '/artifacts/instructions/v1/sources.json', sha256: '2'.repeat(64) },
  changed: ['/workspace/checkout/docs/a.md'],
  changedTruncated: false,
  content: { sha256: head.slice(0, 1).repeat(64), clean: committed, headMatches: committed },
});
export const gate = (outcome: GateEvidence['outcome']): GateEvidence => ({
  id: 't1',
  source: '/artifacts/spec/v1/ticket.json#validation',
  command: 'check t1',
  cwd: '/workspace',
  requiredCheck: null,
  declared: 'run',
  outcome,
  code: null,
  exitCode: outcome === 'passed' ? 0 : 1,
  output: { workId: 'w', id: '11111111-2222-4333-8444-555555555555' },
  sequence: 3,
  current: true,
  reason: null,
  authorization: null,
});
export type Activation = {
  prompt: string;
  phaseId: string;
  executionId: string;
  continuation: unknown;
  handoff: unknown;
  editSourceMaxBytes: unknown;
  token: string;
  pushPolicy?: unknown;
};
/** One Builder activation: an implementation with one review round + the closing capture (ticket 13), or a direct publication. */
export type Script =
  | {
      kind: 'implement';
      head: string;
      gate?: GateEvidence['outcome'];
      committed?: boolean;
      /** Ticket 21: what the Host capture's ancestry check reports for the authorized tip (default: preserved); `during` runs at activation. */
      preserves?: boolean;
      during?: (remote: Remote, activation: Activation) => void;
      /** Real run q21-human-v4: the worker fails at once with this code (e.g. WORKER_INTERRUPTED after WORKER_PROVIDER_UNAVAILABLE). */
      failure?: string;
    }
  | { kind: 'publish'; publish: (remote: Remote, activation: Activation) => void | Promise<void>; end: 'success' | 'failure' | 'receipt-lost' };

export const facts = (prompt: string) => ({
  workId: /Work ([0-9a-f-]{36})/.exec(prompt)![1]!,
  branch: /your branch (\S+);/.exec(prompt)![1]!,
  head: /verified commit ([0-9a-f]{40})/.exec(prompt)![1]!,
});
export const ownPull = (workId: string, branch: string, head: string, overrides: Partial<PullRequestCandidate> = {}): PullRequestCandidate => ({
  pullRequestId: 9004,
  nodeId: 'PR_node4',
  number: 4,
  url: 'https://github.com/acme/project/pull/4',
  state: 'open',
  merged: false,
  headRef: branch,
  headRepositoryId: 3,
  headSha: head,
  baseRef: 'main',
  draft: true,
  author: { id: app.id, login: app.login, type: 'Bot' },
  association: ['closing-reference', 'known-branch'],
  body: [`<!-- software-factory:work:${workId} -->`, '## Summary', 'Adds the note. Closes #3', '## Validation', 'Gate t1 passed.', '## Risk', 'Low.'].join(
    '\n',
  ),
  ...overrides,
});
/** The Builder's direct publication as the remote sees it: its own branch at the verified commit and its own draft PR (or the update of it). */
export const publishOwn =
  (overrides: Partial<PullRequestCandidate> = {}) =>
  (remote: Remote, activation: Activation) => {
    const { workId, branch, head } = facts(activation.prompt);
    (remote.refs ??= {})[branch] = head;
    const existing = (remote.pulls[3] ?? []).find(item => item.headRef === branch && !overrides.number);
    if (existing) existing.headSha = head;
    else remote.pulls[3] = [...(remote.pulls[3] ?? []), ownPull(workId, branch, head, overrides)];
  };

export function executionDoubles(remote: Remote, scripts: Script[], options: { reviews?: boolean } = {}) {
  const calls: { kind: string; detail?: unknown }[] = [];
  let sessions = 0;
  let delivered: ((directive: BuilderDirective) => void) | undefined;
  const captures = new Map<number, HandoffEvent>();
  const receipt = (invocation: Invocation) => ({
    receipt: { workId: invocation.context.workId, id: '99999999-2222-4333-8444-555555555555' },
    invocation: { executionId: invocation.context.executionId, invocationId: invocation.context.invocationId },
  });
  const ports: ExecutionPorts = {
    configuration: { schemaVersion: 1 },
    capacity: 1,
    builder: { skillPack: 'factory-skills-v6', modelBudget: 'builder-v1', copyOutput: true, editSourceMaxBytes: 8192 },
    ...(options.reviews === false ? {} : { reviews: { reviewer: { modelBudget: 'reviewer-v1' as const, imageSourceMaxBytes: 5242880 }, rounds: { max: 4 } } }),
    sandbox: {
      async prepare(input) {
        calls.push({ kind: 'prepare' });
        return {
          status: 'success',
          environment: `env-${'c'.repeat(64)}` as never,
          seeds: [{ name: 'factory/skill-pack/factory-skills-v6', manifestSha256: 'f'.repeat(64), reused: false }],
          checkout: {
            path: '/workspace/checkout',
            repository: input.checkout.repository,
            repositoryId: input.checkout.repositoryId,
            base: 'main',
            branch: input.checkout.branch,
            baseCommit: 'a'.repeat(40),
            origin: 'https://github.com/acme/project.git',
            reused: calls.filter(call => call.kind === 'prepare').length > 1,
            preparedAt: new Date().toISOString(),
          },
        };
      },
      async start() {
        calls.push({ kind: 'start' });
        return { status: 'success', boot: `boot-11111111-2222-4333-8444-${String(calls.length).padStart(12, '5')}` as never };
      },
      async stop() {
        calls.push({ kind: 'stop' });
        return { status: 'success', cessationConfirmed: true, termination: 'unconfirmed', guestFinalization: 'observed' };
      },
      async observeProposal(input): Promise<ProposalIdentity> {
        const event = captures.get(input.round);
        return {
          status: 'observed',
          sha256: event?.status === 'captured' ? event.summary.content!.sha256 : 'x',
          indexSha256: event?.status === 'captured' ? event.summary.indexSha256 : '',
          entries: 1,
          consistent: true,
          observedAt: new Date().toISOString(),
        };
      },
    },
    credentials: {
      async issue(input) {
        const purpose = input.purpose ?? 'builder-start';
        calls.push({ kind: 'issue', detail: purpose });
        return {
          delivery: { token: `ghs_synthetic${purpose === 'builder-publish' ? 'Publish' : 'Start'}0123` },
          metadata: {
            role: 'builder',
            purpose,
            repository: 'acme/project',
            repositoryId: 3,
            installationId: 2,
            permissions:
              purpose === 'builder-publish'
                ? { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'read' }
                : { metadata: 'read', contents: 'read', issues: 'read' },
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
        };
      },
      async revoke() {
        calls.push({ kind: 'revoke' });
        return { kind: 'revoked', nextStep: 'synthetic' };
      },
    },
    workers: {
      async activate(invocation, delivery) {
        const role = invocation.context.role;
        if (role !== 'builder') {
          calls.push({ kind: `activate-${role}`, detail: { prompt: invocation.prompt, round: invocation.review?.round ?? null } });
          const review = invocation.review!;
          const opinion: ReviewOpinion = {
            version: 1,
            role: role as 'spec',
            round: review.round,
            attempt: 1,
            invocationId: invocation.context.invocationId,
            reference: { workId: invocation.context.workId, id: '88888888-2222-4333-8444-555555555555' },
            session: { file: `/run/w-${role}/s.jsonl`, mode: 'new', from: null, code: null },
            model: { providerId: 'openai', modelId: 'gpt-6-luna' },
            profile: { id: 'p', modelBudget: 'reviewer-v1' },
            input: { handoffIndexSha256: review.handoffIndexSha256, required: [...review.required], missing: [...review.missing] },
            conclusion: 'clean',
            code: null,
            coverage: { scope: 'broad', justification: 'all', examined: [] },
            findings: [],
            limitations: [],
            hostChecks: { reads: 1, failedReads: [], requiredNotFullyRead: [], downgraded: [] },
            finalMessageSha256: null,
            recordedAt: new Date().toISOString(),
          };
          return {
            worker: invocation.context.invocationId,
            started: Promise.resolve(receipt(invocation)),
            completed: Promise.resolve({ status: 'success' as const, receipt: receipt(invocation).receipt, opinion }),
            close() {},
          };
        }
        const script = scripts.shift() ?? { kind: 'implement', head: 'd'.repeat(40) };
        const activation: Activation = {
          prompt: invocation.prompt,
          phaseId: invocation.context.phaseId,
          executionId: invocation.context.executionId,
          continuation: invocation.continuation ?? null,
          handoff: invocation.handoff ?? null,
          editSourceMaxBytes: invocation.editSourceMaxBytes,
          token: delivery?.credential?.token ?? '',
          pushPolicy: invocation.pushPolicy ?? null,
        };
        calls.push({ kind: 'activate', detail: activation });
        const session = sessionRef(++sessions);
        if (script.kind === 'publish') {
          const started =
            script.end === 'receipt-lost'
              ? new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('WORKER_START_RECEIPT_LOST')), 5))
              : Promise.resolve(receipt(invocation));
          const completed = started.then(async () => {
            await script.publish(remote, activation);
            return script.end === 'failure'
              ? { status: 'failure' as const, code: 'WORKER_CHANNEL_LOST' }
              : { status: 'success' as const, receipt: receipt(invocation).receipt, session };
          });
          void completed.catch(() => {});
          if (script.end === 'receipt-lost') script.publish(remote, activation); // the Builder ran and published; only its receipt is lost
          return { worker: invocation.context.invocationId, started, completed, close() {} };
        }
        // Implementation with ticket 13's handoff: round 1 (gate declared) reviewed by both reviewers, then the Host's closing capture.
        const branch = /branch=(\S+)/.exec(invocation.prompt)![1]!;
        const committed = script.committed ?? true;
        script.during?.(remote, activation);
        if (script.failure) {
          const code = script.failure;
          return {
            worker: invocation.context.invocationId,
            started: Promise.resolve(receipt(invocation)),
            completed: Promise.resolve({ status: 'failure' as const, code }),
            ...(invocation.handoff
              ? {
                  handoffs: {
                    async next() {
                      return null;
                    },
                  },
                }
              : {}),
            close() {},
          };
        }
        // Ticket 21: the Host capture checks the authorized remote tip as an ancestor of HEAD when the invocation asks for it.
        const preserve = invocation.handoff && 'preserve' in invocation.handoff ? invocation.handoff.preserve : undefined;
        const withPreserved = (value: ProposalHandoff): ProposalHandoff =>
          preserve ? { ...value, preserved: { commit: preserve, ancestor: script.preserves ?? true } } : value;
        const queue: HandoffEvent[] = [
          {
            round: 1,
            status: 'captured',
            summary: withPreserved(summary(1, script.head, branch, committed)),
            declarations: { treatments: [], gates: [gate(script.gate ?? 'passed')] },
          },
          { round: 2, status: 'captured', summary: withPreserved(summary(2, script.head, branch, committed)), closing: true },
        ];
        const first = invocation.handoff && 'rounds' in invocation.handoff && invocation.handoff.rounds ? invocation.handoff.rounds.first : 1;
        for (const event of queue) {
          event.round += first - 1;
          if (event.status === 'captured') event.summary.round = event.round;
          captures.set(event.round, event);
        }
        let finish!: () => void;
        const done = new Promise<void>(resolve => {
          finish = resolve;
        });
        if (!invocation.handoff) finish();
        let waiting: Promise<BuilderDirective> | null = null;
        return {
          worker: invocation.context.invocationId,
          started: Promise.resolve(receipt(invocation)),
          completed: done.then(() => ({ status: 'success' as const, receipt: receipt(invocation).receipt, session })),
          ...(invocation.handoff
            ? {
                handoffs: {
                  async next() {
                    if (waiting) {
                      const directive = await waiting;
                      if (directive.end) {
                        finish();
                        return null;
                      }
                    }
                    const event = queue.shift();
                    if (!event) {
                      finish();
                      return null;
                    }
                    waiting = new Promise(resolve => {
                      delivered = resolve;
                    });
                    return event;
                  },
                },
              }
            : {}),
          close() {},
        };
      },
      async deliver(_worker, directive) {
        calls.push({ kind: `deliver-${directive.kind}` });
        if (directive.kind === 'review-results') {
          delivered?.(directive);
          return { status: 'delivered' as const };
        }
        return { status: directive.kind === 'credential' ? ('delivered' as const) : ('withdrawn' as const) };
      },
      async observe(input) {
        calls.push({ kind: 'observe' });
        return { session: { state: 'compatible' as const, session: input.session }, limitations: [] };
      },
    },
  };
  return { ports, calls };
}

/**
 * Ticket 21: the Builder's direct publication with GIT LEASE SEMANTICS — the push of the prompt's explicit `--force-with-lease=<ref>:<oid>`
 * applies only when the remote branch is exactly at that oid (empty = absent); otherwise nothing changes (the lease failed). The own PR then
 * follows the branch (or is created once).
 */
export const leasedPublish = (remote: Remote, activation: Activation) => {
  const lease = /--force-with-lease=refs\/heads\/(\S+):([0-9a-f]{40})? \S+ ([0-9a-f]{40}):refs\/heads\/\S+/.exec(activation.prompt);
  const { workId, branch, head } = facts(activation.prompt);
  if (lease) {
    const current = remote.refs?.[branch];
    if ((lease[2] ?? undefined) !== (current === undefined ? undefined : current)) return; // stale info: rejected by the lease
    pushAs(remote, branch, head, { login: app.login, id: app.id });
  }
  const existing = (remote.pulls[3] ?? []).find(item => item.headRef === branch);
  if (existing) existing.headSha = remote.refs?.[branch] ?? existing.headSha;
  else remote.pulls[3] = [...(remote.pulls[3] ?? []), ownPull(workId, branch, head)];
};
/** Ticket 21: a human pushes `sha` to the Work's branch (the own PR follows the branch). */
export const humanPush = (remote: Remote, branch: string, sha: string) => {
  const before = remote.refs?.[branch];
  // A human fast-forward commit on top of the current tip.
  if (before && before !== 'unknown') (remote.graph ??= {})[sha] = [...new Set([...(remote.graph?.[sha] ?? []), before])];
  pushAs(remote, branch, sha, { login: 'operator-one', id: 5 });
  for (const pull of remote.pulls[3] ?? []) if (pull.headRef === branch) pull.headSha = sha;
};
/** A ref update as GitHub's push activity reports it. */
export const pushAs = (remote: Remote, branch: string, sha: string, actor: { login: string; id: number }) => {
  const before = remote.refs?.[branch];
  ((remote.activity ??= {})[branch] ??= []).unshift({
    before: before && before !== 'unknown' ? before : '0'.repeat(40),
    after: sha,
    type: 'push',
    actor,
    at: new Date().toISOString(),
  });
  (remote.refs ??= {})[branch] = sha;
};
