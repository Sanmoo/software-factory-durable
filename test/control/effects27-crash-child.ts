// Child controller of effects27-crash.test.ts: real Control + Pi Durable/SQLite + Records with the file-backed host double (recovery-doubles).
// It runs until the requested external-effect cut, prints CUT and waits to be SIGKILLed:
//   question-lost  the Builder PRESERVED its ask_user request in Records and dies with the controller before notifying it (lost ACK);
//   question-post  the Question was recorded and its comment POST reached the (doubled) GitHub, but the controller dies before the result
//                  commit; the comment store is persisted to `github.json` FIRST, as GitHub would keep it.
import { writeFileSync } from 'node:fs';
import { openControl } from '../../src/control/index.js';
import { githubDoubles, manualClock, remoteIssue, scope, type Remote } from './doubles.js';
import { readHost, recoveryDoubles, type RecoveryScript } from './recovery-doubles.js';

const [dir, mode] = [process.argv[2]!, process.argv[3]!];
const questionIds = { 'question-lost': '0b9c6a52-3d3e-4c8f-9a51-000000000271', 'question-post': '0b9c6a52-3d3e-4c8f-9a51-000000000272' } as const;
const scripts: Record<string, RecoveryScript[]> = {
  'question-lost': [
    { kind: 'ask-preserved', questionId: questionIds['question-lost'], question: 'Which port should the service use?', context: 'Checked the docs.' },
  ],
  'question-post': [{ kind: 'ask', questionId: questionIds['question-post'], question: 'Which database?', hangAfterAck: true }],
};
if (!scripts[mode]) throw new Error('UNKNOWN_MODE');
let cut = false;
const doubles = recoveryDoubles(dir, scripts[mode]!);
const remote: Remote = { pulls: {}, issues: [remoteIssue(3)] };
const github = githubDoubles(remote);
if (mode === 'question-post') {
  const post = github.tracker.postComment.bind(github.tracker);
  github.tracker.postComment = async (...args) => {
    await post(...args);
    // The POST landed: GitHub keeps the comment whatever happens to this process. The answer is never returned to the desk.
    writeFileSync(`${dir}/github.json`, JSON.stringify({ comments: remote.comments ?? {}, posts: 1 }));
    cut = true;
    return new Promise<never>(() => {});
  };
}
const time = manualClock();
const control = await openControl({
  storagePath: `${dir}/control.sqlite`,
  runtimeInventory: 'empty',
  execution: doubles.ports,
  access: { tracker: github.tracker, repository: github.repository, repositories: [scope], operators: ['operator-one'] },
  polling: { intervalSeconds: 60, clock: time.clock },
});
void control.run(new AbortController().signal);
const reached = () => cut || (mode === 'question-lost' && readHost(dir).log.some(item => item.kind === 'question-preserved'));
for (;;) {
  if (reached()) break;
  if (time.isSleeping()) time.advance();
  await new Promise(resolve => setTimeout(resolve, 5));
}
process.stdout.write('CUT\n');
await new Promise(() => {});
