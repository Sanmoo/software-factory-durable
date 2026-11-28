// Child controller of triage-publication-crash.test.ts: a real Control + Pi Durable/SQLite over a storage whose Triage
// request is already `publishing`. Its first tracker write (the Verdict comment) reaches the doubled GitHub, whose state is persisted to
// `github.json` FIRST, as GitHub would keep it; the answer is never returned, so nothing of the result is recorded. It prints CUT and
// waits to be SIGKILLed.
import { readFileSync, writeFileSync } from 'node:fs';
import { openControl } from '../../src/control/index.js';
import type { TicketSource } from '../../src/control/types.js';
import { githubDoubles, manualClock, scope, type Remote } from './doubles.js';

const dir = process.argv[2]!;
const remote = JSON.parse(readFileSync(`${dir}/github.json`, 'utf8')) as Remote;
const sources = JSON.parse(readFileSync(`${dir}/sources.json`, 'utf8')) as TicketSource[];
const github = githubDoubles(remote);
let cut = false;
const write = github.tracker.writeTriage!.bind(github.tracker);
github.tracker.writeTriage = async (...args) => {
  await write(...args);
  writeFileSync(`${dir}/github.json`, JSON.stringify(remote));
  cut = true;
  return new Promise<never>(() => {});
};
const time = manualClock();
const control = await openControl({
  storagePath: `${dir}/control.sqlite`,
  runtimeInventory: 'empty',
  access: { tracker: github.tracker, repository: github.repository, repositories: [scope], sources },
  polling: { intervalSeconds: 60, clock: time.clock },
});
void control.run(new AbortController().signal);
while (!cut) {
  if (time.isSleeping()) time.advance();
  await new Promise(resolve => setTimeout(resolve, 5));
}
process.stdout.write('CUT\n');
await new Promise(() => {});
