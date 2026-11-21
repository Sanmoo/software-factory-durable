import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Session } from './store.js';
import { works, type WorkRecord } from './admission.js';
import { releaseReservation, settleCancelled, slots } from './execution.js';
import { applyRecoveryRequest } from './recovery-request.js';
import { questions, questionSha256 } from './questions.js';
import { branchAbsentAnswer, branchAbsentKeywords, branchAbsentQuestion } from '../rules/origin-divergence.js';
import { validateQuestionRequest } from '../rules/questions.js';
import type { ExecutionView } from '../types.js';

// v2 ticket 13, Operator decision 8 of 2026-11-21 (amends V2-11 where the sandbox keeps no disk): what Control records and decides when,
// at a resume, the Work branch on `origin` no longer continues the commit a preservation gate confirmed. Every function is ONE commit
// on the reserved Execution that found it, BEFORE any boot: nothing was started and nothing is written to the repository.

/** The reserved Execution never ran: Slot and reservation are released and the Work keeps its queue position (the body of `releaseBeforeStart`). */
function release(work: WorkRecord, execution: ExecutionView, occupancy: { held: Record<string, string> }, code: string, nextStep: string, at: string) {
  delete occupancy.held[execution.executionId];
  execution.state = 'released';
  execution.slot = { ...execution.slot, held: false, releasedAt: at };
  execution.held = { code, phase: execution.dispatch.phase, at, nextStep };
  releaseReservation(work, execution, at);
  work.queue = { ...work.queue, pending: true };
  work.history.push({ at, event: 'execution-released', origin: 'controller-dispatch', executionId: execution.executionId, detail: code });
  settleCancelled(work, at);
}
const reserved = (work: WorkRecord | null, executionId: string) => work?.execution && work.execution.executionId === executionId && work.execution.state === 'reserved' && !work.execution.start ? work.execution : null;

/**
 * Rewritten history: the remote is followed. An Execution already charged to an operational recovery goes on (`followed`); any other is
 * released before its start and the Work comes back through the queue as ONE operational recovery (`requeued`), whose Execution then
 * follows. No Question. An exhausted recovery budget blocks by the MVP budget rule, as for any recovery.
 */
export async function followRewrittenHistory(session: Session, work_id: string, executionId: string, input: { branch: string; confirmed: string; current: string }) {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const execution = reserved(work, executionId);
    if (!work || !execution) return 'stale' as const;
    const at = new Date().toISOString();
    const known = work.originDivergence;
    const repeated = known?.kind === 'history-rewritten' && known.branch === input.branch && known.confirmed === input.confirmed && known.current === input.current;
    work.originDivergence = { kind: 'history-rewritten', at: repeated ? known.at : at, branch: input.branch, confirmed: input.confirmed, current: input.current, executionId };
    if (!repeated) work.history.push({ at, event: 'origin-rewrite-followed', origin: 'controller-dispatch', executionId, detail: `${input.branch}:${input.confirmed}->${input.current}` });
    if (execution.charge?.kind === 'recovery') return 'followed' as const;
    release(work, execution, await tx.doc(slots), 'ORIGIN_HISTORY_REWRITTEN',
      `The history of ${input.branch} on origin was rewritten (${input.confirmed} is not an ancestor of ${input.current}); the Factory follows the remote with a substitute session on one operational recovery.`, at);
    applyRecoveryRequest(work, { executionId, code: 'ORIGIN_HISTORY_REWRITTEN', at, reason: `origin-history-rewritten:${input.confirmed}->${input.current}` });
    return 'requeued' as const;
  }, BACKGROUND_CONTEXT);
}

/**
 * Branch absent: an ordinary Question (restart from the base, or end the Work). `asked`/`waiting`/`end`: the Execution was released
 * before its start; `restart`: the accepted answer authorized restarting from the base and this Execution goes on. An answer that is
 * neither keyword decides nothing: the branch was read again by the caller, it is still absent, and a new Question is asked.
 */
