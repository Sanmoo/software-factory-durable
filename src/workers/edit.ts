import { randomUUID } from 'node:crypto';
import { createEditTool, type ToolDefinition } from '#factory-pi';
import type { ToolContext, ToolProjection, ReadResult } from '../sandbox/index.js';

// Optional private SDK capability, fixed at host construction, never model-selected.
type LexicalEditOptions = NonNullable<Parameters<typeof createEditTool>[1]> & { mutationQueueMode: 'lexical' };
type TextResult = Extract<ReadResult, { status: 'success'; format: 'text' }>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bound only known fields BEFORE native preparation/diff or JSON traversal. This
 * is a technical whole-buffer cap, not a second edit validator/parity claim. */
function boundedInput(input: unknown) {
  if (!input || typeof input !== 'object') return input;
  const raw = input as { path?: unknown; edits?: unknown; oldText?: unknown; newText?: unknown };
  let total = 0;
  const string = (value: unknown, limit: number) => {
    if (typeof value === 'string') {
      if (value.length > limit) throw new Error('EDIT_PAYLOAD_TOO_LARGE');
      total += value.length;
      if (total > 16384) throw new Error('EDIT_PAYLOAD_TOO_LARGE');
    }
    return value;
  };
  const path = string(raw.path, 4096);
  const pair = (value: unknown) => {
    if (!value || typeof value !== 'object') return value;
    const edit = value as { oldText?: unknown; newText?: unknown };
    return { oldText: string(edit.oldText, 8192), newText: string(edit.newText, 8192) };
  };
  let edits = raw.edits;
  if (Array.isArray(edits)) {
    if (edits.length > 128) throw new Error('EDIT_PAYLOAD_TOO_LARGE');
    edits = edits.map(pair);
  } else if (typeof edits === 'string') edits = string(edits, 16384);
  else edits = pair(edits);
  return { path, edits, oldText: string(raw.oldText, 8192), newText: string(raw.newText, 8192) };
}

/** Private adapter; normal Builder sessions require explicit trusted Host policy.
 * The SDK owns schema, lexical queue, matching, BOM/EOL engine and diff. Q5 owns
 * source identity, confined existing-FD comparison and mutation evidence. */
