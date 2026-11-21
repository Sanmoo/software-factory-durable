import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { LambdaService } from './service.js';

/**
 * v2 ticket 04 (V2-20, V2-22, V2-24): the seam between the Lambda adapter and the guest. The transport is SSH carried in a WebSocket
 * through the MicroVM's `HTTP_INGRESS`, built from ready-made components (`ssh-transport.ts`: the system `ssh` client and `websocat`);
 * tests replace it with an in-process guest (`test/sandbox/lambda-guest-fake.ts`). `SHELL_INGRESS` and an own exec server are not used.
 *
 * Two layers authenticate a connection: the service's ingress token of the port (needed only to OPEN the WebSocket) and the session SSH
 * key of the boot. Authenticating the tunnel authorizes nothing: which role a call runs under is bound by the host (ticket 05).
 */
export const guestSshPort = 8022;
/** SSH-level keepalive the adapter asks of every connection (the proofs ran `ServerAliveInterval 15` against the guest's `ClientAliveInterval 20`). */
export const guestKeepaliveSeconds = 15;
/**
 * The Unix users of the guest a connection may open as (v2 ticket 05, V2-23). `builder` owns the workspace and is in the `docker` group;
 * `reviewer` only reads: it owns nothing, is in no group and has no forwarding. The session key authenticates the HOST for both; which
 * user a call runs as is the host's choice from the role it bound, never something the tunnel or the guest decides.
 */
export type GuestUser = 'builder' | 'reviewer';

/** One connection to one MicroVM: where, the token that opens the WebSocket and the session identity (a private key FILE of the boot). */
export type GuestTarget = { endpoint: string; port: number; token: string; user: GuestUser; identityFile: string; keepaliveSeconds: number };

/**
 * One fixed program run in the guest. `program` names it for records and diagnostics; `script` is its bash text and carries no secret:
 * secrets travel only in `environment`, which the transport delivers as explicit process environment over the channel, never on a
 * command line and never in a guest file (V2-24).
 */
export type GuestExecRequest = { program: string; script: string; environment?: Readonly<Record<string, string>>; stdin?: Uint8Array };
export type GuestRefusal = {
  /** The connection was never established, so nothing ran. */
  status: 'refused';
  code:
    /** The service's proxy refused the token (expired, another port, another MicroVM). */
    | 'TOKEN_REFUSED'
    /** The guest presented a host key other than the one pinned for this boot. */
    | 'HOST_KEY_MISMATCH'
    /** The guest refused the session key. */
    | 'AUTHENTICATION_REFUSED'
    /** Nothing answered: the MicroVM is gone or its `sshd` is not up yet. */
    | 'UNREACHABLE';
  detail?: string };
export type GuestExecResult =
  | { status: 'exited'; exitCode: number; stdout: string; stderr: string }
  | GuestRefusal
  /** The connection ended without an exit status: whether the program ran or finished is unknown (ticket 11 decides what follows). */
  | { status: 'lost'; detail?: string }
  /** The host closed the channel (access withdrawn). */
  | { status: 'closed' };

export interface GuestTransport {
  /**
   * First contact of a boot: opens an authenticated connection and returns the host key the guest presented (one `ssh-ed25519 <base64>`
   * line). The key was generated in the guest at boot and the WebSocket is already authenticated by the service token of THIS MicroVM,
   * over TLS ended by the service; the host pins what it sees here for the rest of the boot.
   */
  readHostKey(target: GuestTarget): Promise<{ status: 'read'; hostKey: string } | GuestRefusal | { status: 'lost'; detail?: string }>;
  /** One program over a NEW connection that accepts only `hostKey`. `signal` closes the connection. */
  exec(target: GuestTarget & { hostKey: string }, request: GuestExecRequest, options?: { signal?: AbortSignal; onData?: (data: Buffer) => void }): Promise<GuestExecResult>;
}

const sshString = (value: Uint8Array | string) => {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};
const publicBlob = (raw: Uint8Array) => Buffer.concat([sshString('ssh-ed25519'), sshString(raw)]);

/**
 * The session SSH key of ONE boot, generated on the host (V2-24). The public line goes to the guest in the run hook payload; the private
 * key (unencrypted OpenSSH format, what the `ssh` client reads) stays in the boot's private directory on the host and is deleted when
 * access is withdrawn.
 */
