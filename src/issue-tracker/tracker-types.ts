// Common tracker contract and GitHub tracker types, re-exported by the module's index (Jira's own types are in jira-types.ts).
import type { AccessDiagnostic, GitHubScope } from '../contracts/index.js';
import type { TokenRevocation } from '../platform/github/index.js';
import type {
  JiraAccessDiagnostic,
  JiraBlockersObservation,
  JiraCandidateObservation,
  JiraCommentAuthor,
  JiraCommentListing,
  JiraCommentResult,
  JiraInputCursor,
  JiraInputsObservation,
  JiraQuestionSearch,
  JiraTicketObservation,
  JiraTicketRef,
  JiraTrackerScope,
} from './jira-types.js';

/** Origin of GitHub Tickets: one configured repository plus its effective entry label (shape unchanged since v1). */
export type GitHubTrackerScope = GitHubScope & { label: string };
/** Scope of a Ticket origin, discriminated by provider (the GitHub variant carries no tag: persisted/configured shapes stay unchanged). */
export type TrackerScope = GitHubTrackerScope | JiraTrackerScope;
/** Repository readable ONLY for native dependency reads: never a Ticket origin, never executable. */
export type DependencyScope = GitHubScope & { role: 'dependency-only' };
/** Qualified, stable GitHub identity of a Ticket; number/url are presentation, never identity on their own. Persisted as-is (storage format 2). */
export type GitHubTicketRef = { tracker: 'github'; repository: string; repositoryId: number; issueId: number; nodeId: string; number: number; url: string };
/** Identity of a Ticket at its origin, discriminated by `tracker`. */
export type TicketRef = GitHubTicketRef | JiraTicketRef;
export type TrackerKind = TicketRef['tracker'];
export type TrackerUnavailable = {
  kind: 'unavailable';
  source: 'github-rest';
  observedAt: string;
  repository: string;
  completeness: 'incomplete';
  code: string;
  waitSeconds?: number;
  nextStep: string;
};
/** A listing never admits Work; an unavailable listing never proves the absence of candidates. */
export type CandidateObservation =
  | {
      kind: 'observed';
      source: 'github-rest';
      observedAt: string;
      repository: string;
      repositoryId: number;
      label: string;
      completeness: 'complete';
      candidates: GitHubTicketRef[];
      limitations: string[];
    }
  | TrackerUnavailable;
/** Entry facts only: no body/spec ingestion and no persistent authorization. */
export type TicketObservation =
  | {
      kind: 'observed';
      source: 'github-rest';
      observedAt: string;
      completeness: 'complete';
      ticket: GitHubTicketRef;
      state: 'open' | 'closed';
      stateReason: string | null;
      labels: { id: number; name: string }[];
      pullRequest: boolean;
    }
  | TrackerUnavailable;

/** One issue reached through native blocked_by; identity = GitHub issue id (globally unique) plus its repository. */
export type DependencyNode = {
  issueId: number;
  nodeId: string;
  repository: string;
  repositoryId: number | null;
  number: number;
  url: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  /** 'read' = issue and ALL its blocked_by pages read under its own repository grant; 'edge-only' = its own blockers are unknown. */
  access: 'read' | 'edge-only';
  repositoryRole: 'executable' | 'dependency-only' | 'not-configured';
  blockedBy: number[] | null;
};
export type DependencyProblem = { code: string; issueId?: number; repository?: string; observedCode?: string; waitSeconds?: number; nextStep: string };
/** Principal/scope of each read used (installation, repository, purpose, permissions); never a token. */
export type DependencyPrincipal = {
  installationId: number;
  repository: string;
  repositoryId: number | null;
  role: 'executable' | 'dependency-only';
  purpose: 'dependency-read';
  permissions: Readonly<Record<string, 'read'>>;
};
/**
 * Reachable native blocked_by graph from one Ticket. Satisfaction (own cycles/merge) is NOT decided here. Any problem makes it incomplete;
 * a complete graph is not an atomic remote snapshot and does not certify the absence of relations GitHub does not show.
 */
export type DependencyGraphObservation = {
  kind: 'observed';
  source: 'github-rest';
  observedAt: string;
  root: GitHubTicketRef;
  completeness: 'complete' | 'incomplete';
  principals: DependencyPrincipal[];
  nodes: DependencyNode[];
  problems: DependencyProblem[];
  limitations: string[];
};

/** Author of a comment as GitHub reports it (id is the identity; login/type are evidence for authorization by the Control). */
export type CommentAuthorRef = { id: number; login: string; type: string };
/** One issue comment. `viaApp`: id of the GitHub App that performed it (null for human/other comments). Never interpreted here. */
export type TrackerComment = {
  commentId: number;
  nodeId: string;
  url: string;
  author: CommentAuthorRef;
  body: string;
  createdAt: string;
  updatedAt: string;
  viaApp: number | null;
};
/** Comments after `cursor` (ascending id), from a COMPLETE listing only; an unavailable read never proves the absence of comments. */
export type InputsObservation =
  | {
      kind: 'observed';
      source: 'github-rest';
      observedAt: string;
      ticket: GitHubTicketRef;
      completeness: 'complete';
      comments: TrackerComment[];
      cursor: number | null;
      limitations: string[];
    }
  | TrackerUnavailable;
/**
 * One comment of the Ticket issue as a fact for whoever composes the Ticket text (spec #68 §9). `authorAssociation`: GitHub's
 * `author_association` as sent (`NONE` when absent); `ownApp`: performed by THIS installation's App as its bot. Never filtered here.
 */
