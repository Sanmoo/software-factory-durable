// Whether one Entry Point run proves a quality gate: the rules that keep a red run from being miscounted as a Gate Proof.
// Pure, so the rules themselves are tested (test/runner/proof-attribution.test.ts).

export interface ProofRun {
  exitCode: number | null;
  report: string;
}
export interface Verdict {
  proved: boolean;
  reason: string;
  failingGates: string[];
}

/** The quality gates the report names in its FAILURE lines (`quality gate <Gate> (<check>): …`); other failures as `unattributed`. */
export function failingGates(report: string): string[] {
  const gates = new Set<string>();
  for (const line of report.split('\n')) {
    if (!line.startsWith('FAILURE: ')) continue;
    const match = /^FAILURE: quality gate (.+?) \([a-z0-9-]+\): /.exec(line);
    gates.add(match ? match[1]! : 'unattributed');
  }
  return [...gates].sort();
}

/**
 * Proved only when the run exited non-zero, every failure is attributed to the gate under proof, its analysis ran to a
 * finding (a finding line at the violation's location), and the report is the runner's (a crash or a precondition is not).
 */
export function attribute(run: ProofRun, gate: string, location: string): Verdict {
  const gates = failingGates(run.report);
  const verdict = (proved: boolean, reason: string): Verdict => ({ proved, reason, failingGates: gates });
  if (!/^RESULT: (PASS|FAIL|INCONCLUSIVE)/m.test(run.report))
    return verdict(false, 'the runner did not complete a report (crash, precondition or environment)');
  if (run.exitCode === 0) return verdict(false, 'the Entry Point stayed green');
  if (gates.length === 0) return verdict(false, 'the run failed without naming a quality gate');
  if (gates.length > 1 || gates[0] !== gate) return verdict(false, `the failing quality gates are ${gates.join(', ')}, not only ${gate}`);
  const located = run.report.split('\n').some(line => line.startsWith(`FAILURE: quality gate ${gate} (`) && line.includes(location));
  if (!located) return verdict(false, `${gate} failed, but not at the violation's location ${location}`);
  return verdict(true, `${gate} failed at ${location}, and nothing else failed`);
}

/**
 * For a changed-set quality gate: whether its step analyzed exactly the declared files. `step` is the tool name in the
 * report's static line (`prettier`, `eslint`); a scope that cannot be read from the report is unavailable, never empty.
 */
export function analyzedExactly(staticLine: string, step: string, declared: readonly string[]): { ok: boolean; analyzed: string[] | 'unavailable' } {
  const match = new RegExp(`(?:^static: |, )${step} \\(changed: ([^)]*)\\)`).exec(staticLine);
  if (!match) return { ok: false, analyzed: 'unavailable' };
  const analyzed = match[1]!.split(', ').filter(Boolean).sort();
  return { ok: analyzed.length === declared.length && [...declared].sort().every((file, index) => analyzed[index] === file), analyzed };
}
