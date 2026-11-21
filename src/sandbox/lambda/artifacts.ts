import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ProposalIdentity } from '../../contracts/index.js';
import type { ArtifactSeed } from '../artifact-seeds.js';
import type { EvidenceExport } from '../evidence-export.js';
import { guestRepositoryDirectory } from './guest-programs.js';
import type { GuestExecRequest, LambdaChannel } from './transport.js';

/**
 * v2 ticket 06 (Operator decisions 1A, 2b-A, 2c; V2-08, V2-26, V2-34): what replaces the HOST reads of the workspace when the adapter has
 * no disk on the host. Every read here is ONE fixed program the host runs in the guest over the boot's channel: the agent chooses
 * neither the program nor its parameters, and the answer is a guest-attested OBSERVATION, never a host observation.
 *
 * - proposal identity (1A): the same light identity as `proposal-identity.ts`, computed inside the guest. It detects a change of the
 *   proposal during a review round; it is not proof against a hostile guest. The authoritative check is Control's own read of `origin`.
 * - preserved source (2b-A): the same two facts as the host read (the version's `sources.json` lists the file and the file exists).
 * - artifacts collection (2c): the review/spec/instructions trees copied to the host BEFORE a boot stops; what was not collected before a
 *   death is lost (V2-34).
 * - seed upload: Factory material (the skill pack) written into the empty guest of each boot.
 *
 * None of these programs ran in a real guest yet. They are exercised with the local `python3` against a temporary tree.
 */
export const guestArtifactsDirectory = '/artifacts';
export type GuestRoots = { checkout: string; artifacts: string; /** The guest's interpreter; tests name the local one. */ python?: string };
const defaultRoots: GuestRoots = { checkout: guestRepositoryDirectory, artifacts: guestArtifactsDirectory };
/** What one collection may carry over the channel (stdout is gathered whole on the host): beyond it the collection fails, never truncates. */
export const artifactCollectionBudget = Object.freeze({ files: 8192, bytes: 64 * 1024 * 1024 });

