import { declaresCapability, environmentDeclarationPath, type EnvironmentDeclaration, type SandboxCapabilities, type SandboxCapabilityName } from '../../contracts/index.js';
import type { Impediment } from '../types.js';

/** v2 (V2-04): the Work-scoped reason of a repository that requires a capability the installation's sandbox does not declare. */
export const sandboxCapabilityImpediment = 'SANDBOX_CAPABILITY_MISSING';

/** V2-04 (pure): the sandbox capabilities a repository's environment declaration requires. Declared container images need Docker. */
export function requiredCapabilities(declaration: Pick<EnvironmentDeclaration, 'images'>): SandboxCapabilityName[] {
  return declaration.images.length > 0 ? ['docker'] : [];
}

/**
 * V2-04 (pure): the required capabilities the sandbox does not declare. `capabilities` absent = the sandbox was composed without a
 * declaration (a composition from before v2): nothing is gated on a guess.
 */
export function missingCapabilities(declaration: Pick<EnvironmentDeclaration, 'images'>, capabilities: SandboxCapabilities | undefined): SandboxCapabilityName[] {
  if (!capabilities) return [];
  return requiredCapabilities(declaration).filter(name => !declaresCapability(capabilities, name));
}

const requiredBy: Record<SandboxCapabilityName, string> = {
  docker: `its ${environmentDeclarationPath} declares container images`,
  'persistent-disk': `its ${environmentDeclarationPath} needs a disk that survives the boot`,
};

/** V2-04 (pure): the visible impediment of a Work that does not start because its repository requires `missing`. Never a fallback. */
export function capabilityImpediment(missing: readonly SandboxCapabilityName[], context: { repository: string }): Impediment {
  return { code: sandboxCapabilityImpediment, scope: 'work',
    nextStep: `${context.repository} requires a sandbox capability this installation's sandbox does not declare: ` +
      `${missing.map(name => `${name} (${requiredBy[name]})`).join('; ')}. The Work does not start. Remove that requirement from the repository's declaration ` +
      '(it applies to Works admitted afterwards) or run the installation on a sandbox that declares the capability; there is no fallback to another sandbox.' };
}
