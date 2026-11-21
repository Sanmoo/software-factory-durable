// Private console-text observations, never readiness/cessation or causal proof.
// SDK delivers normalized lines. We retain no raw text and do not reassemble it.
const exact = new Map<string, string>([
  ['[initramfs] virtio ports not ready', 'initramfs-ports-unready-text'],
  ['[initramfs] udhcpc failed', 'initramfs-network-failed-text'],
  ['[initramfs] root device /dev/vda not found', 'initramfs-root-device-missing-text'],
  ['[initramfs] failed to mount /dev/vda', 'initramfs-root-mount-failed-text'],
  ['[init] /dev entries:', 'root-init-text'],
  ['[init] starting sandboxfs at /data', 'sandboxfs-launch-text'],
  ['[init] sandboxfs mount not ready', 'sandboxfs-unready-text'],
  // SDK emits this BEFORE the injected Docker hook, not after sandboxd exec.
  ['[init] starting sandboxd', 'pre-sandboxd-hook-text'],
]);
const prefixes = [
  ['Linux version ', 'kernel-version-text'],
  ['ACPI:', 'acpi-text'],
  ['Run /init as init process', 'kernel-init-attempt-text'],
  ['Kernel panic - not syncing:', 'kernel-panic-text'],
  ['VFS: Unable to mount root fs', 'kernel-rootfs-error-text'],
] as const;

export function createBootMarkers(boot: string) {
  const stages = new Set<string>();
  let callbacks = 0;
  let oversized = 0;
  let sealed = false;
  return {
    observe(component: unknown, message: unknown) {
      if (sealed || component !== 'qemu' || typeof message !== 'string') return;
      callbacks = Math.min(1024, callbacks + 1);
      // No slicing, regex or copy of an oversized raw callback.
      if (message.length > 4096) {
        oversized = Math.min(1024, oversized + 1);
        return;
      }
      if (!message.startsWith('stdout: ') || message.includes('\n') || message.includes('\r')) return;
      stages.add('console-text-observed');
      const line = message.slice(8).replace(/^\[\s{0,12}\d{1,8}\.\d{1,8}\]\s{0,4}/, '');
      const marker = exact.get(line) ?? prefixes.find(([prefix]) => line.startsWith(prefix))?.[1];
      if (marker) stages.add(marker);
    },
    seal() {
      sealed = true;
      return { version: 1 as const, boot, stages: [...stages], callbacks, oversized };
    },
  };
}
