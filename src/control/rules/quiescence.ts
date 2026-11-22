/**
 * Ticket 33: durable evidence that no own activity may still run. An Execution is UNSETTLED while it is reserved, started or held, while its
 * Slot is held, or when it ended without confirmed cessation. A stop is clean only when nothing is unsettled and no Slot is held (spec §11.4:
 * the intention to stop never makes an interruption clean).
 */
export type SettlementFacts = {
  execution?: { executionId?: unknown; state?: unknown; slot?: { held?: unknown } | null; end?: { cessation?: unknown } | null } | null;
};
export function unsettledExecutions(works: readonly SettlementFacts[]): string[] {
  return works.flatMap(work => {
    const execution = work.execution;
    if (!execution) return [];
    const live = execution.state === 'reserved' || execution.state === 'started' || execution.state === 'held';
    const unsettled = live || execution.slot?.held === true || (execution.state === 'ended' && execution.end?.cessation === 'unconfirmed');
    return unsettled ? [String(execution.executionId ?? 'unknown')] : [];
  });
}