export function builderEdit(context: ToolContext, sandbox: ToolProjection, onCritical: () => void = () => {}): ToolDefinition {
  const bound = Object.freeze({ ...context });
  let revoked = false;
  // Technical admission bound: at most 16 retained executions/captures (owner
  // limit is 32), hence at most 15 FIFO waiters. No payload promise-chain.
  let admitted = 0;
  let rpcBusy = false;
  const waiters: (() => void)[] = [];
  const dispatch = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (rpcBusy) await new Promise<void>(resolve => { waiters.push(resolve); });
    else rpcBusy = true;
    try { return await operation(); }
    finally {
      const next = waiters.shift();
      if (next) next();
      else rpcBusy = false;
    }
  };
  const critical = () => { if (!revoked) { revoked = true; onCritical(); } };
  // Metadata/preparation only: even this never-executed native instance has no
  // default host filesystem callbacks. Actual operations are fresh below.
  const inactive = async (): Promise<never> => { throw new Error('EDIT_OPERATIONS_UNBOUND'); };
  const metadataOptions: LexicalEditOptions = { mutationQueueMode: 'lexical',
    operations: { access: inactive, readFile: inactive, writeFile: inactive } };
  const definition = createEditTool('/workspace', metadataOptions);
  // Fixed host composition: the shared channel admits one tool at a time.
  return { ...definition,
    executionMode: 'sequential',
    prepareArguments(input) {
      const bounded = boundedInput(input);
      return boundedInput(definition.prepareArguments?.(bounded) ?? bounded) as ReturnType<NonNullable<typeof definition.prepareArguments>>;
    },
    async execute(callId, input, signal, onUpdate, ctx) {
      if (bound.role !== 'builder') throw new Error('EDIT_ROLE_DENIED');
      if (revoked) throw new Error('EDIT_INVOCATION_REVOKED');
      const check = () => {
        if (signal?.aborted) { critical(); throw new Error('Operation aborted'); }
        if (revoked) throw new Error('EDIT_INVOCATION_REVOKED');
      };
      check();
      const prepared = boundedInput(input) as Parameters<typeof definition.execute>[1];
      // Fresh closure per execution, including queued same-path invocations.
      let capture: { path: string; result: TextResult & { sourceVersion: string } } | undefined;
      let spent = false;
      let originalError = false;
      const unavailable = (): never => { critical(); throw new Error('EDIT_SOURCE_UNAVAILABLE'); };
      const validReference = (result: Extract<ReadResult, { status: 'success' }>) =>
        result.reference?.workId === bound.workId && uuid.test(result.reference.id);
      const rpc = (call: Parameters<ToolProjection['executeTool']>[1]) => dispatch(async () => {
        check(); // Recheck at dispatch, not merely when entering the FIFO.
        // Consume only at dispatch; a denied queued commit still owns an unused
        // capture. Once dispatched, never release, retry or replay that source.
        if (call.name === 'edit-source' && call.operation === 'commit') spent = true;
        try { return await sandbox.executeTool(bound, call, undefined, signal); }
        catch (error) { critical(); throw error; }
        finally { if (signal?.aborted) critical(); }
      });
      const binding = (path: string) => {
        if (!capture || path !== capture.path || spent) return unavailable();
        return { name: 'edit-source' as const, path: capture.path, reference: capture.result.reference, sourceVersion: capture.result.sourceVersion };
      };
      const options: LexicalEditOptions = { mutationQueueMode: 'lexical', operations: {
        async access(path) {
          if (path.length > 4096) throw new Error('EDIT_PAYLOAD_TOO_LARGE');
          const result = await rpc({ name: 'edit-source', operation: 'capture', path, callId: randomUUID() });
          if (result.status !== 'success') { check(); critical(); throw new Error(result.code); }
          if (result.format !== 'text' || !validReference(result) || !result.sourceVersion || !uuid.test(result.sourceVersion)) return unavailable();
          capture = { path, result: { ...result, sourceVersion: result.sourceVersion } };
          check();
          if (!Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.bytes > 8192 ||
              result.encoding !== 'base64' || result.nextOffset !== 0 || result.data !== '') return unavailable();
        },
        async readFile(path) {
          const trusted = binding(path);
          const result = await rpc({ ...trusted, operation: 'page', offset: 0, callId: randomUUID() });
          check();
          if (result.status !== 'success') { critical(); throw new Error(result.code); }
          // Bound encoded size BEFORE decoding/allocation; no concat/second reader.
          if (result.format !== 'text' || result.encoding !== 'base64' || result.reference?.id !== trusted.reference.id ||
              result.reference.workId !== bound.workId || result.sourceVersion !== trusted.sourceVersion ||
              result.bytes !== capture?.result.bytes || typeof result.data !== 'string' || result.data.length > 10924 || result.nextOffset !== result.bytes) return unavailable();
          const buffer = Buffer.from(result.data, 'base64');
          if (buffer.length !== result.bytes || buffer.toString('base64') !== result.data ||
              !Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer)) return unavailable();
          // Buffer.toString retains BOM; native alone removes/reinserts it.
          return buffer;
        },
        async writeFile(path, replacement) {
          const trusted = binding(path);
          if (replacement.length > 8192 || Buffer.byteLength(replacement, 'utf8') > 8192) throw new Error('EDIT_PAYLOAD_TOO_LARGE');
          const call = { ...trusted, operation: 'commit' as const, replacement, callId: randomUUID() };
          if (Buffer.byteLength(JSON.stringify(call)) > 49152) throw new Error('EDIT_PAYLOAD_TOO_LARGE');
          check();
          const result = await rpc(call);
          check();
          if (result.status !== 'success') {
            if (result.code !== 'EDIT_SOURCE_CHANGED') critical();
            throw new Error(result.code);
          }
          if (result.format !== 'text' || !validReference(result) || result.bytes !== 0 || result.encoding !== 'base64' ||
              result.data !== '' || result.nextOffset !== 0) return unavailable();
        },
      } };
      if (admitted >= 16) throw new Error('EDIT_ADMISSION_FULL');
      admitted++;
      try {
        const result = await createEditTool(ctx?.cwd || '/workspace', options).execute(callId, prepared, signal, onUpdate);
        check();
        return result;
      } catch (error) {
        originalError = true;
        if (signal?.aborted) critical();
        throw error;
      } finally {
        try {
          if (capture && !spent) {
            // Cleanup must survive caller abort; it releases ONLY this unused source,
            // never cancels a shared VM. Channel loss already clears owner versions.
            try {
              const call = { ...binding(capture.path), operation: 'release' as const, callId: randomUUID() };
              const result = await dispatch(() => sandbox.executeTool(bound, call));
              if (result.status !== 'success' || result.format !== 'text' || result.sourceVersion !== capture.result.sourceVersion ||
                  result.reference.id !== capture.result.reference.id || result.reference.workId !== bound.workId ||
                  result.bytes !== capture.result.bytes || result.encoding !== 'base64' || result.data !== '' || result.nextOffset !== 0)
                throw new Error('EDIT_RELEASE_UNAVAILABLE');
            } catch (error) {
              critical();
              if (!originalError) throw error;
            }
          }
        } finally { admitted--; }
      }
    },
  };
}
