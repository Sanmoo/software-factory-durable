import { z } from 'zod';
import type { GitHubScope } from '../contracts/index.js';
import { InvalidGitHubObservation, type GitHubAccess } from '../platform/github/index.js';

// Ticket 23 (spec §10/§11.3): human feedback of a KNOWN own pull request, as facts — its submitted reviews, their inline review comments and
// the PR conversation comments. GET only, complete listings under one reduced `feedback-read` grant. This module never decides who is an
// operator, which request is relevant or what to repair: Control does.

export type FeedbackAuthor = { id: number; login: string; type: string };
/** One submitted review. `state` as GitHub reports it (`CHANGES_REQUESTED`, `APPROVED`, `COMMENTED`, `DISMISSED`, ...); a dismissed review is
 * reported with state `DISMISSED`. `commitId`: the head the review was submitted on. */
export type ReviewFact = {
  reviewId: number;
  author: FeedbackAuthor | null;
  state: string;
  commitId: string | null;
  submittedAt: string | null;
  body: string;
  url: string;
};
/** One inline review comment (diff comment) and the review it belongs to. */
export type ReviewCommentFact = {
  commentId: number;
  reviewId: number | null;
  author: FeedbackAuthor | null;
  body: string;
  path: string;
  line: number | null;
  commitId: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
};
/** One PR conversation comment (an issue comment of the pull request). `viaApp`: id of the GitHub App that performed it, else null. */
export type ConversationCommentFact = {
  commentId: number;
  url: string;
  author: FeedbackAuthor;
  body: string;
  createdAt: string;
  updatedAt: string;
  viaApp: number | null;
};
/** Complete listings at one instant (not an atomic snapshot); an unavailable read never proves the absence of feedback. */
export type FeedbackObservation =
  | {
      kind: 'observed';
      source: 'github-rest';
      observedAt: string;
      repository: string;
      number: number;
      reviews: ReviewFact[];
      reviewComments: ReviewCommentFact[];
      comments: ConversationCommentFact[];
      limitations: string[];
    }
  | { kind: 'unavailable'; source: 'github-rest'; observedAt: string; repository: string; code: string; waitSeconds?: number; nextStep: string };
export type FeedbackQuery = { repo: GitHubScope; number: number };

const id = z.number().int().positive().safe();
const user = z.object({ id, login: z.string().min(1).max(256), type: z.string().max(64) });
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const bodyOf = (value: string | null | undefined) => (value ?? '').slice(0, 65536);
const reviewSchema = z.object({
  id,
  user: user.nullable(),
  state: z.string().min(1).max(64),
  commit_id: sha.nullable().optional(),
  submitted_at: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  html_url: z.string().url(),
});
const reviewCommentSchema = z.object({
  id,
  pull_request_review_id: id.nullable().optional(),
  user: user.nullable(),
  body: z.string().nullable().optional(),
  path: z.string().min(1).max(4096),
  line: z.number().int().nullable().optional(),
  commit_id: sha.nullable().optional(),
  html_url: z.string().url(),
  created_at: z.string(),
  updated_at: z.string(),
});
const commentSchema = z.object({
  id,
  user,
  body: z.string().nullable().optional(),
  html_url: z.string().url(),
  created_at: z.string(),
  updated_at: z.string(),
  performed_via_github_app: z.object({ id }).nullable().optional(),
});

/** `readFeedback(pr)`: three complete GET listings of the own PR; any URL that is not of THIS pull request makes the whole read invalid. */
export function feedbackOperations(options: { github: GitHubAccess }) {
  return {
    async readFeedback(query: FeedbackQuery): Promise<FeedbackObservation> {
      if (!Number.isSafeInteger(query.number) || query.number <= 0) throw new Error('INVALID_PULL_REQUEST_REF');
      const repository = query.repo.repository;
      const pull = `https://github.com/${repository}/pull/${query.number}`.toLowerCase();
      const read = await options.github.read(query.repo, 'feedback-read', async session => {
        const reviews = z.array(reviewSchema).safeParse(await session.list(`/repos/${repository}/pulls/${query.number}/reviews`, { maxPages: 20 }));
        const inline = z.array(reviewCommentSchema).safeParse(await session.list(`/repos/${repository}/pulls/${query.number}/comments`, { maxPages: 20 }));
        const conversation = z.array(commentSchema).safeParse(await session.list(`/repos/${repository}/issues/${query.number}/comments`, { maxPages: 20 }));
        if (!reviews.success || !inline.success || !conversation.success) throw new InvalidGitHubObservation();
        const own = (url: string) => url.toLowerCase().startsWith(`${pull}#`) || url.toLowerCase().startsWith(`${pull}/`);
        if (![...reviews.data, ...inline.data, ...conversation.data].every(item => own(item.html_url))) throw new InvalidGitHubObservation();
        return {
          reviews: reviews.data.map(item => ({
            reviewId: item.id,
            author: item.user ? { id: item.user.id, login: item.user.login, type: item.user.type } : null,
            state: item.state,
            commitId: item.commit_id ?? null,
            submittedAt: item.submitted_at ?? null,
            body: bodyOf(item.body),
            url: item.html_url,
          })),
          reviewComments: inline.data.map(item => ({
            commentId: item.id,
            reviewId: item.pull_request_review_id ?? null,
            author: item.user ? { id: item.user.id, login: item.user.login, type: item.user.type } : null,
            body: bodyOf(item.body),
            path: item.path,
            line: item.line ?? null,
            commitId: item.commit_id ?? null,
            url: item.html_url,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
          })),
          comments: conversation.data
            .map(item => ({
              commentId: item.id,
              url: item.html_url,
              author: { id: item.user.id, login: item.user.login, type: item.user.type },
              body: bodyOf(item.body),
              createdAt: item.created_at,
              updatedAt: item.updated_at,
              viaApp: item.performed_via_github_app?.id ?? null,
            }))
            .sort((a, b) => a.commentId - b.commentId),
        };
      });
      if (!read.ok)
        return {
          kind: 'unavailable',
          source: 'github-rest',
          observedAt: read.observedAt,
          repository,
          code: read.code,
          ...(read.waitSeconds !== undefined ? { waitSeconds: read.waitSeconds } : {}),
          nextStep: `Pull request feedback unavailable; nothing is concluded. ${read.nextStep}`,
        };
      return {
        kind: 'observed',
        source: 'github-rest',
        observedAt: read.observedAt,
        repository,
        number: query.number,
        ...read.value,
        limitations: [
          'Complete listings at one instant, not an atomic snapshot.',
          'Feedback is evidence; authorization, relevance and repairs are decided by the Control.',
        ],
      };
    },
  };
}
