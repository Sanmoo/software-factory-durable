// TEST ONLY. Ticket 34 pre-pilot group R-HOSTFAULT (V-14.c): host disk pressure — below the space floor, a FULL disk (real ENOSPC) and ENOSPC
// right after a native preparation effect — against the REAL Factory (Sandbox.validate/prepare, host capacity, Control SQLite storage) whose
// root lives on a DISPOSABLE ext4 filesystem created for this test. Import and `--plan` are inert. No GitHub, no VM boot, no model, no
// credential. The integrity of a guest disk after a deliberate owner death is an ACCEPTED limit (D-06) and is out of scope.
//
// Confinement (never the real home or root filesystem):
//   image   the recipe creates ONE preallocated ext4 image file of `imageBytes` in its own namespace: NOCOW (`chattr +C` on the EMPTY file,
//           so btrfs writes it in place, uncompressed), then `fallocate`, then `mkfs.ext4 -E nodiscard` (mkfs would otherwise punch the
//           allocation away again). Its blocks are taken from the home filesystem ONCE, up front, so filling the disposable filesystem can
//           never grow home usage. Proven, not assumed: allocated bytes >= size and (btrfs home) the C attribute, re-checked in every phase.
//   mount   an OPERATOR step (rootless udisksctl, or sudo as the alternative) mounts that image; the recipe never mounts/unmounts.
//   guard   every later phase re-verifies, before any write, that the Factory root and the filler directory are on a mount whose source is a
//           loop device backed by EXACTLY that image, of ext4 type, at most `maxDisposableBytes`, on a device different from $HOME's and '/'.
//           Every filler file is fstat-checked on that device before it is grown. The recipe removes ONLY its own filler files (the operator's
//           freeing of space); the Factory itself is never asked to delete anything.
// Phases are one-shot: an exclusive intent tombstone precedes effects; a consumed phase never reruns; nothing is retried automatically.

const user = 'sanmoo';
const root = `/home/${user}/software-factory-test/y5`;
const observations = `${root}/q34-hostfault-v2`;
// v1 held at `image` (real run, btrfs /home): mkfs.ext4 discarded the fallocated image (72 MB of 6 GiB still allocated). v2: NOCOW + nodiscard.
const revision = 'q34-hostfault-v2';
export const phases = ['image', 'preflight', 'floor', 'full', 'native', 'release', 'inspect'] as const;
export type Phase = typeof phases[number];
const gib = 1024 ** 3, mib = 1024 ** 2;
const label = 'qhf34v1';
export const imageBytes = 6 * gib;
export const maxDisposableBytes = 8 * gib;
const image = `${observations}/disk.img`;
/** udisksctl mounts by label under /run/media/<user>; the sudo alternative mounts on the namespace's own mnt/. Exactly one must be the image. */
export const mountCandidates = [`/run/media/${user}/${label}`, `${observations}/mnt`] as const;
/** Home must keep at least this much free AFTER the image is allocated (the image is the only home allocation of the recipe). */
const homeReserveBytes = 32 * gib;
/** diskGiB 1 holds the 823 MB assets34 rootfs; preparation admission needs 2 x diskGiB + minFreeSpaceGiB = 3 GiB free. */
const configuration = { schemaVersion: 1, profile: 'gondolin-qemu-alpine-dev-v1', memoryMiB: 2048, vcpus: 2, diskGiB: 1, shutdownGraceSeconds: 30, minFreeSpaceGiB: 1 } as const;
const floorBytes = configuration.minFreeSpaceGiB * gib;
const preparationBytes = (2 * configuration.diskGiB + configuration.minFreeSpaceGiB) * gib;
const guestAssets = { directory: `/home/${user}/software-factory-test/assets34/assets`, manifestSha256: '8efa506aed5f8fcbd9a233c7e30aa5d4418f83d47456a5a430d4666d07ade807' } as const;
const works = { floor: 'q34hf-floor', full: 'q34hf-full', native: 'q34hf-native', fresh: 'q34hf-fresh' } as const;
const ext4Magic = '0xef53';
export const btrfsMagic = '0x9123683e';

/** Pure: the image creation commands, in order (the empty file is created by the recipe itself with O_EXCL). */
export function imageCommands(path: string, uid: number | undefined, gid: number | undefined): string[][] {
  return [['/usr/bin/chattr', '+C', path], ['/usr/bin/fallocate', '-l', String(imageBytes), path],
    ['/usr/bin/mkfs.ext4', '-q', '-F', '-m', '0', '-L', label, '-E', `nodiscard,root_owner=${uid}:${gid}`, path]];
}
/** Pure: the NOCOW flag from `lsattr <file>` output (null when unreadable). */
export function nocowAttribute(output: string): boolean | null {
  const flags = output.trim().split(/\s+/)[0];
  return flags && /^[-a-zA-Z]+$/.test(flags) ? flags.includes('C') : null;
}

