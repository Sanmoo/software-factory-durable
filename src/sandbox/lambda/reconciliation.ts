import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BootRef } from '../lifecycle.js';
import type { EnvironmentRef } from '../prepare.js';
import {
  closeUnansweredLambdaStart,
  listLambdaBoots,
  listLambdaEnvironments,
  terminateAndConfirm,
  type LambdaBootDependencies,
  type LambdaBootRecord,
} from './boot.js';
import { installationTagKey, workTagKey } from './installation.js';
import type { LambdaProfile } from './profile.js';
import type { LambdaListedMicrovm, LambdaServiceFailure } from './service.js';

/**
 * v2 ticket 15 (V2-33, V2-34): the inventory of the installation's MicroVMs, taken when the controller starts (after the exclusive lock,
 * before the storage opens), and the part of the reconciliation only the adapter can do.
 *
 * Whose MicroVM is it. ListMicrovms shows every MicroVM of the account and region. One belongs to this installation when it carries
 * this installation's tag; the observed listing shows no MicroVM tags, and then it belongs when its IMAGE is one of the installation's
 * (named `factory-<installation>-<32 hex>` and itself tagged with the installation, read with GetMicrovmImage). Anything else is another
 * installation's or somebody else's: counted, never read by id, never changed, never reported by id.
 *
 * Who owns it. The owner of a boot lives in the controller process, so a controller crash leaves its MicroVMs running with nobody:
 * - A MicroVM held by a boot record that has not ended is LISTED, with its environment and Work. Control decides: it stops the boot of
 *   every Execution that is not alive (`stop`, confirmed by GetMicrovm), exactly as it does for any adapter, and never adopts it.
 * - A MicroVM no boot record holds cannot belong to any Execution: Control addresses a boot only through its record (RunMicrovm answered
 *   a process that died before writing the id, or the answer was unreadable). The inventory terminates it and confirms with GetMicrovm.
 * - A start that never recorded an id is closed only when the listing was read and every MicroVM it could have left was confirmed ended.
 *
 * Every inventory that found something of the installation leaves a record under `<root>/lambda/reconciliations/`. The lifecycle evidence in it is GetMicrovm's:
 * Run and Terminate do not appear in CloudTrail by default, and there are no runtime logs without an execution role.
 */
