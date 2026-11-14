import { z } from 'zod';
import type { ProposalHandoff } from '../contracts/index.js';

/**
 * GUEST-ONLY constant program (never model-supplied, never run by the Factory on a host tree). The Builder worker HOST runs it through the
 * Builder's own confined Bash binding right after suspending the Builder (spec §5.6/§6.4): it writes the round's index and diffs into a NEW
 * `/artifacts/review/r<N>/` (exclusive: an existing round is never overwritten) and prints a small summary. Covers committed (base..HEAD),
 * staged, unstaged, new (untracked, not ignored) and removed paths, each with presence/mode/hash, plus HEAD/branch/base/merge-base and
 * the latest COMPLETE preserved request/instructions versions. No commit, clean tree, copy or snapshot is required. Git runs in the guest
 * with hooks/fsmonitor/pager/external diff disabled; this is a cooperative capture, not a freeze against concurrent writers.
 * argv: checkout artifacts round baseCommit checkoutView artifactsView.
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
if len(sys.argv) != 7:
    fail("INPUT_INVALID", 2)
checkout, artifacts, rnd, base, checkout_view, artifacts_view = sys.argv[1:]
if not re.fullmatch(r"[1-9][0-9]?", rnd) or not re.fullmatch(r"[0-9a-f]{40}", base):
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
stage = "write"
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
ordered = [entries[key] for key in sorted(entries)]
counts = {"entries": len(ordered), "committed": sum(1 for e in ordered if e["committed"]), "staged": sum(1 for e in ordered if e["staged"]),
          "unstaged": sum(1 for e in ordered if e["unstaged"]), "untracked": sum(1 for e in ordered if e["untracked"]),
          "removed": sum(1 for e in ordered if not e["present"])}
changed = [e["guestPath"] for e in ordered if e["present"] and e.get("kind") == "file"]
summary = {"version": 1, "round": int(rnd), "index": view + "/index.json", "head": head, "branch": branch, "base": base, "mergeBase": merge_base,
           "counts": counts, "patches": patches, "spec": latest("spec"), "instructions": latest("instructions"),
           "changed": changed[:20], "changedTruncated": len(changed) > 20}
index = dict(summary, checkout=checkout_view, entries=ordered,
             reviewerNote="Read each listed guestPath and patch with the read tool, with offset/limit to continue; read beyond the hunks for context.")
index_bytes = json.dumps(index, indent=1, sort_keys=True).encode()
write("index.json", index_bytes)
summary["indexSha256"] = digest(index_bytes)
sys.stdout.write(json.dumps(summary, sort_keys=True))
`;

const hex40 = /^[0-9a-f]{40}$/;
/** Fixed Builder-binding Bash command (Host-originated): the program arrives on a quoted heredoc, never interpolated. */
export function handoffCommand(round: number, baseCommit: string): string {
  if (!Number.isInteger(round) || round < 1 || round > 99 || !hex40.test(baseCommit)) throw new Error('HANDOFF_INPUT_INVALID');
  if (handoffCaptureProgram.includes('FACTORY_HANDOFF_EOF')) throw new Error('HANDOFF_INPUT_INVALID');
  return `exec /usr/bin/python3 -I -S - /workspace/checkout /artifacts ${round} ${baseCommit} /workspace/checkout /artifacts <<'FACTORY_HANDOFF_EOF'\n${handoffCaptureProgram}\nFACTORY_HANDOFF_EOF\n`;
}

const guestPath = (prefix: string) => z.string().max(4096).refine(path => path.startsWith(prefix) && !path.split('/').includes('..'));
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative().max(1_000_000);
const patch = z.strictObject({ path: guestPath('/artifacts/review/r'), bytes: count.max(Number.MAX_SAFE_INTEGER), sha256 });
const version = z.strictObject({ version: z.string().regex(/^v[1-9][0-9]{0,3}$/), sources: guestPath('/artifacts/'), sha256 }).nullable();
export const handoffSummarySchema = z.strictObject({
  version: z.literal(1), round: z.number().int().min(1).max(99), index: guestPath('/artifacts/review/r'), indexSha256: sha256,
  head: z.string().regex(hex40), branch: z.string().max(512).nullable(), base: z.string().regex(hex40), mergeBase: z.string().regex(hex40).nullable(),
  counts: z.strictObject({ entries: count, committed: count, staged: count, unstaged: count, untracked: count, removed: count }),
  patches: z.strictObject({ committed: patch, staged: patch, unstaged: patch }), spec: version, instructions: version,
  changed: z.array(guestPath('/workspace/checkout/')).max(20), changedTruncated: z.boolean(),
});
/** Strict parse of the program's stdout (already filtered by Records); anything else is a failed capture, never a guessed handoff. */
export function parseHandoffSummary(stdout: string, round: number, baseCommit: string): ProposalHandoff {
  const parsed = handoffSummarySchema.parse(JSON.parse(stdout));
  if (parsed.round !== round || parsed.base !== baseCommit || parsed.index !== `/artifacts/review/r${round}/index.json`) throw new Error('HANDOFF_CAPTURE_INVALID');
  return parsed as ProposalHandoff;
}
