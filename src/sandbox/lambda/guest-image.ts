import { createHash } from 'node:crypto';
import { validateEnvironmentDeclaration, type EnvironmentDeclaration, type EnvironmentDeclarationError } from '../../contracts/index.js';
import { guestFiles } from './guest-files.js';
import type { LambdaProfile } from './profile.js';

/**
 * v2 ticket 03 (V2-27): the release pin of the Lambda guest. Everything a MicroVM image is built from besides the repository's validated
 * declaration: the managed base image, the Alpine image the container starts from (by digest), the Alpine repositories, the template
 * packages at EXACT versions (the ones the Alpine proof installed, evidence `s1-apk-all.txt`), the lifecycle hooks and the guest user.
 * Together with the fixed guest files it hashes to `guestPinSha256`, one third of the image key: changing any of it gives new images.
 *
 * Known limit: only the template's own packages are pinned; their dependencies are resolved by the Alpine repository at build time. The
 * Alpine mirror keeps only the current build of each package, so a pinned version stops building when Alpine bumps its revision: the build
 * then fails with that cause, and the remedy is a release with a new pin (never a fallback version).
 */
export const lambdaGuestPin = Object.freeze({
  version: 1,
  /** Managed base MicroVM image (kernel and VM runtime); the ARN is built per region. */
  baseImage: Object.freeze({ name: 'al2023-1', version: '3' }),
  alpine: Object.freeze({ image: 'public.ecr.aws/docker/library/alpine@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2',
    mirror: 'https://dl-cdn.alpinelinux.org/alpine', branch: 'v3.23' }),
  packages: Object.freeze([
    { name: 'docker', version: '29.5.2-r0' }, { name: 'docker-cli-compose', version: '2.40.3-r6' }, { name: 'docker-cli-buildx', version: '0.30.1-r6' },
    { name: 'openssh', version: '10.2_p1-r1' }, { name: 'git', version: '2.52.1-r0' }, { name: 'python3', version: '3.12.16-r0' },
    { name: 'bash', version: '5.3.3-r1' }, { name: 'websocat', version: '1.14.0-r1' }, { name: 'iptables', version: '1.8.11-r1' },
    { name: 'curl', version: '8.23.0-r0' }] as readonly { name: string; version: string }[]),
  /** `ready` is mandatory whenever a lifecycle hook is enabled (first Lambda proof, finding 3). */
  hooks: Object.freeze({ port: 9000, runTimeoutSeconds: 60, terminateTimeoutSeconds: 60, readyTimeoutSeconds: 120 }),
  user: 'builder',
  /** v2 ticket 05 (V2-23): the read-only user the reviewers' reads run as. No group, no ownership, never in `docker`. */
  reviewer: 'reviewer',
  directory: '/opt/factory',
});
export type LambdaGuestPin = typeof lambdaGuestPin;

/** The release pin as one hash: the pin values and the exact bytes of the fixed guest files. */
export function guestPinSha256(pin: LambdaGuestPin = lambdaGuestPin, files: Readonly<Record<string, string>> = guestFiles): string {
  return createHash('sha256').update(JSON.stringify({ pin, files: Object.entries(files).sort(([left], [right]) => left < right ? -1 : 1) })).digest('hex');
}

/** ARN of the managed base image of the pin in `region`. */
export const managedBaseImageArn = (region: string, pin: LambdaGuestPin = lambdaGuestPin) => `arn:aws:lambda:${region}:aws:microvm-image:${pin.baseImage.name}`;

export type GuestImageFiles = { ok: true; declaration: EnvironmentDeclaration; files: { name: string; content: string }[] } | { ok: false; errors: EnvironmentDeclarationError[] };

/**
 * The build context of a MicroVM image, mounted by the host ONLY from validated values. The declaration is re-validated here with the
 * production validator (closed schema: package names, exact versions and image references match strict patterns, so none can carry a
 * quote, a space or a newline); what does not validate renders nothing. Only `name=version` pairs enter the Dockerfile; the declared
 * Docker images go into a data file the start script pulls by digest at each boot (V2-28: never embedded in the MicroVM image). The user
 * account is unlocked (`*` instead of `!` in the shadow file) because Alpine's sshd refuses a locked account even for public-key login.
 */
export function renderGuestImage(declaration: unknown, pin: LambdaGuestPin = lambdaGuestPin): GuestImageFiles {
  const checked = validateEnvironmentDeclaration(declaration);
  if (!checked.valid) return { ok: false, errors: checked.errors };
  const repository = `${pin.alpine.mirror}/${pin.alpine.branch}`;
  const add = `RUN apk add --no-cache --repositories-file /dev/null --repository ${repository}/main --repository ${repository}/community`;
  const pairs = (packages: readonly { name: string; version: string }[]) => packages.map(entry => `'${entry.name}=${entry.version}'`).join(' ');
  const user = pin.user, reviewer = pin.reviewer;
  const dockerfile = [
    `FROM ${pin.alpine.image}`,
    `${add} ${pairs(pin.packages)}`,
    ...(checked.declaration.apk.length > 0 ? [`${add} ${pairs(checked.declaration.apk)}`] : []),
    `RUN adduser -D -s /bin/bash ${user} && sed -i 's/^${user}:!/${user}:*/' /etc/shadow && addgroup ${user} docker && mkdir -p /workspace /artifacts /etc/ssh/authorized && chown ${user}:${user} /workspace /artifacts`,
    `RUN adduser -D -s /bin/bash ${reviewer} && sed -i 's/^${reviewer}:!/${reviewer}:*/' /etc/shadow`,
    `COPY hook-agent.py start.sh sshd_config declared-images ${pin.directory}/`,
    `CMD ["python3", "-u", "${pin.directory}/hook-agent.py"]`,
    ''].join('\n');
  return { ok: true, declaration: checked.declaration, files: [
    { name: 'Dockerfile', content: dockerfile },
    { name: 'declared-images', content: checked.declaration.images.map(image => `${image.reference}\n`).join('') },
    ...Object.entries(guestFiles).sort(([left], [right]) => left < right ? -1 : 1).map(([name, content]) => ({ name, content }))] };
}

/** What of the adapter profile is a property of the IMAGE (not of a boot): a change of any of it needs another image. */
export type LambdaImageProfile = Pick<LambdaProfile, 'architecture' | 'baselineMemoryMiB' | 'additionalOsCapabilities'>;

/**
 * V2-27: the environment key of a MicroVM image = (repository, hash of the declaration file, release pin). The image's own profile
 * (architecture, baseline memory, OS capabilities: fixed at image creation by the service) is part of what the image was built for, so it
 * is hashed with them. Works with the same key share one image; a new declaration or a new release pin is a new key and a new image.
 */
export function lambdaImageKey({ repositoryId, declarationSha256, profile, pinSha256 = guestPinSha256() }:
  { repositoryId: number; declarationSha256: string; profile: LambdaImageProfile; pinSha256?: string }): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, repositoryId, declarationSha256, pinSha256,
    image: { architecture: profile.architecture, baselineMemoryMiB: profile.baselineMemoryMiB, additionalOsCapabilities: [...profile.additionalOsCapabilities] } })).digest('hex');
}

/** Image name of a key under the installation prefix (`installationResources().imagePrefix`): at most 61 characters. */
export const lambdaImageName = (installation: string, key: string) => `factory-${installation}-${key.slice(0, 32)}`;