export function generateSessionKey(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('ed25519');
  const raw = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const seed = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const check = randomBytes(4);
  const body = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(raw), sshString(Buffer.concat([seed, raw])), sshString('factory-session')]);
  const padding = Buffer.from(Array.from({ length: (8 - body.length % 8) % 8 }, (_, index) => index + 1));
  const one = Buffer.alloc(4);
  one.writeUInt32BE(1);
  const key = Buffer.concat([Buffer.from('openssh-key-v1\0'), sshString('none'), sshString('none'), sshString(''), one, sshString(publicBlob(raw)), sshString(Buffer.concat([body, padding]))]);
  return { publicKey: `ssh-ed25519 ${publicBlob(raw).toString('base64')}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${key.toString('base64').match(/.{1,70}/g)!.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n` };
}

/** The public line of a session private key written by `generateSessionKey` (what a guest must have authorized to accept it). */
export function sessionPublicKey(privateKey: string): string | null {
  try {
    const key = Buffer.from(privateKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
    const magic = Buffer.from('openssh-key-v1\0');
    if (!key.subarray(0, magic.length).equals(magic)) return null;
    let offset = magic.length;
    const next = () => { const length = key.readUInt32BE(offset); const value = key.subarray(offset + 4, offset + 4 + length); offset += 4 + length; return value; };
    next(); next(); next();
    offset += 4;
    return `ssh-ed25519 ${next().toString('base64')}`;
  } catch { return null; }
}

/** The service allows at most 60 minutes; an open connection outlives its token, so the token only matters when a connection OPENS. */
const tokenMinutes = 60;
const tokenRenewalMarginMs = 5 * 60_000;

export type LambdaChannel = {
  /** Runs one fixed program in the guest as the bound user. `signal` closes the connection of THIS program only (its end is then `lost`). */
  exec(request: GuestExecRequest, options?: { onData?: (data: Buffer) => void; signal?: AbortSignal }): Promise<GuestExecResult>;
  /** Withdraws access NOW: closes every open connection and refuses new ones. Never waits for a token to expire. */
  close(): void;
};

/**
 * The adapter's channel to one boot: every program runs over a connection that accepts only the pinned host key, authenticated by the
 * boot's session key, with keepalive. Ingress tokens are issued by the host as connections need them (a boot outlives a token) and are
 * never recorded.
 */
export function openChannel({ service, transport, microvmId, endpoint, identityFile, hostKey, now, user = 'builder' }: { service: LambdaService; transport: GuestTransport;
  microvmId: string; endpoint: string; identityFile: string; hostKey: string; now: () => number; user?: GuestUser }): LambdaChannel {
  let token: { value: string; renewAt: number } | null = null;
  let closed = false;
  const open = new Set<AbortController>();
  const issue = async () => {
    const issued = await service.createAuthToken({ microvmId, port: guestSshPort, expirationMinutes: tokenMinutes });
    if (!issued.ok) return null;
    token = { value: issued.value.token, renewAt: now() + tokenMinutes * 60_000 - tokenRenewalMarginMs };
    return token;
  };
  return {
    async exec(request, options = {}) {
      if (closed) return { status: 'closed' };
      const abort = new AbortController();
      open.add(abort);
      const interrupt = () => abort.abort();
      if (options.signal?.aborted) abort.abort(); else options.signal?.addEventListener('abort', interrupt, { once: true });
      try {
        if (abort.signal.aborted) return { status: 'lost', detail: 'The call was interrupted before its connection opened' };
        // A refused token ran nothing, so one retry with a fresh token is safe.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const current = token && now() < token.renewAt ? token : await issue();
          if (closed) return { status: 'closed' };
          if (!current) return { status: 'refused', code: 'TOKEN_REFUSED', detail: 'The service issued no ingress token' };
          const result = await transport.exec({ endpoint, port: guestSshPort, token: current.value, user, identityFile, keepaliveSeconds: guestKeepaliveSeconds, hostKey },
            request, { signal: abort.signal, ...(options.onData ? { onData: options.onData } : {}) });
          if (closed) return { status: 'closed' };
          if (result.status !== 'refused' || result.code !== 'TOKEN_REFUSED') return result;
          token = null;
        }
        return { status: 'refused', code: 'TOKEN_REFUSED' };
      } finally { open.delete(abort); options.signal?.removeEventListener('abort', interrupt); }
    },
    close() {
      closed = true;
      token = null;
      for (const abort of open) abort.abort();
    },
  };
}
