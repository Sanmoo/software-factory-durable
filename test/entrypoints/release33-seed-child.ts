import { chmod, rm } from 'node:fs/promises';
import { storageWithPendingQuestion, writeFormatOne } from '../control/upgrade-fixture.js';

// TEST ONLY child of the ticket 33 real recipe, launched under the installation's canonical-storage flock. The CURRENT Control produces the
// state through its public operations with doubled execution/GitHub ports (no VM, worker, model or network): Work #3 waits on a published open
// Question, Work #4 is queued, then pause and clean stop. That exact state is re-expressed as a pre-ticket-33 (format 1) storage through the
// public Pi Durable API (writeFormatOne). The recipe then proves the REAL previous release operates it (its own controller and CLI).
const [scratch, storagePath] = process.argv.slice(2) as [string, string];
const source = `${scratch}/seed-source.sqlite`;
const { waiting, list } = await storageWithPendingQuestion(source);
await writeFormatOne(source, storagePath);
await chmod(storagePath, 0o600);
for (const suffix of ['', '-wal', '-shm']) await rm(`${source}${suffix}`, { force: true });
console.log(
  JSON.stringify({
    works: list.works.map(work => ({
      work_id: work.work_id,
      ticket: work.ticket.number,
      queue: work.queue,
      impediments: work.impediments.map(item => item.code),
    })),
    waiting: waiting.work_id,
    questions: waiting.questions,
  }),
);
