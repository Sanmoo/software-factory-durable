import type { EnvironmentRef } from './prepare.js';
import type { BootRef } from './lifecycle.js';

/** Fixed operational profile, never caller/worker scripts or a qualification flag.
 * First-boot stamps are smoke-test data, NOT authority, receipts or proof of all
 * data preservation. Independent inspection across boots must detect recreation.
 * The reserved .factory-profile area is outside the repository checkout/PR.
 */
export function guestStorageReadiness(environment: EnvironmentRef, boot: BootRef): string {
  if (!/^env-[a-f0-9]{64}$/.test(environment) ||
      !/^boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot)) {
    throw new Error('INVALID_STORAGE_PROFILE_IDENTITY');
  }
  return `set -eu
 test -s /etc/alpine-release
 test "$(docker info --format '{{.Driver}}')" = vfs
 umask 077
 environment='${environment}'
 boot='${boot}'
 for base in /root /tmp /var/tmp /var/cache /var/log /var/cache/apk /workspace /artifacts; do
   test -d "$base" || mkdir -p "$base"
   directory="$base/.factory-profile"
   test ! -L "$directory"
   mkdir -p "$directory"
   marker="$base/.factory-profile/storage-v1"
   test ! -L "$marker"
   if [ ! -e "$marker" ]; then
     (set -C; printf '%s' "$environment|$boot" > "$marker")
   fi
   test -f "$marker"
   test "$(head -c 160 "$marker" | wc -c)" -eq 110
   value="$(head -c 160 "$marker")"
   test "\${#value}" -eq 110
   printf '%s\\n' "$value" | grep -Eq "^$environment[|]boot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
 done
 for base in /workspace /artifacts; do
   probe="$base/.factory-profile/probe-$boot"
   mkdir "$probe"
   printf '%s' "$boot" > "$probe/value"
   mv "$probe/value" "$probe/renamed"
   ln -s "$probe/renamed" "$probe/alias"
   test "$(head -c 64 "$probe/alias")" = "$boot"
   rm "$probe/alias" "$probe/renamed"
   rmdir "$probe"
 done
 sync`;
}
