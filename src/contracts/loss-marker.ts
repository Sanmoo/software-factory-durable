/**
 * v2 ticket 12 (V2-16): the loss marker ref. When an environment ends, its terminate hook pushes the committed `HEAD` of the guest's
 * checkout, as best effort, to ONE ref of `origin` named by the Work and the boot. The name is the Factory's: nothing else lives under
 * `refs/factory/lost/`, it is not a branch (no pull request can use it) and it NEVER counts as preservation nor satisfies the gate.
 */
const workPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bootPattern = /^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const lostMarkerPattern =
  /^refs\/factory\/lost\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
/** Every marker ref of one Work lives under this prefix (with the trailing slash); `null`: not a Work id. */
export const lostMarkerPrefix = (workId: string): string | null => (workPattern.test(workId) ? `refs/factory/lost/${workId}/` : null);
/** The marker ref of one boot of one Work; `null` when either is not an identity the Factory issues. */
export const lostMarkerRef = (workId: string, boot: string): string | null =>
  workPattern.test(workId) && bootPattern.test(boot) ? `refs/factory/lost/${workId}/${boot}` : null;
