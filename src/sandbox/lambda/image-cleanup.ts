import { listLambdaEnvironments } from './boot.js';
import { readWorkImage } from './image.js';
import { installationResources, installationTagKey } from './installation.js';
import type { LambdaProfile } from './profile.js';
import type { LambdaListedMicrovm, LambdaService, LambdaServiceFailure } from './service.js';

/**
 * v2 ticket 15 (V2-33): the explicit cleanup of the installation's MicroVM images. Nothing else deletes an image (Prepare and Remove
 * never do; the Operator's environment retry replaces a FAILED one under the same key).
 *
 * An image is IN USE, and then never deleted, while any of these holds:
 * - the environment of a Work records it (`<root>/lambda/works/<environment>/image.json`): the record is written by the Work's first
 *   Prepare and deleted when its environment is removed, which Control does only for a Work that ended. Works with the same key share it;
 * - a MicroVM that has not ended runs from it (ListMicrovms), whatever the host records say;
 * - it is still being built (`CREATING`): the Prepare that asked for it has not recorded its Work yet.
 * Only images named `factory-<installation>-<32 hex>` AND tagged with the installation are considered at all; one whose tags cannot be
 * read is reported and left alone. The plan reads; only `confirm` deletes: the image (its version first), its build artifact and its
 * build log group. The command is the Operator's and runs beside a controller: a Prepare that starts using an image between the plan
 * and the deletion is not excluded by any lock, so it is meant for images whose Works ended.
 */
