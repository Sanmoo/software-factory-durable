// Spec #68 §10 (ticket #80): the local details a Triager attempt leaves under `<root>/triage/a/<attempt>`: its bootstrap (which holds the
// activation prompt, so the Ticket text) and its session file. Read only for the explicit transcript command and for usage; removed whole
// by the retention or an explicit cleanup. An attempt is named by its reference, never by a path: a session an attempt left without
// reporting it (the agent was killed) is found all the same.
import { constants } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { triageAttemptPattern } from '../contracts/index.js';
import { join } from 'node:path';
import { sessionUsage, type SessionUsage } from './session-usage.js';
import { triagerAttemptDirectory } from './triager.js';

const maxUsageBytes = 64 * 1024 * 1024;
type Found = { state: 'found'; files: { path: string; bytes: number }[] } | { state: 'absent' } | { state: 'unavailable'; code: string };

const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
/** The session files of an attempt, oldest first (the SDK names them by their start instant). Only regular files directly there. */
async function sessionsOf(root: string, attempt: string): Promise<Found> {
  if (!triageAttemptPattern.test(attempt) || attempt.length > 64) return { state: 'unavailable', code: 'TRIAGE_ATTEMPT_INVALID' };
  const directory = join(triagerAttemptDirectory(root, attempt), 'profile', 'sessions');
  try {
    const files: { path: string; bytes: number }[] = [];
    for (const name of (await readdir(directory)).filter(item => item.endsWith('.jsonl')).sort()) {
      const info = await lstat(join(directory, name));
      if (info.isFile()) files.push({ path: join(directory, name), bytes: info.size });
    }
    return files.length ? { state: 'found', files } : { state: 'absent' };
  } catch (error) {
    return missing(error) ? { state: 'absent' } : { state: 'unavailable', code: 'TRIAGE_SESSION_UNREADABLE' };
  }
}
/** `length` bytes of `path` from `offset`, without following a link. */
async function readRange(path: string, offset: number, length: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close().catch(() => {});
  }
}
/** The end of the last whole UTF-8 character of a page that does not reach the end of the file. */
function characterBoundary(data: Buffer): number {
  let end = data.length;
  while (end > 0 && (data[end - 1]! & 0xc0) === 0x80) end--;
  if (end === 0) return data.length;
  const lead = data[end - 1]!;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return end - 1 + width <= data.length ? data.length : end - 1;
}

/** The detail store of the Triager attempts of one installation root. */
export function createTriagerDetails(root: string) {
  return {
    async inventory(attempt: string) {
      const found = await sessionsOf(root, attempt);
      if (found.state !== 'found') return found;
      return { state: 'listed' as const, sessions: found.files.length, bytes: found.files.reduce((sum, file) => sum + file.bytes, 0) };
    },
    /** One page of the attempt's latest session file. */
    async read(input: { attempt: string; offset: number; limit: number }) {
      const found = await sessionsOf(root, input.attempt);
      if (found.state !== 'found') return found;
      const file = found.files.at(-1)!;
      try {
        const data = await readRange(file.path, input.offset, Math.max(0, Math.min(input.limit, file.bytes - input.offset)));
        const end = input.offset + data.length >= file.bytes ? data.length : characterBoundary(data);
        return { state: 'read' as const, text: data.subarray(0, end).toString('utf8'), nextOffset: input.offset + end, bytes: file.bytes };
      } catch {
        return { state: 'unavailable' as const, code: 'TRIAGE_SESSION_UNREADABLE' };
      }
    },
    async usage(attempt: string): Promise<SessionUsage> {
      const found = await sessionsOf(root, attempt);
      if (found.state === 'absent') return { state: 'lost', code: 'TRIAGE_SESSION_ABSENT' };
      if (found.state !== 'found') return { state: 'unavailable', code: found.code };
      const file = found.files.at(-1)!;
      if (file.bytes > maxUsageBytes) return { state: 'unavailable', code: 'TRIAGE_SESSION_TOO_LARGE' };
      try {
        // No hash was ever recorded for a Triager session: it is read as it is, never as verified.
        return { ...sessionUsage(await readRange(file.path, 0, file.bytes), attempt), integrity: 'unverified' };
      } catch {
        return { state: 'unavailable', code: 'TRIAGE_SESSION_UNREADABLE' };
      }
    },
    async remove(attempt: string) {
      if (!triageAttemptPattern.test(attempt) || attempt.length > 64) return { state: 'failed' as const, code: 'TRIAGE_ATTEMPT_INVALID' };
      const directory = triagerAttemptDirectory(root, attempt);
      try {
        await lstat(directory);
      } catch (error) {
        return missing(error) ? { state: 'absent' as const } : { state: 'failed' as const, code: 'TRIAGE_DETAILS_UNREADABLE' };
      }
      try {
        await rm(directory, { recursive: true, force: true });
        return { state: 'removed' as const };
      } catch {
        return { state: 'failed' as const, code: 'TRIAGE_DETAILS_REMOVAL_FAILED' };
      }
    },
  };
}