export type TicketCommentFact = TrackerComment & { authorAssociation: string; ownApp: boolean };
/** Every comment of the Ticket issue (ascending id), from a COMPLETE listing only; an unavailable read never proves there are none. */
export type TicketCommentsObservation =
  | {
      kind: 'observed';
      source: 'github-rest';
      observedAt: string;
      ticket: GitHubTicketRef;
      completeness: 'complete';
      comments: TicketCommentFact[];
      limitations: string[];
    }
  | TrackerUnavailable;
/** Comments of THIS installation's App carrying the stable marker of the Question; several candidates are reported, never chosen. */
export type QuestionSearch =
  | {
      kind: 'observed';
      source: 'github-rest';
      observedAt: string;
      completeness: 'complete';
      candidates: { commentId: number; url: string; createdAt: string }[];
      limitations: string[];
    }
  | TrackerUnavailable;
/** Concrete authorized Question text; the adapter prepends the stable marker for `questionId`. No arbitrary endpoint or label/state change. */
export type QuestionComment =
  | { kind: 'question'; questionId: string; body: string }
  /** Ticket 23: the controller's reply to a `/factory` command (marker `software-factory:reply:<id>`), on the Work's Ticket. */
  | { kind: 'reply'; replyId: string; body: string };
/** Identity of the publication effect already persisted by the Control (correlation, not external idempotency). */
export type CommentEffect = { effectId: string; questionId: string } | { effectId: string; replyId: string };
/** Known success, known failure (nothing was created) or unknown outcome (the comment may exist: discover before republishing). */
/** `revocation`: what happened to the single-use write credential after the attempt (never claimed when not observed). */
export type CommentResult = (
  | { kind: 'published'; observedAt: string; commentId: number; url: string; createdAt: string }
  | { kind: 'failed'; observedAt: string; code: string; waitSeconds?: number; nextStep: string }
  | { kind: 'unknown'; observedAt: string; code: string; nextStep: string }
) & { revocation?: TokenRevocation };

/** Author of an input, discriminated by provider (GitHub keeps its untagged `{id, login, type}`). */
export type TrackerCommentAuthor = CommentAuthorRef | JiraCommentAuthor;
/** Read position of inputs, discriminated by provider: GitHub = highest comment id (unchanged), Jira = {@link JiraInputCursor}. */
export type InputCursor = number | JiraInputCursor;

/** Per-provider shapes of the common tracker contract. A provider never simulates another's capability (no GitHub remote links). */
export type TrackerContracts = {
  github: {
    scope: GitHubTrackerScope;
    ticket: GitHubTicketRef;
    candidates: CandidateObservation;
    observation: TicketObservation;
    blockers: DependencyGraphObservation;
    inputs: InputsObservation;
    cursor: number;
    search: QuestionSearch;
    comments: TicketCommentsObservation;
    result: CommentResult;
    access: AccessDiagnostic;
  };
  jira: {
    scope: JiraTrackerScope;
    ticket: JiraTicketRef;
    candidates: JiraCandidateObservation;
    observation: JiraTicketObservation;
    blockers: JiraBlockersObservation;
    inputs: JiraInputsObservation;
    cursor: JiraInputCursor;
    search: JiraQuestionSearch;
    comments: JiraCommentListing;
    result: JiraCommentResult;
    access: JiraAccessDiagnostic;
  };
};

/**
 * Common contract of a Ticket origin, typed per provider: the Control selects the adapter by the Ticket's persisted `tracker`, never by the
 * destination repository. Defaults to GitHub so existing consumers read unchanged.
 */
export interface IssueTracker<P extends TrackerKind = 'github'> {
  checkAccess(scope: TrackerContracts[P]['scope'] | (P extends 'github' ? DependencyScope : never)): Promise<TrackerContracts[P]['access']>;
  listCandidates(scope: TrackerContracts[P]['scope']): Promise<TrackerContracts[P]['candidates']>;
  readTicket(ticket: TrackerContracts[P]['ticket']): Promise<TrackerContracts[P]['observation']>;
  /** GitHub: native blocked_by graph. Jira: visible "is blocked by" neighbours. Neither substitutes for the other. */
  readDependencyGraph(ticket: TrackerContracts[P]['ticket']): Promise<TrackerContracts[P]['blockers']>;
  readInputs(ticket: TrackerContracts[P]['ticket'], cursor: TrackerContracts[P]['cursor'] | null): Promise<TrackerContracts[P]['inputs']>;
  findQuestion(ticket: TrackerContracts[P]['ticket'], questionId: string): Promise<TrackerContracts[P]['search']>;
  postComment(ticket: TrackerContracts[P]['ticket'], comment: QuestionComment, effect: CommentEffect): Promise<TrackerContracts[P]['result']>;
  /** Ticket 23: comments of THIS installation's App carrying the reply marker; several candidates are reported, never chosen. */
  findReply?(ticket: TrackerContracts[P]['ticket'], replyId: string): Promise<TrackerContracts[P]['search']>;
  /**
   * Spec #68 §9: every comment of the Ticket with what the origin says of its author, for whoever composes the Ticket text. GitHub only
   * (the Jira adapter serves it by `JiraComments.listComments`); a tracker without it delivers no Ticket text and no Work starts on it.
   */
  readTicketComments?(ticket: TrackerContracts[P]['ticket']): Promise<TrackerContracts[P]['comments']>;
}
