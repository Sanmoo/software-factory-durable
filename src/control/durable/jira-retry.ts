// Review of the Jira tickets: shared retry timing of the Jira desks (comments and remote links).

/** The earliest instant of the next request after Jira asked to wait `waitSeconds` (429/5xx Retry-After), from the answer instant `at`. */
export const retryNotBefore = (at: string, waitSeconds: number) => new Date(Date.parse(at) + waitSeconds * 1000).toISOString();

/**
 * Seconds to wait before the next POST of a Jira comment after `failures` consecutive unsuccessful attempts (known refusals, or uncertain
 * POSTs then found absent): 0, 60, 180, 420, then 900 (bounded, never abandoned). The first failure is retried on the next pass.
 */
export const jiraCommentBackoffSeconds = (failures: number) => (failures <= 0 ? 0 : Math.min(2 ** Math.min(failures - 1, 4) - 1, 15) * 60);
