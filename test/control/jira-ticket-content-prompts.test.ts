import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryPrompt } from '../../src/control/rules/questions.js';
import { interruptionRecoveryPrompt } from '../../src/control/rules/recovery.js';
import { reconciliationPrompt } from '../../src/control/rules/divergence.js';
import { initialPrompt } from '../../src/control/rules/continuation.js';

// Review of the Jira tickets (decisions-04): every first prompt of a NEW session of a Jira Work carries the Card's text the controller
// persisted with the request, so a session never depends on /artifacts surviving to know its Ticket (the Builder has no Jira access).
const ticketContent = {
  key: 'PAG-42',
  url: 'https://equipe.atlassian.net/browse/PAG-42',
  observedAt: '2026-11-21T10:00:00.000Z',
  summary: 'Preserve the v1 API',
  description: 'Keep /v1/payments answering.\nAdd /v2.',
  truncated: false,
  sha256: 'a'.repeat(64),
};
const common = {
  ticketUrl: ticketContent.url,
  repository: 'equipe/payments-api',
  base: 'main',
  baseCommit: 'b'.repeat(40),
  branch: 'factory/jira-81017-12345678',
  checkout: '/workspace/checkout',
  workId: 'w-1',
  executionId: 'e-2',
  previousExecutionId: 'e-1',
  skillDirectory: '/artifacts/factory/skill-pack/factory-skills-v2',
};
const carries = (prompt: string, label: string) => {
  assert.ok(prompt.includes('Ticket content: Jira Card PAG-42 https://equipe.atlassian.net/browse/PAG-42'), label);
  assert.ok(prompt.includes('Preserve the v1 API') && prompt.includes('Keep /v1/payments answering.\nAdd /v2.'), label);
  assert.ok(prompt.includes(`sha256 ${'a'.repeat(64)}`), label);
};

test('initial, recovery, substitute and reconciliation prompts of a Jira Work carry the persisted Card text; a GitHub Work gets none', () => {
  const initial = initialPrompt({ ...common, reviews: true, scopeUpdates: [], ticketContent });
  assert.ok(initial.kind === 'prompt');
  carries(initial.kind === 'prompt' ? initial.prompt : '', 'initial');
  const recovered = recoveryPrompt({ ...common, question: null, answer: { text: 'sim', author: 'jira acc-human', origin: 'jira-comment' }, ticketContent });
  assert.ok(recovered.kind === 'prompt');
  carries(recovered.kind === 'prompt' ? recovered.prompt : '', 'recovery');
  carries(interruptionRecoveryPrompt({ ...common, reason: 'OPERATIONAL_RECOVERY', code: 'BOOT_LOST', reviews: true, ticketContent }), 'interruption');
  const reconciled = reconciliationPrompt({
    ...common,
    pullRequest: null,
    expected: { state: 'present', sha: 'c'.repeat(40) },
    authorizedRemote: 'd'.repeat(40),
    localHead: 'c'.repeat(40),
    questionId: 'q1',
    answer: { author: 'operator', note: '' },
    commits: [],
    ticketContent,
  });
  assert.ok(reconciled.kind === 'prompt');
  carries(reconciled.kind === 'prompt' ? reconciled.prompt : '', 'reconciliation');
  const github = interruptionRecoveryPrompt({ ...common, reason: 'OPERATIONAL_RECOVERY', code: 'BOOT_LOST', reviews: true });
  assert.doesNotMatch(github, /Ticket content:/);
});
