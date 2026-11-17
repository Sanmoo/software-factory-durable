import { z } from 'zod';
import type { ProposalHandoff } from '../contracts/index.js';

/**
 * GUEST-ONLY constant program (never model-supplied, never run by the Factory on a host tree). The Builder worker HOST runs it through the
 * Builder's own confined Bash binding right after suspending the Builder (spec §5.6/§6.4): it writes the round's index and diffs into a NEW
 * `/artifacts/review/r<N>/` (exclusive: an existing round is never overwritten) and prints a small summary. Covers committed (base..HEAD),
 * staged, unstaged, new (untracked, not ignored) and removed paths, each with presence/mode/hash, plus HEAD/branch/base/merge-base and
 * the latest COMPLETE preserved request/instructions versions. No commit, clean tree, copy or snapshot is required. Git runs in the guest
 * with hooks/fsmonitor/pager/external diff disabled; this is a cooperative capture, not a freeze against concurrent writers.
 * argv: checkout artifacts round baseCommit checkoutView artifactsView [mode] [preserve].
 * Ticket 21: `preserve` (capture mode only) is the remote tip of the Work's branch whose concrete divergence the operator authorized to be
 * incorporated; the summary then states whether that commit is an ancestor of HEAD (`git merge-base --is-ancestor`), computed by this
 * constant program, never declared by the model.
 */
