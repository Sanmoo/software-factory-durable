export type ControlInput = { request_id: string; operation: 'pause' | 'unpause'; origin: 'local-cli' };
export type ControlReceipt = { kind: 'durable'; request_id: string; operation: 'pause' | 'unpause'; paused: boolean; historySequence: number };
export type ControlQuery = { kind: 'status' } | { kind: 'request'; request_id: string };
export type ControlStatus = {
  controller_run_id: string;
  paused: boolean;
  dispatch: 'closed';
  dispatchReason: 'RECONCILIATION_REQUIRED' | 'EXECUTION_NOT_ENABLED';
  historyLength: number;
  persistence: { sqliteVersion: string; sqliteSourceId: string; journalMode: 'wal'; synchronous: 'FULL' };
};
export interface Control {
  accept(input: ControlInput): Promise<ControlReceipt | { kind: 'refused'; code: 'REQUEST_ID_CONFLICT' | 'INVALID_COMMAND' }>;
  inspect(query: ControlQuery): Promise<ControlStatus | { kind: 'request'; receipt: ControlReceipt | null }>;
  run(signal: AbortSignal): Promise<{ kind: 'clean' | 'failed' }>;
}
