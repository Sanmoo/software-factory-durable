// Jira Cloud contract types of the issue tracker (spec §1-§5), re-exported by the module's index. Types only: the adapter is jira.ts.

/** Origin of Jira Tickets: one project of one configured Jira Cloud site, filtered by its entry label (identities by ID only). */
export type JiraTrackerScope = { tracker: 'jira'; siteId: string; url: string; projectId: string; label: string };
/** Stable Jira identity of a Ticket: (siteId, issueId). `key` (e.g. PAG-42) and `url` are presentation only: a key change never makes another Ticket. */
export type JiraTicketRef = {
  tracker: 'jira';
  siteId: string;
  issueId: string;
  key: string;
  url: string;
  /** Absent on Jira: reading a GitHub-only field without narrowing on `tracker` yields `undefined`, never a borrowed GitHub identity. */
  repository?: never;
  repositoryId?: never;
  nodeId?: never;
  number?: never;
};

/*
 * Jira Cloud contracts (spec §1-§4). Facts only: listing, re-read, visible blockers, inputs and comments; never admission or authorization.
 * Ticket 01 fixes the shapes the Control routes by; tickets 03 (discovery/revalidation), 05/06 (comments/inputs) and 08/09 (remote links)
 * fill the REST behaviour behind them.
 */
export type JiraUnavailable = {
  kind: 'unavailable';
  source: 'jira-rest';
  observedAt: string;
  siteId: string;
  completeness: 'incomplete';
  code: string;
  waitSeconds?: number;
  nextStep: string;
};
/** A Jira write that did not succeed: `failed` = certainly not applied (Jira refused, or nothing was sent); `unknown` = it may have been applied. */
export type JiraWriteNotApplied =
  | { kind: 'failed'; observedAt: string; code: string; waitSeconds?: number; nextStep: string }
  | { kind: 'unknown'; observedAt: string; code: string; nextStep: string };
/** Jira's status category keys (`undefined` is Jira's own "No Category" key); any other key read is unverifiable, never a status. */
export const jiraStatusCategories = ['new', 'indeterminate', 'done', 'undefined'] as const;
export type JiraStatusCategory = (typeof jiraStatusCategories)[number];
/** One JQL search (project + label, all pages): candidates only, never authorization; each is re-read by ID before admission. */
export type JiraCandidateObservation =
  | {
      kind: 'observed';
      source: 'jira-rest';
      observedAt: string;
      siteId: string;
      projectId: string;
      label: string;
      completeness: 'complete';
      candidates: JiraTicketRef[];
      limitations: string[];
    }
  | JiraUnavailable;
/** Re-read by ID: entry facts. `components: null` = the list was not read completely (never "zero routes"). */
export type JiraTicketObservation =
  | {
      kind: 'observed';
      source: 'jira-rest';
      observedAt: string;
      completeness: 'complete';
      ticket: JiraTicketRef;
      projectId: string;
      labels: string[];
      components: { id: string; name: string }[] | null;
      statusCategory: JiraStatusCategory;
      /** Jira ticket 03: the Card's summary (null when absent) and its links as observed (`null` = not read completely: never "no link"). */
      summary: string | null;
      links: JiraLink[] | null;
    }
  | JiraUnavailable;
/** One entry of the site's link type catalogue; the labels are the site administrator's (editable). */
export type JiraLinkType = { id: string; name: string; inward: string; outward: string };
/** A link of the read Ticket: `end: 'inward'` = the neighbour came as `inwardIssue` (to be read with `type.inward`). The type's meaning is the Control's rule. */
export type JiraLink = { linkId: string; type: JiraLinkType; end: 'inward' | 'outward'; issue: { issueId: string; key: string } };
export type JiraLinkTypesObservation = { kind: 'observed'; source: 'jira-rest'; observedAt: string; siteId: string; types: JiraLinkType[] } | JiraUnavailable;
/** Status CATEGORY of one issue of the site read by ID (any project, with or without the label); never its local status name. */
export type JiraIssueStatusObservation =
  | { kind: 'observed'; source: 'jira-rest'; observedAt: string; siteId: string; issueId: string; key: string; statusCategory: JiraStatusCategory }
  | JiraUnavailable;