export function plan() {
  return { revision, root, observations, phases, image: { path: image, bytes: imageBytes, label, filesystem: 'ext4 -m 0 (no reserved blocks), root owned by the operator account', preallocated: 'chattr +C (empty file, NOCOW), fallocate -l (never sparse), mkfs.ext4 -E nodiscard; verified every phase: allocated >= size, NOCOW on a btrfs home' },
    mountCandidates, maxDisposableBytes, configuration, guestAssets, floorBytes, preparationBytes, works,
    requires: ['explicit operator authorization for THIS run (host fault injection: disk space), one-shot; a consumed namespace is never reused',
      `home filesystem with at least ${(imageBytes + homeReserveBytes) / gib} GiB free before image`, 'the operator mounts the image (step below) between image and preflight',
      'nothing else of the Factory runs on the disposable filesystem', 'no btrfs snapshot of /home taken during the run and no fstrim of the loop mount (either would break the NOCOW/preallocation proof; the next phase then holds IMAGE_NOT_PREALLOCATED)', 'no VM, GitHub, model or credential is used'],
    operator: {
      afterImage: {
        rootless: [`udisksctl loop-setup --no-user-interaction -f ${image}   # prints /dev/loopN`,
          'udisksctl mount --no-user-interaction -b /dev/loopN -o nosuid,nodev   # mounts on ' + mountCandidates[0]],
        sudo: [`mkdir -m 700 ${mountCandidates[1]}`, `sudo mount -o loop,nosuid,nodev,noexec ${image} ${mountCandidates[1]}`],
        note: 'Use the sudo alternative only if polkit refuses udisksctl outside an active local session. The recipe never runs sudo, mount or losetup.' },
      afterInspect: {
        rootless: ['udisksctl unmount -b /dev/loopN', 'udisksctl loop-delete -b /dev/loopN', `rm ${image}`],
        sudo: [`sudo umount ${mountCandidates[1]}`, `rm ${image}`] } },
    effects: [
      `image: exclusive namespace; home free space checked; ONE file ${image} preallocated with fallocate and formatted by mkfs.ext4 (rootless, a regular file); nothing mounted`,
      'preflight: read-only verification of the mount (mountinfo, loop backing file, ext4, size, devices distinct from $HOME and /, owner, empty); creates <mount>/root (Factory root) and <mount>/filler',
      `floor: filler grown until free space is ${(floorBytes - 256 * mib) / mib} MiB (below the ${configuration.minFreeSpaceGiB} GiB floor); Sandbox.validate, Sandbox.prepare(${works.floor}), host capacity observation; Control storage created on the disposable root and ONE durable pause accepted`,
      `full: filler grown to real ENOSPC (fallocate, then 1 MiB and 4 KiB writes until ENOSPC); Sandbox.prepare(${works.full}); Control storage reopened and ONE unpause attempted (no ACK expected)`,
      `native: the recipe removes its OWN filler down to ${preparationBytes / gib} GiB + 256 MiB free (admission passes); Sandbox.prepare(${works.native}) runs and, as soon as its environment directory appears, the recipe allocates the remaining space (real ENOSPC after the native effect began)`,
      `release: the recipe removes ALL its own filler; Sandbox.prepare(${works.native}) again (incomplete preparation never adopted), Sandbox.prepare(${works.fresh}) (pressure recovered, nothing deleted), Control storage reopened (state consistent)`,
      'inspect: verdict from the saved results; secret-shape scan of the namespace and the disposable root; prints the operator teardown'],
    guards: ['one-shot intent tombstones and phase order', 'every write re-verifies the disposable mount; a filler file is grown only after an fstat on the mount device',
      'the recipe deletes only files it created under <mount>/filler', 'the Factory is never asked to remove/cleanup anything', 'no retry'],
    expected: [
      'floor: validate storage blocked; prepare INSUFFICIENT_STORAGE_FOR_PREPARATION with NO environment directory created; capacity diagnostic blocked; the durable pause accepted (the floor is a sandbox admission, not a storage refusal)',
      'full: statfs available below 64 KiB; prepare INSUFFICIENT_STORAGE_FOR_PREPARATION, nothing created; the unpause gets NO durable receipt (refused/thrown); no Factory file deleted',
      'native: the cut is reached (filler allocated after the environment directory appeared and before prepare returned); prepare indeterminate (ENVIRONMENT_PREPARATION_INCOMPLETE or _UNAVAILABLE), its owner.json kept',
      'release: the same Work again indeterminate (never adopted, never repaired); a fresh Work prepares successfully; every Factory file seen before is still present; Control storage readable, paused state as last ACKed',
      'verdict: passed only if every check holds; inconclusive when the native cut was missed or the mount guard could not be read; failed on any deletion, adoption, ACK without durability or green-by-absence'],
  };
}

