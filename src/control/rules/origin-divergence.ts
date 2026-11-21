import { questionLimits } from './questions.js';

// Pure rules of v2 ticket 13, Operator decision 8 of 2026-11-21 (amends V2-11 where the sandbox keeps no disk; a sandbox with a
// persistent disk keeps MVP §10.1). At a resume, the Work branch on `origin` may no longer continue the commit a preservation gate
// confirmed. Rewritten history: the remote is followed by a substitute session on one operational recovery, without a Question. Branch
// absent: an ordinary Question, restart from the base or end the Work; the answer decides. No I/O, clock or randomness.

export const branchAbsentKeywords = Object.freeze({ restart: 'restart', end: 'end' });
const control = /[\u0000-\u001f\u007f`]/g;
const line = (text: string, max: number) => text.replace(control, ' ').trim().slice(0, max);

/** The ordinary Question of a Work whose branch is gone from `origin` at a resume. */
export function branchAbsentQuestion(input: { workId: string; repository: string; branch: string; base: string; confirmed: string }): { question: string; context: string } {
  const question = [`Work ${input.workId}: the branch ${line(input.branch, 200)} of ${line(input.repository, 140)} no longer exists on origin. The Factory confirmed commit ` +
      `${input.confirmed} on it before the previous environment ended; this environment keeps no disk, so the Factory holds no other copy of that work.`,
    `Nothing is started until you answer. Reply exactly "${branchAbsentKeywords.restart}" to restart the Work from the tip of the base ${line(input.base, 200)} (a new session ` +
      `implements the Ticket again; the earlier commits are not used), or exactly "${branchAbsentKeywords.end}" to end the Work (it is cancelled; nothing on GitHub is undone). ` +
      'To keep the earlier work instead, push the branch back yourself and reply anything else: the branch is then read again. Any other reply decides nothing and is asked again.',
  ].join('\n').slice(0, questionLimits.question);
  const context = [`Repository: ${line(input.repository, 140)}. Work branch: ${line(input.branch, 200)}. Base: ${line(input.base, 200)}.`,
    `Last commit the Factory confirmed on the Work branch: ${input.confirmed}.`, 'Observed by the Factory\'s own read of origin at the resume: the branch is absent.'].join('\n').slice(0, questionLimits.context);
  return { question, context };
}

export type BranchAbsentAnswer = 'restart' | 'end' | 'not-authorized';
/** Exact answers only: anything else decides nothing. */
export function branchAbsentAnswer(text: string): BranchAbsentAnswer {
  const answer = text.trim();
  return answer === branchAbsentKeywords.restart ? 'restart' : answer === branchAbsentKeywords.end ? 'end' : 'not-authorized';
}