/** A visible "is blocked by" neighbour, judged by its status CATEGORY (never the local column name). */
export type JiraBlocker = { issueId: string; key: string; statusCategory: JiraStatusCategory };
/** Visible blockers of one Ticket. `coverage: 'visible'`: an empty list is a valid read of what this account sees, never global absence. */
export type JiraBlockersObservation =
  | { kind: 'observed'; source: 'jira-rest'; observedAt: string; root: JiraTicketRef; coverage: 'visible'; blockers: JiraBlocker[]; limitations: string[] }
  | JiraUnavailable;
/**
 * Spec #68 §4.6: one label change of a Card, from its changelog. `eventId` is the changelog entry's id (one entry may add and remove
 * several labels: they share it). `author: null` = Jira gave no author account.
 */
export type JiraLabelEvent = {
  eventId: string;
  action: 'added' | 'removed';
  label: string;
  at: string;
  author: JiraCommentAuthor | null;
  /** Spec #68 §8: the `historyMetadata.type` the caller of that edit supplied (a Triage publication sends its request's mark); absent = none. */
  mark?: string;
};
/** Spec #68 §8: one component the changelog shows added to or removed from the Card, with who made the edit and its mark (as in {@link JiraLabelEvent}). */
export type JiraComponentEvent = {
  eventId: string;
  action: 'added' | 'removed';
  componentId: string;
  at: string;
  author: JiraCommentAuthor | null;
  mark?: string;
};
/**
 * Spec #68 §8: one write of a Triage publication on a Card. `comment`: an ordinary comment, one ADF paragraph per line. `edit`: ONE `PUT`
 * of the issue with relative operations only (labels added and removed, components added, never a set replaced and never another field),
 * carrying `mark` as `historyMetadata.type` so the changelog entry it makes can be told from an edit a person made with the same account.
 */
export type JiraTriageWrite =
  { kind: 'comment'; lines: string[] } | { kind: 'edit'; mark: string; addLabels: string[]; removeLabels: string[]; addComponents: string[] };
/** Every label change of a Card, oldest first, from a COMPLETE changelog read. A label the Card was created with has no entry. */
export type JiraLabelHistoryObservation =
  | {
      kind: 'observed';
      source: 'jira-rest';
      observedAt: string;
      ticket: JiraTicketRef;
      completeness: 'complete';
      events: JiraLabelEvent[];
      /** Every component change, in the same order (spec #68 §8: the authorship of a component the publication added). */
      components: JiraComponentEvent[];
      limitations: string[];
    }
  | JiraUnavailable;
/** Author of a Jira comment: the observed `accountId` is the identity (a shared Factory account may also author human answers). */
export type JiraCommentAuthor = { tracker: 'jira'; accountId: string };
/** Stable reference of one Jira input: (siteId, issueId, commentId). */
export type JiraInputRef = { tracker: 'jira'; siteId: string; issueId: string; commentId: string };
/**
 * One ordinary Platform comment of the origin Card; `body` is the plain text projected from validated ADF. `author: null` = Jira gave no
 * author account; `body: null` = the body was not a valid ADF document. Neither is ever an instruction (the Control records it as ignored).
 */
export type JiraComment = {
  ref: JiraInputRef;
  url: string;
  author: JiraCommentAuthor | null;
  body: string | null;
  createdAt: string;
  updatedAt: string;
  /** A visibility restriction applies: its text is never applied nor projected to a broader audience. */
  restricted: boolean;
};
/** Read position in a Card's comments: the last processed comment (ascending created instant, then id); advanced only over processed inputs. */
export type JiraInputCursor = { tracker: 'jira'; createdAt: string; commentId: string };
export type JiraInputsObservation =
  | {
      kind: 'observed';
      source: 'jira-rest';
      observedAt: string;
      ticket: JiraTicketRef;
      completeness: 'complete';
      comments: JiraComment[];
      cursor: JiraInputCursor | null;
      limitations: string[];
    }
  | JiraUnavailable;
export type JiraQuestionSearch =
  | {
      kind: 'observed';
      source: 'jira-rest';
      observedAt: string;
      completeness: 'complete';
      candidates: { commentId: string; url: string; createdAt: string }[];
      limitations: string[];
    }
  | JiraUnavailable;
