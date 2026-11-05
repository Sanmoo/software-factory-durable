import { access, constants, statfs } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

export async function canAccess(path: string, mode = constants.R_OK): Promise<boolean> {
  try { await access(path, mode); return true; } catch { return false; }
}

export function versionOf(command: string): string | undefined {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' },
  });
  if (result.status !== 0 || result.error) return undefined;
  // Never return arbitrary command output or the inherited environment.
  return result.stdout.split('\n')[0]?.match(/\b\d+(?:\.\d+)*(?:[-+][\w.-]+)?\b/)?.[0];
}

export async function inspectStorage(path: string) {
  try {
    const fs = await statfs(path, { bigint: true });
    return { type: `0x${fs.type.toString(16)}`, availableBytes: (fs.bavail * fs.bsize).toString(),
      // Known remote/ephemeral filesystems cannot satisfy the persistent local storage contract.
      unsuitable: [0x6969n, 0xff534d42n, 0x01021994n, 0x858458f6n].includes(fs.type) };
  } catch { return undefined; }
}
