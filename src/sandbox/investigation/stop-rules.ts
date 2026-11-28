import type { InvestigationRecord, InvestigationStop, StopRefusal } from './port.js';

/** What was read from the Host for one stop observation. Nothing here is inferred: a failed read is `unavailable` / `unreadable`. */
export type StopFacts = {
  /** The Host boot now. */
  hostBoot: string;
  /** The cgroup the user manager gives the recorded unit. */
  expectedCgroup: string;
  manager: 'unavailable' | { activeState: string; invocation: string; controlGroup: string };
  /** `absent`: the group no longer exists; `empty`: it exists with `populated 0`. */
  cgroup: 'absent' | 'empty' | 'populated' | 'unreadable';
};

const refused = (code: StopRefusal): InvestigationStop => ({ cessationConfirmed: false, code });

/** The unit the manager describes is the recorded attempt: same invocation (or none left after collection) and its own cgroup. */
function sameInvocation(record: InvestigationRecord, manager: Exclude<StopFacts['manager'], 'unavailable'>, expectedCgroup: string) {
  if (manager.controlGroup && manager.controlGroup !== expectedCgroup) return false;
  return !record.invocation || !manager.invocation || manager.invocation === record.invocation;
}

/**
 * The stop is confirmed with the unit inactive in the same invocation and its cgroup empty; a different Host boot also
 * confirms. An unanswering manager or a divergent invocation never confirms: the Triage capacity stays held.
 */
export function stopConfirmation(record: InvestigationRecord, facts: StopFacts): InvestigationStop {
  if (facts.hostBoot !== record.hostBoot) return { cessationConfirmed: true, evidence: 'host-rebooted' };
  if (facts.manager === 'unavailable') return refused('INVESTIGATION_MANAGER_UNAVAILABLE');
  if (!sameInvocation(record, facts.manager, facts.expectedCgroup)) return refused('INVESTIGATION_INVOCATION_MISMATCH');
  if (facts.manager.activeState !== 'inactive' && facts.manager.activeState !== 'failed') return refused('INVESTIGATION_UNIT_ACTIVE');
  if (facts.cgroup === 'populated') return refused('INVESTIGATION_CGROUP_POPULATED');
  if (facts.cgroup === 'unreadable') return refused('INVESTIGATION_CGROUP_UNREADABLE');
  return { cessationConfirmed: true, evidence: 'unit-inactive' };
}
