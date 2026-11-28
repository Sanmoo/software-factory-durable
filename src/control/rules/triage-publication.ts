// Pure rules of the publication of a recorded Verdict, common to both trackers. The Control re-reads the origin
// before every write and passes the facts here; this decides the single next move. No I/O, clock, storage or tracker types.
import { triageMarkerPrefix } from '../../contracts/index.js';
import { routeTicket } from './jira-admission.js';
import { stateLabelConflict, suspendsAdmission, type TriageRoles } from './triage.js';
import type { TriageIntendedChange, TriageIntendedEffect, TriageOutcome, VerdictCategory } from './triage-verdict.js';

/**
 * What a fresh read of the origin shows for one intended effect. `holds`: its target state is there (the request's own comment exists, the
 * label is present or gone, the Ticket is closed). `author`: who the origin's history says produced that state last: this installation's
 * own account (`own`), somebody else it names (`other`), an event without a distinguishable author (`unknown`), or no such event (`none`).
 * For the comment, `holds` means a comment of the own account under the request's marker; `unknown` = its content is not the expected one.
 */
export type EffectFact = { holds: boolean; author: 'own' | 'other' | 'unknown' | 'none'; reference?: string };
/** A fresh read of the Ticket plus the local fact of a Work; `effects` is aligned with the request's intended effects. */
export type PublicationFacts = { open: boolean; hasWork: boolean; labels: readonly string[]; effects: readonly EffectFact[] };
/** `informative`: `needs-triage` was withdrawn during the investigation; only one comment is published and the outcome is not applied. */
export type PublicationMode = 'verdict' | 'informative';
export type PublicationNext =
  /** Send this write unit (the indexes of the effects one request to the tracker carries), after committing the attempt. */
  | { action: 'write'; mode: PublicationMode; group: number[] }
  /** An effect is present and the history does not show its author yet: read again later, write nothing. */
  | { action: 'wait' }
  | { action: 'suspend'; labels: string[] }
  /** Effects present without an attributable author: the publication stops for the operator. */
  | { action: 'impediment'; effects: number[] }
  | { action: 'end'; to: 'concluded' | 'abandoned'; code: string };
export type PublicationStep = { effects: TriageIntendedEffect[]; mode: PublicationMode | null; next: PublicationNext };
type PublicationInput = {
  roles: TriageRoles;
  caseSensitive: boolean;
  /** `null`: nothing was attempted yet (the re-read before the first write). */
  mode: PublicationMode | null;
  intended: readonly TriageIntendedEffect[];
  facts: PublicationFacts;
  /** The write units of the tracker, in order: one effect each on GitHub; on a Card the label and component effects share one `PUT`. */
  groups: readonly (readonly number[])[];
  at: string;
  /** The operator's `triage complete`: these effects (indexes), found without an attributable author, are taken as the Factory's. */
  ambiguousAsOwn?: readonly number[];
};

const unsettled = (effect: TriageIntendedEffect) => effect.status === 'pending' || effect.status === 'ambiguous-authorship';
const discarded = (effect: TriageIntendedEffect, code: string, at: string): TriageIntendedEffect =>
  unsettled(effect) ? { ...effect, status: 'no-longer-allowed', code, settledAt: at } : effect;
const ended = (effects: readonly TriageIntendedEffect[], mode: PublicationMode | null, code: string, at: string): PublicationStep => ({
  effects: effects.map(effect => discarded(effect, code, at)),
  mode,
  next: { action: 'end', to: 'abandoned', code },
});
/** The first write unit that still has a pending effect, reduced to its pending effects. */
function nextWrite(effects: readonly TriageIntendedEffect[], groups: PublicationInput['groups'], mode: PublicationMode): PublicationNext {
  for (const group of groups) {
    const pending = group.filter(index => effects[index]?.status === 'pending');
    if (pending.length) return { action: 'write', mode, group: pending };
  }
  return { action: 'wait' };
}

/** The re-read before the first write (with the withdrawal of `needs-triage` during the investigation). */
function begin(input: PublicationInput): PublicationStep {
  const { facts, roles, caseSensitive, at } = input;
  if (!facts.open) return ended(input.intended, null, 'TICKET_CLOSED', at);
  if (facts.hasWork) return ended(input.intended, null, 'WORK_EXISTS', at);
  if (!suspendsAdmission(roles, facts.labels, caseSensitive)) {
    const effects = input.intended.map(effect => (effect.kind === 'comment' ? effect : discarded(effect, 'NEEDS_TRIAGE_REMOVED', at)));
    return { effects, mode: 'informative', next: nextWrite(effects, input.groups, 'informative') };
  }
  const labels = stateLabelConflict(roles, facts.labels, caseSensitive);
  if (labels.length) return { effects: [...input.intended], mode: null, next: { action: 'suspend', labels } };
  return { effects: [...input.intended], mode: 'verdict', next: nextWrite(input.intended, input.groups, 'verdict') };
}