export type ReconciliationRecord = {
  boot: string;
  environment: string;
  workId: string;
  phase: LambdaBootRecord['phase'];
  microvmId?: string | undefined;
  imageArn: string;
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `imageArn` is NAMED as an image of the installation (`factory-acme-2-...` is not an image of `acme`). */
export const namedInstallationImage = (installation: string, imageArn: string | undefined) =>
  imageArn !== undefined && new RegExp(`:microvm-image:factory-${escaped(installation)}-[a-f0-9]{32}$`).test(imageArn);

/**
 * Pure rule of the inventory. `images` holds the tags read from each image NAMED as the installation's (`null`: the read failed).
 * `orphans` are to be terminated, `held` listed for Control, `unverifiable` reported and left alone.
 */
export function planLambdaReconciliation({
  installation,
  microvms,
  images,
  records,
}: {
  installation: string;
  microvms: readonly LambdaListedMicrovm[];
  images: Readonly<Record<string, Readonly<Record<string, string>> | null>>;
  records: readonly ReconciliationRecord[];
}) {
  const held: { microvmId: string; environment: string; boot: string; workId: string }[] = [];
  const orphans: { microvmId: string; workId: string | null }[] = [];
  const unverifiable: string[] = [];
  let otherInstallations = 0;
  const open = records.filter(record => record.phase !== 'ended');
  for (const microvm of microvms) {
    const tagged = microvm.tags?.[installationTagKey];
    let ownership: 'own' | 'other' | 'unverifiable';
    if (tagged !== undefined) ownership = tagged === installation ? 'own' : 'other';
    else if (!namedInstallationImage(installation, microvm.imageArn)) ownership = 'other';
    else {
      const tags = images[microvm.imageArn!];
      ownership = tags === null || tags === undefined ? 'unverifiable' : tags[installationTagKey] === installation ? 'own' : 'other';
    }
    if (ownership === 'other') {
      otherInstallations++;
      continue;
    }
    // A terminated MicroVM stays listed by the service; there is nothing left to end.
    if (microvm.state === 'TERMINATED') continue;
    if (ownership === 'unverifiable') {
      unverifiable.push(microvm.microvmId);
      continue;
    }
    const holder = open.find(record => record.microvmId === microvm.microvmId);
    if (holder) held.push({ microvmId: microvm.microvmId, environment: holder.environment, boot: holder.boot, workId: holder.workId });
    else orphans.push({ microvmId: microvm.microvmId, workId: microvm.tags?.[workTagKey] ?? null });
  }
  const unansweredStarts = open
    .filter(record => record.phase === 'requested' && !record.microvmId)
    .map(record => ({ environment: record.environment, boot: record.boot, workId: record.workId }));
  return { held, orphans, unverifiable, unansweredStarts, otherInstallations };
}

export type LambdaRuntimeReconciliation =
  /** `environments`: what still runs under a boot record, for Control to settle. `unknown`: what the adapter could not end or attribute. */
  | { status: 'reconciled'; at: string; environments: { environment: string; workId: string }[]; unknown: string[] }
  /** The account could not be listed: the inventory is unknown and nothing was changed. */
  | { status: 'unavailable'; code: 'MICROVM_INVENTORY_UNAVAILABLE'; detail: string };

const describe = (failure: LambdaServiceFailure) => [failure.kind, failure.action, failure.detail].filter(Boolean).join(': ').slice(0, 400);

export async function reconcileLambdaInstallation(
  dependencies: Pick<LambdaBootDependencies, 'root' | 'service' | 'clock'>,
  profile: LambdaProfile,
): Promise<LambdaRuntimeReconciliation> {
  const { root, clock } = dependencies;
  const unavailable = (detail: string): LambdaRuntimeReconciliation => ({ status: 'unavailable', code: 'MICROVM_INVENTORY_UNAVAILABLE', detail });
  const service = dependencies.service({ awsProfile: profile.awsProfile, region: profile.region });
  const listed = await service.listMicrovms();
  if (!listed.ok) return unavailable(describe(listed.failure));
  const records: LambdaBootRecord[] = [];
  try {
    for (const environment of await listLambdaEnvironments(root)) records.push(...(await listLambdaBoots(root, environment)));
  } catch {
    return unavailable('a boot record of this installation is unreadable');
  }
  // Only images NAMED as this installation's are read, and only for MicroVMs whose own tags the listing does not show.
  const images: Record<string, Record<string, string> | null> = {};
  for (const microvm of listed.value) {
    if (microvm.tags?.[installationTagKey] !== undefined || microvm.state === 'TERMINATED' || !namedInstallationImage(profile.installation, microvm.imageArn))
      continue;
    if (microvm.imageArn! in images) continue;
    const image = await service.image(microvm.imageArn!);
    images[microvm.imageArn!] = image.ok ? image.value.tags : null;
  }
  const planned = planLambdaReconciliation({ installation: profile.installation, microvms: listed.value, images, records });
  const at = new Date(clock.now()).toISOString();
  const unknown = planned.unverifiable.map(microvmId => `lambda/microvm/${microvmId}`);
  const microvms: {
    microvmId: string;
    workId: string | null;
    boot?: string;
    action: 'terminated' | 'listed' | 'unverifiable';
    cessation: 'confirmed' | 'unconfirmed' | 'not-requested';
    state?: string;
    stateReason?: string;
    startedAt?: string;
    terminatedAt?: string;
  }[] = [
    ...planned.held.map(item => ({
      microvmId: item.microvmId,
      workId: item.workId,
      boot: item.boot,
      action: 'listed' as const,
      cessation: 'not-requested' as const,
    })),
    ...planned.unverifiable.map(microvmId => ({ microvmId, workId: null, action: 'unverifiable' as const, cessation: 'not-requested' as const })),
  ];
  let allEnded = planned.unverifiable.length === 0;
  for (const orphan of planned.orphans) {
    const cessation = await terminateAndConfirm(service, orphan.microvmId, clock);
    if (!cessation.confirmed) {
      allEnded = false;
      unknown.push(`lambda/microvm/${orphan.microvmId}`);
    }
    // What is recorded about the end is what GetMicrovm answered (V2-34).
    microvms.push({
      microvmId: orphan.microvmId,
      workId: orphan.workId,
      action: 'terminated',
      cessation: cessation.confirmed ? 'confirmed' : 'unconfirmed',
      ...(cessation.confirmed
        ? {
            state: cessation.microvm.state,
            ...(cessation.microvm.stateReason ? { stateReason: cessation.microvm.stateReason } : {}),
            ...(cessation.microvm.startedAt ? { startedAt: cessation.microvm.startedAt } : {}),
            ...(cessation.microvm.terminatedAt ? { terminatedAt: cessation.microvm.terminatedAt } : {}),
          }
        : {}),
    });
  }
  const boots: { environment: string; boot: string; workId: string; action: 'closed' | 'left-open' }[] = [];
  for (const start of planned.unansweredStarts) {
    const closed =
      allEnded &&
      (await closeUnansweredLambdaStart(dependencies, { environment: start.environment as EnvironmentRef, boot: start.boot as BootRef }).catch(() => false));
    boots.push({ ...start, action: closed ? 'closed' : 'left-open' });
  }
  // An inventory that found nothing of the installation running and nothing open leaves no record: there is nothing to account for.
  if (microvms.length > 0 || boots.length > 0) {
    const directory = join(await realpath(root), 'lambda', 'reconciliations');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `${at.replace(/[:.]/g, '-')}-${randomUUID()}.json`;
    await writeFile(
      join(directory, `${name}.tmp`),
      JSON.stringify({
        version: 1,
        at,
        installation: profile.installation,
        region: profile.region,
        evidence: 'GetMicrovm',
        listed: listed.value.length,
        otherInstallations: planned.otherInstallations,
        microvms,
        boots,
      }),
      { mode: 0o600, flag: 'wx' },
    );
    await rename(join(directory, `${name}.tmp`), join(directory, name));
  }
  const environments = [...new Map(planned.held.map(item => [item.environment, { environment: item.environment, workId: item.workId }])).values()];
  return { status: 'reconciled', at, environments, unknown };
}
