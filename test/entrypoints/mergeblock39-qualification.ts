import type { BranchRule } from '../../src/code-repository/index.js';
import type { ModalityView } from '../../src/control/index.js';
import { ghGuardScript } from './checks15-qualification.js';

// TEST ONLY. Ticket 39 one-shot real qualification recipe: READ-ONLY proof that the active rules GitHub applies to main of
// Sanmoo/java-springboot-event-sourcing (ruleset 26435808, `update` re-enabled by the operator) are classified by the integrated code, with
// `update` ("Restrict updates") as MERGE-BLOCKING. No Control storage, no owner, no Work: the real CodeRepository Q4B readPullRequest of the
// latest (closed) own PR #5 is used only because it collects the base requirements; its result is never a readiness of #5. Import and `--plan`
// are inert. Every other phase is a REAL effect and needs an explicit operator grant: real GitHub through the App, GET requests only (plus
// installation token issuance). No model, VM, Docker, write, merge, approval, ready conversion or protection change. One-shot: exclusive
// intent tombstones precede effects; a consumed phase never reruns; nothing is retried.

const root = '/home/sanmoo/software-factory-test/y5';
const observations = `${root}/q39-mergeblock-v1`;
const revision = 'q39-mergeblock-v1';
const phases = ['preflight', 'evaluate'] as const;
type Phase = typeof phases[number];
const repository = { repository: 'Sanmoo/java-springboot-event-sourcing', base: 'main', installationId: 177599217, workflows: false, label: 'ready-for-agent' };
const expectedRuleset = { id: 26435808, base: 'main', merge: { update: 'blocking', pull_request: 'human-stage', non_fast_forward: 'not-blocking', deletion: 'not-blocking' } };
/** The latest own PR (ticket 14 v8, delivered by ticket 17): read only to collect the base requirements. */
const pullRequest = { number: 5, nodeId: 'PR_kwDOSuqsXs8AAAABPTSKww', headRef: 'factory/3-99fe871b', head: 'bfdd439ceba20a424538647f41e55d5ab2d03217', authorId: 351187749,
  pullRequestId: 5321820867, repositoryId: 1256893534 };
const githubApp = { appId: 5569788, privateKeyFile: 'credentials/app.pem' };
const ghTrace = `${observations}/gh-trace.jsonl`;
const raw = (repo: string) => ({ repository: `/repos/${repo}`, branch: `/repos/${repo}/branches/main`, rules: `/repos/${repo}/rules/branches/main`,
  ruleset: `/repos/${repo}/rulesets/${expectedRuleset.id}`, pull: `/repos/${repo}/pulls/${pullRequest.number}` });

export function plan() {
  return { revision, root, observations, phases, repository, expectedRuleset, pullRequest: { number: pullRequest.number, purpose: 'requirements collection only (closed/merged: never evaluated as readiness)' },
    requires: ['ticket 39 integrated in the composed revision', 'the operator re-enabled `update` in ruleset 26435808 (main) and authorized this read-only run', `${root}/${githubApp.privateKeyFile} present`],
    github: { app: githubApp, purposes: ['checks-read {metadata:read, contents:read, pull_requests:read, checks:read, statuses:read, administration:read}'],
      writes: ['App: access_tokens issuance POSTs only (native HTTPS, not gh); no other non-GET request'],
      guard: 'gh (GitHub access root = this namespace, never y5) behind ticket 15\'s wrapper: every request traced in gh-trace.jsonl; anything but GET without input refused (exit 97, nothing sent)',
      never: ['GitHub write of any kind', 'merge', 'approval or review', 'ready-for-review or draft conversion', 'comment', 'bypass', 'branch/ruleset/protection change'],
      requestBound: `preflight: GET ${Object.values(raw(repository.repository)).join(', ')} (rules paginated, <=10 pages); evaluate: one readPullRequest of #5 (1 PR + 1 branch + 0..1 classic ` +
        '+ <=10 rules + <=10 check-run + <=10 status pages + 0..1 compare + requirements re-read + 1 PR re-read)' },
    model: 'none', sandbox: 'none', control: 'none (no storage, no owner, no Work: nothing is admitted, converted or recorded)',
    effects: [
      'preflight: exclusive observations directory with its own GitHub access root (credentials/ copy of the App key, run/); raw GET payloads of the repository (merge settings), ' +
        'main (classic protection summary), the active rules of main, ruleset 26435808 and PR #5, saved verbatim',
      'evaluate (only after a successful preflight): the real Q4B readPullRequest of #5 (its parsed rules, with parameters) and Control\'s public interpretBaseRules over them; ' +
        'a COUNTERFACTUAL evaluateChecks over the same observation with the PR state set to open (labelled as such) shows the outcome and next step an open own PR would get; ' +
        'the key copy is removed at the end'],
    guards: ['one-shot intent tombstones', 'phase guard (evaluate only after a successful preflight, each phase once)', 'no retry', 'gh guard: GET only, every request traced', 'no Control', 'nothing under the repository changes'],
    expected: [
      'preflight: the active rules of main include ruleset 26435808 rules pull_request, non_fast_forward, deletion and update (with update_allows_fetch_and_merge as GitHub reports it)',
      'evaluate: interpretBaseRules -> update merge-blocking UPDATE_RESTRICTED, pull_request human-stage, non_fast_forward/deletion not-blocking, each with source ruleset:26435808:Repository:Sanmoo/java-springboot-event-sourcing',
      'counterfactual open: outcome blocked, reason merge:UPDATE_RESTRICTED:update@<source>, conflict not derived from mergeable_state, next step "adjust the base protection" without any bypass',
      'gh-trace.jsonl: every request GET and allowed'],
  };
}

