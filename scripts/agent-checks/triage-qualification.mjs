// Launcher of the REAL `triage-qualification` recipe (spec #68 §13, ticket #84). It is the only way to start a phase: it reads the
// reviewed rubric with its approval record and hands the recipe the finalization helper of docs/agents/experiment-proofs.md.
// Every phase other than `--plan` is a real effect (model, GitHub, Jira, systemd units) and needs the operator's authorization for
// that execution; a rubric hash and `approvedBy` are review records, never that authorization. Run from the checkout, after the build:
//   node scripts/agent-checks/triage-qualification.mjs --plan
//   node scripts/agent-checks/triage-qualification.mjs <preflight|measure|fixed|jira-probe|inspect>
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeProof } from './finalize.mjs';
import { readApprovedRubric } from './rubric.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const recipe = await import('../../dist/test/entrypoints/triage-qualification.js');
const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === '--plan') await recipe.main(args);
  else {
    // Refused here, before the recipe is asked for anything, when the rubric was not reviewed or changed after its review.
    const approved = await readApprovedRubric(root, recipe.rubric.path, recipe.rubric.approval);
    await recipe.main(args, {
      rubric: { criterionIds: approved.rubric.criteria.map(criterion => criterion.id), sha256: approved.sha256 },
      finalizeProof,
    });
  }
} catch (error) {
  console.error(`Qualification held; no retry. (${String(error instanceof Error ? error.message : error).slice(0, 128)})`);
  process.exitCode = 1;
}
