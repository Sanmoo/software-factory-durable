// Pure rules of the Verdict a Triager records through `concluir_triagem`, of the changes the Control intends
// from it and of the repositories a Triage may clone. No I/O, clock, storage or tracker types: nothing here writes to a tracker.
import type { TriageRoles } from './triage.js';

/** The four outcomes of a Triage. `ready-for-agent` is published as the admission label of the destination. */
const triageOutcomes = ['ready-for-agent', 'needs-info', 'ready-for-human', 'wontfix'] as const;
export type TriageOutcome = (typeof triageOutcomes)[number];
/** Categories of a Verdict; the Control never turns them into labels. */
const verdictCategories = ['bug', 'enhancement'] as const;
export type VerdictCategory = (typeof verdictCategories)[number];
/** The structured Verdict as recorded. `component`: the Jira component the Triager identified (always null on a GitHub issue). */
type TriageVerdict = { outcome: TriageOutcome; category: VerdictCategory; text: string; component: string | null };

/**
 * Bound of the Verdict text in UTF-8 bytes. It fits one protocol frame even fully escaped and stays under the comment limit of both
 * trackers (32,767 characters on Jira), so a recorded Verdict never has to be cut to be published.
 */
export const verdictTextMaxBytes = 24000;
const bytes = (text: string) => new TextEncoder().encode(text).length;
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export type VerdictError = { code: string; message: string };
type VerdictValidation = { valid: true; verdict: TriageVerdict } | { valid: false; errors: VerdictError[] };
/** Where the Verdict lands: the tracker of the Ticket and, for a Card, the component IDs of its source's routes. */
export type VerdictContext = { tracker: 'github' } | { tracker: 'jira'; components: readonly string[] };

const oneOf = (values: readonly string[]) => values.join(', ');
function textErrors(text: unknown): VerdictError[] {
  if (typeof text !== 'string' || !text.trim()) return [{ code: 'VERDICT_TEXT_EMPTY', message: '`text` must be the Verdict, a non-empty string.' }];
  if (bytes(text) > verdictTextMaxBytes)
    return [
      {
        code: 'VERDICT_TEXT_TOO_LARGE',
        message: `\`text\` has ${bytes(text)} bytes; at most ${verdictTextMaxBytes} are recorded. Shorten it: nothing is cut for you.`,
      },
    ];
  if (control.test(text)) return [{ code: 'VERDICT_TEXT_INVALID', message: '`text` carries control characters; only tabs and line breaks are accepted.' }];
  return [];
}
function componentErrors(component: unknown, context: VerdictContext): VerdictError[] {
  if (component === undefined || component === null) return [];
  if (context.tracker === 'github')
    return [{ code: 'VERDICT_COMPONENT_NOT_APPLICABLE', message: '`component` only exists for a Jira Card; leave it out for a GitHub issue.' }];
  if (typeof component !== 'string' || !context.components.includes(component))
    return [
      {
        code: 'VERDICT_COMPONENT_NOT_A_CANDIDATE',
        message: `\`component\` must be the ID of one component of the candidate repositories: ${oneOf(context.components) || 'none is routed'}.`,
      },
    ];
  return [];
}

/**
 * Whether what the Triager sent is a Verdict the Control records. Every error is named with what is accepted, because the session
 * receives them and corrects its call; nothing is repaired or cut here.
 */
export function validateVerdict(input: unknown, context: VerdictContext): VerdictValidation {
  const value = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const errors: VerdictError[] = [];
  if (!triageOutcomes.includes(value.outcome as TriageOutcome))
    errors.push({ code: 'VERDICT_OUTCOME_INVALID', message: `\`outcome\` must be one of: ${oneOf(triageOutcomes)}.` });
  if (!verdictCategories.includes(value.category as VerdictCategory))
    errors.push({ code: 'VERDICT_CATEGORY_INVALID', message: `\`category\` must be one of: ${oneOf(verdictCategories)}.` });
  errors.push(...textErrors(value.text), ...componentErrors(value.component, context));
  if (Object.keys(value).some(key => !['outcome', 'category', 'text', 'component'].includes(key)))
    errors.push({ code: 'VERDICT_FIELD_UNKNOWN', message: 'Only `outcome`, `category`, `text` and `component` are accepted.' });
  if (errors.length) return { valid: false, errors };
  return {
    valid: true,
    verdict: {
      outcome: value.outcome as TriageOutcome,
      category: value.category as VerdictCategory,
      text: value.text as string,
      component: typeof value.component === 'string' ? value.component : null,
    },
  };
}

