import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Jira ticket 01: the Jira API token of a configured site, read on the host only when a Jira request needs it (never on the YAML v1 path,
 * never by the configuration check, never handed to Control, prompts or the agent). Same discipline as the GitHub App key: private
 * directories, no symlink followed, a private regular file of this user with one link and a bounded size.
 */
export async function readJiraToken(root: string, tokenFile: string): Promise<string> {
  for (const path of [root, join(root, 'credentials')]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error('UNSAFE_CREDENTIAL_PATH');
  }
  const file = await open(join(root, tokenFile), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.nlink !== 1 || info.size > 4096)
      throw new Error('UNSAFE_CREDENTIAL_FILE');
    const token = (await file.readFile('utf8')).trim();
    if (!token || /\s/.test(token)) throw new Error('INVALID_JIRA_TOKEN');
    return token;
  } finally {
    await file.close();
  }
}
