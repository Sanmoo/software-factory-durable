// Disposable copies of the project for the rehearsal and the Gate Proofs: a git repository with the project's tracked and
// untracked files and a private node_modules (prepare-sdk refuses a shared one; a reflink copy where the filesystem allows),
// whose base commit carries an optional fixture.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Copy { dir: string; edit(file: string, change: (text: string) => string): void; write(file: string, text: string): void;
  commit(message: string): void; remove(): void }

export function disposableCopy(project: string, name: string, fixture: (copy: Copy) => void = () => {}): Copy {
  const parent = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'sf-disposable');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(parent, `${name}-`));
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: project, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) if (existsSync(join(project, file))) cpSync(join(project, file), join(dir, file), { recursive: true, verbatimSymlinks: true });
  execFileSync('cp', ['-a', '--reflink=auto', join(project, 'node_modules'), join(dir, 'node_modules')]);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  const copy: Copy = { dir,
    edit: (file, change) => {
      const before = readFileSync(join(dir, file), 'utf8'), after = change(before);
      if (after === before) throw new Error(`the edit of ${file} changed nothing`);
      writeFileSync(join(dir, file), after);
    },
    write: (file, text) => writeFileSync(join(dir, file), text),
    commit: message => { git('add', '-A'); git('-c', 'user.name=disposable', '-c', 'user.email=disposable@example.invalid', 'commit', '-q', '--allow-empty', '-m', message); },
    remove: () => rmSync(dir, { recursive: true, force: true }) };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.git/info/exclude'), '.integral-result.json\n');
  fixture(copy);
  copy.commit('base');
  git('switch', '-q', '-c', 'change');
  return copy;
}