/** Phase order: each phase once and only after the previous one SUCCEEDED (a held phase is consumed and never followed). */
export function phaseGuard(phase: Phase, results: Partial<Record<Phase, { status?: unknown } | null>>, intents: ReadonlySet<string>): string | null {
  if (intents.has(`${phase}-intent`)) return 'PHASE_ALREADY_RAN';
  const index = phases.indexOf(phase);
  const previous = index > 0 ? phases[index - 1]! : null;
  if (previous && results[previous]?.status !== 'success') return `${previous.toUpperCase()}_SUCCESS_REQUIRED`;
  return null;
}

export type MountEntry = { majorMinor: string; mountPoint: string; fstype: string; source: string; options: string };
/** Pure: /proc/self/mountinfo lines (octal escapes such as \040 decoded). */
export function parseMountinfo(text: string): MountEntry[] {
  const unescape = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  return text.split('\n').filter(Boolean).flatMap(line => {
    const [left, right] = line.split(' - ');
    const fields = left?.split(' ') ?? [];
    const tail = right?.split(' ') ?? [];
    if (fields.length < 6 || tail.length < 2) return [];
    return [{ majorMinor: fields[2]!, mountPoint: unescape(fields[4]!), options: fields[5]!, fstype: tail[0]!, source: unescape(tail[1]!) }];
  });
}

export type MountFacts = { candidate: string; entry: MountEntry | undefined; backingFile: string | null; imagePath: string;
  statfs: { type: string; totalBytes: number; availableBytes: number } | null; mountDev: number | null; homeDev: number; rootDev: number;
  owner: { uid: number; mode: number } | null; uid: number; entries: string[]; imageAllocatedBytes: number;
  /** statfs type of the filesystem holding the image (the home), and the image's NOCOW flag (lsattr). */
  homeFs: string | null; imageNocow: boolean | null };
/** Pure: the disposable-filesystem guard. Every problem is named; an empty list is the only way to write. */
export function confinementProblems(facts: MountFacts, { requireEmpty }: { requireEmpty: boolean }): string[] {
  const problems: string[] = [];
  if (!facts.entry) problems.push('NOT_A_MOUNT_POINT');
  if (facts.entry && !/^\/dev\/loop[0-9]{1,3}$/.test(facts.entry.source)) problems.push('MOUNT_SOURCE_NOT_A_LOOP_DEVICE');
  if (facts.entry && facts.entry.fstype !== 'ext4') problems.push('MOUNT_NOT_EXT4');
  if (facts.backingFile === null || facts.backingFile.replace(/ \(deleted\)$/, '') !== facts.imagePath || / \(deleted\)$/.test(facts.backingFile)) problems.push('LOOP_NOT_BACKED_BY_THE_RECIPE_IMAGE');
  if (!facts.statfs) problems.push('STATFS_UNREADABLE');
  else {
    if (facts.statfs.type !== ext4Magic) problems.push('STATFS_NOT_EXT4');
    if (facts.statfs.totalBytes > maxDisposableBytes) problems.push('DISPOSABLE_FILESYSTEM_TOO_LARGE');
  }
  if (facts.mountDev === null || facts.mountDev === facts.homeDev || facts.mountDev === facts.rootDev) problems.push('MOUNT_DEVICE_NOT_DISTINCT');
  if (!facts.owner || facts.owner.uid !== facts.uid) problems.push('MOUNT_ROOT_NOT_OWNED_BY_OPERATOR');
  if (facts.imageAllocatedBytes < imageBytes) problems.push('IMAGE_NOT_PREALLOCATED');
  // btrfs is copy-on-write: without NOCOW a write into the image may allocate NEW home blocks despite the preallocation.
  if (facts.homeFs === btrfsMagic && facts.imageNocow !== true) problems.push('IMAGE_NOT_NOCOW_ON_BTRFS');
  if (requireEmpty && facts.entries.some(name => name !== 'lost+found')) problems.push('MOUNT_NOT_EMPTY');
  return problems;
}

/** Pure: bytes to allocate so that `target` bytes stay free (never negative; null when already below target). */
export function fillBytes(availableBytes: number, targetFreeBytes: number): number | null {
  const bytes = availableBytes - targetFreeBytes;
  return bytes > 0 ? Math.floor(bytes / 4096) * 4096 : null;
}