export const handoffCaptureProgram = String.raw`import hashlib, json, os, re, stat, subprocess, sys
stage = "input"
def fail(code, status=3):
    sys.stderr.write("FACTORY_HANDOFF_ERROR " + code + " " + stage + "\n")
    sys.stderr.flush()
    raise SystemExit(status)
def unexpected(kind, value, trace):
    sys.stderr.write("FACTORY_HANDOFF_ERROR UNEXPECTED " + stage + "\n")
    sys.stderr.flush()
    os._exit(5)
sys.excepthook = unexpected
if len(sys.argv) not in (7, 8, 9):
    fail("INPUT_INVALID", 2)
checkout, artifacts, rnd, base, checkout_view, artifacts_view = sys.argv[1:7]
mode = sys.argv[7] if len(sys.argv) >= 8 else "capture"
preserve = sys.argv[8] if len(sys.argv) == 9 else None
if mode not in ("capture", "probe") or not re.fullmatch(r"[1-9][0-9]?", rnd) or not re.fullmatch(r"[0-9a-f]{40}", base):
    fail("INPUT_INVALID", 2)
if preserve is not None and (mode != "capture" or not re.fullmatch(r"[0-9a-f]{40}", preserve)):
    fail("INPUT_INVALID", 2)
out = os.path.join(artifacts, "review", "r" + rnd)
view = artifacts_view + "/review/r" + rnd
env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LC_ALL": "C", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
       "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"}
# safe.directory on the command line: the guest root sees the FUSE checkout owned by another uid, and NOSYSTEM ignores /etc/gitconfig.
G = ["/usr/bin/git", "-C", checkout, "-c", "safe.directory=" + checkout, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat",
     "-c", "diff.external=", "-c", "core.quotePath=false", "-c", "diff.noprefix=false"]
def git(*args, ok=(0,)):
    p = subprocess.run(G + list(args), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    if p.returncode not in ok:
        fail("GIT_FAILED")
    return p.stdout
def text(b):
    return b.decode("utf-8", "surrogateescape")
stage = "git-head"
head = text(git("rev-parse", "--verify", "HEAD^{commit}")).strip()
branch = text(git("symbolic-ref", "-q", "--short", "HEAD", ok=(0, 1))).strip() or None
stage = "git-merge-base"
merge_base = text(git("merge-base", base, "HEAD", ok=(0, 1))).strip() or None
preserved = None
if preserve is not None:
    # Ticket 21: 0 = ancestor; 1 = not an ancestor; 128 = the commit is not even present locally (never incorporated).
    stage = "git-preserve"
    p = subprocess.run(G + ["merge-base", "--is-ancestor", preserve, "HEAD"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if p.returncode not in (0, 1, 128):
        fail("GIT_FAILED")
    preserved = {"commit": preserve, "ancestor": p.returncode == 0}
entries = {}
def entry(path):
    return entries.setdefault(path, {"path": path, "guestPath": checkout_view + "/" + path, "committed": None, "staged": None,
                                     "unstaged": None, "untracked": False})
stage = "git-diff-committed"
names = git("diff", "--name-status", "-z", "--no-renames", base, "HEAD").split(b"\0")
for i in range(0, len(names) - 1, 2):
    entry(text(names[i + 1]))["committed"] = text(names[i])[:1]
stage = "git-status"
for record in git("status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames").split(b"\0"):
    kind = record[:1]
    if kind == b"1":
        fields = record.split(b" ", 8)
        xy = text(fields[1])
        item = entry(text(fields[8]))
        item["staged"] = None if xy[0] == "." else xy[0]
        item["unstaged"] = None if xy[1] == "." else xy[1]
    elif kind == b"u":
        fields = record.split(b" ", 10)
        item = entry(text(fields[10]))
        item["staged"] = "U"
        item["unstaged"] = "U"
    elif kind == b"?":
        entry(text(record[2:]))["untracked"] = True
if len(entries) > 5000:
    fail("TOO_MANY_ENTRIES", 4)
stage = "hash"
def digest(data):
    return hashlib.sha256(data).hexdigest()
for path, item in entries.items():
    full = os.path.join(checkout, path)
    try:
        info = os.lstat(full)
    except FileNotFoundError:
        item["present"] = False
        continue
    item["present"] = True
    item["mode"] = "%o" % info.st_mode
    if stat.S_ISLNK(info.st_mode):
        item["kind"] = "symlink"
        item["sha256"] = digest(os.fsencode(os.readlink(full)))
    elif stat.S_ISREG(info.st_mode):
        item["kind"] = "file"
        item["bytes"] = info.st_size
        h = hashlib.sha256()
        with open(full, "rb") as handle:
            for chunk in iter(lambda: handle.read(1048576), b""):
                h.update(chunk)
        item["sha256"] = h.hexdigest()
    else:
        item["kind"] = "other"
stage = "git-head-blobs"
# Ticket 13: the HEAD blob of every indexed path, hashed by content (oids carry no newline, unlike paths), to prove a commit holds the tree.
listing = {}
for record in git("ls-tree", "-r", "-z", "--full-tree", "HEAD").split(b"\0"):
    if not record:
        continue
    meta, _, name = record.partition(b"\t")
    fields = meta.split(b" ")
    if len(fields) == 3 and fields[1] == b"blob":
        listing[text(name)] = text(fields[2])
wanted = sorted(set(listing[path] for path in entries if path in listing))
blobs = {}
if wanted:
    p = subprocess.run(G + ["cat-file", "--batch"], input=("\n".join(wanted) + "\n").encode(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    if p.returncode != 0:
        fail("GIT_FAILED")
    data, at = p.stdout, 0
    for oid in wanted:
        end = data.index(b"\n", at)
        header = data[at:end].split(b" ")
        if len(header) != 3 or text(header[0]) != oid or header[1] != b"blob":
            fail("GIT_FAILED")
        size = int(header[2])
        blobs[oid] = digest(data[end + 1:end + 1 + size])
        at = end + 1 + size + 1
for path, item in entries.items():
    item["headSha256"] = blobs.get(listing[path]) if path in listing else None
ordered = [entries[key] for key in sorted(entries)]
counts = {"entries": len(ordered), "committed": sum(1 for e in ordered if e["committed"]), "staged": sum(1 for e in ordered if e["staged"]),
          "unstaged": sum(1 for e in ordered if e["unstaged"]), "untracked": sum(1 for e in ordered if e["untracked"]),
          "removed": sum(1 for e in ordered if not e["present"])}
changed = [e["guestPath"] for e in ordered if e["present"] and e.get("kind") == "file"]
identity = [[e["path"], e["present"], e.get("kind"), e.get("mode"), e.get("sha256")] for e in ordered]
clean = not any(e["staged"] or e["unstaged"] or e["untracked"] for e in ordered)
head_matches = all((e["headSha256"] is not None and e.get("kind") in ("file", "symlink") and e["headSha256"] == e.get("sha256")) if e["present"]
                   else e["headSha256"] is None for e in ordered)
content = {"sha256": digest(json.dumps(identity, separators=(",", ":")).encode()), "clean": clean, "headMatches": head_matches}
stage = "write"
if mode == "probe":
    # Ticket 13 (Host content snapshot): the SAME identity computation, writing nothing and opening no round directory.
    sys.stdout.write(json.dumps(content, sort_keys=True))
    raise SystemExit(0)
os.makedirs(os.path.join(artifacts, "review"), exist_ok=True)
try:
    os.mkdir(out, 0o755)
except FileExistsError:
    fail("ROUND_EXISTS")
def write(name, data):
    with open(os.path.join(out, name), "xb") as handle:
        handle.write(data)
    return {"path": view + "/" + name, "bytes": len(data), "sha256": digest(data)}
diff = ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color"]
stage = "git-diff-patches"
patches = {"committed": write("committed.patch", git(*diff, base, "HEAD")), "staged": write("staged.patch", git(*diff, "--cached")),
           "unstaged": write("unstaged.patch", git(*diff))}
own_changed = None
if preserved is not None and preserved["ancestor"]:
    # q34-ghadv-v2/v3: the review SUBJECT of a reconciliation is the Builder's own work on top of the authorized remote tip (the human commits
    # are context): its patch and its present changed files (changed since that tip, or in the working tree).
    stage = "git-diff-own"
    patches["own"] = write("own.patch", git(*diff, preserve, "HEAD"))
    since = set(text(name) for name in git("diff", "--name-only", "-z", "--no-renames", preserve, "HEAD").split(b"\0") if name)
    own_changed = [e["guestPath"] for e in ordered if e["present"] and e.get("kind") == "file" and
                   (e["path"] in since or e["staged"] or e["unstaged"] or e["untracked"])]
def latest(kind):
    best = None
    try:
        names = os.listdir(os.path.join(artifacts, kind))
    except FileNotFoundError:
        return None
    for name in names:
        match = re.fullmatch(r"v([1-9][0-9]{0,3})", name)
        path = os.path.join(artifacts, kind, name, "sources.json")
        if not match or not os.path.isdir(os.path.join(artifacts, kind, name)) or os.path.islink(path) or not os.path.isfile(path):
            continue
        with open(path, "rb") as handle:
            data = handle.read(4194305)
        try:
            complete = json.loads(data).get("complete") is True
        except Exception:
            complete = False
        if complete and (best is None or int(match.group(1)) > best[0]):
            best = (int(match.group(1)), {"version": name, "sources": artifacts_view + "/" + kind + "/" + name + "/sources.json", "sha256": digest(data)})
    return best and best[1]
summary = {"version": 1, "round": int(rnd), "index": view + "/index.json", "head": head, "branch": branch, "base": base, "mergeBase": merge_base,
           "counts": counts, "patches": patches, "spec": latest("spec"), "instructions": latest("instructions"),
           "changed": changed[:20], "changedTruncated": len(changed) > 20, "content": content}
if preserved is not None:
    summary["preserved"] = preserved
if own_changed is not None:
    summary["ownChanged"] = own_changed[:20]
    summary["ownChangedTruncated"] = len(own_changed) > 20
index = dict(summary, checkout=checkout_view, entries=ordered,
             reviewerNote="Read each listed guestPath and patch with the read tool, with offset/limit to continue; read beyond the hunks for context.")
index_bytes = json.dumps(index, indent=1, sort_keys=True).encode()
write("index.json", index_bytes)
summary["indexSha256"] = digest(index_bytes)
sys.stdout.write(json.dumps(summary, sort_keys=True))
`;

