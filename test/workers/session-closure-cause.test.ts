import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelRuntime } from '#factory-pi';
import { qualifyOAuth, reviewerBudget } from '../../src/workers/oauth-qualification.js';
import { composeOpinion } from '../../src/workers/review.js';

// Ticket 57 (pilot 2, #126): the Spec reviewer sessions ended `aborted`/WORKER_QUALIFICATION_CLOSED at their 49th model request (the Host's
// own 48-request `reviewer-v1` count), and Control only saw REVIEWER_INTERRUPTED. The Builder's failed request was recorded nowhere as such.
// The worker now says WHY a qualified session closed (a Host fact, never a model claim).

const model = { provider: 'openai', id: 'gpt-6-luna', api: 'openai-responses' };
type Pushed = { type: string; error?: { stopReason: string; errorMessage?: string }; message?: { stopReason: string; errorMessage?: string } };
/** A runtime whose native stream records what the qualification wrapper pushes on (the session listener's view). */
function runtime() {
  const pushed: Pushed[] = [];
  const value = {
    streamSimple: () => ({
      push(event: Pushed) {
        pushed.push(event);
      },
      end() {},
    }),
  } as unknown as ModelRuntime;
  return { value, pushed };
}
const failedMessage = (stopReason: 'error' | 'aborted') => ({
  role: 'assistant',
  content: [],
  api: 'openai-responses',
  provider: 'openai',
  model: 'gpt-6-luna',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason,
  errorMessage: 'raw provider text',
  timestamp: 1,
});

test('ticket 57: a request that failed without a Host abort is a provider failure; a Host abort or a budget close is not', () => {
  const failing = runtime();
  const gate = qualifyOAuth(
    failing.value,
    new AbortController().signal,
    () => true,
    () => {},
    reviewerBudget,
  );
  const stream = failing.value.streamSimple(model as never, { messages: [] } as never, {}) as unknown as { push(event: unknown): void };
  assert.equal(gate.providerFailed(), false);
  stream.push({ type: 'error', reason: 'error', error: failedMessage('error') });
  assert.deepEqual([gate.failed(), gate.providerFailed(), gate.exhausted()], [true, true, null]);
  assert.deepEqual(
    [failing.pushed[0]!.error!.stopReason, failing.pushed[0]!.error!.errorMessage],
    ['error', 'WORKER_PROVIDER_UNAVAILABLE'],
    'raw provider text never leaves',
  );

  // The Host aborted the session (Execution stop, owner channel lost): the stream ends `aborted`; that is not the provider's failure.
  const host = new AbortController();
  const aborted = runtime();
  const stopped = qualifyOAuth(
    aborted.value,
    host.signal,
    () => true,
    () => {},
    reviewerBudget,
  );
  const live = aborted.value.streamSimple(model as never, { messages: [] } as never, {}) as unknown as { push(event: unknown): void };
  host.abort();
  live.push({ type: 'error', reason: 'aborted', error: failedMessage('aborted') });
  assert.deepEqual([stopped.failed(), stopped.providerFailed()], [true, false]);
  // Ticket 60: the session label of a Host abort is its own closed code, never the provider's.
  assert.deepEqual([aborted.pushed[0]!.error!.stopReason, aborted.pushed[0]!.error!.errorMessage], ['error', 'WORKER_SESSION_CLOSED_BY_HOST']);

  // Its own request budget (the pilot's reviewer case): the 49th request closes, never a provider failure.
  const counted = runtime();
  const budget = qualifyOAuth(
    counted.value,
    new AbortController().signal,
    () => true,
    () => {},
    reviewerBudget,
  );
  for (let i = 0; i < reviewerBudget.requests; i++) counted.value.streamSimple(model as never, { messages: [] } as never, {});
  assert.throws(() => counted.value.streamSimple(model as never, { messages: [] } as never, {}), /WORKER_QUALIFICATION_CLOSED/);
  assert.deepEqual([budget.exhausted(), budget.providerFailed()], ['requests', false]);
});

test('ticket 57: an interrupted reviewer opinion names its cause: own budget, provider failure, or a plain interruption', () => {
  const opinion = (closedBy?: 'requests' | 'tools' | 'provider') =>
    composeOpinion({
      role: 'spec',
      invocationId: 'spec-x',
      status: 'interrupted',
      finalText: null,
      sessionFile: null,
      review: { round: 2, attempt: 1, handoffIndexSha256: 'e'.repeat(64), required: [], missing: [] },
      model: { providerId: 'openai', modelId: 'gpt-6-luna' },
      profile: { id: 'p', modelBudget: 'reviewer-v1' },
      host: { reads: 48, failedReads: [], requiredNotFullyRead: [] },
      ...(closedBy ? { closedBy } : {}),
    });
  assert.deepEqual([opinion('requests').conclusion, opinion('requests').code], ['cancelled', 'REVIEWER_BUDGET_EXHAUSTED']);
  assert.deepEqual([opinion('tools').conclusion, opinion('tools').code], ['cancelled', 'REVIEWER_BUDGET_EXHAUSTED']);
  assert.deepEqual([opinion('provider').conclusion, opinion('provider').code], ['failure', 'WORKER_PROVIDER_UNAVAILABLE']);
  assert.deepEqual([opinion().conclusion, opinion().code], ['cancelled', 'REVIEWER_INTERRUPTED']);
});
