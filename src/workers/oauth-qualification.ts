import type { ModelRuntime, ToolDefinition } from '#factory-pi';
import {
  builderBudgetMaximumFactor,
  builderBudgetV1,
  qualificationRequestsV1,
  reviewerBudgetV1,
  defaultWorkerThinkingLevel,
  type WorkerThinkingLevel,
} from '../contracts/index.js';

/** Invocation-local qualification limits, NOT an admission/billing scheduler.
 * Observed parsed bytes/deadline do not bound remote output, billing, RSS or
 * physical cessation. The built-in ChatGPT route omits max_output_tokens. */
export const oauthQualification = Object.freeze({
  requests: qualificationRequestsV1,
  tools: 1,
  promptBytes: 4096,
  contextBytes: 32768,
  toolBytes: 8192,
  providerBytes: 65536,
  deadlineMs: 30000,
});
/** Host-selected Builder start budget (ticket 09): a bounded, explicit envelope for one real Builder Execution with the skill pack.
 * Same native SDK/no-retry path; these are observation limits, NOT a billing cap, RSS bound or physical cessation.
 * Ticket 48 (operator decision 2026-11-19, pilot 35): 150 requests, 300 tool calls and 60 minutes, recorded in the release
 * (`productionProfile.limits.modelBudget.builderV1`); the old 60/120/30 was exhausted by every Builder of a Java code Ticket. The 60 minutes
 * are the budget's only time field, the SDK request timeout of EACH model request (spec §4.4/ticket 19: no worker clock in production). */
export const builderBudget = Object.freeze({
  requests: builderBudgetV1.requests,
  tools: builderBudgetV1.toolCalls,
  promptBytes: 16384,
  contextBytes: 2 * 1024 * 1024,
  toolBytes: 262144,
  providerBytes: 16 * 1024 * 1024,
  deadlineMs: builderBudgetV1.requestTimeoutMinutes * 60 * 1000,
});
/** Ticket 48: a repository may adjust the Builder budget up to this factor of `builderBudget`; above it the configuration is refused. */
export { builderBudgetMaximumFactor };
/** Ticket 48: the per-repository Builder budget override (requests, tool calls, per-request timeout), as the Host passes it to the worker. */
export type BuilderBudgetOverride = { requests: number; tools: number; deadlineMs: number };
/** Whether an override stays inside [1, 2x] of the release values (whole numbers; the timeout in whole minutes). */
export function builderBudgetOverrideValid(value: BuilderBudgetOverride): boolean {
  const within = (n: number, max: number) => Number.isSafeInteger(n) && n >= 1 && n <= max;
  return (
    within(value.requests, builderBudget.requests * builderBudgetMaximumFactor) &&
    within(value.tools, builderBudget.tools * builderBudgetMaximumFactor) &&
    within(value.deadlineMs, builderBudget.deadlineMs * builderBudgetMaximumFactor) &&
    value.deadlineMs % 60000 === 0
  );
}
/** Host-selected reviewer budget (ticket 12): one bounded Standards or Spec opinion over a handed-off proposal, read-only tools. Same
 * native SDK/no-retry path; observation limits, NOT a billing cap. The reviewers share the Execution and its Slot (no own budget/Slot).
 * Ticket 51 (operator decision 2026-11-19, pilot 35): 48 requests, 160 tool calls and 30 minutes, fixed and recorded in the release
 * (`productionProfile.limits.modelBudget.reviewerV1`); the old 24/80/15 was exhausted by the Spec review of a medium change. */
export const reviewerBudget = Object.freeze({
  requests: reviewerBudgetV1.requests,
  tools: reviewerBudgetV1.toolCalls,
  promptBytes: 16384,
  contextBytes: 2 * 1024 * 1024,
  toolBytes: 262144,
  providerBytes: 16 * 1024 * 1024,
  deadlineMs: reviewerBudgetV1.requestTimeoutMinutes * 60 * 1000,
});
export type QualificationLimits = {
  readonly requests: number;
  readonly tools: number;
  readonly promptBytes: number;
  readonly contextBytes: number;
  readonly toolBytes: number;
  readonly providerBytes: number;
  readonly deadlineMs: number;
};
/** Host policy -> limits; a budget never applies to a role it was not made for. Ticket 48: a Builder override (per repository, validated
 * again here: never above 2x) replaces only requests/tools/request timeout of `builder-v1`; an invalid one refuses the activation. */
export function budgetFor(role: string, modelBudget: string | undefined, override?: BuilderBudgetOverride): QualificationLimits {
  if (override !== undefined && (modelBudget !== 'builder-v1' || role !== 'builder' || !builderBudgetOverrideValid(override)))
    throw new Error('WORKER_BUDGET_INVALID');
  if (modelBudget === 'builder-v1' && role === 'builder') return override ? Object.freeze({ ...builderBudget, ...override }) : builderBudget;
  if (modelBudget === 'reviewer-v1' && (role === 'standards' || role === 'spec')) return reviewerBudget;
  return oauthQualification;
}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '');
const unavailable = () => new Error('WORKER_QUALIFICATION_CLOSED');
type Stream = ReturnType<ModelRuntime['streamSimple']>;
type Message = Awaited<ReturnType<Stream['result']>>;