const program = String.raw`
import base64, hashlib, json, os, stat, sys

mode = sys.argv[1]
def digest(data): return hashlib.sha256(data).hexdigest()
def answer(value):
    sys.stdout.write(json.dumps(value, sort_keys=True) + "\n")
    sys.exit(0)
def parts_of(relative):
    parts = relative.split("/")
    if not relative or any(part in ("", ".", "..") for part in parts): return None
    return parts
# One path under a root, never following a link: (kind, sha256, size). A linked or missing parent is absence, as on the host.
def observe(root, relative, limit):
    parts = parts_of(relative)
    if parts is None: return ("unsafe", None, 0)
    path = root
    for part in parts[:-1]:
        path = os.path.join(path, part)
        try: info = os.lstat(path)
        except OSError: return ("absent", None, 0)
        if not stat.S_ISDIR(info.st_mode): return ("absent", None, 0)
    leaf = os.path.join(path, parts[-1])
    try: info = os.lstat(leaf)
    except FileNotFoundError: return ("absent", None, 0)
    except OSError: return ("other", None, 0)
    if stat.S_ISLNK(info.st_mode): return ("symlink", digest(os.fsencode(os.readlink(leaf))), 0)
    if not stat.S_ISREG(info.st_mode): return ("other", None, 0)
    if info.st_nlink != 1: return ("unsafe", None, 0)
    if info.st_size > limit: raise OverflowError()
    sha = hashlib.sha256()
    with open(leaf, "rb") as handle:
        for chunk in iter(lambda: handle.read(1048576), b""): sha.update(chunk)
    return ("file", sha.hexdigest(), info.st_size)
def read_plain(root, relative, limit):
    kind, _, size = observe(root, relative, limit)
    if kind != "file": return None
    parts = parts_of(relative)
    with open(os.path.join(root, *parts), "rb") as handle: return handle.read(limit + 1)[:limit]

if mode == "identity":
    checkout, artifacts, round_number = sys.argv[2], sys.argv[3], int(sys.argv[4])
    try:
        raw = read_plain(artifacts, "review/r%d/index.json" % round_number, 16 * 1024 * 1024)
        if raw is None: answer({"status": "unavailable", "code": "PROPOSAL_INDEX_MISSING"})
        index = json.loads(raw)
        entries = index.get("entries")
        head, branch = index.get("head"), index.get("branch")
        valid = (isinstance(entries, list) and len(entries) <= 5000 and index.get("round") == round_number
            and isinstance(index.get("counts"), dict) and index["counts"].get("entries") == len(entries)
            and all(isinstance(entry, dict) and isinstance(entry.get("path"), str) and isinstance(entry.get("present"), bool) for entry in entries)
            and len(set(entry["path"] for entry in entries)) == len(entries)
            and isinstance(head, str) and len(head) == 40 and (branch is None or isinstance(branch, str)))
        if not valid: answer({"status": "refused", "code": "PROPOSAL_INDEX_INVALID"})
        consistent, total, files = True, 0, []
        for entry in entries:
            kind, sha, size = observe(checkout, entry["path"], 256 * 1024 * 1024)
            total += size
            if total > 2 * 1024 * 1024 * 1024: answer({"status": "refused", "code": "PROPOSAL_TOO_LARGE"})
            files.append([entry["path"], kind, sha])
            expected = entry.get("kind", "other") if entry["present"] else "absent"
            if kind != expected or (sha is not None and sha != entry.get("sha256")): consistent = False
        git = {}
        names = ["HEAD", "index", "packed-refs"] + (["refs/heads/" + branch] if branch else [])
        for name in names:
            kind, sha, _ = observe(checkout, ".git/" + name, 256 * 1024 * 1024)
            git[name] = "%s:%s" % (kind, sha) if sha else kind
        if branch:
            ref = None
            loose = read_plain(checkout, ".git/refs/heads/" + branch, 4096)
            if loose is not None: ref = loose.decode("utf-8", "replace").strip()
            else:
                packed = read_plain(checkout, ".git/packed-refs", 16 * 1024 * 1024)
                for line in (packed or b"").decode("utf-8", "replace").split("\n"):
                    if line.endswith(" refs/heads/" + branch): ref = line.split(" ")[0]; break
            if ref != head: consistent = False
        identity = digest(json.dumps({"indexSha256": digest(raw), "files": files, "git": git}, sort_keys=True).encode())
        answer({"status": "observed", "sha256": identity, "indexSha256": digest(raw), "entries": len(entries), "consistent": consistent})
    except OverflowError: answer({"status": "refused", "code": "PROPOSAL_TOO_LARGE"})
    except SystemExit: raise
    except Exception: answer({"status": "unavailable", "code": "PROPOSAL_IDENTITY_UNAVAILABLE"})

if mode == "source":
    artifacts, kind, version, name = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
    try:
        raw = read_plain(artifacts, "%s/%s/sources.json" % (kind, version), 4 * 1024 * 1024)
        if raw is None: answer({"status": "invalid", "code": "PRESERVED_SOURCE_INDEX_MISSING"})
        sources = json.loads(raw).get("sources") or []
        listed = set(entry["copy"][2:] if entry["copy"].startswith("./") else entry["copy"] for entry in sources if isinstance(entry, dict) and isinstance(entry.get("copy"), str))
        if name not in listed: answer({"status": "invalid", "code": "PRESERVED_SOURCE_NOT_LISTED"})
        found, _, _ = observe(artifacts, "%s/%s/%s" % (kind, version, name), 16 * 1024 * 1024)
        if found != "file": answer({"status": "invalid", "code": "PRESERVED_SOURCE_MISSING"})
        answer({"status": "verified", "code": "PRESERVED_SOURCE_VERIFIED"})
    except SystemExit: raise
    except Exception: answer({"status": "invalid", "code": "PRESERVED_SOURCE_UNSAFE"})

if mode == "collect":
    artifacts, max_files, max_bytes = sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    try:
        if not os.path.isdir(artifacts) or os.path.islink(artifacts): answer({"status": "absent"})
        found, total = [], 0
        for tree in ("review", "spec", "instructions"):
            top = os.path.join(artifacts, tree)
            if not os.path.lexists(top): continue
            if os.path.islink(top) or not os.path.isdir(top): answer({"status": "failure", "code": "EVIDENCE_UNSAFE"})
            for directory, names, files in os.walk(top):
                names.sort()
                for name in names:
                    if os.path.islink(os.path.join(directory, name)): answer({"status": "failure", "code": "EVIDENCE_UNSAFE"})
                for name in sorted(files):
                    path = os.path.join(directory, name)
                    info = os.lstat(path)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: answer({"status": "failure", "code": "EVIDENCE_UNSAFE"})
                    total += info.st_size
                    if len(found) + 1 > max_files or total > max_bytes: answer({"status": "failure", "code": "EVIDENCE_TOO_LARGE"})
                    found.append(path)
        for path in found:
            with open(path, "rb") as handle: data = handle.read()
            sys.stdout.write(json.dumps({"path": os.path.relpath(path, artifacts), "data": base64.b64encode(data).decode()}) + "\n")
        answer({"status": "success", "files": len(found), "bytes": total})
    except SystemExit: raise
    except Exception: answer({"status": "failure", "code": "EVIDENCE_EXPORT_FAILED"})

if mode == "seed":
    target = sys.argv[2]
    try:
        if os.path.lexists(target): answer({"status": "failure", "code": "ARTIFACT_SEED_VERSION_CONFLICT"})
        written = 0
        for line in sys.stdin:
            if not line.strip(): continue
            entry = json.loads(line)
            parts = parts_of(entry["path"])
            if parts is None: answer({"status": "failure", "code": "ARTIFACT_SEED_INVALID"})
            path = os.path.join(target, *parts)
            os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            with os.fdopen(descriptor, "wb") as handle: handle.write(base64.b64decode(entry["data"]))
            written += 1
        answer({"status": "written", "files": written})
    except SystemExit: raise
    except Exception: answer({"status": "failure", "code": "ARTIFACT_SEED_UNAVAILABLE"})

answer({"status": "failure", "code": "PROGRAM_MODE_UNKNOWN"})
`;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const request = (name: string, roots: GuestRoots, parameters: readonly string[], stdin?: Uint8Array): GuestExecRequest => ({ program: name,
  script: `exec ${[roots.python ?? '/usr/bin/python3', '-I', '-S', '-c', program, ...parameters].map(quote).join(' ')}`, ...(stdin ? { stdin } : {}) });