export type FileManifest = Record<string, { size: number; sha256: string | null }>;
/** Pure: Factory files present before and missing after (deletion), ignoring the recipe's own filler. SQLite WAL/SHM may change size, never vanish. */
export function deletedFiles(before: FileManifest, after: FileManifest): string[] {
  return Object.keys(before).filter(path => !path.startsWith('filler/') && !(path in after)).sort();
}
/** Pure: Factory files whose CONTENT changed (only immutable preparation outputs are hashed; SQLite files are excluded by the manifest). */
export function rewrittenFiles(before: FileManifest, after: FileManifest): string[] {
  return Object.keys(before).filter(path => before[path]!.sha256 !== null && after[path] && after[path]!.sha256 !== before[path]!.sha256).sort();
}

type Prepared = { status: string; code?: string };
export type HostFaultResults = {
  floor: { validateStorage: string | null; prepare: Prepared; environmentsCreated: number; capacity: string | null; pause: { receipt: string | null; error: string | null }; availableBytes: number } | null;
  full: { availableBytes: number; enospcObserved: boolean; prepare: Prepared; environmentsCreated: number; unpause: { receipt: string | null; error: string | null }; deleted: string[] } | null;
  native: { cutReached: boolean; prepare: Prepared; ownerKept: boolean; deleted: string[] } | null;
  release: { again: Prepared; fresh: Prepared; deleted: string[]; rewritten: string[]; controlReadable: boolean; paused: boolean | null; lastAckedPaused: boolean | null } | null;
};
export type Assessment = { status: 'passed' | 'failed' | 'inconclusive'; checks: Record<string, boolean>; inconclusive: string[]; failures: string[] };
/** The verdict of the run (no secret involved). A deletion, an adoption or an ACK without durability FAILS; a missed native cut proves nothing. */
export function assess(results: HostFaultResults): Assessment {
  const { floor, full, native, release } = results;
  const indeterminate = (prepared: Prepared | undefined) => prepared?.status === 'indeterminate' && ['ENVIRONMENT_PREPARATION_INCOMPLETE', 'ENVIRONMENT_PREPARATION_UNAVAILABLE'].includes(prepared.code ?? '');
  const checks = {
    floorRefusedBeforeEffect: floor?.prepare.status === 'failure' && floor.prepare.code === 'INSUFFICIENT_STORAGE_FOR_PREPARATION' && floor.environmentsCreated === 0 && floor.availableBytes < floorBytes,
    floorDiagnosed: floor?.validateStorage === 'blocked' && floor.capacity === 'blocked',
    floorStorageStillDurable: floor?.pause.receipt === 'durable',
    diskFull: (full?.availableBytes ?? Infinity) < 64 * 1024 && full?.enospcObserved === true,
    fullRefusedBeforeEffect: full?.prepare.status === 'failure' && full.prepare.code === 'INSUFFICIENT_STORAGE_FOR_PREPARATION' && full.environmentsCreated === 0,
    noAckWithoutDurability: full !== null && full.unpause.receipt !== 'durable',
    nativeEnospcPreserved: native?.cutReached === true && indeterminate(native.prepare) && native.ownerKept,
    incompleteNeverAdopted: indeterminate(release?.again),
    pressureRecovered: release?.fresh.status === 'success',
    nothingDeleted: [...(full?.deleted ?? []), ...(native?.deleted ?? []), ...(release?.deleted ?? [])].length === 0 && (release?.rewritten.length ?? 1) === 0,
    controlConsistent: release?.controlReadable === true && release.paused !== null && release.paused === release.lastAckedPaused,
  };
  const failures = (['floorRefusedBeforeEffect', 'fullRefusedBeforeEffect', 'noAckWithoutDurability', 'incompleteNeverAdopted', 'nothingDeleted', 'controlConsistent'] as const)
    .filter(key => !checks[key] && !(key === 'incompleteNeverAdopted' && native?.cutReached === false));
  const inconclusive = [...(native && !native.cutReached ? ['NATIVE_CUT_NOT_REACHED'] : []), ...(full && !full.enospcObserved ? ['ENOSPC_NOT_REACHED'] : []),
    ...(!floor || !full || !native || !release ? ['PHASE_RESULT_MISSING'] : [])];
  const status = failures.length ? 'failed' : inconclusive.length ? 'inconclusive' : Object.values(checks).every(Boolean) ? 'passed' : 'failed';
  return { status, checks, inconclusive, failures };
}

