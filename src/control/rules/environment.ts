import { environmentDeclarationPath, type EnvironmentDeclarationObservation } from '../../contracts/index.js';
import type { Impediment, WorkEnvironment } from '../types.js';

/** Ticket 44: the Work-scoped impediments of the environment declaration (any of them keeps the Work from starting). */
export const environmentImpedimentCodes = ['ENVIRONMENT_NOT_EVALUATED', 'ENVIRONMENT_NOT_DECLARED', 'ENVIRONMENT_DECLARATION_INVALID'] as const;

export const environmentExample = 'schemaVersion: 1 / apk: [{ name: <alpine package>, version: <exact version with -rN> }] / ' +
  'images (optional): [{ reference: <registry>/<path>@sha256:<digest> }]';

/** The state of a Work created by this release before its first read (admission or `factory new`). */
export function environmentNotEvaluated(since: string): { environment: WorkEnvironment; impediment: Impediment } {
  return { environment: { state: 'not-evaluated', since, code: null },
    impediment: { code: 'ENVIRONMENT_NOT_EVALUATED', scope: 'work', since,
      nextStep: `The environment declaration (${environmentDeclarationPath} at the base commit) has not been read yet; polling reads it before any start.` } };
}

/**
 * Ticket 44 (pure): what one read of the declaration does to a Work. Only a Work whose environment is not pinned yet changes (a legacy Work
 * without `environment` never does: it was admitted before ticket 44 and keeps its prepared generic environment). `declared` pins it (by
 * commit + sha256) and lifts the environment impediments; `missing`/`invalid` keep the Work from starting with an impediment that says what to
 * create or which paths are wrong; `unavailable` keeps it not evaluated. Never a fallback to the generic guest.
 */
export function environmentOutcome(current: WorkEnvironment | undefined, observation: EnvironmentDeclarationObservation,
  context: { workId: string; repository: string; base: string; at: string }): { environment: WorkEnvironment; impediment: Impediment | null; event: string | null } | null {
  if (!current || current.state === 'pinned') return null;
  const where = `${context.repository} (${context.base}`;
  if (observation.kind === 'declared') {
    return { environment: { state: 'pinned', pinnedAt: context.at, observedAt: observation.observedAt,
      pin: { path: environmentDeclarationPath, commit: observation.commit, sha256: observation.sha256, declaration: observation.declaration } },
    impediment: null, event: `environment-pinned:${observation.commit}:${observation.sha256}` };
  }
  if (observation.kind === 'missing') {
    return { environment: { state: 'not-declared', commit: observation.commit, observedAt: observation.observedAt }, event: current.state === 'not-declared' ? null : `environment-not-declared:${observation.commit}`,
      impediment: { code: 'ENVIRONMENT_NOT_DECLARED', scope: 'work', since: context.at,
        nextStep: `${where} at ${observation.commit.slice(0, 12)}) has no ${environmentDeclarationPath}; every repository declares the environment its Work runs in. ` +
          `Merge that file into ${context.base} (${environmentExample}); polling re-reads it and this Work starts with the declared environment. ` +
          'There is no fallback to the generic guest.' } };
  }
  if (observation.kind === 'invalid') {
    const errors = observation.errors.slice(0, 8).map(item => `${item.path}: ${item.message}`).join('; ');
    return { environment: { state: 'invalid', commit: observation.commit, sha256: observation.sha256, errors: observation.errors.slice(0, 32), observedAt: observation.observedAt },
      event: current.state === 'invalid' && current.sha256 === observation.sha256 ? null : `environment-invalid:${observation.commit}:${observation.sha256 ?? 'none'}`,
      impediment: { code: 'ENVIRONMENT_DECLARATION_INVALID', scope: 'work', since: context.at,
        nextStep: `${environmentDeclarationPath} of ${where} at ${observation.commit.slice(0, 12)}) is invalid: ${errors}${observation.errors.length > 8 ? '; …' : ''}. ` +
          `Fix it on ${context.base} (${environmentExample}); polling re-reads it. There is no fallback to the generic guest.` } };
  }
  return { environment: { state: 'not-evaluated', since: current.state === 'not-evaluated' ? current.since : context.at, code: observation.code }, event: null,
    impediment: { code: 'ENVIRONMENT_NOT_EVALUATED', scope: 'work', since: context.at,
      nextStep: `The environment declaration of ${where}) could not be read (${observation.code}); nothing is concluded and the Work does not start until it is read. ${observation.nextStep}`.slice(0, 1024) } };
}
