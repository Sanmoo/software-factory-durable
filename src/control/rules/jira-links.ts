// Jira ticket 08 (spec §5): pure facts of the Work's ONE remote link on its Card. The link informs the team; its presence or title never
// proves a merge (delivery is the GitHub merge of the own PR). No I/O, clock or randomness.

import type { JiraLinkDesired } from '../types.js';

/** Stable per Work: every update (timeout, restart, new state) upserts the same link. */
export const jiraLinkGlobalId = (workId: string) => `software-factory:work:${workId}`;
/** Short readable reference of the Work: its installation admission sequence (stable for the Work's life). */
export const workShortRef = (sequence: number) => `T-${sequence}`;
const titles: Record<JiraLinkDesired, string> = { open: 'Abrir PR', 'closed-unmerged': 'PR fechado sem merge', delivered: 'Entregue' };
export const jiraLinkTitle = (workRef: string, desired: JiraLinkDesired) => `Trabalho ${workRef} · ${titles[desired]}`;

/** Polling passes skipped after `failures` consecutive unconfirmed upserts of the same state: 0, 1, 3, 7, then 15 (bounded, never abandoned). */
export const jiraLinkBackoffPasses = (failures: number) => (failures <= 0 ? 0 : Math.min(2 ** Math.min(failures - 1, 4) - 1, 15));