async function io() {
  const fs = await import('node:fs/promises');
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 1);
    if (Buffer.byteLength(text) > 8 * mib) throw new Error('OBSERVATION_LIMIT');
    if (/gh[sopu]_[A-Za-z0-9]{20,}|PRIVATE KEY/.test(text)) throw new Error('OBSERVATION_SECRET_SHAPE');
    const file = await fs.open(`${observations}/${name}.json`, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  };
  const exists = (name: string) => fs.access(`${observations}/${name}.json`).then(() => true, () => false);
  const load = (name: string) => fs.readFile(`${observations}/${name}.json`, 'utf8').then(text => JSON.parse(text) as { status?: unknown } & Record<string, unknown>, () => null);
  return { fs, save, exists, load };
}

async function run(command: string, args: string[]) {
  const { execFile } = await import('node:child_process');
  return new Promise<{ code: number; stdout: string }>(resolve => execFile(command, args, { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, maxBuffer: mib, shell: false, encoding: 'utf8' },
    (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout })));
}

/** Read-only facts of the image file: allocated bytes, the home filesystem type and the NOCOW flag. */
async function imageFacts() {
  const fs = await import('node:fs/promises');
  const info = await fs.stat(image).catch(() => null);
  const homeFs = await fs.statfs(observations, { bigint: true }).then(value => `0x${value.type.toString(16)}`, () => null);
  const listed = info ? await run('/usr/bin/lsattr', [image]) : null;
  return { imageAllocatedBytes: info ? info.blocks * 512 : 0, homeFs, imageNocow: listed?.code === 0 ? nocowAttribute(listed.stdout) : null };
}

/** Live facts of one mount candidate (read-only). */
async function mountFacts(candidate: string): Promise<MountFacts> {
  const fs = await import('node:fs/promises');
  const real = await fs.realpath(candidate).catch(() => candidate);
  const entry = parseMountinfo(await fs.readFile('/proc/self/mountinfo', 'utf8')).filter(item => item.mountPoint === real).at(-1);
  const loop = entry && /^\/dev\/(loop[0-9]{1,3})$/.exec(entry.source)?.[1];
  const backingFile = loop ? (await fs.readFile(`/sys/block/${loop}/loop/backing_file`, 'utf8').catch(() => null))?.trim() ?? null : null;
  const statfs = await fs.statfs(real, { bigint: true }).then(value => ({ type: `0x${value.type.toString(16)}`, totalBytes: Number(value.blocks * value.bsize), availableBytes: Number(value.bavail * value.bsize) }), () => null);
  const info = await fs.stat(real).catch(() => null);
  const imageInfo = await fs.stat(image).catch(() => null);
  return { candidate: real, entry, backingFile, imagePath: await fs.realpath(image).catch(() => image), statfs, mountDev: info?.dev ?? null,
    homeDev: (await fs.stat(`/home/${user}`)).dev, rootDev: (await fs.stat('/')).dev, owner: info ? { uid: info.uid, mode: info.mode & 0o777 } : null, uid: process.getuid?.() ?? -1,
    entries: await fs.readdir(real).catch(() => []), ...await imageFacts() };
}

/** The verified disposable mount recorded by preflight, re-verified now (never writes without it). */
async function verifiedMount(load: (name: string) => Promise<Record<string, unknown> | null>) {
  const preflight = await load('preflight-result') as { mountPoint?: string; mountDev?: number } | null;
  if (!preflight?.mountPoint) throw new Error('PREFLIGHT_SUCCESS_REQUIRED');
  const facts = await mountFacts(preflight.mountPoint);
  const problems = confinementProblems(facts, { requireEmpty: false });
  if (problems.length || facts.mountDev !== preflight.mountDev) throw new Error(`DISPOSABLE_MOUNT_UNVERIFIED:${problems.join(',') || 'DEVICE_CHANGED'}`);
  return { mount: facts.candidate, dev: facts.mountDev!, factoryRoot: `${facts.candidate}/root`, filler: `${facts.candidate}/filler` };
}