const hex40 = /^[0-9a-f]{40}$/;
const command = (round: number, baseCommit: string, mode: 'capture' | 'probe', preserve?: string) => {
  if (!Number.isInteger(round) || round < 1 || round > 99 || !hex40.test(baseCommit)) throw new Error('HANDOFF_INPUT_INVALID');
  if (preserve !== undefined && (mode !== 'capture' || !hex40.test(preserve))) throw new Error('HANDOFF_INPUT_INVALID');
  if (handoffCaptureProgram.includes('FACTORY_HANDOFF_EOF')) throw new Error('HANDOFF_INPUT_INVALID');
  const extra = mode === 'probe' ? ' probe' : preserve !== undefined ? ` capture ${preserve}` : '';
  return `exec /usr/bin/python3 -I -S - /workspace/checkout /artifacts ${round} ${baseCommit} /workspace/checkout /artifacts${extra} <<'FACTORY_HANDOFF_EOF'\n${handoffCaptureProgram}\nFACTORY_HANDOFF_EOF\n`;
};
/** Fixed Builder-binding Bash command (Host-originated): the program arrives on a quoted heredoc, never interpolated. */
export const handoffCommand = (round: number, baseCommit: string, preserve?: string) => command(round, baseCommit, 'capture', preserve);
/** Ticket 13: the same constant program in probe mode (Host content snapshot before/after a Builder command; writes nothing). */
export const contentProbeCommand = (baseCommit: string) => command(1, baseCommit, 'probe');