export type JiraCommentResult = { kind: 'published'; observedAt: string; commentId: string; url: string; createdAt: string } | JiraWriteNotApplied;
/** Jira ticket 10: one capability the Factory needs on the configured project, as observed by the account's own permissions read. */
export type JiraCapabilityFact = 'granted' | 'missing' | 'unverified';
export type JiraAccessDiagnostic = {
  source: 'jira-rest';
  purpose: 'tracker';
  observedAt: string;
  siteId: string;
  projectId: string;
  status: 'ok' | 'blocked';
  code: string;
  completeness: 'complete' | 'incomplete';
  nextStep: string;
  limitations?: string[];
  /** Read project/issues/links/comments (Browse projects), create comments (Add comments), keep remote links (Link issues); audience and
   * visibility of what Jira hides from this account can never be proved by it. */
  facts?: {
    projectRead: JiraCapabilityFact;
    commentCreate: JiraCapabilityFact;
    remoteLinks: JiraCapabilityFact;
    commentAudience: 'unverified';
    blockerVisibility: 'unverified';
  };
};

/** Jira-only capability (spec §5): keep the Work's link on the Card, upserted by a stable `globalId` (e.g. `software-factory:work:<uuid>`). */
export type RemoteLink = { globalId: string; url: string; title: string };
/** `applied`: Jira created or updated the link with this globalId; `failed`: certainly not applied; `unknown`: may have been applied. An
 * upsert by globalId may be repeated in every case (it never makes a second link), unlike a comment POST. */
export type RemoteLinkResult = { kind: 'applied'; observedAt: string; linkId: string } | JiraWriteNotApplied;
export interface JiraRemoteLinks {
  upsertRemoteLink(ticket: JiraTicketRef, link: RemoteLink): Promise<RemoteLinkResult>;
}
/**
 * Jira ticket 04: the Card's text for the Builder's context (the agent has no Jira client or token). Summary and description (ADF as plain
 * text, bounded with an explicit `truncated`); presentation data of the Ticket, never instructions to the Factory.
 */
export type JiraTicketContent =
  | { kind: 'observed'; source: 'jira-rest'; observedAt: string; ticket: JiraTicketRef; summary: string | null; description: string | null; truncated: boolean }
  | JiraUnavailable;
export interface JiraContentReads {
  readTicketContent(ticket: JiraTicketRef): Promise<JiraTicketContent>;
}
/**
 * Jira-only reads behind the visible-blockers fact (Jira ticket 03): the site's link type catalogue and the status category of a neighbour.
 * The Control decides which links block (catalogue + direction rule) and reads only those neighbours.
 */
export interface JiraBlockerReads {
  readLinkTypes(siteId: string): Promise<JiraLinkTypesObservation>;
  readIssueStatus(siteId: string, issueId: string): Promise<JiraIssueStatusObservation>;
}

/** Jira ticket 05: an automatic comment as plain lines (the first is the reserved header); the adapter writes one ADF paragraph per line. */
export type JiraFactoryComment = { lines: string[] };
/** Outcome of one comment POST: created (with the author Jira recorded), known refusal (nothing created) or unknown (it may exist). */
export type JiraCommentPost =
  { kind: 'published'; observedAt: string; commentId: string; url: string; createdAt: string; authorAccountId: string | null } | JiraWriteNotApplied;
/**
 * One visible comment: author account (`null`: none observed), plain text projected from its current ADF (`null`: the body is not a valid
 * ADF document, nothing is guessed), and whether a visibility restriction applies.
 */
export type JiraVisibleComment = {
  commentId: string;
  authorAccountId: string | null;
  text: string | null;
  createdAt: string;
  updatedAt: string;
  restricted: boolean;
};
/** Every visible comment of a Card, all pages (never a shorter list); what this account sees, not an atomic snapshot. */
export type JiraCommentListing =
  | {
      kind: 'observed';
      source: 'jira-rest';
      observedAt: string;
      siteId: string;
      issueId: string;
      completeness: 'complete';
      comments: JiraVisibleComment[];
      limitations: string[];
    }
  | JiraUnavailable;
export type JiraAccountObservation = { kind: 'observed'; source: 'jira-rest'; observedAt: string; siteId: string; accountId: string } | JiraUnavailable;
/**
 * Jira-only automatic comments (Jira ticket 05, reused by Questions and delivery notices): POST a Platform comment with NO visibility
 * restriction, list every visible comment for reconciliation after an uncertain POST, and read the configured account on demand (no
 * pre-registered accountId). Jira documents no idempotency key: reconciliation is the Control's rule.
 */
export interface JiraComments {
  publishComment(ticket: JiraTicketRef, comment: JiraFactoryComment): Promise<JiraCommentPost>;
  listComments(ticket: JiraTicketRef): Promise<JiraCommentListing>;
  readAccount(siteId: string): Promise<JiraAccountObservation>;
}
