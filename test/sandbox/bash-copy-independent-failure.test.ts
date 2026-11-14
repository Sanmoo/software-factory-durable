import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { createRecords } from '../../src/records/index.js';
import { serveReadTools, connectReadTools, type GuestOwner, type ToolContext } from '../../src/sandbox/read-tools.js';

const context: ToolContext = { workId: 'work', executionId: 'execution', invocationId: 'invocation', role: 'builder',
  environmentRef: 'environment', bootRef: 'boot', phaseId: 'phase' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

// Independent stdin pump: output/result deliberately ignore abort until released.
// No helper execution, VM startup or SDK import; only real Records is exercised.
for (const mode of ['projection', 'local-validation', 'result-rejection'] as const) {
  test(`independent ${mode} failure revokes mutations before held guest output/result settle`, async t => {
    const root = await mkdtemp('/tmp/bci-');
    const records = await createRecords({ root });
    const signal = new AbortController();
    const firstChunk = deferred(); const resumeSource = deferred(); const releaseOutput = deferred(); const releaseResult = deferred();
    const sourceFailure = deferred(); const resultFailure = deferred();
    let copySignal: AbortSignal | undefined;
    let executions = 0; let acceptedChunks = 0; let acceptedBytes = 0; let abortEvents = 0;
    let outputSettled = false; let resultSettled = false; let uncertainRecords = 0;
    const record = records.record;
    records.record = async (captureContext, event) => {
      if (event && typeof event === 'object' && 'kind' in event && event.kind === 'mutation-result' &&
          'operation' in event && event.operation === 'copy-output' && 'status' in event && event.status === 'effects-unknown-no-retry') uncertainRecords++;
      return record(captureContext, event);
    };
    let sourceError: unknown;
    let rejectResult!: (error: Error) => void;
    let pump: Promise<void> | undefined;
    // Fault injection at the local validation boundary, retaining the actual
    // Records projection/iterator. Projection mode itself has no wrapper.
    if (mode === 'local-validation') {
      const projectText = records.projectText;
      records.projectText = input => {
        const projection = projectText(input);
        const next = projection.chunks.next.bind(projection.chunks);
        let pulls = 0;
        projection.chunks.next = async (...args) => {
          const item = await next(...args);
          return !item.done && ++pulls === 2 ? { done: false, value: Buffer.alloc(0) } : item;
        };
        return projection;
      };
    }
    const vm: GuestOwner = { exec(argv, options) {
      executions++;
      if (!options.stdin || typeof options.stdin === 'string') return {
        result: Promise.resolve({ exitCode: 0 }),
        async *output() { yield { stream: 'stdout' as const, data: Buffer.from(argv.includes('/bin/bash') ? 'owned-output-'.repeat(20000) : 'old') }; },
      };
      const stdin = options.stdin;
      copySignal = options.signal;
      copySignal?.addEventListener('abort', () => { abortEvents++; });
      const result = mode === 'result-rejection'
        ? new Promise<{ exitCode: number }>((_resolve, reject) => { rejectResult = reject; })
        : releaseResult.promise.then(() => ({ exitCode: 0 }));
      void result.then(() => { resultSettled = true; }, () => { resultSettled = true; resultFailure.resolve(); });
      pump = (async () => {
        try {
          for await (const chunk of stdin) {
            assert.ok(chunk.length > 0);
            acceptedChunks++; acceptedBytes += chunk.length;
            if (acceptedChunks === 1) { firstChunk.resolve(); await resumeSource.promise; }
          }
        } catch (error) { sourceError = error; sourceFailure.resolve(); }
      })();
      return { result, async *output() { await releaseOutput.promise; outputSettled = true; } };
    } };
    const endpoint = root + '/tools';
    const owner = await serveReadTools({ endpoint, records, context, signal: signal.signal, vm, editSourceMaxBytes: 8192,
      profileOrigin: 'factory-development-gondolin-0.14.0-stdin-capacity-v1', copyOutput: true });
    const tools = await connectReadTools(endpoint, context);
    const peer = await connectReadTools(endpoint, context);
    let pending: ReturnType<typeof tools.executeTool> | undefined;
    try {
      const edit = await peer.executeTool({ name: 'edit-source', operation: 'capture', path: '/workspace/edit', callId: 'edit-source' });
      assert.equal(edit.status, 'success'); if (edit.status !== 'success') return;
      assert.equal(edit.format, 'text'); if (edit.format !== 'text') return;
      assert.ok(edit.sourceVersion);
      const bash = await tools.executeTool({ name: 'bash', command: 'owned', callId: 'bash' }, () => {});
      assert.equal(bash.status, 'success'); if (bash.status !== 'success') return;
      pending = tools.executeTool({ name: 'bash', operation: 'copy-output', reference: bash.reference, callId: 'copy' });
      await firstChunk.promise;
      if (mode === 'result-rejection') {
        rejectResult(new Error('independent result rejection'));
        await resultFailure.promise;
      } else {
        if (mode === 'projection') records.registerSecret('revision-changed-midstream');
        resumeSource.resolve();
        await sourceFailure.promise; // Observe failure, NOT the abort old code never requests.
        assert.ok(sourceError instanceof Error);
      }
      const before = executions;
      const aborted = copySignal?.aborted;
      const write = await peer.executeTool({ name: 'write', operation: 'create', path: '/artifacts/peer', content: '', callId: 'peer-write' });
      const editResult = await peer.executeTool({ name: 'edit-source', operation: 'commit', path: '/workspace/edit', reference: edit.reference,
        sourceVersion: edit.sourceVersion!, replacement: 'new', callId: 'peer-edit' });
      const bashResult = await peer.executeTool({ name: 'bash', command: 'peer', callId: 'peer-bash' }, () => {});
      assert.deepEqual({ aborted, write, edit: editResult, bash: bashResult, additionalGuestExec: executions - before,
        acceptedChunks, outputSettled, resultSettled }, {
        aborted: true, write: { status: 'failure', code: 'STALE_TOOL_CONTEXT' }, edit: { status: 'failure', code: 'STALE_TOOL_CONTEXT' },
        bash: { status: 'failure', code: 'STALE_TOOL_CONTEXT' }, additionalGuestExec: 0, acceptedChunks: 1,
        outputSettled: false, resultSettled: mode === 'result-rejection',
      });
      assert.equal(before, 3, 'only edit-source capture, Bash capture, and copy entered VM double');
      assert.equal(acceptedBytes, 65536); assert.equal(abortEvents, 1); assert.equal(uncertainRecords, 0);
      t.diagnostic(JSON.stringify({ mode, aborted, guestExec: executions, additionalGuestExec: executions - before,
        acceptedChunks, acceptedBytes, abortEvents, outputSettled, resultSettled, uncertainRecords,
        peerWrite: write.status === 'failure' && write.code, peerEdit: editResult.status === 'failure' && editResult.code,
        peerBash: bashResult.status === 'failure' && bashResult.code }));
    } finally {
      // Even RED releases and joins every held operation, without timers/polling.
      resumeSource.resolve(); releaseOutput.resolve(); releaseResult.resolve();
      try {
        if (pending) assert.equal((await pending).status, 'failure');
        await pump;
        if (pending) { assert.equal(uncertainRecords, 1); assert.equal(abortEvents, 1); }
      } finally {
        peer.close(); tools.close(); await owner.close(); await rm(root, { recursive: true, force: true });
      }
    }
  });
}
