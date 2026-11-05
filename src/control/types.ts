import type { AccessDiagnostic, GitHubScope } from '../contracts/index.js';
import type { IssueTracker } from '../issue-tracker/index.js';
import type { CodeRepository } from '../code-repository/index.js';

export type AccessView = { kind: 'access'; scope: 'authenticated'; results: { tracker: AccessDiagnostic; repository: AccessDiagnostic }[] };
export type AccessDependencies = { tracker: IssueTracker; repository: CodeRepository; repositories: (GitHubScope & { base: string; label: string })[] };
export type ControlInput = { request_id: string; operation: 'pause' | 'unpause'; origin: 'local-cli' };
export type ControlReceipt = { kind: 'durable'; request_id: string; operation: 'pause' | 'unpause'; paused: boolean; historySequence: number };
export type ControlQuery = { kind: 'status' } | { kind: 'request'; request_id: string } | { kind: 'access' };
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
  inspect(query: ControlQuery): Promise<ControlStatus | { kind: 'request'; receipt: ControlReceipt | null } | AccessView>;
  run(signal: AbortSignal): Promise<{ kind: 'clean' | 'failed' }>;
}