export type ImageCleanupItem = {
  imageName: string;
  imageArn: string;
  state: string;
  /** Works whose environment records the image. */ works: string[];
  /** MicroVMs of the image that have not ended. */ running: number;
  decision: 'in-use' | 'removable' | 'unverifiable';
  outcome?: 'removed' | 'kept' | 'failed';
  /** `failed`: the step that did not complete and why. */ detail?: string;
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure rule of the cleanup: which images of the installation may be removed. `tags: null`: the image's tags could not be read. */
export function planImageCleanup({
  installation,
  images,
  works,
  microvms,
}: {
  installation: string;
  images: readonly { name: string; imageArn: string; state: string; tags: Readonly<Record<string, string>> | null }[];
  works: readonly { workId: string; imageArn: string }[];
  microvms: readonly Pick<LambdaListedMicrovm, 'microvmId' | 'state' | 'imageArn'>[];
}): ImageCleanupItem[] {
  const named = new RegExp(`^factory-${escaped(installation)}-[a-f0-9]{32}$`);
  const items: ImageCleanupItem[] = [];
  for (const image of images) {
    if (!named.test(image.name) || (image.tags !== null && image.tags[installationTagKey] !== installation)) continue;
    const holders = [...new Set(works.filter(work => work.imageArn === image.imageArn).map(work => work.workId))].sort();
    const running = microvms.filter(microvm => microvm.imageArn === image.imageArn && microvm.state !== 'TERMINATED').length;
    const decision = image.tags === null ? 'unverifiable' : holders.length > 0 || running > 0 || image.state === 'CREATING' ? 'in-use' : 'removable';
    items.push({ imageName: image.name, imageArn: image.imageArn, state: image.state, works: holders, running, decision });
  }
  return items.sort((left, right) => left.imageName.localeCompare(right.imageName));
}

export type ImageCleanupResult = {
  status: 'planned' | 'cleaned' | 'refused' | 'unavailable';
  code?: 'IMAGE_IN_USE' | 'IMAGE_NOT_FOUND' | 'IMAGE_NOT_VERIFIABLE' | 'IMAGE_INVENTORY_UNAVAILABLE' | 'IMAGE_CLEANUP_INCOMPLETE';
  detail?: string;
  images: ImageCleanupItem[];
};

const describe = (failure: LambdaServiceFailure) => [failure.kind, failure.action, failure.detail].filter(Boolean).join(': ').slice(0, 400);

export async function cleanupInstallationImages({
  root,
  service,
  profile,
  image,
  confirm,
}: {
  root: string;
  service: LambdaService;
  profile: LambdaProfile;
  /** One image by name; absent: every removable image of the installation. */ image?: string | undefined;
  confirm: boolean;
}): Promise<ImageCleanupResult> {
  const unavailable = (detail: string): ImageCleanupResult => ({ status: 'unavailable', code: 'IMAGE_INVENTORY_UNAVAILABLE', detail, images: [] });
  // Everything that decides "in use" is read before anything is deleted; one unreadable part plans nothing.
  const listed = await service.listImages();
  if (!listed.ok) return unavailable(`listing the images: ${describe(listed.failure)}`);
  const microvms = await service.listMicrovms();
  if (!microvms.ok) return unavailable(`listing the MicroVMs: ${describe(microvms.failure)}`);
  const identity = await service.callerIdentity();
  if (!identity.ok) return unavailable(`reading the account identity: ${describe(identity.failure)}`);
  const resources = installationResources(profile, identity.value.account);
  const works: { workId: string; imageArn: string }[] = [];
  try {
    for (const environment of await listLambdaEnvironments(root)) {
      const record = await readWorkImage(root, environment);
      if (record) works.push({ workId: record.workId, imageArn: record.imageArn });
    }
  } catch {
    return unavailable('an image record of a Work is unreadable');
  }
  const named = new RegExp(`^factory-${escaped(profile.installation)}-[a-f0-9]{32}$`);
  const images: Parameters<typeof planImageCleanup>[0]['images'][number][] = [];
  const versions = new Map<string, string | undefined>();
  for (const item of listed.value) {
    // Another installation's image is not even read.
    if (!named.test(item.name)) continue;
    const imageArn = item.imageArn ?? `arn:aws:lambda:${profile.region}:${identity.value.account}:microvm-image:${item.name}`;
    const read = await service.image(imageArn);
    if (!read.ok && read.failure.kind === 'not-found') continue;
    images.push({ name: item.name, imageArn, state: read.ok ? read.value.state : item.state, tags: read.ok ? read.value.tags : null });
    if (read.ok) versions.set(imageArn, read.value.latestActiveImageVersion ?? read.value.latestFailedImageVersion);
  }
  const planned = planImageCleanup({ installation: profile.installation, images, works, microvms: microvms.value });
  const selected = image === undefined ? planned : planned.filter(item => item.imageName === image);
  if (image !== undefined) {
    const [only] = selected;
    if (!only) return { status: 'refused', code: 'IMAGE_NOT_FOUND', detail: `${image} is not an image of this installation.`, images: [] };
    if (only.decision === 'in-use')
      return {
        status: 'refused',
        code: 'IMAGE_IN_USE',
        images: selected,
        detail:
          only.works.length > 0
            ? `held by Work ${only.works.join(', ')}`
            : only.running > 0
              ? `${only.running} MicroVM(s) still run from it`
              : 'it is still being built',
      };
    if (only.decision === 'unverifiable') return { status: 'refused', code: 'IMAGE_NOT_VERIFIABLE', detail: 'its tags could not be read', images: selected };
  }
  if (!confirm) return { status: 'planned', images: selected };
  let failed = false;
  for (const item of selected) {
    if (item.decision !== 'removable') {
      item.outcome = 'kept';
      continue;
    }
    const gone = (result: { ok: true } | { ok: false; failure: LambdaServiceFailure }) => result.ok || result.failure.kind === 'not-found';
    const steps: [string, () => Promise<{ ok: true } | { ok: false; failure: LambdaServiceFailure }>][] = [
      // Acceptance finding A18: the service refuses to delete an image's last version ("delete the entire image"); the image goes whole.
      ['deleting the image', () => service.deleteImage(item.imageArn)],
      ['deleting the build artifact', () => service.deleteBuildArtifact({ bucket: resources.artifactBucket, key: `${item.imageName}.zip` })],
      ['deleting the build log', () => service.deleteBuildLog(`/aws/lambda-microvms/${item.imageName}`)],
    ];
    item.outcome = 'removed';
    for (const [step, run] of steps) {
      const result = await run();
      if (gone(result)) continue;
      item.outcome = 'failed';
      item.detail = `${step}: ${describe((result as { failure: LambdaServiceFailure }).failure)}`;
      failed = true;
      break;
    }
  }
  return { status: 'cleaned', ...(failed ? { code: 'IMAGE_CLEANUP_INCOMPLETE' as const } : {}), images: selected };
}