/** Grows ONE new filler file by `bytes`, only after an fstat proves it lives on the disposable device. */
async function grow(mount: { dev: number; filler: string }, name: string, bytes: number) {
  const fs = await import('node:fs/promises');
  if (!/^f-[a-z0-9-]{1,32}$/.test(name)) throw new Error('FILLER_NAME_INVALID');
  const path = `${mount.filler}/${name}`;
  const file = await fs.open(path, 'wx', 0o600);
  try { if ((await file.stat()).dev !== mount.dev) throw new Error('FILLER_NOT_ON_DISPOSABLE_DEVICE'); } finally { await file.close(); }
  const result = await run('/usr/bin/fallocate', ['-l', String(bytes), path]);
  return { path, code: result.code };
}
/** Fills the disposable filesystem to real ENOSPC with bounded appends after the bulk allocation. */
async function fillToEnospc(mount: { dev: number; filler: string }) {
  const fs = await import('node:fs/promises');
  const file = await fs.open(`${mount.filler}/f-tail`, 'wx', 0o600);
  let enospc = false;
  try {
    if ((await file.stat()).dev !== mount.dev) throw new Error('FILLER_NOT_ON_DISPOSABLE_DEVICE');
    // Two stages (1 MiB, then 4 KiB), each bounded and each ending at ENOSPC; the result is whether the LAST stage met ENOSPC.
    for (const size of [mib, 4096]) {
      const chunk = Buffer.alloc(size, 0x5a);
      enospc = false;
      for (let index = 0; index < 4096 && !enospc; index++) {
        await file.write(chunk).then(async () => { await file.sync(); }, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOSPC') enospc = true; else throw error; });
      }
    }
  } finally { await file.close().catch(() => {}); }
  return enospc;
}

const available = async (path: string) => {
  const fs = await import('node:fs/promises');
  const value = await fs.statfs(path, { bigint: true });
  return Number(value.bavail * value.bsize);
};

/** Bounded manifest of the Factory root: sizes of every regular file, sha256 of immutable preparation outputs (never SQLite or filler). */
async function manifest(base: string): Promise<FileManifest> {
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const result: FileManifest = {};
  const entries = await fs.readdir(base, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries.slice(0, 5000)) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const path = `${entry.parentPath}/${entry.name}`;
    const relative = path.slice(base.length + 1);
    const info = await fs.lstat(path);
    const hashed = /\.(json)$/.test(entry.name) && info.size <= mib;
    result[relative] = { size: info.size, sha256: hashed ? createHash('sha256').update(await fs.readFile(path)).digest('hex') : null };
  }
  return result;
}
const environmentsOf = async (factoryRoot: string) => {
  const fs = await import('node:fs/promises');
  return (await fs.readdir(`${factoryRoot}/environments`).catch(() => [])).filter(name => /^env-[a-f0-9]{64}$/.test(name));
};

async function factory(factoryRoot: string) {
  const { createSandbox, observeHostCapacity, capacityDiagnostic } = await import('../../src/sandbox/index.js');
  return { sandbox: createSandbox({ root: factoryRoot, guestAssets }), observeHostCapacity, capacityDiagnostic };
}
/** One local durable request on the disposable Control storage: the receipt kind, or the error code (never an ACK by assumption). */
async function controlRequest(storagePath: string, operation: 'pause' | 'unpause', request_id: string) {
  const { openControl } = await import('../../src/control/index.js');
  let control: Awaited<ReturnType<typeof openControl>> | undefined;
  try {
    control = await openControl({ storagePath, runtimeInventory: 'empty' });
    const receipt = await control.accept({ request_id, operation, origin: 'local-cli' }) as { kind?: string };
    return { receipt: receipt.kind ?? null, error: null };
  } catch (error) {
    return { receipt: null, error: error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message.slice(0, 96) : 'UNKNOWN' };
  } finally {
    const halt = new AbortController(); halt.abort();
    await control?.run(halt.signal).catch(() => {});
  }
}