/** Each phase once; evaluate only after a SUCCESSFUL preflight (a held one is consumed and never followed). */
export function phaseGuard(phase: Phase, results: { preflight?: { status?: unknown } | null }, intents: ReadonlySet<string>): string | null {
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  if (phase === 'evaluate' && results.preflight?.status !== 'success') return 'PREFLIGHT_SUCCESS_REQUIRED';
  return null;
}

/** The verdict of the run: the expected ruleset's rules are present and interpreted as expected (update merge-blocking), or why not. */
export function verdict(rules: Pick<BranchRule, 'type' | 'ruleset'>[], interpreted: Pick<ModalityView, 'type' | 'source' | 'merge' | 'reason'>[]):
  { status: 'success' | 'held'; reasons: string[] } {
  const reasons: string[] = [];
  for (const [type, merge] of Object.entries(expectedRuleset.merge)) {
    const index = rules.findIndex(rule => rule.type === type && rule.ruleset.id === expectedRuleset.id);
    if (index < 0) { reasons.push(`RULE_ABSENT:${type}`); continue; }
    if (interpreted[index]?.merge !== merge) reasons.push(`UNEXPECTED_INTERPRETATION:${type}:${interpreted[index]?.merge ?? 'none'}`);
  }
  return { status: reasons.length ? 'held' : 'success', reasons };
}

export const keySource = `${root}/${githubApp.privateKeyFile}`;
/** Fails loudly, with the path and what to do, when the App key the preflight copies is missing (nothing has been created yet). */
export async function requireKeySource(access: (path: string) => Promise<unknown>) {
  await access(keySource).catch(() => {
    throw new Error(`APP_KEY_SOURCE_MISSING: ${keySource} is absent; restore the App private key there before preflight (nothing was created, no intent, no GitHub call).`);
  });
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('OBSERVATION_LIMIT');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  };
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  const load = (name: string) => fs.readFile(`${observations}/${name}.json`, 'utf8').then(text => JSON.parse(text) as { status?: unknown }, () => null);
  return { fs, save, exists, load };
}

async function guardedGh() {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const target = `${observations}/gh-guard.mjs`;
  if (!(await fs.access(target).then(() => true, () => false))) {
    let gh: string | undefined;
    for (const directory of (process.env.PATH ?? '').split(':').filter(item => item.startsWith('/'))) {
      if (await fs.access(`${directory}/gh`, constants.X_OK).then(() => true, () => false)) { gh = `${directory}/gh`; break; }
    }
    if (!gh) throw new Error('GH_NOT_FOUND');
    await fs.writeFile(target, ghGuardScript({ node: process.execPath, gh, trace: ghTrace }), { mode: 0o700, flag: 'wx' });
  }
  return target;
}