/** The fixed program requests (exported so the in-process guest of the tests can recognise them by `program` name). */
export const proposalIdentityProgram = (round: number, roots: GuestRoots = defaultRoots) => request('proposal-identity', roots, ['identity', roots.checkout, roots.artifacts, String(round)]);
export const preservedSourceProgram = (source: { kind: string; version: string; file: string }, roots: GuestRoots = defaultRoots) =>
  request('preserved-source', roots, ['source', roots.artifacts, source.kind, source.version, source.file]);
export const collectArtifactsProgram = (roots: GuestRoots = defaultRoots, budget: { files: number; bytes: number } = artifactCollectionBudget) =>
  request('collect-artifacts', roots, ['collect', roots.artifacts, String(budget.files), String(budget.bytes)]);
export const seedProgram = (name: string, files: readonly { path: string; data: Buffer }[], roots: GuestRoots = defaultRoots) =>
  request('artifact-seed', roots, ['seed', `${roots.artifacts}/${name}`], Buffer.from(files.map(file => JSON.stringify({ path: file.path, data: file.data.toString('base64') })).join('\n') + '\n', 'utf8'));

/** The last line of a program's stdout is its answer; anything else is no answer (never a guessed one). */
function answerOf(result: Awaited<ReturnType<LambdaChannel['exec']>>): unknown {
  if (result.status !== 'exited' || result.exitCode !== 0) return null;
  const line = result.stdout.trimEnd().split('\n').at(-1) ?? '';
  try { return JSON.parse(line) as unknown; } catch { return null; }
}

const code = z.string().regex(/^[A-Z_]{1,64}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const identitySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('observed'), sha256, indexSha256: sha256, entries: z.number().int().nonnegative(), consistent: z.boolean() }),
  z.strictObject({ status: z.enum(['unavailable', 'refused']), code })]);

/**
 * Decision 1A: the identity of the handed-off proposal of `round`, computed in the guest by the fixed program. Guest-attested: on this
 * profile MVP §6.4 "identity observed by the Host" is an observation that detects change during review, nothing more.
 */
export async function observeLambdaProposal(channel: LambdaChannel, round: number, roots: GuestRoots = defaultRoots): Promise<ProposalIdentity> {
  if (!Number.isInteger(round) || round < 1 || round > 99) return { status: 'refused', code: 'PROPOSAL_ROUND_INVALID' };
  const parsed = identitySchema.safeParse(answerOf(await channel.exec(proposalIdentityProgram(round, roots))));
  if (!parsed.success) return { status: 'unavailable', code: 'PROPOSAL_IDENTITY_UNAVAILABLE' };
  return parsed.data.status === 'observed' ? { ...parsed.data, observedAt: new Date().toISOString() } : parsed.data;
}

const sourceSchema = z.strictObject({ status: z.enum(['verified', 'invalid']), code });
/**
 * Decision 2b-A: the two facts of a preserved-source authorization (listed in the version's `sources.json`, and present), read over the
 * channel before the boot stops. Same strength as the MVP host read: the content was always written by the guest.
 */
