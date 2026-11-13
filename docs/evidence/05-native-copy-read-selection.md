# 05 / Task149 — native copied-output Read and Host reviewer selection

This is a technical implementation increment under the already approved User119
policy and existing Q5/Q6 pipeline, not a change to acceptance criteria or admission
authority. Task05 and the MVP remain incomplete.

## Host DTO and composition

`Invocation.selectedOutputCopies?: readonly string[]` is reviewer-only Host data.
Absent means empty. Shared strict launch/bootstrap validation accepts at most 32
entries, each exactly `/artifacts/factory-output-<lowercase UUID-v4>.txt`. Builder
selection (including an empty array), malformed/foreign-root paths, extra launch
keys and reviewer `copyOutput: true` reject. `Workers.activate` parses/deep-copies
and freezes the selection before its first await. `launchWorker` independently
parses before awaiting. The existing owner receives a separate private selection
snapshot; the child bootstrap carries only bounded readonly data, never a grant
callback, caller Set, Records capability or model schema field.

Builder `copyOutput === true` adds the SAME sequential native Read adapter used by
reviewers. Absent/false retains Write+Bash and the independent existing Host Edit
gate. The SAME boot's private qualified capability remains distinct from per-call
Host opt-in. Control admission/reservation remains a trusted caller precondition.

## Owner authority and bounds

`serveReadTools` allocates a private per-binding published-copy Set. Its private
Bash/stream-copy factories receive that Set internally. A generated path is added
synchronously ONLY at successful local publication after the guest receipt, all
async protected metadata/evidence, context/signal checks and the final
`assertCompleteAndCurrent` secret fence. No awaited operation follows successful
publication. Failed, pending and uncertain copies grant nothing; immediate
uncertain-copy revocation and one-shot slot spending remain intact.

All successful paths remain available across later Bash commands in the same
binding. The 33rd copy is denied before intent/guest mutation when 32 completed
paths are retained; no eviction, old-grant reuse, overwrite, relabel or deletion.
This is a private technical metadata/argv bound, not WorkAdmission or billing.
Binding abort/close and uncertain mutation revoke/clear grants. Guest files are
never automatically deleted. Persisted paths, JSONL reopen and Records references
do not authorize a new invocation. A new reviewer may read a persistent copy only
when the Host explicitly selects that exact path for its current Work VM.

Builder requests must name their own published copy; generic workspace/artifact
reads are denied. Reviewer ordinary roots remain available, but the reserved flat
`/artifacts/factory-output-` namespace is default-deny except selected paths. The
derived guest Read helper checks the actual opened regular FD's `/proc/self/fd/N`
target BEFORE any source read: Builder target must equal the requested granted
path; reviewer factory-output targets must be selected, including through aliases.
Original Edit-source helper construction, source bounds, BOM/hash/FD semantics and
the shared source loop are unchanged. Guest helpers remain SOURCE DATA on the
Host, tested by AST/source ordering only, never executed there.

Known directly selected generated copies are TEXT (`projectText` output), so an
ASCII `GIF89a` prefix does not select image capture. Ordinary reviewer PNG/JPEG/
GIF/WebP native classification, protected raw flow and explicit Host image budget
remain unchanged. The existing native stream/page/filter/offset/limit/truncator/
BOM callbacks are reused; the unusual text `readFile` fallback still caps at 50000
bytes. Read pages accept only references from this binding's private Read captures,
never guessed Bash captures, raw Records refs, foreign refs or persisted metadata.

## Validation and qualification

Three genuine compiled RED→GREEN slices: owner `READ_ROLE_DENIED` before published
copy access; strict launch schema rejecting the new field before implementation;
and normal public Host/native SDK pipeline lacking the Builder Read tool before
composition. A fixture expectation was corrected to include the native Read
continuation footer; it was not represented as a production failure.

New public proof uses real Host activation, the same qualified owner, five fresh
Node24 processes, native Pi Bash/Read/session persistence and real Protocol/Records.
The first Builder copies >1MiB then reads first/last lines using native ranges.
A new Builder cannot read that known path after JSONL reopen. Reviewers with
absent/empty selection cannot read it; explicit Host selection permits it. Mutating
the caller arrays after activation in both directions cannot change permissions.
Provider ALL-attempt/validated notifications and VM read/write-attempt counters
precede assertions. The VM's in-memory files survive the five invocations; grants
do not. Invalid public selections reject before a new child or guest source.

Focused regression gates: 75/75 Read/schema/BOM/image/transport cases, 84/84
copy/public/native Write/owner-policy cases (overlap includes nine new owner cases),
and 28/28 fixed-process/image/Host compatibility cases. No repeated whole suite.
SDK profiles, private copies, loader/preparer, dependencies, MIME facade, assets,
actual VFS qualification and the unconditional `gondolin.test.ts` skip are untouched.

The VM/manager/provider are doubles; this does NOT qualify physical Guest FDs,
Gondolin VM/FUSE, kernel confinement, hostile/concurrently changing namespaces,
hardlink inode identity, immutable content, CAS/snapshots, continuous root membership,
physical cessation, backpressure or storage durability. This is point-in-time FD
source authorization. Existing independent Bash/Edit/Write permissions are NOT
revoked by the new Read restriction; it is not blanket guest-file isolation.
Selected copies can later be modified by independent writers. No secret recall of
already copied guest bytes, new reader/export RPC, auto-deletion or host Records
mount was added. Native structured-output cap remains the SDK's actual 1MiB,
separate from its native view threshold. Real model/credential/accounting/budget
qualification remains pending (Task65); no physical or external authority inferred.
