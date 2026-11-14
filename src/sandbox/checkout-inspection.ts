import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { copyConfinedTree, readConfined } from './confined.js';

export type CheckoutInspection = { status: 'observed'; head: string; branch: string | null; commits: string[]; diffStat: string;
  remotes: { name: string; url: string }[]; alternates: false; copiedBytes: number } | { status: 'refused' | 'unavailable'; code: string };

/**
 * Read-only observation of a Work checkout WITHOUT running host git in the guest-writable tree (spec §7.3): HEAD, refs, packed-refs and
 * objects are copied with confined reads into a fresh Factory-owned bare repository whose config the Factory writes; git runs only there,
 * with no system/global/repo-local configuration, hooks, attributes, pager, external diff, textconv or signature verification. Remotes are
 * parsed as text, never executed. Alternates are refused.
 */
export async function inspectCheckout(environmentDirectory: string, options: { scratch: string; base?: string; limits?: { files: number; bytes: number } }): Promise<CheckoutInspection> {
  const checkout = join(await realpath(environmentDirectory), 'workspace', 'checkout');
  let copy: string | undefined;
  try {
    if (await readConfined(checkout, '.git/objects/info/alternates', 65536).catch(error => { throw error; }) !== null) return { status: 'refused', code: 'CHECKOUT_ALTERNATES_PRESENT' };
    const head = (await readConfined(checkout, '.git/HEAD', 4096))?.toString('utf8').trim();
    if (!head) return { status: 'unavailable', code: 'CHECKOUT_HEAD_MISSING' };
    copy = await mkdtemp(join(options.scratch, 'inspect-'));
    const budget = options.limits ?? { files: 100000, bytes: 1024 * 1024 * 1024 };
    const total = budget.bytes;
    const run = (...args: string[]) => new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.pager=cat',
        '-c', 'log.showSignature=false', '-c', 'gpg.program=/bin/false', '-c', 'diff.external=', '-c', 'init.templateDir=', `--git-dir=${copy}`, ...args],
      { cwd: copy, timeout: 60000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', shell: false,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: copy!, XDG_CONFIG_HOME: copy!, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_ATTR_NOSYSTEM: '1', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout) => error ? reject(new Error('CHECKOUT_INSPECTION_GIT_FAILED')) : resolve(stdout.trim()));
    });
    await run('init', '--quiet', '--bare', '--template=', copy);
    for (const part of ['refs', 'objects']) await copyConfinedTree(checkout, `.git/${part}`, join(copy, part), budget);
    const packed = await readConfined(checkout, '.git/packed-refs', 16 * 1024 * 1024);
    const { writeFile } = await import('node:fs/promises');
    if (packed) await writeFile(join(copy, 'packed-refs'), packed, { mode: 0o600, flag: 'w' });
    await writeFile(join(copy, 'HEAD'), `${head}\n`, { mode: 0o600 });
    const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
    const resolved = await run('rev-parse', '--verify', 'HEAD^{commit}');
    const commits = (await run('log', '--no-show-signature', '--no-decorate', '--oneline', '-n', '50', 'HEAD')).split('\n').filter(Boolean);
    const diffStat = options.base ? await run('diff', '--no-ext-diff', '--no-textconv', '--stat', options.base, 'HEAD') : '';
    const config = (await readConfined(checkout, '.git/config', 65536))?.toString('utf8') ?? '';
    const remotes: { name: string; url: string }[] = [];
    let section: string | undefined;
    for (const line of config.split('\n')) {
      const header = /^\s*\[remote "([^"]+)"\]\s*$/.exec(line);
      if (header) { section = header[1]; continue; }
      if (/^\s*\[/.test(line)) { section = undefined; continue; }
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (section && url) remotes.push({ name: section, url: url[1]! });
    }
    return { status: 'observed', head: resolved, branch, commits, diffStat, remotes, alternates: false, copiedBytes: total - budget.bytes };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'CONFINED_PATH_UNSAFE') return { status: 'refused', code: 'CHECKOUT_PATH_UNSAFE' };
    if (code === 'CONFINED_FILE_TOO_LARGE' || code === 'CONFINED_TREE_TOO_LARGE') return { status: 'refused', code: 'CHECKOUT_TOO_LARGE' };
    return { status: 'unavailable', code: /^[A-Z_]+$/.test(code) ? code : 'CHECKOUT_INSPECTION_UNAVAILABLE' };
  } finally { if (copy) await rm(copy, { recursive: true, force: true }); }
}