export async function verifyLambdaPreservedSource(channel: LambdaChannel, reference: string, roots: GuestRoots = defaultRoots): Promise<{ status: 'verified' | 'invalid'; code: string }> {
  const match = /^\/artifacts\/(spec|instructions)\/(v[1-9][0-9]{0,3})\/([^#]+)$/.exec(reference.split('#')[0]!);
  if (!match || match[3]!.split('/').some(part => part === '' || part === '.' || part === '..')) return { status: 'invalid', code: 'AUTHORIZATION_REFERENCE_INVALID' };
  const parsed = sourceSchema.safeParse(answerOf(await channel.exec(preservedSourceProgram({ kind: match[1]!, version: match[2]!, file: match[3]! }, roots))));
  return parsed.success ? parsed.data : { status: 'invalid', code: 'PRESERVED_SOURCE_UNAVAILABLE' };
}

const relativePath = z.string().max(4096).regex(/^(review|spec|instructions)\/[^\0]+$/).refine(path => !path.split('/').some(part => part === '' || part === '.' || part === '..'));
const fileLine = z.strictObject({ path: relativePath, data: z.string() });
const collectSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('success'), files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
  z.strictObject({ status: z.literal('absent') }), z.strictObject({ status: z.literal('failure'), code })]);
/**
 * Decision 2c: the review/spec/instructions trees of `/artifacts`, written under the caller's private `destination` exactly as the guest
 * holds them at this instant. `absent`: the guest has no artifacts tree. A failure writes a partial tree at most; the caller owns
 * `destination` and discards it. Returned as received: the host does not certify the content.
 */
export async function collectLambdaArtifacts(channel: LambdaChannel, destination: string, roots: GuestRoots = defaultRoots): Promise<EvidenceExport> {
  const result = await channel.exec(collectArtifactsProgram(roots));
  if (result.status !== 'exited' || result.exitCode !== 0) return { status: 'failure', code: 'EVIDENCE_EXPORT_FAILED' };
  const lines = result.stdout.trimEnd().split('\n');
  let last: unknown;
  try { last = JSON.parse(lines.at(-1) ?? ''); } catch { return { status: 'failure', code: 'EVIDENCE_EXPORT_FAILED' }; }
  const outcome = collectSchema.safeParse(last);
  if (!outcome.success) return { status: 'failure', code: 'EVIDENCE_EXPORT_FAILED' };
  if (outcome.data.status !== 'success') return outcome.data;
  let bytes = 0;
  try {
    for (const line of lines.slice(0, -1)) {
      const file = fileLine.parse(JSON.parse(line));
      const data = Buffer.from(file.data, 'base64');
      bytes += data.length;
      if (bytes > artifactCollectionBudget.bytes) return { status: 'failure', code: 'EVIDENCE_TOO_LARGE' };
      const path = join(destination, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, data, { flag: 'wx', mode: 0o600 });
    }
  } catch { return { status: 'failure', code: 'EVIDENCE_EXPORT_FAILED' }; }
  if (lines.length - 1 !== outcome.data.files) return { status: 'failure', code: 'EVIDENCE_EXPORT_FAILED' };
  return { status: 'success', files: outcome.data.files, bytes };
}

const seedName = /^factory\/[a-z0-9-]+\/[a-z0-9][a-z0-9.-]{0,63}$/;
const manifestSchema = z.object({ files: z.array(z.object({ path: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/).refine(path => !path.split('/').some(part => part === '.' || part === '..')),
  sha256 })).min(1).max(1024) });
const writtenSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('written'), files: z.number().int() }), z.strictObject({ status: z.literal('failure'), code })]);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type SeedManifest = { name: string; manifestSha256: string; reused: boolean };
/** A seed's manifest identity from the host copy only (the same value the Gondolin adapter records when it copies the seed). */
export async function seedManifests(seeds: readonly ArtifactSeed[]): Promise<SeedManifest[]> {
  return Promise.all(seeds.map(async seed => ({ name: seed.name, manifestSha256: sha(await readFile(join(seed.directory, 'manifest.json'))), reused: false })));
}
/**
 * Factory material of the release (the skill pack) written into the guest of THIS boot under `/artifacts/<name>`: exactly the manifest's
 * files, verified against the manifest on the host first. A boot starts empty, so this is sent at every start, never reused.
 */