type Sighting = 'settled' | 'absent' | 'own' | 'ambiguous' | 'foreign' | 'lagging';
/** Whose an unsettled effect is, from what the origin shows. Only an effect the Factory attempted can be its own. */
function sighting(effect: TriageIntendedEffect, fact: EffectFact | undefined, ambiguousAsOwn: boolean): Sighting {
  if (!unsettled(effect)) return 'settled';
  if (!fact?.holds) return 'absent';
  const attempted = effect.kind === 'comment' || effect.attemptedAt !== undefined;
  if (!attempted || fact.author === 'other') return 'foreign';
  if (fact.author === 'own') return 'own';
  if (fact.author === 'none') return 'lagging';
  return ambiguousAsOwn ? 'own' : 'ambiguous';
}
function sighted(effect: TriageIntendedEffect, seen: Sighting, fact: EffectFact | undefined, at: string): TriageIntendedEffect {
  if (seen === 'settled') return effect;
  if (seen === 'own') return { ...effect, status: 'confirmed', settledAt: at, ...(fact?.reference ? { reference: fact.reference } : {}) };
  return { ...effect, status: seen === 'ambiguous' ? 'ambiguous-authorship' : 'pending' };
}

const foreignCode: Record<TriageIntendedChange['kind'], string> = {
  comment: 'TRIAGE_LABELS_CHANGED',
  'add-label': 'TRIAGE_LABELS_CHANGED',
  'remove-label': 'NEEDS_TRIAGE_REMOVED',
  close: 'TICKET_CLOSED',
  'add-component': 'TRIAGE_LABELS_CHANGED',
};
/** The state labels beside `needs-triage` that the publication did not put there, and its own confirmed label when somebody removed it. */
function labelsChanged(input: PublicationInput, effects: readonly TriageIntendedEffect[]): boolean {
  const same = (a: string, b: string) => (input.caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase());
  const added = effects.filter(effect => effect.kind === 'add-label');
  const own = added.filter(effect => effect.attemptedAt !== undefined || effect.status === 'confirmed').map(effect => effect.label);
  if (stateLabelConflict(input.roles, input.facts.labels, input.caseSensitive).some(label => !own.some(item => same(item, label)))) return true;
  return added.some(effect => effect.status === 'confirmed' && !input.facts.labels.some(label => same(label, effect.label)));
}
/** Why the effects still to write are no longer allowed: a change of the Ticket the publication did not make. */
function intervention(input: PublicationInput, mode: PublicationMode, effects: readonly TriageIntendedEffect[], seen: readonly Sighting[]): string | null {
  const foreign = seen.indexOf('foreign');
  if (foreign >= 0) return foreignCode[effects[foreign]!.kind];
  const closing = effects.some(effect => effect.kind === 'close' && (effect.attemptedAt !== undefined || effect.status === 'confirmed'));
  if (!input.facts.open && !closing) return 'TICKET_CLOSED';
  if (input.facts.hasWork) return 'WORK_EXISTS';
  return mode === 'verdict' && labelsChanged(input, effects) ? 'TRIAGE_LABELS_CHANGED' : null;
}
/** Every effect is settled: `concluded` only when the whole outcome was applied by the Factory itself. */
function finished(effects: TriageIntendedEffect[], mode: PublicationMode): PublicationStep {
  if (mode === 'verdict' && effects.every(effect => effect.status === 'confirmed'))
    return { effects, mode, next: { action: 'end', to: 'concluded', code: 'VERDICT_PUBLISHED' } };
  const code = effects.find(effect => effect.status === 'no-longer-allowed')?.code ?? 'NEEDS_TRIAGE_REMOVED';
  return { effects, mode, next: { action: 'end', to: 'abandoned', code } };
}

/**
 * The next move of a publication, from a fresh read. Before the first write: abandon a Ticket that closed or got a Work, suspend on a
 * label conflict, or start (with only the informative comment when `needs-triage` is gone). After it: recognise the Factory's own effects
 * and confirm them, stop on an effect nobody can be named for, end when a person changed the Ticket in between (the remaining effects
 * become `no-longer-allowed`), and otherwise write the first unit still pending. An effect is confirmed only by a read, never by the
 * answer of the write.
 */
