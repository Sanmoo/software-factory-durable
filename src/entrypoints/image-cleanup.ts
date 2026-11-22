import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readConfiguration } from './configuration.js';
import { inspectRelease } from './release.js';
import { cleanupLambdaImages, type ImageCleanupResult, type LambdaServiceFactory } from '../sandbox/index.js';

/**
 * v2 ticket 15 (V2-33): `factory cleanup-images [<image name>] [--yes]`, the explicit cleanup of the installation's MicroVM images. It is
 * an installation command (images are shared by Works with the same environment key), run by the CLI itself like `doctor`, with the
 * installation's validated configuration. Without `--yes` it shows the plan and changes nothing; with it, every removable image (or the
 * named one) is deleted. An image in use is never deleted: naming one is refused with `IMAGE_IN_USE`.
 *
 * `lambdaService`: composition input (the `aws` CLI by default, the in-memory account in tests).
 */
export type ImageCleanupReport =
  (ImageCleanupResult & { root: string }) | { status: 'refused'; code: 'CONFIGURATION_INVALID' | 'IMAGE_CLEANUP_NOT_APPLICABLE'; root: string; images: [] };

export async function cleanupImages(
  root: string,
  options: { image?: string | undefined; confirm: boolean; lambdaService?: LambdaServiceFactory },
): Promise<ImageCleanupReport> {
  const canonicalRoot = await realpath(root).catch(() => resolve(root));
  const release = await inspectRelease(canonicalRoot);
  const { configuration } = await readConfiguration(canonicalRoot, release.guestAssets, options.lambdaService ? { lambdaService: options.lambdaService } : {});
  if (!configuration.valid) return { status: 'refused', code: 'CONFIGURATION_INVALID', root: canonicalRoot, images: [] };
  const result = await cleanupLambdaImages({
    root: canonicalRoot,
    configuration: configuration.effective.sandbox,
    image: options.image,
    confirm: options.confirm,
    ...(options.lambdaService ? { lambdaService: options.lambdaService } : {}),
  });
  // Only the Lambda adapter keeps images in an account; another adapter's environments are removed with their Works.
  if (!result) return { status: 'refused', code: 'IMAGE_CLEANUP_NOT_APPLICABLE', root: canonicalRoot, images: [] };
  return { ...result, root: canonicalRoot };
}

/** 0: planned or cleaned completely; 1: refused, unreadable account or incomplete deletion; 2: not a usable Lambda installation. */
export const imageCleanupExitCode = (report: ImageCleanupReport): number =>
  report.code === 'CONFIGURATION_INVALID' || report.code === 'IMAGE_CLEANUP_NOT_APPLICABLE' ? 2 : report.code ? 1 : 0;

export function imageCleanupText(report: ImageCleanupReport): string {
  const lines = report.images.map(
    image =>
      `${image.imageName}: ${image.outcome ?? image.decision} (${image.state}` +
      `${image.works.length ? `; Works ${image.works.join(', ')}` : ''}${image.running ? `; ${image.running} MicroVM(s) running` : ''})${image.detail ? ` — ${image.detail}` : ''}`,
  );
  const head =
    report.status === 'planned'
      ? 'Plan (nothing was changed; repeat with --yes to delete what is removable):'
      : report.status === 'cleaned'
        ? `Cleanup ${report.code ? 'incomplete' : 'done'}:`
        : `${report.code}${'detail' in report && report.detail ? `: ${report.detail}` : ''}`;
  return [head, ...(lines.length || report.status === 'refused' || report.status === 'unavailable' ? lines : ['No MicroVM image of this installation.'])].join(
    '\n',
  );
}