async function compose() {
  const { createGitHubAccess } = await import('../../src/platform/github/index.js');
  const { createCodeRepository } = await import('../../src/code-repository/index.js');
  // The recipe's OWN namespace is the GitHub access root (its run/ holds the transient gh dirs; never y5/run).
  const github = createGitHubAccess({ root: observations, ...githubApp, executable: await guardedGh() });
  return { github, codeRepository: createCodeRepository({ github }) };
}
const traceOf = async () => {
  const fs = await import('node:fs/promises');
  return (await fs.readFile(ghTrace, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string | null; endpoint: string; allowed: boolean });
};

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, exists, load } = await io();
  if (phase === 'preflight') {
    // Before ANY effect (no directory, no intent, no GitHub call): the App key the namespace copies must exist.
    await requireKeySource(path => fs.access(path));
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
    const { constants } = await import('node:fs');
    await fs.mkdir(`${observations}/credentials`, { mode: 0o700 }); await fs.mkdir(`${observations}/run`, { mode: 0o700 });
    await fs.copyFile(`${root}/${githubApp.privateKeyFile}`, `${observations}/${githubApp.privateKeyFile}`, constants.COPYFILE_EXCL);
    await fs.chmod(`${observations}/${githubApp.privateKeyFile}`, 0o600);
  }
  const refused = phaseGuard(phase, { preflight: await load('preflight-result') },
    new Set((await Promise.all(phases.map(async item => await exists(`${item}-intent`) ? `${item}-intent` : null))).filter((item): item is string => item !== null)));
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'preflight') {
      const { github } = await compose();
      const paths = raw(repository.repository);
      const read = (path: string, listed = false) => github.read(repository, 'checks-read', session => listed ? session.list(path, { maxPages: 10 }) : session.get(path));
      const payloads = { repository: await read(paths.repository), branch: await read(paths.branch), rules: await read(paths.rules, true), ruleset: await read(paths.ruleset),
        pull: await read(paths.pull) };
      const rules = payloads.rules.ok && Array.isArray(payloads.rules.value) ? payloads.rules.value as { type?: unknown; ruleset_id?: unknown }[] : [];
      const present = Object.keys(expectedRuleset.merge).filter(type => rules.some(rule => rule.type === type && rule.ruleset_id === expectedRuleset.id));
      const ok = Object.values(payloads).every(item => item.ok) && present.length === Object.keys(expectedRuleset.merge).length;
      await save('preflight-result', { status: ok ? 'success' : 'held', present, payloads, trace: await traceOf() });
      if (!ok) throw new Error('EXPECTED_RULES_NOT_READ');
      return;
    }
    const { codeRepository } = await compose();
    const { evaluateChecks, interpretBaseRules } = await import('../../src/control/index.js');
    const observed = await codeRepository.readPullRequest({ repo: repository, number: pullRequest.number });
    if (observed.kind !== 'observed' || observed.rules.state !== 'complete') {
      await save('evaluate-result', { status: 'held', reason: 'RULES_NOT_READ', observed, trace: await traceOf() }); throw new Error('RULES_NOT_READ');
    }
    const interpreted = interpretBaseRules(observed.rules.value);
    // Counterfactual (labelled): the same observation as if the own PR were still open, to show the explanation an open PR gets. Never recorded.
    const open = { ...observed, pullRequest: { ...observed.pullRequest, state: 'open' as const, merged: false },
      recheck: observed.recheck.state === 'complete' ? { state: 'complete' as const, value: { ...observed.recheck.value, state: 'open' as const, merged: false } } : observed.recheck };
    const counterfactual = evaluateChecks({ at: new Date().toISOString(), observation: open, expect: { own: { pullRequestId: pullRequest.pullRequestId, nodeId: pullRequest.nodeId,
      number: pullRequest.number, headRef: pullRequest.headRef, base: repository.base, authorId: pullRequest.authorId }, repositoryId: pullRequest.repositoryId,
      linkedHeads: [observed.pullRequest.headSha], localRequiredChecks: [] } });
    const trace = await traceOf();
    const judged = verdict(observed.rules.value, interpreted);
    await save('evaluate-result', { ...judged, getOnly: trace.every(entry => entry.method === 'GET' && entry.allowed), requests: trace.length, interpreted, rules: observed.rules.value,
      pullRequest: { state: observed.pullRequest.state, merged: observed.pullRequest.merged, mergeable: observed.pullRequest.mergeable, mergeableState: observed.pullRequest.mergeableState },
      counterfactualOpen: { label: 'COUNTERFACTUAL: PR state set to open on a copy of the observation; not a readiness of #5', outcome: counterfactual.outcome,
        reasons: counterfactual.reasons, conflict: counterfactual.conflict, modalities: counterfactual.modalities, nextStep: counterfactual.nextStep }, observed, trace });
    await fs.rm(`${observations}/${githubApp.privateKeyFile}`, { force: true });
    if (judged.status !== 'success') throw new Error(judged.reasons.join(',').slice(0, 128));
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 128) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith('APP_KEY_SOURCE_MISSING') ? message : `Qualification held; no retry. (${message.slice(0, 128)})`); process.exit(1);
  });
}
