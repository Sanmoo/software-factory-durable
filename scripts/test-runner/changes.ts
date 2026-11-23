// The change validation by change measures: files changed relative to the shared base (`VALIDATION_BASE`, else the
// policy's base), plus the working tree and untracked files. On the base branch itself (or detached at its tip), the
// change is what landed with the tip commit; any other branch compares against its merge base. Any part that cannot be established is reported as a widening reason, never read as "no change".
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Change } from './selection.ts';

type Git = (args: readonly string[]) => string | undefined;

export function gitIn(root: string): Git {
  return args => {
    try {
      return execFileSync('git', [...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return undefined;
    }
  };
}

const names = (output: string) => output.split('\0').filter(Boolean);

export function changedSet(root: string, base: string, git: Git = gitIn(root)): Change & { base: string; compared?: string } {
  const head = git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'])?.trim();
  if (!head) return { widened: 'HEAD does not resolve to a commit', base };
  const tip = git(['rev-parse', '--verify', '-q', `${base}^{commit}`])?.trim();
  if (!tip) return { widened: `the comparison base ${base} does not resolve`, base };
  let compared: string | undefined;
  const branch = git(['symbolic-ref', '-q', '--short', 'HEAD'])?.trim();
  if (tip === head && (branch === undefined || branch === base)) {
    compared = git(['rev-parse', '--verify', '-q', 'HEAD^1'])?.trim();
    if (!compared) return { widened: `HEAD is the tip of ${base} and has no earlier commit to compare against`, base };
  } else {
    compared = git(['merge-base', base, 'HEAD'])?.trim();
    if (!compared) return { widened: `HEAD shares no history with ${base}`, base };
  }
  const committed = git(['diff', '--name-only', '--no-renames', '-z', compared, 'HEAD']);
  const working = git(['diff', '--name-only', '--no-renames', '-z', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (committed === undefined || working === undefined || untracked === undefined) return { widened: 'the changed files cannot be listed', base };
  const files = [...new Set([...names(committed), ...names(working), ...names(untracked)])].sort();
  return { files, deleted: files.filter(file => !existsSync(join(root, file))), base, compared };
}
