import type { ModelRuntime, ToolDefinition } from '#factory-pi';

/** Invocation-local qualification limits, NOT an admission/billing scheduler.
 * Observed parsed bytes/deadline do not bound remote output, billing, RSS or
 * physical cessation. The built-in ChatGPT route omits max_output_tokens. */
export const oauthQualification = Object.freeze({ requests: 2, tools: 1, promptBytes: 4096,
  contextBytes: 32768, toolBytes: 8192, providerBytes: 65536, deadlineMs: 30000 });
/** Host-selected Builder start budget (ticket 09): a bounded, explicit envelope for one real Builder Execution with the skill pack.
 * Same native SDK/no-retry path; these are observation limits, NOT a billing cap, RSS bound or physical cessation. */
export const builderBudget = Object.freeze({ requests: 60, tools: 120, promptBytes: 16384, contextBytes: 2 * 1024 * 1024,
  toolBytes: 262144, providerBytes: 16 * 1024 * 1024, deadlineMs: 30 * 60 * 1000 });
/** Host-selected reviewer budget (ticket 12): one bounded Standards or Spec opinion over a handed-off proposal, read-only tools. Same
 * native SDK/no-retry path; observation limits, NOT a billing cap. The reviewers share the Execution and its Slot (no own budget/Slot).
 * Ticket 51 (operator decision 2026-11-19, pilot 35): 48 requests, 160 tool calls and 30 minutes, fixed and recorded in the release
 * (`productionProfile.limits.modelBudget.reviewerV1`); the old 24/80/15 was exhausted by the Spec review of a medium change. */
export const reviewerBudget = Object.freeze({ requests: 48, tools: 160, promptBytes: 16384, contextBytes: 2 * 1024 * 1024,
  toolBytes: 262144, providerBytes: 16 * 1024 * 1024, deadlineMs: 30 * 60 * 1000 });
export type QualificationLimits = typeof oauthQualification | typeof builderBudget | typeof reviewerBudget;
/** Host policy -> limits; a budget never applies to a role it was not made for. */
export function budgetFor(role: string, modelBudget: string | undefined): QualificationLimits {
  if (modelBudget === 'builder-v1' && role === 'builder') return builderBudget;
  if (modelBudget === 'reviewer-v1' && (role === 'standards' || role === 'spec')) return reviewerBudget;
  return oauthQualification;
}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '');
const unavailable = () => new Error('WORKER_QUALIFICATION_CLOSED');
type Stream = ReturnType<ModelRuntime['streamSimple']>;
type Message = Awaited<ReturnType<Stream['result']>>;

/** Native agent/accumulator/stream retained. Only this runtime instance's
 * public request/stream boundaries are narrowed before auth and persistence. */
export function qualifyOAuth(runtime: ModelRuntime, signal: AbortSignal, publicInputIsSafe: () => boolean, abort: () => void,
  limits: QualificationLimits = oauthQualification) {
  let requests = 0, tools = 0, providerBytes = 0, failed = false;
  const close = () => { failed = true; abort(); return unavailable(); };
  const check = () => { if (failed || signal.aborted || !publicInputIsSafe()) throw close(); };
  const safeMessage = (message: Message): Message => {
    if (message.stopReason === 'error' || message.stopReason === 'aborted' || message.errorMessage !== undefined) {
      failed = true;
      return { role: 'assistant', content: [], api: 'openai-responses', provider: 'openai', model: 'gpt-6-luna',
        usage: structuredClone(message.usage), stopReason: 'error', errorMessage: 'WORKER_PROVIDER_UNAVAILABLE', timestamp: message.timestamp };
    }
    return structuredClone(message);
  };
  const native = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    // Freeze/count BEFORE calling native (whose lazy setup begins auth immediately).
    const count = ++requests;
    check();
    if (count > limits.requests || model.provider !== 'openai' || model.id !== 'gpt-6-luna' ||
        model.api !== 'openai-responses' || size(context) > limits.contextBytes) throw close();
    const stream = native(model, context, { signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
      ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      maxRetries: 0, timeoutMs: limits.deadlineMs, cacheRetention: 'none',
      async onProviderStreamEvent(data) {
        providerBytes += size(data); // awaited by native Responses BEFORE normalization
        check();
        if (providerBytes > limits.providerBytes) throw close();
      } });
    const push = stream.push.bind(stream), end = stream.end.bind(stream);
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
  return { check, failed: () => failed,
    tool(tool: ToolDefinition): ToolDefinition {
      return { ...tool, async execute(...args) {
        const count = ++tools; // before delegate/adapter, including concurrent calls
        check();
        if (count > limits.tools || size(args[1]) > limits.toolBytes) throw close();
        const [callId, input, callerSignal, onUpdate, context] = args;
        const toolSignal = callerSignal ? AbortSignal.any([signal, callerSignal]) : signal;
        const checkTool = () => { check(); if (toolSignal.aborted) throw close(); };
        const update: typeof onUpdate = onUpdate ? result => {
          checkTool();
          if (size(result) > limits.toolBytes) throw close();
          onUpdate(result);
        } : undefined;
        checkTool();
        const result = await tool.execute(callId, input, toolSignal, update, context);
        checkTool();
        if (size(result) > limits.toolBytes) throw close();
        return result;
      } };
    } };
}