/** One write the Control intends on the Ticket for a recorded Verdict. */
export type TriageIntendedChange =
  | { kind: 'comment' }
  | { kind: 'add-label'; label: string }
  | { kind: 'remove-label'; label: string }
  | { kind: 'close'; reason: 'not_planned' }
  | { kind: 'add-component'; componentId: string };
/** Situation of an intended change. Recorded `pending` with the Verdict; only the publication moves it. */
type TriageEffectStatus = 'pending' | 'confirmed' | 'no-longer-allowed' | 'ambiguous-authorship';
/**
 * What the publication records on an intended change, all absent until it reaches it. `attempts`/`attemptedAt`: writes sent
 * for it, committed BEFORE each one (an effect never attempted and found present is somebody else's). `settledAt`: when it left `pending`.
 * `code`: why it is `no-longer-allowed`. `reference`: what confirmed it at the origin (the comment URL, or the id of the history event).
 */
type TriageEffectProgress = { attempts?: number; attemptedAt?: string; settledAt?: string; code?: string; reference?: string };
export type TriageIntendedEffect = TriageIntendedChange & { status: TriageEffectStatus } & TriageEffectProgress;

const outcomeLabel = (outcome: TriageOutcome, roles: TriageRoles) =>
  ({ 'ready-for-agent': roles.admission, 'needs-info': roles.needsInfo, 'ready-for-human': roles.readyForHuman, wontfix: roles.wontfix })[outcome];

/**
 * The changes a recorded Verdict intends, in the order they are written: the comment, the label of the outcome, the withdrawal of
 * `needs-triage`, then the `not_planned` closing (GitHub `wontfix` only) or the identified component (Jira `ready-for-agent` only). On a
 * Card the label and component entries travel in one `PUT`; whether the component is still needed is decided at publication.
 */
export function intendedChanges(
  verdict: Pick<TriageVerdict, 'outcome' | 'component'> & Partial<TriageVerdict>,
  roles: TriageRoles,
  tracker: 'github' | 'jira',
): TriageIntendedEffect[] {
  const changes: TriageIntendedChange[] = [
    { kind: 'comment' },
    { kind: 'add-label', label: outcomeLabel(verdict.outcome, roles) },
    { kind: 'remove-label', label: roles.needsTriage },
  ];
  if (tracker === 'github' && verdict.outcome === 'wontfix') changes.push({ kind: 'close', reason: 'not_planned' });
  if (tracker === 'jira' && verdict.outcome === 'ready-for-agent' && verdict.component) changes.push({ kind: 'add-component', componentId: verdict.component });
  return changes.map(change => ({ ...change, status: 'pending' }));
}

/** A repository a Triage may clone, with the Jira components that route to it (none on a GitHub source). */
export type TriageCandidate<R> = R & { components: string[] };
/**
 * The candidates of a GitHub issue are its own repository; those of a Card are the executable repositories of the `routes` of
 * its source, each once. Nothing outside this list is ever cloned.
 */
export function triageCandidates<R extends { repository: string }>(
  source: { tracker: 'github'; repository: string } | { tracker: 'jira'; routes: readonly { componentId: string; repository: string }[] },
  repositories: readonly R[],
): TriageCandidate<R>[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (source.tracker === 'github') return repositories.filter(item => same(item.repository, source.repository)).map(item => ({ ...item, components: [] }));
  return repositories
    .map(item => ({ ...item, components: source.routes.filter(route => same(route.repository, item.repository)).map(route => route.componentId) }))
    .filter(item => item.components.length > 0);
}
