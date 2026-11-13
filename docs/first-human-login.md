# First Factory ChatGPT login (source prerequisite)

This is a standalone human setup operation, not worker activation, model qualification,
credential CRUD, or a wizard. No live login is authorized by its implementation/tests.
Do not run it until the operator approves a concrete finite operational manifest.

## Proposed ordered human stages (for confirmation, not execution)

1. **Choose the installation and local terminal.** Confirm canonical absolute installation
   root `R` owned by the installation UID, mode `0700`, with no symlink components.
   `R/credentials` must be absent or owned `0700`; `R/credentials/chatgpt.json` must
   not exist, even empty. No existing path is repaired/chmodded. Use an unrecorded
   human terminal, not an agent session, terminal recording, redirected transcript,
   chat, or CI. This stage produces only the nonsecret root choice.
2. **Authorize exactly one first login.** Compiled entrypoint shape:
   `/home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node dist/src/entrypoints/cli.js login --root R`.
   Use the approved absolute Node 24.21.0 binary and release working directory.
   There are no provider/auth-file/profile/key/JSON flags and no default root.
   No command in this document has been executed as a live CLI login.
3. **Complete native browser authorization on the same host.** The program writes
   only the validated native authorization URL directly to `/dev/tty`, never captured
   stdout/stderr, Records, JSONL, or sessions. The human deliberately opens that URL
   in their browser; the program never opens a browser or runs OS commands.
   Sign in with the chosen ChatGPT account and complete the provider's actual consent
   UI. No specific dashboard labels are assumed. URL state/public client ID/PKCE
   challenge are intentionally delivered to that human only. Never paste the URL,
   password, auth code, redirect, or tokens into chat or this terminal.
4. **Observe generic completion.** Native direct callback is
   `http://127.0.0.1:1455/auth/callback` (no fallback port/bind host). If blocked or
   occupied, fail closed; do not switch to manual copy/paste. Manual native prompt
   stays input-free pending callback or cancellation; no redirect/code is collected.
   Ctrl-C/SIGTERM and a ten-minute deadline use supported AbortSignals. Native flow
   calls `server.close()` and `closeAllConnections()`; these and credential-write
   draining are not proof of physical cessation.
5. **Hold subsequent live actions for separate approval.** Success means the fixed
   private credential was created, not entitlement, billing, refresh qualification,
   a model request, guest/VM qualification, controller admission, or worker ACK.
   The accepted worker later independently reads the file and registers/ACKs values
   with its actual owner before use. No active owner exists in standalone setup.

## Values and destinations

- Public canonical root: CLI `--root` only; fixed derived credential path, no discovery.
- Stable nonsecret installation UUID: generated locally into
  `R/credentials/setup/device-id`, own `0600`; never imported from personal SDK state.
- Native catalog cache: `R/credentials/setup/models-store.json`, own private setup
  directory `0700`; `modelsPath:null`, explicit credentials, model network disabled,
  `refreshOnCreate:false`. No personal/default profile is read or copied.
- Authorization URL: native
  `https://auth.openai.com/api/accounts/authorize`, dynamic public-client authorization
  code + PKCE S256, resource `https://api.openai.com/v1`, direct scope
  `chatgpt.tokens.use.direct`. Only the human TTY gets this URL.
- Code/issued client ID: direct native in-memory loopback callback, no manual entry.
- Native token exchange: `https://auth.openai.com/api/accounts/oauth/token`;
  access/refresh/issued client ID are registered in the existing in-memory Records
  registry before native memory commit/post-login synchronization/private commit.
  No runtime key/environment/provider fallback or inference request occurs.
- Validated credential document: only `{openai: <native OAuth credential>}` in
  `R/credentials/chatgpt.json`, exclusively created own `0600`, regular single link,
  **after** memory login succeeds. No bearer is returned to the CLI, written to
  setup `auth.json`, sessions, argv, environment, logs, or public results.

## Failure and retention

An existing target refuses before native activity. A concurrent target appearance
fails exclusive creation without overwrite. Missing credentials/setup directories
may be created privately; existing unsafe objects refuse, without repair. Own
setup UUID/cache may remain after cancellation, but no credential reservation is
created before login success. Native FileAuthStorageBackend performs the final
locked **in-place** write, not atomic replacement. A failed/torn private commit
retains the private empty/partial file and any already-written credential bytes;
there is no rollback, deletion, rename, retry, or automatic repair. A later consumer
rejects invalid contents. Recovery requires a separately scoped operator decision;
do not ask an agent to inspect or print credential contents. Failure outputs are
closed generic codes/messages without SDK bodies, causes, stacks or error URLs.

The same-UID/trusted-ancestor premise remains: checks and native locks are not atomic
hostile-filesystem confinement. Human terminal recording and browser/account trust
are operational obligations, not properties established by closed tests.