const guestPath = (prefix: string) => z.string().max(4096).refine(path => path.startsWith(prefix) && !path.split('/').includes('..'));
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** Host parse of a probe's stdout; anything else is an unavailable snapshot (never a guessed identity). */
export const contentProbeSchema = z.strictObject({ sha256, clean: z.boolean(), headMatches: z.boolean() });
const count = z.number().int().nonnegative().max(1_000_000);
const patch = z.strictObject({ path: guestPath('/artifacts/review/r'), bytes: count.max(Number.MAX_SAFE_INTEGER), sha256 });
const version = z.strictObject({ version: z.string().regex(/^v[1-9][0-9]{0,3}$/), sources: guestPath('/artifacts/'), sha256 }).nullable();
export const handoffSummarySchema = z.strictObject({
  version: z.literal(1), round: z.number().int().min(1).max(99), index: guestPath('/artifacts/review/r'), indexSha256: sha256,
  head: z.string().regex(hex40), branch: z.string().max(512).nullable(), base: z.string().regex(hex40), mergeBase: z.string().regex(hex40).nullable(),
  counts: z.strictObject({ entries: count, committed: count, staged: count, unstaged: count, untracked: count, removed: count }),
  patches: z.strictObject({ committed: patch, staged: patch, unstaged: patch, own: patch.optional() }), spec: version, instructions: version,
  changed: z.array(guestPath('/workspace/checkout/')).max(20), changedTruncated: z.boolean(),
  ownChanged: z.array(guestPath('/workspace/checkout/')).max(20).optional(), ownChangedTruncated: z.boolean().optional(),
  content: z.strictObject({ sha256, clean: z.boolean(), headMatches: z.boolean() }).optional(),
  preserved: z.strictObject({ commit: z.string().regex(hex40), ancestor: z.boolean() }).optional(),
});
/** Strict parse of the program's stdout (already filtered by Records); anything else is a failed capture, never a guessed handoff. */
export function parseHandoffSummary(stdout: string, round: number, baseCommit: string, preserve?: string): ProposalHandoff {
  const parsed = handoffSummarySchema.parse(JSON.parse(stdout));
  if (parsed.round !== round || parsed.base !== baseCommit || parsed.index !== `/artifacts/review/r${round}/index.json`) throw new Error('HANDOFF_CAPTURE_INVALID');
  // Ticket 21: the ancestry answer must be about exactly the requested commit, and present only when requested.
  if ((parsed.preserved?.commit ?? null) !== (preserve ?? null)) throw new Error('HANDOFF_CAPTURE_INVALID');
  // q34-ghadv-v2/v3: an own patch/listing exists only together, and only when the authorized tip is an ancestor of HEAD.
  const own = parsed.patches.own !== undefined, listed = parsed.ownChanged !== undefined;
  if (own !== listed || listed !== (parsed.ownChangedTruncated !== undefined) || (own && parsed.preserved?.ancestor !== true)) throw new Error('HANDOFF_CAPTURE_INVALID');
  if (own && parsed.patches.own!.path !== `/artifacts/review/r${round}/own.patch`) throw new Error('HANDOFF_CAPTURE_INVALID');
  return parsed as ProposalHandoff;
}
