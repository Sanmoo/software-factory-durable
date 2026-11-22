import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realSteps } from '../../scripts/test-runner/steps.ts';

// A throwaway detached worktree of HEAD (no .scratch/factory-development-*, no dist/) with a copy of this
// checkout's node_modules: the ci static stage must pass on its first run there. Never touches this checkout's
// shared state (.scratch, dist/); the temp worktree is removed even on failure.
test('ci static analysis passes on the first run of a fresh tree (depcruise sees the staged SDK)', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'sf-fresh-tree-'));
  const root = join(parent, 'tree');
  execFileSync('git', ['worktree', 'add', '--detach', '--quiet', root, 'HEAD'], { stdio: 'pipe' });
  try {
    await cp('node_modules', join(root, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
      filter: source => !source.startsWith(join('node_modules', '.cache')),
    });
    assert.equal(existsSync(join(root, '.scratch/factory-development-sdk-v3')), false);
    const steps = await realSteps(root, process.env, () => {}).staticAnalysis('ci', new AbortController().signal);
    const failed = steps.filter(step => !step.ok);
    assert.deepEqual(
      failed.map(step => step.name),
      [],
      failed.map(step => `${step.name}:\n${step.output ?? ''}`).join('\n'),
    );
    assert.ok(steps.some(step => step.name === 'depcruise'));
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', root], { stdio: 'pipe' });
    await rm(parent, { recursive: true, force: true });
  }
});
