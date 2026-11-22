// The Secrets quality gate: gitleaks over the history reachable from HEAD and over the uncommitted working tree, matched against
// the tolerance policy (scripts/test-runner/secrets-tolerated.json). One entry tolerates one finding at its identity
// (commit, file, rule, line, column); a finding with no entry, two findings under one entry, or an entry whose commit the
// scan covered but which it no longer reports, fails. The run never writes the policy.
export interface SecretFinding {
  commit: string;
  file: string;
  rule: string;
  line: number;
  column: number;
}
export interface ToleratedSecret extends SecretFinding {
  decision: string;
}

export const identity = (item: SecretFinding) => `${item.commit}:${item.file}:${item.rule}:${item.line}:${item.column}`;

export function parseTolerance(value: unknown): ToleratedSecret[] {
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new Error('SECRETS_POLICY_INVALID: entries must be a list');
  return entries.map((raw, index) => {
    const entry = raw as Record<string, unknown>;
    const ok =
      typeof entry.commit === 'string' &&
      /^[0-9a-f]{40}$/.test(entry.commit) &&
      typeof entry.file === 'string' &&
      typeof entry.rule === 'string' &&
      Number.isInteger(entry.line) &&
      Number.isInteger(entry.column) &&
      typeof entry.decision === 'string' &&
      entry.decision.trim().length > 0;
    if (!ok) throw new Error(`SECRETS_POLICY_INVALID: entry ${index} needs a 40-character commit, file, rule, line, column and the explicit decision`);
    return entry as unknown as ToleratedSecret;
  });
}

/** `covered(commit)`: whether the scan analyzed that commit (an entry outside the analyzed history is not stale). */
export function matchSecrets(
  findings: readonly SecretFinding[],
  tolerated: readonly ToleratedSecret[],
  covered: (commit: string) => boolean,
): { rule: string; location: string }[] {
  const failures: { rule: string; location: string }[] = [];
  const entries = new Map(tolerated.map(entry => [identity(entry), entry]));
  const seen = new Map<string, number>();
  for (const finding of findings) seen.set(identity(finding), (seen.get(identity(finding)) ?? 0) + 1);
  for (const [key, count] of seen) {
    const [commit, file, rule, line, column] = key.split(':');
    const location = `${file}:${line}:${column} (${commit === 'working-tree' ? 'working tree' : `commit ${commit!.slice(0, 12)}`})`;
    if (!entries.has(key)) failures.push({ rule: `${rule}`, location });
    else if (count > 1) failures.push({ rule: `${rule}:several-findings-one-entry`, location });
  }
  for (const [key, entry] of entries)
    if (!seen.has(key) && covered(entry.commit))
      failures.push({ rule: `${entry.rule}:stale-entry`, location: `${entry.file}:${entry.line}:${entry.column} (commit ${entry.commit.slice(0, 12)})` });
  return failures.sort((a, b) => a.location.localeCompare(b.location));
}

/** gitleaks JSON (git mode carries Commit; dir mode does not, and is the working tree). */
export function readGitleaks(output: string, workingTree: boolean): SecretFinding[] {
  const report = JSON.parse(output) as { RuleID: string; File: string; StartLine: number; StartColumn: number; Commit?: string }[];
  if (!Array.isArray(report)) throw new Error('not a gitleaks JSON report');
  return report.map(item => ({
    commit: workingTree ? 'working-tree' : (item.Commit ?? ''),
    file: item.File,
    rule: item.RuleID,
    line: item.StartLine,
    column: item.StartColumn,
  }));
}