export function publicationStep(input: PublicationInput): PublicationStep {
  const { mode, at } = input;
  if (mode === null) return begin(input);
  const seen = input.intended.map((effect, index) => sighting(effect, input.facts.effects[index], input.ambiguousAsOwn?.includes(index) ?? false));
  const effects = input.intended.map((effect, index) => sighted(effect, seen[index]!, input.facts.effects[index], at));
  const ambiguous = seen.flatMap((item, index) => (item === 'ambiguous' ? [index] : []));
  if (ambiguous.length) return { effects, mode, next: { action: 'impediment', effects: ambiguous } };
  if (!effects.some(unsettled)) return finished(effects, mode);
  const code = intervention(input, mode, effects, seen);
  if (code) return ended(effects, mode, code, at);
  if (seen.includes('lagging')) return { effects, mode, next: { action: 'wait' } };
  return { effects, mode, next: nextWrite(effects, input.groups, mode) };
}

/** Why a `ready-for-agent` Verdict of a Card is applied as `needs-info`, with what the comment suggests. */
export type RouteFallback = {
  code:
    | 'TRIAGE_ROUTE_DIVERGENT'
    | 'TRIAGE_COMPONENTS_UNREADABLE'
    | 'TRIAGE_COMPONENT_NOT_IDENTIFIED'
    | 'TRIAGE_COMPONENT_NOT_ROUTED'
    | 'TRIAGE_COMPONENT_NOT_WRITTEN';
  componentId: string | null;
  repository: string | null;
};
/** `routed`: the outcome stands; `addComponent`: the Card has no routed component and the identified one is written with the label. */
export type CardRoute = { kind: 'routed'; addComponent: boolean } | ({ kind: 'fallback' } & RouteFallback);
/**
 * Whether a `ready-for-agent` Verdict may be applied to a Card, from a fresh read of its components. It needs exactly one destination:
 * the one the Card's components already route to (nothing is added, and a component the Triager identified must agree with it), or the
 * one of the single component the Triager identified, which the Factory then adds. Anything else falls to `needs-info`. A component
 * is never removed, so divergent routes are never repaired here.
 */
export function cardRoute(input: {
  /** The component the Triager identified, or null. */
  component: string | null;
  /** The Card's current component ids; null = not read completely. */
  cardComponents: readonly string[] | null;
  routes: readonly { componentId: string; repository: string }[];
  authorizedRepositories: readonly string[];
}): CardRoute {
  const { component, routes, authorizedRepositories } = input;
  const identified = component === null ? { kind: 'none' as const } : routeTicket({ components: [component], routes, authorizedRepositories });
  const destination = identified.kind === 'single' ? identified.repository : null;
  const fallback = (code: RouteFallback['code']): CardRoute => ({ kind: 'fallback', code, componentId: component, repository: destination });
  const current = routeTicket({ components: input.cardComponents, routes, authorizedRepositories });
  if (current.kind === 'unverifiable') return fallback('TRIAGE_COMPONENTS_UNREADABLE');
  if (current.kind === 'divergent') return fallback('TRIAGE_ROUTE_DIVERGENT');
  // The Card already has its destination: nothing is added, and a component identified for another repository is a divergence.
  if (current.kind === 'single')
    return component === null || destination === current.repository ? { kind: 'routed', addComponent: false } : fallback('TRIAGE_ROUTE_DIVERGENT');
  if (component === null) return fallback('TRIAGE_COMPONENT_NOT_IDENTIFIED');
  return destination ? { kind: 'routed', addComponent: true } : fallback('TRIAGE_COMPONENT_NOT_ROUTED');
}

/** First line of every comment a Triage publishes: how a later read recognises the comment of one request. */
export const triageCommentMarker = (triage_request_id: string) => `<!-- ${triageMarkerPrefix}${triage_request_id} -->`;
const normalized = (text: string) => text.replace(/\r\n?/g, '\n').trim();
/** Whether a comment read back is the one that was sent, whatever the origin did to line endings and outer blanks. */
export const sameCommentText = (a: string, b: string) => normalized(a) === normalized(b);

const aiMark = (title: string) =>
  `**${title}, generated by AI.** The Software Factory Triager investigated this Ticket by reading and wrote the Verdict below. ` +
  'No person wrote or reviewed this comment.';
