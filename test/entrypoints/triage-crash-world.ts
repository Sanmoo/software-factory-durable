// Spec #68 TR-11 (ticket #76): the Control of the real-crash scenario, opened the same way by the child that is killed and by the test
// that takes the storage over. Real Control and SQLite, the REAL Investigation Environment (a transient unit of the user manager, with
// bubblewrap for its commands) and the production Triager agent inside it; doubled only at the third-party boundary: the tracker and the
// model provider (a local HTTP server of the test, reached by the agent from outside the confinement).
import { openControl, type SourceTriage, type TicketSource, type TriageRequestsView } from '../../src/control/index.js';
import { triagerAgentStart } from '../../src/entrypoints/controller/composition.js';
import { createInvestigationClones, createInvestigationEnvironment, investigationEnvironmentRoot } from '../../src/sandbox/index.js';
import { createTriager } from '../../src/workers/index.js';
import { applyLabel, githubDoubles, manualClock, remoteIssue, scope } from '../control/doubles.js';

const triage: SourceTriage = { needsTriage: 'needs-triage', needsInfo: 'needs-info', readyForHuman: 'ready-for-human', wontfix: 'wontfix', available: true };
const source: TicketSource = { tracker: 'github', repository: 'acme/project', discover: true, triage };

export async function openCrashControl(options: { factoryRoot: string; storagePath: string; modelUrl: string }) {
  const issue = remoteIssue(7, { labels: [], title: 'Total errado no carrinho', body: 'O total ignora o desconto.' });
  applyLabel(issue, 'needs-triage');
  const github = githubDoubles({ issues: [issue], pulls: {} });
  const environment = createInvestigationEnvironment({ root: investigationEnvironmentRoot(options.factoryRoot), factoryRoot: options.factoryRoot });
  const triager = createTriager({
    root: options.factoryRoot,
    skillPack: 'factory-skills-v13',
    profile: {
      id: 'factory-development-pi-1.5.2-read-async-bash-lexical-v3',
      systemPrompt: 'Factory Triager policy.',
      providerId: 'fixture',
      modelId: 'm',
      apiKey: 'synthetic-key',
      provider: {
        api: 'openai-completions',
        baseUrl: options.modelUrl,
        models: [
          {
            id: 'm',
            name: 'm',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 1000,
          },
        ],
      },
    },
    // The agent start of the production composition: the fixed entrypoint with its closed environment.
    agent: triagerAgentStart,
  });
  const clones = createInvestigationClones({
    root: options.factoryRoot,
    fetch: {
      fetch: async () => ({ token: 'unused', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      revoke: async () => ({ kind: 'revoked' }),
    } as unknown as Parameters<typeof createInvestigationClones>[0]['fetch'],
  });
  const time = manualClock();
  const control = await openControl({
    storagePath: options.storagePath,
    runtimeInventory: 'empty',
    access: { tracker: github.tracker, repository: github.repository, repositories: [scope], sources: [source] },
    polling: { intervalSeconds: 60, clock: time.clock },
    triage: {
      environment,
      limits: { memoryGiB: 2, processes: 512, commandSeconds: 120 },
      investigationMinutes: 15,
      capacity: 1,
      attempts: 2,
      triager: { activate: request => triager.activate(request) },
      clones,
    },
  });
  const requests = async () => ((await control.inspect({ kind: 'triage-requests' })) as TriageRequestsView).requests;
  return { control, time, environment, github, requests };
}
