import type { VM, RealFSProvider } from '@earendil-works/gondolin';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gondolinSdkProfile, verifyDevelopmentGondolinSdk } from './gondolin-sdk-profile.js';

type RuntimeExports = { VM: typeof VM; RealFSProvider: typeof RealFSProvider };

/** Closed private SDK selection. Reverify even when Node caches the namespace.
 * No preparation, repair, legacy fallback or caller-selected module/loader.
 * Provenance comes from the pinned full-tree verifier, not export shape alone.
 * This is source selection, not admission, guest or native-capacity qualification.
 */
export async function loadDevelopmentGondolinSdk(): Promise<RuntimeExports> {
  // The adapter's systemd working directory is not the application checkout.
  // Compiled dist/src/sandbox location fixes selection independently of cwd.
  const project = fileURLToPath(new URL('../../../', import.meta.url));
  await verifyDevelopmentGondolinSdk(project);
  // The verifier checks canonical owned directory chains and this exact tree.
  // Never import the installed SDK entry, nor accept a URL from profile JSON.
  const entry = pathToFileURL(join(project, gondolinSdkProfile.directory, 'sdk/dist/src/index.js')).href;
  // Only this fixed verified entry is computed; the type-only public SDK import
  // above keeps the Sandbox SDK ownership edge visible to dependency-cruiser.
  // eslint-disable-next-line no-restricted-syntax -- Closed canonical profile entry, verified immediately above; no caller URL.
  const sdk: RuntimeExports = await import(entry);
  if (typeof sdk.VM !== 'function' || typeof sdk.VM.create !== 'function' || typeof sdk.RealFSProvider !== 'function') {
    throw new Error('GONDOLIN_RUNTIME_EXPORTS');
  }
  return { VM: sdk.VM, RealFSProvider: sdk.RealFSProvider };
}