/** What the Factory does with the outcome, in the order it writes. */
function application(intended: readonly TriageIntendedChange[]): string {
  const parts = intended.flatMap(change => {
    if (change.kind === 'add-label') return [`adds the label \`${change.label}\``];
    if (change.kind === 'remove-label') return [`removes \`${change.label}\``];
    if (change.kind === 'close') return ['closes the Ticket as not planned'];
    return change.kind === 'add-component' ? [`adds the component ${change.componentId}`] : [];
  });
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'changes nothing else');
}
const fallbackReason: Record<RouteFallback['code'], string> = {
  TRIAGE_ROUTE_DIVERGENT: 'the components of the Card, with the one the Triager identified, route to more than one repository',
  TRIAGE_COMPONENTS_UNREADABLE: 'the Factory could not read the components of the Card completely',
  TRIAGE_COMPONENT_NOT_IDENTIFIED: 'the Card has no component that routes to a repository and the Triager identified no single one',
  TRIAGE_COMPONENT_NOT_ROUTED: 'the component the Triager identified does not route to an authorized repository',
  TRIAGE_COMPONENT_NOT_WRITTEN: 'Jira refused the edit that adds the component',
};
const suggestion = (route: Pick<RouteFallback, 'componentId' | 'repository'>) =>
  route.componentId
    ? `Suggested component: ${route.componentId}${route.repository ? `, which routes to the repository \`${route.repository}\`` : ''}.`
    : 'The Triager suggested no component.';
/** What the comment of a Card says of its route, beside the outcome. */
function routeLines(route: TriageCommentRoute | undefined): string[] {
  if (!route) return [];
  if (route.kind === 'adds')
    return [
      '',
      `**Route:** the Card has no component that routes to a repository, so the same edit adds the component ${route.componentId}, which routes to ` +
        `the repository \`${route.repository}\`. If Jira refuses that edit, the Factory applies \`${route.needsInfo}\` instead of ` +
        `\`${route.admission}\`: a person then adds that component and replaces \`${route.needsInfo}\` with \`${route.admission}\`.`,
    ];
  return [
    '',
    `**Route:** the Triager concluded \`ready-for-agent\`, which needs the Card to route to exactly one repository. The Factory applies ` +
      `\`${route.needsInfo}\` instead because ${fallbackReason[route.code]}. ${suggestion(route)} A person who agrees leaves exactly one ` +
      `routed component on the Card and replaces \`${route.needsInfo}\` with \`${route.admission}\`.`,
  ];
}
function outcomeLine(input: TriageCommentInput): string {
  const outcome = `\`${input.outcome}\` (category: \`${input.category}\`)`;
  if (input.mode === 'verdict') return `**Outcome:** ${outcome}. The Factory applies it right after this comment: it ${application(input.intended)}.`;
  const withdrawn = input.intended.find(change => change.kind === 'remove-label')?.label ?? 'needs-triage';
  const label = input.intended.find(change => change.kind === 'add-label')?.label;
  return (
    `**Outcome recommended:** ${outcome}. This is a recommendation, not an action: the Factory did not apply the outcome because ` +
    `\`${withdrawn}\` was removed from this Ticket during the investigation. It changed no label and closed nothing.` +
    (label ? ` A person who accepts the recommendation applies the label \`${label}\`.` : '')
  );
}
export type TriageCommentInput = {
  triage_request_id: string;
  mode: PublicationMode;
  outcome: TriageOutcome;
  category: VerdictCategory;
  text: string;
  intended: readonly TriageIntendedChange[];
  /** Characters one comment of the tracker holds (60,000 on GitHub; 32,767 on Jira). */
  limit: number;
  /** Lines one comment may have, where the tracker stores a block per line (Jira); absent = any. */
  maxLines?: number;
  /** A Card's route, when the outcome depends on it (never in the informative comment). */
  route?: TriageCommentRoute;
};
/** `adds`: the publication writes the identified component with the label. `fallback`: `ready-for-agent` is applied as `needs-info`. */
type TriageCommentRoute = { admission: string; needsInfo: string } & (
  { kind: 'adds'; componentId: string; repository: string } | ({ kind: 'fallback' } & RouteFallback)
);
/**
 * The one comment of a publication: the request's marker, the AI mark, the outcome and what the Factory does with it, then the Verdict
 * text whole (what was observed, what was inferred, the brief or the action). Above the tracker's limit, in characters or in lines, it
 * is refused: nothing is cut.
 */
export function triageComment(
  input: TriageCommentInput,
): { kind: 'comment'; body: string } | { kind: 'too-large'; characters: number; limit: number; lines?: number; maxLines?: number } {
  const body = [
    triageCommentMarker(input.triage_request_id),
    aiMark(input.mode === 'verdict' ? 'Triage Verdict' : 'Triage recommendation'),
    '',
    outcomeLine(input),
    ...(input.mode === 'verdict' ? routeLines(input.route) : []),
    '',
    "**Verdict** (what was observed, what was inferred from it, and the brief or the action needed, in the Triager's words):",
    '',
    input.text,
  ].join('\n');
  if (body.length > input.limit) return { kind: 'too-large', characters: body.length, limit: input.limit };
  const lines = body.split('\n').length;
  if (input.maxLines !== undefined && lines > input.maxLines)
    return { kind: 'too-large', characters: body.length, limit: input.limit, lines, maxLines: input.maxLines };
  return { kind: 'comment', body };
}
