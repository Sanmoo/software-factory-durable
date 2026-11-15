/**
 * Review HIGH (Builder-side guard, Host policy — the Control-side preservation check before linking is the enforcement): the ONLY Git push a
 * Builder Bash command may contain is the exact command Control derived for its publication activation, with the lease oid Control recorded
 * (`--force-with-lease=refs/heads/<own>:<expected>`, empty only to create the branch). Any other push form (bare/`-f`/`+refspec`/`-u`,
 * a recaptured lease, another ref) and any GitHub API/HTTP write to git refs is refused before it reaches the guest. Outside a publication
 * activation no push is allowed at all. Not a sandbox: a guard against a model repeating a rejected push with a new expectation.
 * The ONE sanctioned exception to ticket 14's no-wrapper/no-parser rule (supervisor sign-off, ticket 21); reuse it, never duplicate it.
 */
/** `remote`: the exact token Control emitted in the instruction (`origin` or the configured `https://github.com/<owner>/<repo>.git`); absent = `origin`. */
export type PushPolicy = { branch: string; expected: string | null; head: string; remote?: string | undefined };
const remoteToken = /^(origin|https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git)$/;
const hex40 = /^[0-9a-f]{40}$/;
export const allowedPush = (policy: PushPolicy) => `git -C /workspace/checkout push --force-with-lease=refs/heads/${policy.branch}:${policy.expected ?? ''} ${policy.remote ?? 'origin'} ${policy.head}:refs/heads/${policy.branch}`;
export function pushDenied(command: string, policy: PushPolicy | undefined): string | null {
  const refsWrite = /\b(gh\b[\s\S]*\bapi|curl|wget)\b[\s\S]*(git\/refs|\/git\/ref\b|graphql)/i.test(command) && !/\bgh\s+pr\b/.test(command);
  if (refsWrite) return 'PUSH_POLICY_DENIED: GitHub API/HTTP calls on git refs are refused; publish only with the exact git push command of your Factory instruction.';
  if (!/\bgit\b[\s\S]*\bpush\b/.test(command) && !/\bsend-pack\b/.test(command)) return null;
  if (!policy || !hex40.test(policy.head) || (policy.remote !== undefined && !remoteToken.test(policy.remote)) || (policy.expected !== null && !hex40.test(policy.expected)) || policy.expected === policy.head) {
    return 'PUSH_POLICY_DENIED: no push is allowed in this activation.';
  }
  const allowed = allowedPush(policy);
  // Strict: the exact command as the WHOLE call (no chaining). The denial is local and says how to correct it once (real run q21-human-v3).
  return command.trim() === allowed ? null : 'PUSH_POLICY_DENIED: refused LOCALLY by the Factory Host before any network effect: nothing was sent, so this is ' +
    `not a publication attempt. The only push allowed is exactly: ${allowed} — run exactly this command ALONE as its own bash call: ${allowed}`;
}