export async function settleBranchAbsent(session: Session, work_id: string, executionId: string, input: { branch: string; confirmed: string; base: string }):
  Promise<{ kind: 'asked' | 'waiting' | 'end'; questionId: string } | { kind: 'restart'; questionId: string } | { kind: 'stale' }> {
  return session.commit(async tx => {
    const work = (await tx.doc(works, work_id, null)).work;
    const execution = reserved(work, executionId);
    if (!work || !execution) return { kind: 'stale' as const };
    const at = new Date().toISOString();
    const occupancy = await tx.doc(slots);
    const known = work.originDivergence?.kind === 'branch-absent' && work.originDivergence.branch === input.branch && work.originDivergence.confirmed === input.confirmed ? work.originDivergence : null;
    if (known?.state === 'awaiting-answer') {
      const question = (await tx.doc(questions, known.questionId, null)).question;
      if (!question || question.state !== 'answered' || !question.answer) {
        release(work, execution, occupancy, 'ORIGIN_BRANCH_ABSENT', `Question ${known.questionId} is not answered yet.`, at);
        return { kind: 'waiting' as const, questionId: known.questionId };
      }
      const decision = branchAbsentAnswer(question.answer.text);
      known.state = decision === 'restart' ? 'restart-authorized' : decision === 'end' ? 'end-authorized' : 'not-authorized';
      known.resolvedAt = at;
      work.history.push({ at, event: 'origin-branch-absent-resolved', origin: 'controller-dispatch', executionId, detail: `${known.questionId}:${decision}` });
    }
    if (known?.state === 'restart-authorized') return { kind: 'restart' as const, questionId: known.questionId };
    if (known?.state === 'end-authorized') {
      release(work, execution, occupancy, 'ORIGIN_BRANCH_ABSENT', `The answer to Question ${known.questionId} ended the Work.`, at);
      return { kind: 'end' as const, questionId: known.questionId };
    }
    const questionId = randomUUID();
    const text = branchAbsentQuestion({ workId: work_id, repository: work.repository.repository, branch: input.branch, base: input.base, confirmed: input.confirmed });
    if (!validateQuestionRequest({ questionId, question: text.question, context: text.context }).valid) throw new Error('BRANCH_ABSENT_QUESTION_INVALID');
    const document = await tx.doc(questions, questionId, null);
    document.question = { questionId, workId: work_id, executionId, invocationId: execution.invocationId, recordedAt: at, recordedFrom: 'controller-divergence',
      content: { question: text.question, context: text.context, sha256: questionSha256(text.question, text.context), reference: { workId: work_id, id: questionId } },
      destination: { kind: 'issue', ticket: work.ticket }, state: 'open',
      publication: { effectId: randomUUID(), state: 'intended', updatedAt: at, attempts: [], comment: null, nextStep: null }, answer: null, ignored: [] };
    work.questions = [...(work.questions ?? []), questionId];
    work.originDivergence = { kind: 'branch-absent', at, branch: input.branch, confirmed: input.confirmed, questionId, executionId, state: 'awaiting-answer', resolvedAt: null };
    work.impediments.push({ code: 'QUESTION_PENDING', scope: 'work', since: at, questionId, nextStep: `The Work branch ${input.branch} no longer exists on origin. Answer with ` +
      `\`/factory answer ${questionId} ${branchAbsentKeywords.restart}\` (restart from the base) or \`/factory answer ${questionId} ${branchAbsentKeywords.end}\` (end the Work) on the Ticket, ` +
      `or locally with \`factory answer ${questionId} ${branchAbsentKeywords.restart}|${branchAbsentKeywords.end}\`.` });
    work.history.push({ at, event: 'question-recorded', origin: 'controller-dispatch', questionId, detail: `origin-branch-absent:${input.confirmed}` });
    work.history.push({ at, event: 'origin-branch-absent-asked', origin: 'controller-dispatch', executionId, detail: `${input.branch}:${input.confirmed}:${questionId}` });
    release(work, execution, occupancy, 'ORIGIN_BRANCH_ABSENT', `The Work branch ${input.branch} no longer exists on origin; Question ${questionId} asks whether to restart from the base or end the Work.`, at);
    return { kind: 'asked' as const, questionId };
  }, BACKGROUND_CONTEXT);
}