export async function runPhase(phase: Phase) {
  if (!phases.includes(phase)) throw new Error('UNKNOWN_PHASE');
  const { fs, save, exists, load } = await io();
  if (phase === 'image') {
    const home = await available(`/home/${user}`);
    if (home < imageBytes + homeReserveBytes) throw new Error('HOME_FREE_SPACE_INSUFFICIENT'); // before ANY effect
    await fs.mkdir(observations, { mode: 0o700 }); // EXCLUSIVE: never adopt an existing qualification
  }
  const results: Partial<Record<Phase, { status?: unknown } | null>> = {};
  for (const item of phases) results[item] = await load(`${item}-result`);
  const intents = new Set((await Promise.all(phases.map(async item => await exists(`${item}-intent`) ? `${item}-intent` : null))).filter((item): item is string => item !== null));
  const refused = phaseGuard(phase, results, intents);
  if (refused) throw new Error(refused);
  await save(`${phase}-intent`, { revision, phase, at: new Date().toISOString() });
  try {
    if (phase === 'image') {
      const file = await fs.open(image, 'wx', 0o600); await file.close();
      const codes: number[] = [];
      for (const [command, ...args] of imageCommands(image, process.getuid?.(), process.getgid?.())) {
        const result = await run(command!, args);
        codes.push(result.code);
        if (result.code !== 0) break; // never continue past a failed step
      }
      const facts = await imageFacts();
      const problems = [...(facts.imageAllocatedBytes < imageBytes ? ['IMAGE_NOT_PREALLOCATED'] : []), ...(facts.homeFs === btrfsMagic && facts.imageNocow !== true ? ['IMAGE_NOT_NOCOW_ON_BTRFS'] : [])];
      if (codes.length !== 3 || codes.some(code => code !== 0) || problems.length) { await save('image-held', { codes, ...facts, problems }); throw new Error('IMAGE_NOT_CREATED'); }
      await save('image-result', { status: 'success', image, bytes: imageBytes, ...facts, homeAvailableAfter: await available(`/home/${user}`),
        operatorNext: plan().operator.afterImage });
      return;
    }
    if (phase === 'preflight') {
      const facts = await Promise.all(mountCandidates.map(candidate => mountFacts(candidate)));
      const mounted = facts.filter(item => confinementProblems(item, { requireEmpty: true }).length === 0);
      if (mounted.length !== 1) { await save('preflight-held', { candidates: facts.map(item => ({ ...item, problems: confinementProblems(item, { requireEmpty: true }) })) }); throw new Error('DISPOSABLE_MOUNT_NOT_VERIFIED'); }
      const mount = mounted[0]!;
      await fs.mkdir(`${mount.candidate}/root`, { mode: 0o700 }); await fs.mkdir(`${mount.candidate}/filler`, { mode: 0o700 });
      await save('preflight-result', { status: 'success', mountPoint: mount.candidate, mountDev: mount.mountDev, source: mount.entry!.source, backingFile: mount.backingFile, statfs: mount.statfs,
        homeDev: mount.homeDev, rootDev: mount.rootDev });
      return;
    }
    const mount = await verifiedMount(load);
    const storagePath = `${mount.factoryRoot}/control.sqlite`;
    const { sandbox, observeHostCapacity, capacityDiagnostic } = await factory(mount.factoryRoot);
    if (phase === 'floor') {
      const bytes = fillBytes(await available(mount.mount), floorBytes - 256 * mib);
      if (bytes === null) throw new Error('ALREADY_BELOW_TARGET');
      const grown = await grow(mount, 'f-floor', bytes);
      const free = await available(mount.mount);
      const validated = await sandbox.validate(configuration);
      const before = await environmentsOf(mount.factoryRoot);
      const prepared = await sandbox.prepare({ workId: works.floor, configuration });
      const after = await environmentsOf(mount.factoryRoot);
      const capacity = capacityDiagnostic({ concurrency: 1, configuration: { ...configuration }, host: await observeHostCapacity(mount.factoryRoot) });
      const pause = await controlRequest(storagePath, 'pause', 'q34hf-floor-pause');
      await save('floor-result', { status: grown.code === 0 ? 'success' : 'held', availableBytes: free, validateStorage: validated.checks.find(item => item.id === 'storage')?.status ?? null,
        prepare: prepared, environmentsCreated: after.length - before.length, capacity: capacity.status, pause, manifest: await manifest(mount.factoryRoot) });
      return;
    }
    if (phase === 'full') {
      const before = await manifest(mount.factoryRoot);
      const bulk = fillBytes(await available(mount.mount), 16 * mib);
      if (bulk !== null) await grow(mount, 'f-full', bulk);
      const enospcObserved = await fillToEnospc(mount);
      const free = await available(mount.mount);
      const environments = await environmentsOf(mount.factoryRoot);
      const prepared = await sandbox.prepare({ workId: works.full, configuration });
      const unpause = await controlRequest(storagePath, 'unpause', 'q34hf-full-unpause');
      const after = await manifest(mount.factoryRoot);
      await save('full-result', { status: 'success', availableBytes: free, enospcObserved, prepare: prepared, environmentsCreated: (await environmentsOf(mount.factoryRoot)).length - environments.length,
        unpause, deleted: deletedFiles(before, after), manifest: after });
      return;
    }
    if (phase === 'native') {
      const before = await manifest(mount.factoryRoot);
      // The operator's freeing of space: ONLY the recipe's own bulk filler of the full phase and its tail are removed.
      await fs.rm(`${mount.filler}/f-tail`); await fs.rm(`${mount.filler}/f-full`, { force: true });
      const headroom = fillBytes(await available(mount.mount), preparationBytes + 256 * mib);
      if (headroom !== null) await grow(mount, 'f-native-pre', headroom);
      const { watch } = await import('node:fs');
      await fs.mkdir(`${mount.factoryRoot}/environments`, { recursive: true, mode: 0o700 }).catch(() => {});
      const known = new Set(await environmentsOf(mount.factoryRoot));
      let done = false, cut: Promise<{ at: string; environment: string; code: number }> | null = null;
      const watcher = watch(`${mount.factoryRoot}/environments`, (_event, name) => {
        if (cut || done || !name || !/^env-[a-f0-9]{64}$/.test(String(name)) || known.has(String(name))) return;
        // 1 MiB left: far below the remaining copy of the 823 MB rootfs, so the native copy/convert meets a real ENOSPC.
        cut = (async () => { const bytes = fillBytes(await available(mount.mount), mib) ?? 4096; const grown = await grow(mount, 'f-native-cut', bytes);
          return { at: new Date().toISOString(), environment: String(name), code: grown.code }; })();
      });
      let prepared: Prepared;
      try { prepared = await sandbox.prepare({ workId: works.native, configuration }); } finally { done = true; watcher.close(); }
      const observed = cut ? await (cut as Promise<{ at: string; environment: string; code: number }>) : null;
      const environment = observed?.environment ?? (await environmentsOf(mount.factoryRoot)).find(name => !known.has(name)) ?? null;
      const ownerKept = environment ? await fs.access(`${mount.factoryRoot}/environments/${environment}/owner.json`).then(() => true, () => false) : false;
      const after = await manifest(mount.factoryRoot);
      await save('native-result', { status: 'success', cut: observed, cutReached: observed !== null && observed.code === 0 && prepared.status !== 'success', prepare: prepared, environment,
        ownerKept, deleted: deletedFiles(before, after), manifest: after });
      return;
    }
    if (phase === 'release') {
      const before = await manifest(mount.factoryRoot);
      for (const name of await fs.readdir(mount.filler)) if (/^f-[a-z0-9-]{1,32}$/.test(name)) await fs.rm(`${mount.filler}/${name}`);
      const again = await sandbox.prepare({ workId: works.native, configuration });
      const fresh = await sandbox.prepare({ workId: works.fresh, configuration });
      const { openControl } = await import('../../src/control/index.js');
      const { snapshotStorage } = await import('./review12-qualification.js');
      let controlReadable = false, paused: boolean | null = null;
      try {
        const copy = await snapshotStorage(mount.factoryRoot, `${observations}/release-storage-copy`);
        const stored = await openControl({ storagePath: copy, runtimeInventory: 'unknown' });
        const status = await stored.inspect({ kind: 'status' }) as { paused?: boolean };
        const halt = new AbortController(); halt.abort(); await stored.run(halt.signal);
        controlReadable = true; paused = typeof status.paused === 'boolean' ? status.paused : null;
      } catch { controlReadable = false; }
      const floor = await load('floor-result') as { pause?: { receipt: string | null } } | null;
      const full = await load('full-result') as { unpause?: { receipt: string | null } } | null;
      // The last ACKed request decides: the floor pause (durable) unless the full-phase unpause was ACKed too.
      const lastAckedPaused = full?.unpause?.receipt === 'durable' ? false : floor?.pause?.receipt === 'durable' ? true : null;
      const after = await manifest(mount.factoryRoot);
      const { inventoryRuntime } = await import('../../src/sandbox/index.js');
      await save('release-result', { status: 'success', again, fresh, controlReadable, paused, lastAckedPaused, deleted: deletedFiles(before, after), rewritten: rewrittenFiles(before, after),
        inventory: await inventoryRuntime(mount.factoryRoot), availableBytes: await available(mount.mount) });
      return;
    }
    const pick = async <T>(name: string) => (await load(`${name}-result`)) as T | null;
    const { secretScan } = await import('./credential20-qualification.js');
    const verdict = assess({ floor: await pick('floor'), full: await pick('full'), native: await pick('native'), release: await pick('release') });
    await save('inspect-result', { status: 'success', verdict, secretShapes: await secretScan([observations, mount.factoryRoot]), operatorNext: plan().operator.afterInspect });
  } catch (error) {
    await save(`${phase}-held`, { phase, status: 'held', code: error instanceof Error ? error.message.slice(0, 160) : 'UNKNOWN', note: 'Consumed; no retry.' }).catch(() => {});
    throw new Error('QUALIFICATION_HELD');
  }
}

export async function main(args: string[]) {
  if (args.length === 1 && args[0] === '--plan') { console.log(JSON.stringify(plan(), null, 2)); return; }
  if (args.length !== 1 || !phases.includes(args[0] as Phase)) throw new Error('EXACT_PHASE_REQUIRED');
  await runPhase(args[0] as Phase);
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
    console.error(`Qualification held; no retry. (${(error instanceof Error ? error.message : String(error)).slice(0, 128)})`); process.exit(1);
  });
}