/** Native agent/accumulator/stream retained. Only this runtime instance's
 * public request/stream boundaries are narrowed before auth and persistence. */
export function qualifyOAuth(
  runtime: ModelRuntime,
  signal: AbortSignal,
  publicInputIsSafe: () => boolean,
  abort: () => void,
  limits: QualificationLimits = oauthQualification,
  thinkingLevel: WorkerThinkingLevel = defaultWorkerThinkingLevel,
) {
  let requests = 0,
    tools = 0,
    providerBytes = 0,
    failed = false;
  // Ticket 48: which count of the budget closed the session (Host fact, never a model claim); null = closed for another reason or open.
  let exhausted: 'requests' | 'tools' | null = null;
  // Ticket 57: a model request ended in error while the Host had NOT aborted this session (provider, transport or credential failure inside
  // the request). Host fact for the result's cause; the native SDK never retries it (maxRetries 0, SDK retry disabled).
  let providerFailed = false;
  const close = () => {
    failed = true;
    abort();
    return unavailable();
  };
  const check = () => {
    if (failed || signal.aborted || !publicInputIsSafe()) throw close();
  };
  const safeMessage = (message: Message): Message => {
    if (message.stopReason === 'error' || message.stopReason === 'aborted' || message.errorMessage !== undefined) {
      if (!failed && message.stopReason !== 'aborted' && !signal.aborted) providerFailed = true;
      failed = true;
      return {
        role: 'assistant',
        content: [],
        api: 'openai-responses',
        provider: 'openai',
        model: 'gpt-6-luna',
        // Ticket 60: a closed label either way; a Host abort or Host close (budget, owner, critical tool) is never labelled the provider's.
        usage: structuredClone(message.usage),
        stopReason: 'error',
        errorMessage: providerFailed ? 'WORKER_PROVIDER_UNAVAILABLE' : 'WORKER_SESSION_CLOSED_BY_HOST',
        timestamp: message.timestamp,
      };
    }
    return structuredClone(message);
  };
  const native = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    // Freeze/count BEFORE calling native (whose lazy setup begins auth immediately).
    const count = ++requests;
    check();
    if (count > limits.requests && !failed) exhausted = 'requests';
    if (
      count > limits.requests ||
      model.provider !== 'openai' ||
      model.id !== 'gpt-6-luna' ||
      model.api !== 'openai-responses' ||
      size(context) > limits.contextBytes
    )
      throw close();
    const stream = native(model, context, {
      signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
      ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      maxRetries: 0,
      timeoutMs: limits.deadlineMs,
      cacheRetention: 'none',
      // #48: the role's reasoning level is a Host fact of every request, never whatever the session happened to pass.
      reasoning: thinkingLevel,
      async onProviderStreamEvent(data) {
        providerBytes += size(data); // awaited by native Responses BEFORE normalization
        check();
        if (providerBytes > limits.providerBytes) throw close();
      },
    });
    const push = stream.push.bind(stream),
      end = stream.end.bind(stream);
    stream.push = event => {
      // Snapshot every partial: native output is a mutable reference later
      // decorated with raw HTTP errors. Never expose it to session listeners.
      if (event.type === 'error') push({ type: 'error', reason: 'error', error: safeMessage(event.error) });
      else if (event.type === 'done') push({ ...event, message: safeMessage(event.message) });
      else {
        const snapshot = structuredClone(event);
        if ('partial' in snapshot) snapshot.partial = safeMessage(snapshot.partial);
        push(snapshot);
      }
    };
    stream.end = result => end(result === undefined ? undefined : safeMessage(result));
    return stream;
  };
  return {
    check,
    failed: () => failed,
    exhausted: () => exhausted,
    providerFailed: () => providerFailed,
    tool(tool: ToolDefinition): ToolDefinition {
      return {
        ...tool,
        async execute(...args) {
          const count = ++tools; // before delegate/adapter, including concurrent calls
          check();
          if (count > limits.tools && !failed) exhausted = 'tools';
          if (count > limits.tools || size(args[1]) > limits.toolBytes) throw close();
          const [callId, input, callerSignal, onUpdate, context] = args;
          const toolSignal = callerSignal ? AbortSignal.any([signal, callerSignal]) : signal;
          const checkTool = () => {
            check();
            if (toolSignal.aborted) throw close();
          };
          const update: typeof onUpdate = onUpdate
            ? result => {
                checkTool();
                if (size(result) > limits.toolBytes) throw close();
                onUpdate(result);
              }
            : undefined;
          checkTool();
          const result = await tool.execute(callId, input, toolSignal, update, context);
          checkTool();
          if (size(result) > limits.toolBytes) throw close();
          return result;
        },
      };
    },
  };
}