export async function uploadLambdaSeeds(channel: LambdaChannel, seeds: readonly ArtifactSeed[], roots: GuestRoots = defaultRoots):
  Promise<{ status: 'success'; seeds: SeedManifest[] } | { status: 'failure'; code: string }> {
  const sent: SeedManifest[] = [];
  for (const seed of seeds) {
    if (!seedName.test(seed.name)) return { status: 'failure', code: 'ARTIFACT_SEED_INVALID' };
    let manifest: Buffer, files: { path: string; data: Buffer }[];
    try {
      manifest = await readFile(join(seed.directory, 'manifest.json'));
      const parsed = manifestSchema.parse(JSON.parse(manifest.toString('utf8')));
      files = await Promise.all(parsed.files.map(async file => {
        const data = await readFile(join(seed.directory, file.path));
        if (sha(data) !== file.sha256) throw new Error('ARTIFACT_SEED_SOURCE_DRIFT');
        return { path: file.path, data };
      }));
    } catch (error) { return { status: 'failure', code: error instanceof Error && error.message === 'ARTIFACT_SEED_SOURCE_DRIFT' ? error.message : 'ARTIFACT_SEED_INVALID' }; }
    const written = writtenSchema.safeParse(answerOf(await channel.exec(seedProgram(seed.name, [...files, { path: 'manifest.json', data: manifest }], roots))));
    if (!written.success) return { status: 'failure', code: 'ARTIFACT_SEED_UNAVAILABLE' };
    if (written.data.status === 'failure') return written.data;
    if (written.data.files !== files.length + 1) return { status: 'failure', code: 'ARTIFACT_SEED_UNAVAILABLE' };
    sent.push({ name: seed.name, manifestSha256: sha(manifest), reused: false });
  }
  return { status: 'success', seeds: sent };
}

export const restoredTrees = Object.freeze(['spec', 'instructions'] as const);
export type RestoredArtifacts = { status: 'restored'; /** `spec/v1`, `instructions/v2`…: the version directories written, in tree order. */ versions: string[]; files: number } | { status: 'failure'; code: string };
/**
 * v2 ticket 08 (Operator decision 3D): at the start of a boot the host re-sends ONLY `spec/` and `instructions/` from `source`, the host
 * copy of what was collected before the previous stop (decision 2c). Returned as received: the host certifies nothing about the content.
 * Review captures of earlier rounds and output copies are per boot and are never sent back. The same fixed write program as the seeds
 * (each tree is created, never merged into an existing one); a link or a special file in the host copy sends nothing.
 */
export async function restoreLambdaArtifacts(channel: LambdaChannel, source: string, roots: GuestRoots = defaultRoots): Promise<RestoredArtifacts> {
  const versions: string[] = [];
  let total = 0;
  const trees: { tree: string; files: { path: string; data: Buffer }[] }[] = [];
  try {
    for (const tree of restoredTrees) {
      const files: { path: string; data: Buffer }[] = [];
      const walk = async (relative: string): Promise<void> => {
        for (const name of (await readdir(join(source, tree, relative))).sort()) {
          const path = relative ? `${relative}/${name}` : name;
          const info = await lstat(join(source, tree, path));
          if (info.isDirectory()) { await walk(path); continue; }
          if (!info.isFile() || info.nlink !== 1) throw new Error('ARTIFACT_RESTORE_SOURCE_UNSAFE');
          total += info.size;
          if (files.length + 1 > artifactCollectionBudget.files || total > artifactCollectionBudget.bytes) throw new Error('ARTIFACT_RESTORE_TOO_LARGE');
          files.push({ path, data: await readFile(join(source, tree, path)) });
        }
      };
      let top;
      try { top = await lstat(join(source, tree)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!top.isDirectory()) throw new Error('ARTIFACT_RESTORE_SOURCE_UNSAFE');
      await walk('');
      if (!files.length) continue;
      trees.push({ tree, files });
      versions.push(...[...new Set(files.map(file => file.path.split('/')[0]!))].map(version => `${tree}/${version}`));
    }
  } catch (error) { return { status: 'failure', code: error instanceof Error && /^ARTIFACT_RESTORE_[A-Z_]+$/.test(error.message) ? error.message : 'ARTIFACT_RESTORE_SOURCE_UNAVAILABLE' }; }
  let files = 0;
  for (const { tree, files: content } of trees) {
    const written = writtenSchema.safeParse(answerOf(await channel.exec(seedProgram(tree, content, roots))));
    if (!written.success) return { status: 'failure', code: 'ARTIFACT_RESTORE_UNAVAILABLE' };
    if (written.data.status === 'failure') return { status: 'failure', code: written.data.code === 'ARTIFACT_SEED_VERSION_CONFLICT' ? 'ARTIFACT_RESTORE_CONFLICT' : 'ARTIFACT_RESTORE_FAILED' };
    if (written.data.files !== content.length) return { status: 'failure', code: 'ARTIFACT_RESTORE_UNAVAILABLE' };
    files += content.length;
  }
  return { status: 'restored', versions, files };
}
