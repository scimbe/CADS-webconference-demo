// webconference-demo-bridge: a small directory + presence + call-signaling
// service so two browser tabs can find each other by email and place a call
// without any manual ct-video-call-grant/CLI step. Plain Node, zero deps,
// matching CADS-flappy-demo/CADS-cookbook-demo's own bridge convention.
//
// What this holds server-side: the channel OPERATOR's private key (pure
// local ed25519 signing, same as ct-video-call-grant -- never a DNS/TLS
// credential) and an in-memory directory (email -> holder/noise PUBLIC keys
// + last-seen). It never sees or needs anyone's holder/noise PRIVATE key --
// those stay in the browser's localStorage, generated locally.
//
// Real, disclosed trade-off: this bridge (the operator) necessarily learns
// call metadata -- which two emails are connecting, and when -- the same way
// a phone exchange knows who's calling whom. It never sees the call's actual
// audio/video/chat content, which stays end-to-end encrypted exactly as
// without this directory layer.
//
// Registering a freshly-minted channel with the control plane (POST
// /me/channels + .../members) authenticates as the workflow-maintainer
// account. Preferred: CT_OIDC_CLIENT_ID/CT_OIDC_CLIENT_SECRET, a durable
// service-account credential (POST /me/service-accounts) this bridge
// exchanges for a fresh 5-minute bearer token itself, on demand -- doesn't
// expire on its own the way the two fallbacks below do, which is what kept
// breaking real calls ("POST /me/channels -> 401 missing bearer token")
// every few hours whenever a manually-minted credential expired. Fallback
// (only if no service account is configured): CT_OIDC_TOKEN (a raw,
// manually-obtained bearer token) or CT_PORTAL_SESSION_COOKIE (the portal's
// own session cookie value, ~8h TTL -- also the ONLY option for the
// login-allowlist add/remove routes below, which are cookie-only and don't
// accept a bearer token at all, service-account or otherwise).

const http = require('http');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

// CADS-webconference-demo#30: these three are this bridge's highest-value
// secrets (the operator key can mint grants for any channel; the OIDC
// secret and portal session cookie authenticate as the workflow-maintainer
// account against the control plane) -- all three used to live as plain
// `environment:` entries in the compose file, readable via `docker
// inspect`/`docker compose config`/`/proc/1/environ` by anyone who can
// reach the host or the docker socket. Standard Docker-secrets convention
// (same one the official postgres/mysql images use): if `<NAME>_FILE` is
// set, read the value from that file (a Docker `secrets:` mount lands at
// /run/secrets/<name>, never in `environment:` or `docker inspect`
// output); otherwise fall back to the plain env var, so an operator who
// hasn't migrated to secrets yet isn't broken by this. Full closure needs
// the docker-compose secrets: wiring, not just this read-side support.
function readSecret(name) {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (e) {
      console.error(`bridge: failed to read ${name}_FILE (${filePath}):`, e.message);
      return undefined;
    }
  }
  return process.env[name];
}

const LISTEN = process.env.WEBCONFERENCE_BRIDGE_LISTEN || '0.0.0.0:8791';
const CP_URL = process.env.CT_AGENT_CP_URL || 'https://bunsenbrenner.org';
// Derived from CT_AGENT_HOSTNAME -- the SAME variable the agent service is
// given, both ultimately sourced from one value in .env.selfservice. Never a
// separately-specified URL: a prior hardcoded fallback here
// (wss://site-34a13a96.bunsenbrenner.org/ws/channel, this tunnel's OLD
// hostname from before it was rebound to the real one) silently pointed the
// browser at a dead tunnel for hours after the rebind, because nothing forced
// this value to move in lockstep with the agent's own hostname. There is now
// exactly one place this hostname is configured.
const AGENT_HOSTNAME = process.env.CT_AGENT_HOSTNAME;
if (!AGENT_HOSTNAME) {
  console.error('bridge: CT_AGENT_HOSTNAME is required (same value passed to the agent service)');
  process.exit(1);
}
const WS_URL = `wss://${AGENT_HOSTNAME}/ws/channel`;
const OPERATOR_KEY = readSecret('CT_CHANNEL_OPERATOR_KEY'); // 64-hex private key, from `ct-agent channel operator-init`
// CADS-webconference-demo#30: readSecret() above already supports the
// _FILE convention for reading OPERATOR_KEY into this process's own
// memory -- but mintGrants() below used to pass OPERATOR_KEY inline on
// the child's argv regardless of where it came from, which still put the
// key in /proc/<pid>/cmdline (visible to any same-user process) for the
// duration of every mint call. Kept separately from the read-and-trimmed
// OPERATOR_KEY above so mintGrants can hand the CHILD the file path
// itself (via ct-video-call-grant's own --operator-private-file, which
// reads it in-process) instead of the key value, whenever a file backs
// it. Falls back to the inline form only when no _FILE is configured --
// unavoidable without one, same as before this fix.
const OPERATOR_KEY_FILE = process.env.CT_CHANNEL_OPERATOR_KEY_FILE;
const GRANT_BIN = process.env.CT_VIDEO_CALL_GRANT_BIN || '/usr/local/bin/ct-video-call-grant';
// This tunnel's own portal id (the UUID-ish string in /portal/tunnels/:id/...),
// needed only for the login-allowlist add/remove proxy below -- optional
// because the address book's contact *list* (presence-based) works without it.
const TUNNEL_ID = process.env.WEBCONFERENCE_TUNNEL_ID || '';
const PRESENCE_TTL_MS = 45_000;
const CALL_TTL_MS = 60_000;

// Who's allowed to revoke someone else's login access. Comma-separated,
// case-insensitive. Empty (unset) preserves the previous behaviour -- any
// gate-verified caller can revoke -- with a startup warning, so an operator
// who deploys without setting this doesn't get silently locked out of their
// own admin panel; setting it is what actually turns the gate on.
// Caller identity here is client-asserted (a `callerEmail` field in the
// request body), same trust level as every other email this bridge accepts
// (e.g. /register's own caller-supplied email) -- not cryptographically
// verified against the gate's session. A real guarantee would need the
// frontend to forward its Keycloak ID token for this bridge to verify, which
// is a larger change; this at least closes the "any script that can reach
// the API can revoke anyone" gap for the common case.
const ADMIN_EMAILS = new Set(
  (process.env.WEBCONFERENCE_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
// CADS-webconference-demo#76: this warning previously named only
// /api/allowlist/remove -- but the SAME empty-ADMIN_EMAILS short-circuit
// (`ADMIN_EMAILS.size > 0 && !ADMIN_EMAILS.has(caller)` evaluating to
// false) also opens /api/allowlist/add, GET /api/access-requests, and
// /api/access-requests/approve|decline to any gate-admitted caller, not
// just the one revoke-capability endpoint the old message called out.
// approve and allowlist/add are GRANT-capability endpoints (they add an
// arbitrary account to the tunnel's login allow-list -- the exact #10
// escalation) -- materially worse than the revoke/read endpoints the old
// warning implied was the whole exposure. Those two now fail closed
// below regardless of this warning; this expanded message covers what's
// still open (GET/decline/remove) plus documents the change.
if (ADMIN_EMAILS.size === 0) {
  console.warn(
    'bridge: WEBCONFERENCE_ADMIN_EMAILS not set -- GET /api/access-requests, ' +
      '/api/access-requests/decline, and /api/allowlist/remove are open to any ' +
      'gate-admitted caller (read pending requesters\' emails / revoke anyone\'s ' +
      'access). /api/access-requests/approve and /api/allowlist/add -- which GRANT ' +
      'tunnel access to an arbitrary account -- now fail closed (503) instead of ' +
      'also being open; set WEBCONFERENCE_ADMIN_EMAILS to restore them.'
  );
}

if (!OPERATOR_KEY || !/^[0-9a-f]{64}$/i.test(OPERATOR_KEY)) {
  console.error('bridge: CT_CHANNEL_OPERATOR_KEY (64-hex) is required');
  process.exit(1);
}

// email -> { holderPub, noisePub, lastSeen }
const directory = new Map();
// channel -> { callerEmail, calleeEmail, grantForCaller, grantForCallee, createdAt,
//              callerAttest, calleeAttest, status }
const pendingCalls = new Map();

// toEmail (lowercased) -> [{ fromEmail, createdAt }]. "A adds B as a
// contact" also asks B to add A back -- otherwise A can message/call B
// (allowlist/add already grants B login) while B's own contact list never
// hears about it. In-memory only, same durability tier as pendingCalls
// above: a same-session convenience, not a persisted notification.
const contactRequests = new Map();
// email (lowercased) -> { email, createdAt }. CADS-webconference-demo#36 --
// someone not yet on the login allow-list asking to be admitted.
// CADS-webconference-demo#41 (finding 3): unlike the maps above, this one is
// mirrored to a single JSON file (ACCESS_REQUESTS_FILE) on every add/
// approve/decline, so a bridge restart no longer silently drops every
// pending request -- the in-memory Map stays the runtime source of truth
// (every read goes through it), the file is only a load-on-boot /
// write-through backup. Out-of-band admin notification (nothing pings
// anyone when a request arrives) is deliberately NOT built here -- that
// needs a real SMTP/webhook config surface and is a separate feature, not a
// data-loss bug fix; the admin UI already lists pending requests whenever
// an admin next signs in, and now they'll actually still be there.
const accessRequests = new Map();
const ACCESS_REQUESTS_FILE = process.env.WEBCONFERENCE_ACCESS_REQUESTS_FILE || './access-requests.json';
try {
  const raw = fs.readFileSync(ACCESS_REQUESTS_FILE, 'utf8');
  for (const entry of JSON.parse(raw)) {
    if (entry && typeof entry.email === 'string') accessRequests.set(entry.email.toLowerCase(), entry);
  }
  console.log(`loaded ${accessRequests.size} pending access request(s) from ${ACCESS_REQUESTS_FILE}`);
} catch (e) {
  if (e.code !== 'ENOENT') console.log(`could not load ${ACCESS_REQUESTS_FILE}: ${e.message} -- starting with no pending requests`);
}
function persistAccessRequests() {
  // Atomic write (tmp file + rename) so a crash mid-write can't leave
  // ACCESS_REQUESTS_FILE truncated/corrupted -- the rename is a single
  // filesystem operation, never a partially-written target file.
  const tmp = `${ACCESS_REQUESTS_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify([...accessRequests.values()]));
    fs.renameSync(tmp, ACCESS_REQUESTS_FILE);
  } catch (e) {
    console.log(`could not persist access requests to ${ACCESS_REQUESTS_FILE}: ${e.message}`);
  }
}

// CADS-webconference-demo#87/#88: cross-device sync store. email (lowercased)
// -> { nextRevision, messages: [...], contacts: {entries}, blocked: {entries} }.
//
// This bridge NEVER decrypts or inspects message content -- `messages` rows
// are exactly what chatStore.js already stores locally (conversation, seq,
// from, ts, pending, kind, iv, ciphertext, and the file fields for a file
// row), forwarded here opaquely for another of the SAME identity's devices
// to pull and decrypt with the key only that identity holds (never this
// bridge). `contacts`/`blocked` are the tombstone-aware {present, ts} entry
// maps app.js's localSetFor already builds -- merged here with the exact
// same last-write-wins-by-ts rule as the client's own merge(), so the
// server converges to the same state any two directly-syncing clients
// would reach. `messages` uses one MONOTONIC REVISION COUNTER per identity
// (not a per-conversation seq) so a client only needs to remember ONE
// "last seen revision" number to page through every conversation's deltas
// in one pull loop, instead of tracking a cursor per conversation.
//
// Deliberately does NOT cover nameMapFor's per-contact display-name labels
// (out of scope for this pass -- lower-stakes personal labels, not access-
// or security-relevant like contacts/blocklist; flagged in the completion
// comment, not silently dropped).
const syncStore = new Map();
const SYNC_STORE_FILE = process.env.WEBCONFERENCE_SYNC_STORE_FILE || './sync-store.json';
// CADS-webconference-demo#77's own precedent: unbounded per-identity growth
// here is the exact same shared-storage-exhaustion shape that issue fixed
// client-side -- bounding it server-side too, FIFO-pruned oldest-revision-
// first once exceeded, same reasoning.
const MAX_SYNC_MESSAGES_PER_IDENTITY = 20_000;
try {
  const raw = fs.readFileSync(SYNC_STORE_FILE, 'utf8');
  for (const [email, state] of Object.entries(JSON.parse(raw))) {
    syncStore.set(email, state);
  }
  console.log(`loaded sync state for ${syncStore.size} identit(y/ies) from ${SYNC_STORE_FILE}`);
} catch (e) {
  if (e.code !== 'ENOENT') console.log(`could not load ${SYNC_STORE_FILE}: ${e.message} -- starting with no sync state`);
}
function persistSyncStore() {
  const tmp = `${SYNC_STORE_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(syncStore)));
    fs.renameSync(tmp, SYNC_STORE_FILE);
  } catch (e) {
    console.log(`could not persist sync store to ${SYNC_STORE_FILE}: ${e.message}`);
  }
}
function getSyncState(email) {
  let state = syncStore.get(email);
  if (!state) {
    state = { nextRevision: 1, messages: [], contacts: { entries: {} }, blocked: { entries: {} } };
    syncStore.set(email, state);
  }
  return state;
}

// CADS-webconference-demo#87: a single message row's ciphertext (JSON-
// array-encoded, ~3.5-4x the raw bytes -- see sync.js's own comment) can
// exceed MAX_BODY_BYTES on its own for a real file/image attachment, even
// after batching multiple SMALL rows together (#87's first fix). The
// client now splits an oversized row's ciphertext into fixed-size chunks
// (sync.js's SYNC_CIPHERTEXT_CHUNK_BYTES) sent as separate /sync/push
// calls; this reassembles them here, in memory only -- deliberately NOT
// part of `syncStore`/persistSyncStore, since a partial (possibly
// abandoned) upload is exactly the kind of transient state that has no
// business surviving a restart or bloating the on-disk store.
// Key: `${email}:${conversation}:${seq}:${from}` -- flat rather than
// nested per-email, since that's the only granularity anything here
// actually needs.
const pendingChunkedMessages = new Map();
// Same FIFO-eviction reasoning as MAX_SYNC_MESSAGES_PER_IDENTITY above --
// an identity that starts (chunkIndex 0) many large uploads and never
// finishes any of them (abandoned tab, crashed device) would otherwise
// leak one in-memory buffer per abandoned upload forever. A fresh
// chunkIndex 0 for the same key always resets/reclaims its own slot (a
// legitimate retry-from-scratch), so this only bounds truly distinct,
// still-incomplete uploads.
const MAX_PENDING_CHUNKED_UPLOADS_PER_IDENTITY = 20;
function pendingChunkKeysFor(email) {
  const prefix = `${email}:`;
  return [...pendingChunkedMessages.keys()].filter((k) => k.startsWith(prefix));
}
// Last-write-wins merge, identical rule to app.js's localSetFor.merge() --
// the server has to converge on the SAME result the client would reach
// merging the same two states, or a client that trusts the server's
// response and a client that merged two peers directly could permanently
// disagree.
function mergeEntries(local, remote) {
  for (const [email, r] of Object.entries(remote || {})) {
    const l = local[email];
    if (!l || r.ts > l.ts) local[email] = r;
  }
}

// CADS-webconference-demo#87: live device-pairing relay. Honest scoping
// note (see the completion comment on #87 for the full disclosure): the
// account owner asked for this to go over the existing ct_channel
// (ws_channel/Noise_IK) transport -- that would need a new grant type from
// `ct-video-call-grant`, a separately-compiled binary this repo doesn't
// build or control, so it's out of reach for this pass. This relay
// achieves the SAME security property with standard WebCrypto (ECDH +
// AES-GCM) instead: this bridge only ever sees each side's ECDH PUBLIC key
// and an AES-GCM ciphertext it has no way to decrypt (it never holds
// either device's ECDH private key) -- functionally equivalent to relaying
// opaque bytes over a channel it can't read, just over plain HTTP instead
// of the WS channel transport. Still live, still ephemeral (single-use,
// short TTL, in-memory only -- same durability tier as pendingCalls/
// contactRequests above), still requires both devices online within the
// TTL window, same as the ws_channel version would have.
//
// code (the short pairing code shown on the new device, typed on the
// existing one) -> { email, tempPubKeyJwk, offeredAt, result }. `result`,
// once the existing device delivers it, is
// { oldDevicePubKeyJwk, iv, ciphertext } -- new device's poll consumes and
// deletes the whole entry (single-use).
const pairingOffers = new Map();
const PAIRING_TTL_MS = 5 * 60 * 1000;
const PAIRING_CODE_RE = /^[A-Z2-9]{8}$/; // Crockford-ish alphabet (no 0/O/1/I confusion), 8 chars -- ~37 bits, brute-force bounded further by the rate limiter below
function prunePairingOffers() {
  const cutoff = Date.now() - PAIRING_TTL_MS;
  for (const [code, offer] of pairingOffers) {
    if (offer.offeredAt < cutoff) pairingOffers.delete(code);
  }
}
// Same fixed-window-per-IP shape as accessRequestRateLimited/callRateLimited
// above -- bounds both a brute-force guess sweep across the code space and
// plain memory growth from offer spam, without needing per-code state.
const pairingRateLimited = makeRateLimiter(20, 5 * 60 * 1000);

// CADS-webconference-demo#41 (finding 2): this is the one endpoint the
// gate exemption in Caddyfile.selfservice deliberately leaves reachable
// with NO authentication at all -- by design (it's the one way a rejected
// registrant can reach this bridge before being admitted), but that also
// means it's open to the whole internet with none of the "already
// gate-authenticated" cost every other endpoint implicitly has. Simple
// fixed-window per-IP cap (not sliding, not persisted across restarts --
// this whole feature is already in-memory-only per the comment above) plus
// a hard ceiling on total pending requests, so flooding this can't grow
// memory or spam the admin panel unbounded.
const ACCESS_REQUEST_RATE_LIMIT = 5; // per IP, per window
const ACCESS_REQUEST_RATE_WINDOW_MS = 10 * 60 * 1000;
const ACCESS_REQUEST_MAX_PENDING = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Simple fixed-window limiter (not sliding, not persisted across
// restarts -- matches this whole bridge's existing in-memory-only
// durability tier). Generalized out of what was originally a one-off for
// access-requests, now also used by /api/call (CADS-webconference-demo#12,
// finding 8's "rate-limit /api/call per identity" -- keyed by IP rather
// than the claimed fromEmail specifically, since an ungated deployment has
// no way to verify that email is real, and per-IP still bounds the actual
// resource cost: each call spawns a real execFile process).
function makeRateLimiter(maxCount, windowMs) {
  const hits = new Map(); // key -> { count, windowStart }
  return function rateLimited(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      return false;
    }
    entry.count++;
    return entry.count > maxCount;
  };
}
const accessRequestRateLimited = makeRateLimiter(ACCESS_REQUEST_RATE_LIMIT, ACCESS_REQUEST_RATE_WINDOW_MS);
// CADS-webconference-demo#12 (finding 8): each /api/call spawns a real
// execFile process (mintGrants) -- with no cap at all, hammering this
// endpoint forks a new process per request, exhausting the process table
// (or at minimum burning real CPU signing grants nobody will ever use).
// 20/min per caller IP is generous for real usage (placing a call, or a
// background chat-delivery attempt, is a rare human-paced action) while
// still bounding the actual fork rate an attacker could sustain.
const CALL_RATE_LIMIT = 20;
const CALL_RATE_WINDOW_MS = 60 * 1000;
const callRateLimited = makeRateLimiter(CALL_RATE_LIMIT, CALL_RATE_WINDOW_MS);
// Real client IP, not the reverse proxy's own socket -- Caddy's
// reverse_proxy sets X-Forwarded-For by default; falls back to the raw
// socket address if that's ever missing (e.g. a direct request bypassing
// Caddy entirely, which happens routinely in local/dev testing).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
// email -> channel (the most recent incoming call offered to this email)
const incomingByEmail = new Map();

// Incoming-call push over a raw WebSocket (GET /api/ws?email=...), so a
// callee learns about a ring immediately instead of waiting for the next
// /api/incoming poll tick. Hand-rolled (RFC 6455 handshake + minimal framing)
// rather than an `ws` npm dependency, matching this bridge's own "plain
// Node, zero deps" convention from the header comment above. The existing
// poll in app.js is deliberately left in place as a fallback -- if a socket
// never connects, drops, or this code has a bug, the callee still gets the
// call within one poll interval, just not instantly.
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// email -> raw net.Socket already upgraded to a WebSocket connection
const wsClients = new Map();

function wsAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

function wsFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsPush(email, obj) {
  const socket = wsClients.get(email);
  if (!socket || socket.destroyed) return false;
  try {
    // CADS-webconference-demo#12 (finding 5): socket.write()'s return value
    // (false = the kernel send buffer is full, data is queued in userspace
    // instead) used to be ignored entirely -- a slow-draining or stalled
    // client would have frames buffer up in Node's own memory unbounded.
    // Real backpressure (pause upstream production until 'drain') doesn't
    // apply here -- there's no upstream to pause, each push is triggered by
    // an independent incoming call -- so this instead just surfaces the
    // signal: a client repeatedly failing to drain is either gone or badly
    // stalled, worth logging so it's visible rather than silently growing.
    const drained = socket.write(wsFrame(obj));
    if (!drained) console.warn(`bridge: wsPush to ${email} did not drain immediately (client reading slowly or stalled)`);
    return true;
  } catch (_) {
    return false;
  }
}

// CADS-webconference-demo#12 (findings 1, 3, 4): this channel is push-only
// (server->client) -- a real client only ever sends tiny RFC 6455 control
// frames (close/ping/pong), never application data. Three real gaps this
// closes:
// - No frame size cap at all: `len` came straight from an attacker-
//   controlled 16- or 64-bit length field and was trusted outright: a
//   client claiming a multi-GB payload while trickling bytes would have
//   made this buffer without bound waiting for a frame that never
//   completes. WS_MAX_CLIENT_FRAME_BYTES rejects (destroys the socket on)
//   anything bigger than any legitimate control frame could ever need.
// - O(n^2) buffering: Buffer.concat([buf, chunk]) on EVERY incoming chunk
//   re-copies the entire accumulated buffer each time -- a slow byte-drip
//   with no complete frame arriving is quadratic in total bytes received.
//   Capping the buffer size above also bounds the blast radius of this
//   (a real fix would restructure to an array of chunks + lazy concat, but
//   with the size cap in place the worst case is now O(WS_MAX^2), a fixed
//   small constant, not O(attacker-controlled n^2)).
// - No heartbeat: a silently-dropped half-open TCP connection (network
//   blip, killed client, no clean FIN/close frame ever sent) left wsClients
//   holding a socket forever, with wsPush still writing into it (the
//   .destroyed check only catches a CLEANLY closed socket, not a half-open
//   one the OS hasn't noticed is dead yet). Server-side pings + a
//   last-pong watchdog (below, alongside sweepExpired) now detects and
//   cleans these up instead of leaking indefinitely.
const WS_MAX_CLIENT_FRAME_BYTES = 1024;
const WS_PING_INTERVAL_MS = 30_000;
const WS_PONG_TIMEOUT_MS = 90_000; // 3 missed pings -- forgiving of a slow/busy client, not of a genuinely dead one
function wsPingFrame() {
  return Buffer.from([0x89, 0x00]); // FIN=1, opcode 0x9 (ping), empty payload, unmasked (server frame)
}
function wsAttachReader(socket, onClose) {
  let buf = Buffer.alloc(0);
  socket._wsLastPong = Date.now();
  const onData = (chunk) => {
    if (buf.length + chunk.length > WS_MAX_CLIENT_FRAME_BYTES) {
      onClose();
      try { socket.destroy(); } catch (_) {}
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b1 = buf[1];
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (len > WS_MAX_CLIENT_FRAME_BYTES) {
        onClose();
        try { socket.destroy(); } catch (_) {}
        return;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return; // wait for the rest
      const opcode = buf[0] & 0x0f;
      buf = buf.slice(offset + maskLen + len);
      if (opcode === 0x8) {
        onClose();
        try { socket.end(); } catch (_) {}
        return;
      } else if (opcode === 0xa) {
        socket._wsLastPong = Date.now(); // pong
      }
      // 0x9 (ping) from a client is unexpected on this push-only channel --
      // no server-side use for responding to it, safely ignored.
    }
  };
  socket.on('data', onData);
  socket.on('close', onClose);
  socket.on('error', onClose);
}
function wsHeartbeatSweep() {
  const now = Date.now();
  for (const [email, socket] of wsClients) {
    if (socket.destroyed) {
      wsClients.delete(email);
      continue;
    }
    if (now - socket._wsLastPong > WS_PONG_TIMEOUT_MS) {
      console.warn(`bridge: WS client ${email} missed ${WS_PONG_TIMEOUT_MS / WS_PING_INTERVAL_MS} pongs -- treating as dead, closing`);
      try { socket.destroy(); } catch (_) {}
      wsClients.delete(email);
      continue;
    }
    try { socket.write(wsPingFrame()); } catch (_) {}
  }
}
setInterval(wsHeartbeatSweep, WS_PING_INTERVAL_MS).unref();

// CADS-webconference-demo#81: this used to consult ONLY the directory
// entry's lastSeen, which is refreshed exclusively by the client's HTTP
// /api/heartbeat poll (app.js's pollEvery, 15s base cadence) -- a signal
// that background-tab browser timer throttling degrades well past
// PRESENCE_TTL_MS (desktop Chrome slows setTimeout recursion to ~1/min
// after ~5min backgrounded; mobile browsers routinely freeze it outright).
// A tab backgrounded for a couple minutes was marked offline and every
// incoming call refused at the check below, even with its incoming-call
// WebSocket still open and answering the server's own ping/pong watchdog
// (wsHeartbeatSweep, WS_PING_INTERVAL_MS/WS_PONG_TIMEOUT_MS above) -- a
// signal NOT subject to JS-timer throttling, since the ping/pong itself is
// server-initiated and network-level, not a client setTimeout loop. Now
// treats a socket that's still in wsClients (not yet swept for a stale
// pong) as online too -- strictly additive: never makes an actually-dead
// client look online (wsHeartbeatSweep already removes those), only
// recognizes a genuinely-alive one the HTTP heartbeat alone was blind to.
function isOnline(entry, email) {
  if (entry && Date.now() - entry.lastSeen < PRESENCE_TTL_MS) return true;
  const sock = email && wsClients.get(email);
  return !!sock && !sock.destroyed && Date.now() - sock._wsLastPong < WS_PONG_TIMEOUT_MS;
}

function mintGrants(holderAPub, holderBPub) {
  return new Promise((resolve, reject) => {
    // CADS-webconference-demo#12: no timeout meant a hung/misbehaving
    // ct-video-call-grant process left this request (and the caller
    // awaiting it) stuck forever. Local key-signing has no reason to take
    // anywhere near this long; 10s is a generous ceiling, not a tight one.
    // maxBuffer: Node's own default (1MB) already covers this CLI's real
    // output (a few lines of hex, well under a KB) with room to spare --
    // set explicitly rather than left implicit, so a future change to this
    // CLI that somehow started spamming stdout fails loudly (ERR_CHILD_
    // PROCESS_STDIO_MAXBUFFER) instead of silently relying on whatever
    // Node's own default happens to be on a given version.
    // CADS-webconference-demo#30: --operator-private-file (read by the child
    // itself) when a file backs the key, so it never appears on this argv at
    // all -- see OPERATOR_KEY_FILE's own comment above for why.
    const operatorArgs = OPERATOR_KEY_FILE ? ['--operator-private-file', OPERATOR_KEY_FILE] : ['--operator-private', OPERATOR_KEY];
    execFile(GRANT_BIN, [holderAPub, holderBPub, ...operatorArgs, '--ttl-secs', '3600'], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const out = {};
      for (const line of stdout.trim().split('\n')) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        out[line.slice(0, idx)] = line.slice(idx + 1);
      }
      if (!out.channel_id_hex || !out.grant_a_hex || !out.grant_b_hex) {
        return reject(new Error(`unexpected ct-video-call-grant output: ${stdout}`));
      }
      resolve({ channel: out.channel_id_hex, grantA: out.grant_a_hex, grantB: out.grant_b_hex, operatorPub: out.operator_public_hex });
    });
  });
}

// Durable service-account credentials (POST /me/service-accounts, minted
// once via the portal, never expiring on their own -- only on rotate/
// revoke). Preferred over CT_OIDC_TOKEN/CT_PORTAL_SESSION_COOKIE below:
// both of those are short-lived (a client_credentials access_token is
// good for 5 minutes; the portal session cookie for 8 hours) and were
// only ever manual stopgaps -- this repeatedly broke real calls
// ("POST /me/channels -> 401 missing bearer token") every time whichever
// human-minted credential happened to expire between manual refreshes.
const OIDC_CLIENT_ID = process.env.CT_OIDC_CLIENT_ID;
const OIDC_CLIENT_SECRET = readSecret('CT_OIDC_CLIENT_SECRET');
const OIDC_TOKEN_URL = process.env.CT_OIDC_TOKEN_URL || 'https://auth.bunsenbrenner.org/realms/ct-demo/protocol/openid-connect/token';

let cachedToken = null; // { value, expiresAt } -- expiresAt in epoch ms
async function getBearerToken() {
  if (!OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET) return null;
  // 30s safety margin so a token never gets used right as it's expiring
  // (the request would land server-side after expiry and 401 anyway).
  if (cachedToken && cachedToken.expiresAt - 30_000 > Date.now()) return cachedToken.value;
  const resp = await fetch(OIDC_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: OIDC_CLIENT_ID, client_secret: OIDC_CLIENT_SECRET }).toString(),
  });
  if (!resp.ok) {
    console.error(`bridge: service-account token exchange failed: ${resp.status} ${await resp.text().catch(() => '')}`);
    return null;
  }
  const body = await resp.json();
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

async function cpFetch(path, body) {
  const serviceToken = await getBearerToken();
  const token = serviceToken || process.env.CT_OIDC_TOKEN;
  const sessionCookie = readSecret('CT_PORTAL_SESSION_COOKIE');
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  else if (sessionCookie) headers['cookie'] = `ct_portal_session=${sessionCookie}`;
  const resp = await fetch(`${CP_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: resp.status, text: await resp.text().catch(() => '') };
}

// Like cpFetch, but for the portal's own HTML-form routes (login-allowlist
// add/remove) -- cookie-only, no bearer fallback: those handlers call
// portal::session_subject_for directly, not the dual-auth subject_of_channel
// /me/channels gets, so a future CT_OIDC_TOKEN (once core's service-account
// API lands) won't cover this specific pair of endpoints on its own.
// `redirect: 'manual'` avoids needlessly following the 302 back to the full
// /portal/tunnels HTML page -- an opaque redirect (status 0) means success.
async function cpFetchForm(path, fields) {
  const sessionCookie = readSecret('CT_PORTAL_SESSION_COOKIE');
  if (!sessionCookie) return { status: 401, text: 'CT_PORTAL_SESSION_COOKIE not configured' };
  const resp = await fetch(`${CP_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `ct_portal_session=${sessionCookie}` },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  const status = resp.status === 0 ? 200 : resp.status;
  return { status, text: await resp.text().catch(() => '') };
}

// Attempts real control-plane registration for a pending call once both
// sides' attestations are in. Never fabricates success: reports the exact
// failure (almost always 401 today, see header comment) rather than
// pretending the channel is usable.
async function tryRegister(call) {
  if (!call.callerAttest || !call.calleeAttest) return; // wait for both sides
  const reg = await cpFetch('/me/channels', { channel: call.channel, operator_pubkey: call.operatorPub });
  if (reg.status !== 200) {
    call.status = { state: 'pending_core_credential', detail: `POST /me/channels -> ${reg.status} ${reg.text}`.slice(0, 300) };
    console.error(`bridge: channel registration failed for ${call.channel}: ${call.status.detail}`);
    return;
  }
  const memA = await cpFetch(`/me/channels/${call.channel}/members`, call.callerAttest);
  const memB = await cpFetch(`/me/channels/${call.channel}/members`, call.calleeAttest);
  if (memA.status !== 200 || memB.status !== 200) {
    call.status = {
      state: 'pending_core_credential',
      detail: `members -> caller=${memA.status} callee=${memB.status} ${memA.text || memB.text}`.slice(0, 300),
    };
    console.error(`bridge: channel registration failed for ${call.channel}: ${call.status.detail}`);
    return;
  }
  call.status = { state: 'accepted_and_registered' };
  // The "ringing" phase is over the moment a call is genuinely accepted --
  // without this, incomingByEmail keeps pointing at this (now long-finished)
  // channel forever, since sweepExpired() deliberately never expires an
  // accepted_and_registered call. Every subsequent /api/incoming poll (or a
  // page reload after hangup re-subscribing to the same poll) then kept
  // re-surfacing this already-completed call as a brand-new incoming ring,
  // requiring a manual Decline just to clear it before a new call could be
  // placed at all.
  if (incomingByEmail.get(call.calleeEmail) === call.channel) incomingByEmail.delete(call.calleeEmail);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// CADS-webconference-demo#12: no cap here at all meant a single request
// body of any size just kept accumulating in memory until the connection
// ended -- a real, trivial DoS vector. 64KB is generous for what this API
// actually sends (the largest real payload is an attestation blob, still
// well under a few KB); this rejects anything past that instead of trying
// to buffer it.
const MAX_BODY_BYTES = 65_536;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return; // already over the cap -- drop further chunks, memory growth already stopped
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        rejected = true;
        // Deliberately NOT req.destroy() here (regression, caught live): it
        // tears down the request's underlying socket, which the response
        // shares -- Caddy then saw the backend connection just die and
        // reported a bare 502 to the browser instead of ever getting the
        // clean 413 below a chance to be written. Just stop accumulating
        // and let the connection wind down normally once the client
        // finishes sending (or times out on its own) -- the memory-growth
        // concern this cap exists for is already fully addressed by no
        // longer appending to `data`.
        reject(new Error('request body too large'));
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (rejected) return; // already settled via the reject() above
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// CADS-webconference-demo#12 (finding 2): directory and contactRequests
// were never swept at all -- entries only ever left on a clean
// unregister/clear that doesn't exist for either map, so a client that
// simply disappears (closes the tab, network dies, abandons a test
// identity) leaked its entry forever. Neither causes a FUNCTIONAL bug on
// its own (isOnline() already treats a stale directory entry as offline
// via PRESENCE_TTL_MS, regardless of whether the entry still exists) --
// this is purely about bounding unbounded memory growth over the
// deployment's lifetime. Thresholds deliberately generous (days, not the
// ~45s PRESENCE_TTL_MS) -- this is a leak-prevention sweep, not a
// liveness check; a real but currently-offline user's directory
// registration shouldn't vanish just because they haven't opened the app
// in a while.
const DIRECTORY_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const CONTACT_REQUEST_STALE_MS = 7 * 24 * 60 * 60 * 1000;
// Robustness audit finding (proactive review, not yet live-reproduced --
// needs a genuinely long-running bridge process to observe, not a timing
// race): the CALL_TTL_MS check just below deliberately skips any call
// that already reached accepted_and_registered -- see tryRegister's own
// comment above ("sweepExpired() deliberately never expires an
// accepted_and_registered call") -- so incomingByEmail doesn't keep
// re-surfacing a long-finished call as a fresh incoming ring. That
// reasoning is correct for the SHORT-term (~60s CALL_TTL_MS) window, but
// nothing else ever prunes an accepted call's own pendingCalls entry --
// unlike directory/contactRequests just below, which both get this exact
// generous (days, not the short liveness window) leak-prevention sweep.
// Every call this bridge ever successfully connects leaves one entry
// (caller/callee emails, grants, attestations) sitting in memory for the
// rest of the process's life, unboundedly, on a service explicitly meant
// to be a durable, long-running deployment (see #68's own framing).
// Every reader of pendingCalls (/api/attest, /api/cancel, /api/decline,
// /api/call-status, /api/incoming) already handles a missing entry
// gracefully (404 or {incoming:null}) -- the exact same response a truly
// nonexistent/already-expired channel produces today -- so pruning a
// call this stale is safe: no legitimate client still polls a channel
// from a call accepted a week ago.
const ACCEPTED_CALL_STALE_MS = 7 * 24 * 60 * 60 * 1000;
function sweepExpired() {
  const now = Date.now();
  for (const [channel, call] of pendingCalls) {
    if (call.status?.state === 'accepted_and_registered') {
      if (now - call.createdAt > ACCEPTED_CALL_STALE_MS) pendingCalls.delete(channel);
      continue;
    }
    if (now - call.createdAt > CALL_TTL_MS) {
      pendingCalls.delete(channel);
      if (incomingByEmail.get(call.calleeEmail) === channel) incomingByEmail.delete(call.calleeEmail);
    }
  }
  for (const [email, entry] of directory) {
    if (now - entry.lastSeen > DIRECTORY_STALE_MS) directory.delete(email);
  }
  for (const [toEmail, list] of contactRequests) {
    const fresh = list.filter((r) => now - r.createdAt <= CONTACT_REQUEST_STALE_MS);
    if (fresh.length !== list.length) {
      if (fresh.length) contactRequests.set(toEmail, fresh);
      else contactRequests.delete(toEmail);
    }
  }
  // Defensive only -- wsHeartbeatSweep (its own, faster interval) already
  // removes a destroyed socket the moment its ping/pong watchdog notices;
  // this just catches anything that ever slips past that for another
  // reason (e.g. the 'close'/'error' handlers in wsAttachReader, which
  // already delete their own entry via onClose -- true belt-and-suspenders).
  for (const [email, socket] of wsClients) {
    if (socket.destroyed) wsClients.delete(email);
  }
}
setInterval(sweepExpired, 10_000).unref();

// CADS-webconference-demo#9/#10: the real per-request identity check --
// X-Gate-Email is set by Caddy's forward_auth only after the gate's own
// /gate/check verifies a real Keycloak session (same signal /api/whoami,
// #46's /api/is-admin, and #41's approve/decline already trust
// exclusively). The bridge itself is only ever reachable via Caddy's
// reverse proxy on the internal docker network (never exposed directly),
// so a client cannot forge this header -- Caddy is the one setting it.
// Re-verifying the JWT/JWKS a second time inside the bridge would just
// duplicate work the gate already did; trusting this header IS the real
// per-request verification, not a shortcut around it.
//
// Deliberately fails OPEN (returns true -- "can't verify, don't block")
// when X-Gate-Email is absent: an ungated tunnel, or this browser's own
// free-text/no-login identity fallback (see runIdentityScreen's own
// comment in app.js), has no gate-verified identity to check against at
// all. Those deployment modes keep exactly today's trust level (whatever
// the body claims) -- this closes the impersonation gap for a REAL gated
// deployment (the actual production configuration) without silently
// breaking the free-text/testing fallback the app is also built to
// support. A tunnel operator who wants the stronger guarantee everywhere
// enables gate enforcement for that tunnel; that's an existing per-tunnel
// setting, not something this bridge can force from here.
function gateVerifiedEmail(req) {
  const email = req.headers['x-gate-email'];
  return email ? email.trim().toLowerCase() : null;
}
function identityAllowed(req, claimedEmail) {
  const verified = gateVerifiedEmail(req);
  if (!verified) return true; // can't verify -- don't block (see comment above)
  return verified === (claimedEmail || '').trim().toLowerCase();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://bridge');
  try {
    if (req.method === 'GET' && url.pathname === '/api/whoami') {
      // CADS-Tunnel#214: X-Gate-Email is set by the origin's Caddyfile from
      // the login gate's verified /gate/check response -- never client-set,
      // absent entirely when the tunnel isn't gated. Null here means "no
      // verified identity available", not an error.
      const email = req.headers['x-gate-email'] || null;
      return json(res, 200, { email });
    }

    if (req.method === 'POST' && url.pathname === '/api/register') {
      const { email, holderPub, noisePub } = await readBody(req);
      if (!email || !holderPub || !noisePub) return json(res, 400, { error: 'email, holderPub, noisePub required' });
      // CADS-webconference-demo#9: registering overwrites directory[email]
      // with caller-supplied public keys, unconditionally -- a gate-verified
      // caller could register as anyone else, taking over future calls to
      // that victim (see identityAllowed's own comment for the trust model).
      if (!identityAllowed(req, email)) return json(res, 403, { error: 'email does not match your verified identity', code: 'identity_mismatch' });
      directory.set(email.toLowerCase(), { holderPub, noisePub, lastSeen: Date.now() });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
      const { email } = await readBody(req);
      // CADS-webconference-demo#73: no check here let a gate-verified
      // caller keep ANY registered user's presence artificially fresh
      // forever (POST {email:"victim@..."} every 15s), same class of gap
      // #9/f2d199f fixed for register/call/incoming -- this predates that
      // fix, which didn't touch this endpoint.
      if (!identityAllowed(req, email)) return json(res, 403, { error: 'email does not match your verified identity', code: 'identity_mismatch' });
      const entry = directory.get((email || '').toLowerCase());
      if (!entry) return json(res, 404, { error: 'not registered' });
      entry.lastSeen = Date.now();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/presence') {
      const email = (url.searchParams.get('email') || '').toLowerCase();
      return json(res, 200, { online: isOnline(directory.get(email), email) });
    }

    // Presence lookup for the caller's OWN contact list -- CADS-webconference-demo#11:
    // this used to return the FULL directory (every email that has ever
    // registered here, anywhere), regardless of who asked -- a real PII leak
    // (email enumeration) and a presence oracle (who's online right now) for
    // anyone who could reach this endpoint at all. app.js's refreshContacts()
    // already only ever used this to annotate presence for myContacts.all()
    // -- it never needed anyone else's entries -- so scoping the response to
    // an explicit, caller-supplied list changes no real behavior, just closes
    // the leak. `emails` unset/empty deliberately returns nothing rather than
    // falling back to the old full-directory behavior for an unpatched caller.
    if (req.method === 'GET' && url.pathname === '/api/contacts') {
      const requested = (url.searchParams.get('emails') || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const contacts = requested
        .map((email) => ({ email, online: isOnline(directory.get(email), email) }))
        .sort((a, b) => a.email.localeCompare(b.email));
      return json(res, 200, { contacts });
    }

    // Lets the frontend decide whether to show admin-only UI (the revoke
    // panel) at all -- returns only a boolean, never the admin list itself.
    // CADS-webconference-demo#46: used to trust a client-supplied ?email=
    // instead of the gate-verified X-Gate-Email header (same pattern
    // /api/whoami already gets right, above) -- the "only a boolean, so it
    // can't enumerate admins" comment was wrong: a boolean per arbitrary
    // *chosen* identity is exactly an enumeration oracle, one guess per
    // request, no auth required at all. Answers only about the CALLER now
    // (whoever the gate actually verified), never an arbitrary queried
    // identity -- absent X-Gate-Email (tunnel isn't gated, or this is the
    // free-text/no-login identity path) means no verified caller exists, so
    // isAdmin is unconditionally false rather than trusting a guess.
    if (req.method === 'GET' && url.pathname === '/api/is-admin') {
      const email = (req.headers['x-gate-email'] || '').trim().toLowerCase();
      return json(res, 200, { isAdmin: !!email && ADMIN_EMAILS.size > 0 && ADMIN_EMAILS.has(email) });
    }

    // Add/remove an email on the tunnel's login allow-list (who's permitted
    // to pass the gate at all) -- proxies the control plane's own portal
    // form-POST routes (login_allowlist_add_route/_remove_route in
    // CADS-Tunnel's portal_api.rs), reusing the exact same session-cookie
    // credential cpFetch() already holds for channel registration.
    // CADS-webconference-demo#10: adding used to be open to ANY gate-verified
    // caller, for an ARBITRARY email -- not "add myself," an actual
    // privilege-escalation surface into the tunnel's login system (self-
    // approve any account, not just your own). Gated to ADMIN_EMAILS now,
    // the same as remove already was. msgSearchForm's "add a contact"
    // action in app.js already treats this call as best-effort (the contact
    // still gets added locally, and the invited person still gets a
    // contact-request notification, either way) -- a non-admin adding
    // someone not yet on the allow-list now needs that person to separately
    // self-request access via the #36 flow (request-access.html) for an
    // admin to approve, rather than being silently self-granted.
    if (req.method === 'POST' && url.pathname === '/api/allowlist/add') {
      if (!TUNNEL_ID) return json(res, 503, { error: 'WEBCONFERENCE_TUNNEL_ID not configured' });
      const { email } = await readBody(req);
      if (!email) return json(res, 400, { error: 'email required' });
      const caller = gateVerifiedEmail(req) || '';
      // CADS-webconference-demo#76: this GRANTS tunnel access to an
      // arbitrary account -- the ADMIN_EMAILS.size>0 short-circuit that
      // every admin guard here uses meant an unconfigured admin list made
      // this a no-op check, open to any gate-admitted caller, reopening
      // exactly the #10 escalation this comment block already describes.
      // Fails closed instead when unconfigured, unlike the read/revoke
      // endpoints below (GET access-requests, decline, allowlist/remove),
      // which stay permissive on an empty ADMIN_EMAILS for the same demo-
      // ergonomics reason #10's own fix originally allowed -- granting
      // access is the one action worth requiring real admin config for.
      if (ADMIN_EMAILS.size === 0) {
        return json(res, 503, { error: 'admin not configured (WEBCONFERENCE_ADMIN_EMAILS unset) -- cannot grant tunnel access without a configured admin' });
      }
      if (!ADMIN_EMAILS.has(caller)) {
        return json(res, 403, { error: 'admin only' });
      }
      const resp = await cpFetchForm(`/portal/tunnels/${TUNNEL_ID}/login-allowlist`, { email });
      if (resp.status >= 400) return json(res, 502, { error: `control plane -> ${resp.status}` });
      return json(res, 200, { ok: true });
    }
    // Contact requests: "I added you" shows up in the OTHER person's
    // Requests tab so adding someone isn't silently one-sided. POST is
    // idempotent per (from,to) pair (no duplicate entries); GET returns and
    // leaves the list intact (the client itself tracks which it has already
    // shown, same as /api/incoming's own polling model) so a page reload
    // doesn't lose a still-unactioned request; DELETE clears one entry once
    // the recipient accepts or declines it.
    if (req.method === 'POST' && url.pathname === '/api/contact-requests') {
      const { fromEmail, toEmail } = await readBody(req);
      if (!fromEmail || !toEmail) return json(res, 400, { error: 'fromEmail and toEmail required' });
      // CADS-webconference-demo#73: fromEmail was trusted outright -- a
      // gate-verified caller could POST {fromEmail:"victim@...", toEmail:
      // "anyone@..."} and the recipient would see a request that appears
      // to come FROM the victim (toEmail deliberately stays unchecked --
      // sending someone a request is the whole point). Same impersonation
      // class #9/f2d199f fixed for /api/call and /api/register.
      if (!identityAllowed(req, fromEmail)) return json(res, 403, { error: 'fromEmail does not match your verified identity', code: 'identity_mismatch' });
      const to = toEmail.trim().toLowerCase();
      const list = contactRequests.get(to) || [];
      if (!list.some((r) => r.fromEmail.toLowerCase() === fromEmail.trim().toLowerCase())) {
        list.push({ fromEmail: fromEmail.trim(), createdAt: Date.now() });
        contactRequests.set(to, list);
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/contact-requests') {
      const rawEmail = url.searchParams.get('email') || '';
      // CADS-webconference-demo#73: no check here made this an enumeration
      // oracle -- any gate-verified caller could read who's been sending a
      // victim contact requests (fromEmail + createdAt per entry) via
      // ?email=victim@..., the same PII-leak class as #11/#61.
      if (!identityAllowed(req, rawEmail)) return json(res, 403, { error: 'email does not match your verified identity', code: 'identity_mismatch' });
      const email = rawEmail.trim().toLowerCase();
      return json(res, 200, { requests: contactRequests.get(email) || [] });
    }
    if (req.method === 'POST' && url.pathname === '/api/contact-requests/clear') {
      const { email, fromEmail } = await readBody(req);
      // CADS-webconference-demo#73: checked against `email` (whose inbox
      // this clears), not `fromEmail` (which entry to remove from it) --
      // without this a gate-verified caller could wipe a victim's pending
      // inbound contact requests before they're ever seen (delivery DoS).
      // fromEmail deliberately stays unchecked, same reasoning as toEmail
      // above: it names which existing entry to drop, not who's acting.
      if (!identityAllowed(req, email)) return json(res, 403, { error: 'email does not match your verified identity', code: 'identity_mismatch' });
      const to = (email || '').trim().toLowerCase();
      const list = contactRequests.get(to);
      if (list) {
        contactRequests.set(to, list.filter((r) => r.fromEmail.toLowerCase() !== (fromEmail || '').trim().toLowerCase()));
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/allowlist/remove') {
      if (!TUNNEL_ID) return json(res, 503, { error: 'WEBCONFERENCE_TUNNEL_ID not configured' });
      const { email } = await readBody(req);
      if (!email) return json(res, 400, { error: 'email required' });
      // CADS-webconference-demo#9/#10: same fix as /api/is-admin (#46) and
      // approve/decline (#41) -- was checking the client-supplied
      // callerEmail body field, letting any gate-admitted non-admin spoof
      // it to a real admin's address and revoke anyone's access.
      const caller = gateVerifiedEmail(req) || '';
      if (ADMIN_EMAILS.size > 0 && !ADMIN_EMAILS.has(caller)) {
        return json(res, 403, { error: 'admin only' });
      }
      const resp = await cpFetchForm(`/portal/tunnels/${TUNNEL_ID}/login-allowlist/${encodeURIComponent(email)}/remove`, {});
      if (resp.status >= 400) return json(res, 502, { error: `control plane -> ${resp.status}` });
      return json(res, 200, { ok: true });
    }

    // CADS-webconference-demo#36: a brand-new self-registered user hits the
    // gate's own rejection page (control plane, a separate repo) with no
    // actionable next step -- every existing contact-add path requires
    // already being admitted. POST here is reachable WITHOUT passing the
    // gate (see Caddyfile.selfservice's @exempt matcher) so a rejected
    // registrant has somewhere to go; GET/approve/decline stay behind the
    // normal gate (part of /api/*, not exempted) and approve is admin-only,
    // matching /allowlist/remove's own gate -- same reasoning: letting any
    // already-admitted caller grant a THIRD party's access is a bigger
    // privilege than adding your own contact.
    if (req.method === 'POST' && url.pathname === '/api/access-requests') {
      // CADS-webconference-demo#41 (finding 2): the one gate-exempt,
      // fully-unauthenticated endpoint in this bridge -- rate-limited per
      // IP, email-format-checked, and capped in total, see the constants'
      // own comment above for why.
      if (accessRequestRateLimited(clientIp(req))) return json(res, 429, { error: 'too many requests -- try again later' });
      const { email } = await readBody(req);
      if (!email || !EMAIL_RE.test(email.trim())) return json(res, 400, { error: 'a valid email is required' });
      const key = email.trim().toLowerCase();
      if (!accessRequests.has(key) && accessRequests.size >= ACCESS_REQUEST_MAX_PENDING) {
        return json(res, 503, { error: 'too many pending requests -- try again later' });
      }
      if (!accessRequests.has(key)) {
        accessRequests.set(key, { email: email.trim(), createdAt: Date.now() });
        persistAccessRequests();
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/access-requests') {
      // CADS-webconference-demo#61: the write side of this feature
      // (approve/decline, right below) was made admin-only in #41 -- this
      // read side wasn't, even though app.js's own UI comment already
      // called the list admin-only. Any gate-admitted non-admin could
      // fetch() this directly and enumerate pending requesters' emails
      // regardless of the UI panel being hidden for them. Same
      // X-Gate-Email / ADMIN_EMAILS check as approve/decline, so the
      // "admin-only" claim is actually true at the server, not just in
      // the client.
      const caller = (req.headers['x-gate-email'] || '').trim().toLowerCase();
      if (ADMIN_EMAILS.size > 0 && !ADMIN_EMAILS.has(caller)) {
        return json(res, 403, { error: 'admin only' });
      }
      return json(res, 200, { requests: [...accessRequests.values()].sort((a, b) => a.createdAt - b.createdAt) });
    }
    if (req.method === 'POST' && url.pathname === '/api/access-requests/approve') {
      if (!TUNNEL_ID) return json(res, 503, { error: 'WEBCONFERENCE_TUNNEL_ID not configured' });
      const { email } = await readBody(req);
      if (!email) return json(res, 400, { error: 'email required' });
      // CADS-webconference-demo#41 (finding 1): used to check the
      // client-supplied `callerEmail` body field -- any gate-admitted
      // NON-admin could POST callerEmail: "<a real admin's email>" and
      // approve/decline arbitrary requests, bypassing the admin-only gate
      // this feature claims to have. X-Gate-Email is the same
      // gate-verified signal /api/whoami and (#46) /api/is-admin already
      // trust -- never client-supplied, set by Caddy's forward_auth only
      // after a real verified session.
      const caller = (req.headers['x-gate-email'] || '').trim().toLowerCase();
      // CADS-webconference-demo#76: same GRANT-capability reasoning as
      // allowlist/add's matching comment -- this also adds an arbitrary
      // account to the tunnel's login allow-list, so it fails closed on an
      // unconfigured admin list instead of the size>0 short-circuit making
      // the check a no-op.
      if (ADMIN_EMAILS.size === 0) {
        return json(res, 503, { error: 'admin not configured (WEBCONFERENCE_ADMIN_EMAILS unset) -- cannot grant tunnel access without a configured admin' });
      }
      if (!ADMIN_EMAILS.has(caller)) {
        return json(res, 403, { error: 'admin only' });
      }
      const resp = await cpFetchForm(`/portal/tunnels/${TUNNEL_ID}/login-allowlist`, { email });
      if (resp.status >= 400) return json(res, 502, { error: `control plane -> ${resp.status}` });
      accessRequests.delete(email.trim().toLowerCase());
      persistAccessRequests();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/access-requests/decline') {
      const { email } = await readBody(req);
      if (!email) return json(res, 400, { error: 'email required' });
      // CADS-webconference-demo#41 (finding 1) -- see approve's matching comment.
      const caller = (req.headers['x-gate-email'] || '').trim().toLowerCase();
      if (ADMIN_EMAILS.size > 0 && !ADMIN_EMAILS.has(caller)) {
        return json(res, 403, { error: 'admin only' });
      }
      accessRequests.delete(email.trim().toLowerCase());
      persistAccessRequests();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/call') {
      // CADS-webconference-demo#12 (finding 8) -- see callRateLimited's own
      // comment for why this is keyed by IP.
      if (callRateLimited(clientIp(req))) return json(res, 429, { error: 'too many calls -- try again in a moment' });
      const { fromEmail, toEmail, transport, kind } = await readBody(req);
      // CADS-webconference-demo#9: fromEmail used to be trusted outright --
      // a gate-verified caller could place a call "from" any registered
      // victim and receive grantForCaller, joining as that victim. toEmail
      // deliberately ISN'T checked here -- calling someone else is the
      // whole point of this endpoint.
      if (!identityAllowed(req, fromEmail)) return json(res, 403, { error: 'fromEmail does not match your verified identity', code: 'identity_mismatch' });
      const from = (fromEmail || '').toLowerCase();
      const to = (toEmail || '').toLowerCase();
      const caller = directory.get(from);
      const callee = directory.get(to);
      if (!caller) return json(res, 400, { error: 'caller not registered' });
      if (!isOnline(callee, to)) return json(res, 200, { status: 'offline' });
      let minted;
      try {
        minted = await mintGrants(caller.holderPub, callee.holderPub);
      } catch (e) {
        // CADS-webconference-demo#31: e.message here can be raw execFile
        // internals (stderr from the grant binary, an ENOENT-shaped path
        // error) -- logged in full server-side, generic to the client.
        console.error('bridge: grant minting failed:', e);
        return json(res, 500, { error: 'grant minting failed' });
      }
      const call = {
        channel: minted.channel,
        operatorPub: minted.operatorPub,
        callerEmail: from,
        calleeEmail: to,
        grantForCaller: minted.grantA,
        grantForCallee: minted.grantB,
        // 'webrtc' (default) or 'channel' -- caller's choice, both sides use
        // the same value so they agree on how media/chat travel (see app.js).
        transport: transport === 'channel' ? 'channel' : 'webrtc',
        // 'call' (default, rings + shows the incoming card) or
        // 'chat-delivery' (silent -- the callee auto-attests with no UI at
        // all, see showIncoming's branch in app.js). Threaded through so a
        // background message flush never surfaces a ringing card for
        // something the recipient never asked to be interrupted for.
        kind: kind === 'chat-delivery' ? 'chat-delivery' : 'call',
        createdAt: Date.now(),
        callerAttest: null,
        calleeAttest: null,
        status: { state: 'ringing' },
      };
      pendingCalls.set(call.channel, call);
      incomingByEmail.set(to, call.channel);
      // Push immediately if the callee has a live WS connection -- falls back
      // to their own /api/incoming poll (still running regardless) if not.
      wsPush(to, { type: 'incoming', channel: call.channel, fromEmail: call.callerEmail, grant: call.grantForCallee, ws: WS_URL, transport: call.transport, kind: call.kind });
      return json(res, 200, { status: 'ringing', channel: call.channel, grant: call.grantForCaller, ws: WS_URL, transport: call.transport });
    }

    if (req.method === 'POST' && url.pathname === '/api/attest') {
      // {channel, role: 'caller'|'callee', holderPub, noisePub, attestation}
      const { channel, role, holderPub, noisePub, attestation } = await readBody(req);
      const call = pendingCalls.get(channel);
      if (!call) return json(res, 404, { error: 'no such pending call' });
      const rec = { holder: holderPub, noise_pubkey: noisePub, noise_attestation: attestation };
      if (role === 'caller') call.callerAttest = rec;
      else if (role === 'callee') call.calleeAttest = rec;
      else return json(res, 400, { error: 'role must be caller or callee' });
      await tryRegister(call);
      return json(res, 200, { status: call.status });
    }

    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      // Caller-initiated hangup of a still-ringing call (gave up, closed the
      // tab, etc). Mirrors /api/decline's fix in the other direction: without
      // this, the callee's incoming-call card had no way to learn the caller
      // moved on, so it kept ringing for the full 60s CALL_TTL_MS regardless.
      // Pushes an explicit dismissal over the callee's WS (if connected) so an
      // already-displayed card disappears immediately, not just on next poll.
      const { channel } = await readBody(req);
      const call = pendingCalls.get(channel);
      if (!call) return json(res, 404, { error: 'no such pending call' });
      // #69-follow: same clobber-guard as /api/decline below -- see that
      // comment for the full race. A stale cancel arriving after the call
      // already registered must not silently revert a genuine connection.
      if (call.status?.state === 'accepted_and_registered') {
        return json(res, 200, { ok: true, ignored: true, reason: 'call already accepted' });
      }
      call.status = { state: 'cancelled' };
      if (incomingByEmail.get(call.calleeEmail) === channel) incomingByEmail.delete(call.calleeEmail);
      wsPush(call.calleeEmail, { type: 'cancelled', channel });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/decline') {
      // Callee-initiated hangup of a still-ringing/pending call. Without this,
      // Decline only hid the card client-side -- the bridge kept the channel
      // in incomingByEmail until its 60s TTL, so the callee's own fallback
      // poll (every 3s) kept re-fetching and re-showing the same call,
      // looping regardless of whether the caller was still calling.
      const { channel } = await readBody(req);
      const call = pendingCalls.get(channel);
      if (!call) return json(res, 404, { error: 'no such pending call' });
      // #69-follow: call.status is a single value keyed only by channel, but
      // a callee can have more than one tab/window open under the same
      // identity, each independently running its own 45s ring-timeout /
      // busy-guard auto-decline (app.js INCOMING_CARD_TIMEOUT_MS). If one
      // tab genuinely accepts (tryRegister above sets
      // 'accepted_and_registered' once both attestations land) and a
      // *different*, backgrounded tab's stray decline arrives afterward,
      // an unconditional overwrite here would revert the status back to
      // 'declined' -- the caller's pollCallStatus (app.js) would then see
      // "declined" for a call that was genuinely answered a moment earlier.
      // Reproduced live: caller reported seeing "declined" while the callee
      // had multiple tabs open, one of which had accepted. Once a call has
      // resolved to accepted_and_registered it's terminal from this
      // endpoint's perspective: ignore the stale decline instead of
      // silently reverting a successful call.
      if (call.status?.state === 'accepted_and_registered') {
        return json(res, 200, { ok: true, ignored: true, reason: 'call already accepted' });
      }
      call.status = { state: 'declined' };
      if (incomingByEmail.get(call.calleeEmail) === channel) incomingByEmail.delete(call.calleeEmail);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/call-status') {
      const channel = url.searchParams.get('channel');
      const call = pendingCalls.get(channel);
      if (!call) return json(res, 404, { error: 'no such pending call' });
      return json(res, 200, { status: call.status });
    }

    if (req.method === 'GET' && url.pathname === '/api/incoming') {
      // CADS-webconference-demo#9: the single most severe vector -- this
      // returns grant: call.grantForCallee, a bearer credential that joins
      // the call as the callee, to whoever asks with ?email=<anyone>. A
      // gate-verified caller could steal any other user's incoming call
      // grant with no check that they own that email at all.
      const rawEmail = url.searchParams.get('email') || '';
      if (!identityAllowed(req, rawEmail)) return json(res, 403, { error: 'email does not match your verified identity', code: 'identity_mismatch' });
      const email = rawEmail.toLowerCase();
      const channel = incomingByEmail.get(email);
      if (!channel) return json(res, 200, { incoming: null });
      const call = pendingCalls.get(channel);
      if (!call) {
        incomingByEmail.delete(email);
        return json(res, 200, { incoming: null });
      }
      return json(res, 200, { incoming: { channel: call.channel, fromEmail: call.callerEmail, grant: call.grantForCallee, ws: WS_URL, transport: call.transport, kind: call.kind } });
    }

    // CADS-webconference-demo#87/#88: accepts a batch of already-encrypted
    // chatStore rows (appended, deduped by conversation+seq+from -- same
    // dedupe key ChatStore.record()'s own received:true path already
    // uses) and/or a contacts/blocked tombstone-entries delta (merged via
    // mergeEntries, same rule as the client's own merge()). Any subset of
    // {messages, contacts, blocked} may be present -- callers push what
    // changed, not the whole state, keeping each call well under the
    // existing MAX_BODY_BYTES cap (this endpoint intentionally does NOT
    // get its own larger body limit -- see readBody's own #12 comment on
    // why 64KB exists at all; a device with a large backlog just calls
    // this multiple times).
    if (req.method === 'POST' && url.pathname === '/api/sync/push') {
      const { email, messages, contacts, blocked } = await readBody(req);
      if (!email) return json(res, 400, { error: 'email required' });
      if (!identityAllowed(req, email)) return json(res, 403, { error: 'email does not match your verified identity', code: 'identity_mismatch' });
      const emailKey = email.toLowerCase();
      const state = getSyncState(emailKey);
      if (Array.isArray(messages)) {
        for (const row of messages) {
          if (!row || typeof row.conversation !== 'string' || typeof row.seq !== 'number' || (row.from !== 'me' && row.from !== 'peer')) continue;
          const dup = state.messages.some((m) => m.conversation === row.conversation && m.seq === row.seq && m.from === row.from);
          if (dup) continue;
          // CADS-webconference-demo#87: a chunked row carries chunkIndex/
          // chunkCount + this chunk's own ciphertextChunk slice instead of
          // a complete ciphertext -- reassembled across however many
          // /sync/push calls it takes before landing in state.messages
          // exactly like a normal (small, single-request) row does.
          if (typeof row.chunkIndex === 'number' && typeof row.chunkCount === 'number' && row.chunkCount > 0) {
            const chunkKey = `${emailKey}:${row.conversation}:${row.seq}:${row.from}`;
            let pending = pendingChunkedMessages.get(chunkKey);
            if (row.chunkIndex === 0) {
              // Fresh start (or a retry-from-scratch after an earlier
              // attempt failed partway) -- always (re)initializes, never
              // appends onto a stale prior attempt's parts.
              const keys = pendingChunkKeysFor(emailKey);
              if (!pending && keys.length >= MAX_PENDING_CHUNKED_UPLOADS_PER_IDENTITY) {
                pendingChunkedMessages.delete(keys[0]); // oldest-first, same FIFO shape as MAX_SYNC_MESSAGES_PER_IDENTITY above
              }
              pending = {
                parts: new Array(row.chunkCount),
                received: 0,
                meta: { conversation: row.conversation, seq: row.seq, from: row.from, ts: row.ts, kind: row.kind, iv: row.iv, fileName: row.fileName, fileMimeType: row.fileMimeType, fileSize: row.fileSize },
              };
              pendingChunkedMessages.set(chunkKey, pending);
            }
            if (!pending || row.chunkCount !== pending.parts.length || row.chunkIndex >= pending.parts.length) continue; // no chunk 0 seen yet, or an inconsistent resend -- drop, client will retry from scratch
            if (pending.parts[row.chunkIndex] === undefined) pending.received++;
            pending.parts[row.chunkIndex] = Array.isArray(row.ciphertextChunk) ? row.ciphertextChunk : [];
            if (pending.received < pending.parts.length) continue; // still waiting on more chunks
            const ciphertext = pending.parts.flat();
            pendingChunkedMessages.delete(chunkKey);
            state.messages.push({ ...pending.meta, ciphertext, rev: state.nextRevision++ });
            continue;
          }
          state.messages.push({ ...row, rev: state.nextRevision++ });
        }
        const overflow = state.messages.length - MAX_SYNC_MESSAGES_PER_IDENTITY;
        if (overflow > 0) state.messages.splice(0, overflow); // oldest-revision-first, same FIFO shape as #77's local cap
      }
      if (contacts && typeof contacts.entries === 'object') mergeEntries(state.contacts.entries, contacts.entries);
      if (blocked && typeof blocked.entries === 'object') mergeEntries(state.blocked.entries, blocked.entries);
      persistSyncStore();
      return json(res, 200, { ok: true, revision: state.nextRevision - 1 });
    }

    // Pull everything this identity's sync state has past `since` (a
    // revision number the caller remembers from its last pull/push
    // response; 0 on a device's very first sync). One counter across every
    // conversation -- see the syncStore comment for why -- so a single
    // `since` value pages through all of them together; `contacts`/
    // `blocked` are returned in full each time (their entries maps stay
    // small, no pagination needed) for the caller to merge() locally.
    if (req.method === 'GET' && url.pathname === '/api/sync/pull') {
      const email = (url.searchParams.get('email') || '').toLowerCase();
      if (!email) return json(res, 400, { error: 'email required' });
      if (!identityAllowed(req, email)) return json(res, 403, { error: 'email does not match your verified identity', code: 'identity_mismatch' });
      const since = Number(url.searchParams.get('since') || 0);
      const state = getSyncState(email);
      const SYNC_PULL_PAGE = 200; // keeps the response well under MAX_BODY_BYTES-scale concerns; caller pages via the returned nextSince
      const rows = state.messages.filter((m) => m.rev > (Number.isFinite(since) ? since : 0)).slice(0, SYNC_PULL_PAGE);
      const nextSince = rows.length ? rows[rows.length - 1].rev : since;
      return json(res, 200, { messages: rows, nextSince, contacts: state.contacts, blocked: state.blocked });
    }

    // New device: publishes its ephemeral ECDH public key under a short
    // code it displays to the user. Gate-verified when a session exists
    // (identityAllowed), but ALSO reachable ungated -- this app supports a
    // free-text/no-login identity mode (see identityAllowed's own comment)
    // where there's no session to verify against at all, and the pairing
    // CODE is the only proof of "same person, both devices" available in
    // that mode. Overwrites any existing offer for the same code (a retry
    // after a network blip shouldn't need a fresh code).
    if (req.method === 'POST' && url.pathname === '/api/pair/offer') {
      if (pairingRateLimited(clientIp(req))) return json(res, 429, { error: 'too many pairing attempts, try again later' });
      prunePairingOffers();
      const { email, code, tempPubKeyJwk } = await readBody(req);
      if (!email || !EMAIL_RE.test(email.trim())) return json(res, 400, { error: 'a valid email is required' });
      if (!code || !PAIRING_CODE_RE.test(code)) return json(res, 400, { error: 'invalid pairing code' });
      if (!tempPubKeyJwk || typeof tempPubKeyJwk !== 'object') return json(res, 400, { error: 'tempPubKeyJwk required' });
      if (!identityAllowed(req, email)) return json(res, 403, { error: 'email does not match your verified identity', code: 'identity_mismatch' });
      pairingOffers.set(code, { email: email.toLowerCase(), tempPubKeyJwk, offeredAt: Date.now(), result: null });
      return json(res, 200, { ok: true });
    }

    // Existing/already-paired device: user typed in the code shown on the
    // new device. Fetches just enough to encrypt to it -- never the offer
    // holder's email is NOT what authorizes this (the code itself is the
    // only secret exchanged out-of-band); this only leaks the temp pubkey
    // for a still-pending, not-yet-delivered offer, which is public key
    // material by definition.
    if (req.method === 'GET' && url.pathname === '/api/pair/lookup') {
      prunePairingOffers();
      const code = (url.searchParams.get('code') || '').toUpperCase();
      const offer = pairingOffers.get(code);
      if (!offer || offer.result) return json(res, 404, { error: 'no such pending pairing code' });
      return json(res, 200, { tempPubKeyJwk: offer.tempPubKeyJwk });
    }

    // Existing/already-paired device: delivers the real identity, ECDH-
    // encrypted to the new device's temp public key from /api/pair/lookup.
    // This bridge stores oldDevicePubKeyJwk/iv/ciphertext opaquely -- it
    // has neither ECDH private key, so it can't decrypt this any more than
    // a relay hop on the ws_channel transport the account owner originally
    // asked for could have. Single delivery per code (result set once,
    // /api/pair/poll below consumes and deletes it) -- a second delivery
    // attempt for an already-fulfilled code is rejected, not overwritten.
    if (req.method === 'POST' && url.pathname === '/api/pair/deliver') {
      if (pairingRateLimited(clientIp(req))) return json(res, 429, { error: 'too many pairing attempts, try again later' });
      prunePairingOffers();
      const { code: rawCode, oldDevicePubKeyJwk, iv, ciphertext } = await readBody(req);
      const code = (rawCode || '').toUpperCase();
      const offer = pairingOffers.get(code);
      if (!offer) return json(res, 404, { error: 'no such pending pairing code' });
      if (offer.result) return json(res, 409, { error: 'this pairing code was already used' });
      // When gated, the delivering device's OWN verified email must match
      // the offer's claimed email -- stops a gate-verified caller from
      // delivering (encrypted, so not a confidentiality issue, but still a
      // pointless-at-best action) into a pairing session for a different
      // account than their own.
      if (!identityAllowed(req, offer.email)) return json(res, 403, { error: 'email does not match your verified identity', code: 'identity_mismatch' });
      if (!oldDevicePubKeyJwk || !iv || !ciphertext) return json(res, 400, { error: 'oldDevicePubKeyJwk, iv, ciphertext required' });
      offer.result = { oldDevicePubKeyJwk, iv, ciphertext, deliveredAt: Date.now() };
      return json(res, 200, { ok: true });
    }

    // New device: polls until the existing device has delivered. Consumes
    // (deletes) the offer once returned -- single-use, so a stolen/guessed
    // code can't be replayed after the legitimate new device already
    // claimed it.
    if (req.method === 'GET' && url.pathname === '/api/pair/poll') {
      prunePairingOffers();
      const code = (url.searchParams.get('code') || '').toUpperCase();
      const offer = pairingOffers.get(code);
      if (!offer || !offer.result) return json(res, 200, { ready: false });
      pairingOffers.delete(code);
      return json(res, 200, { ready: true, ...offer.result });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    // CADS-webconference-demo#31: this used to return e.message verbatim to
    // the client for ANY uncaught error, including a JSON.parse failure on
    // a malformed body (readBody) surfacing its raw parse message, and
    // (were one to ever reach here) a stack-trace-adjacent detail from
    // somewhere deeper. Malformed input is a client mistake worth a real
    // 400 with a real reason; anything else is unexpected enough that the
    // client doesn't need (and shouldn't get) the internals -- logged
    // server-side in full instead, where whoever operates this bridge can
    // actually act on it.
    if (e instanceof SyntaxError) {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    if (e.message === 'request body too large') {
      return json(res, 413, { error: e.message }); // readBody's own message is already client-safe, not internal detail
    }
    console.error(`bridge: unhandled error on ${req.method} ${url.pathname}:`, e);
    json(res, 500, { error: 'internal error' });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://bridge');
  const rawEmail = url.searchParams.get('email') || '';
  const email = rawEmail.toLowerCase();
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/api/ws' || !email || !key) {
    // CADS-webconference-demo#65: this destroy (and the identityAllowed one
    // below) used to be completely silent -- a rejected WS upgrade just
    // vanished as a raw socket close, indistinguishable from a genuine
    // network-level drop by anyone looking at server-side logs. Logging why
    // turned out to matter live: it's what let a real live-reported
    // "Connection trouble" recurrence be conclusively ruled OUT as an
    // app-level rejection (zero log lines here across the reproduction
    // window) rather than staying an open question about whether the fix
    // in bf8f424 was actually complete.
    console.warn(`bridge: WS upgrade rejected -- pathname=${url.pathname} email=${email || '(empty)'} hasKey=${!!key}`);
    socket.destroy();
    return;
  }
  // CADS-webconference-demo#9: first-connector-wins with no auth at all --
  // an attacker connecting as the victim's email received the victim's own
  // incoming-call grant over this socket (wsPush in /api/call). Same
  // gate-verified-header check as every other identity-sensitive endpoint;
  // this request goes through the SAME Caddy route (gate check, then
  // reverse_proxy) as any other /api/* call before it ever reaches here, so
  // X-Gate-Email should be present under the same conditions it is
  // anywhere else.
  if (!identityAllowed(req, rawEmail)) {
    console.warn(`bridge: WS upgrade rejected -- identityAllowed false for claimed=${rawEmail} verified=${gateVerifiedEmail(req)}`);
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
  );
  wsClients.set(email, socket);
  wsAttachReader(socket, () => {
    if (wsClients.get(email) === socket) wsClients.delete(email);
  });
});

// CADS-webconference-demo#12 (finding 7): Node has no default request
// timeout as of the version this runs on -- a slowloris client (headers or
// body trickled in at ~1 byte/sec) held a connection, and readBody's own
// accumulation, open indefinitely. headersTimeout bounds how long the
// initial request line + headers can take to arrive; requestTimeout bounds
// the whole request (headers through body) -- both well above any
// legitimate real-world latency this bridge would ever see for its own
// tiny JSON payloads.
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;

const [host, port] = LISTEN.split(':');
server.listen(Number(port), host, () => {
  const authMode = OIDC_CLIENT_ID && OIDC_CLIENT_SECRET
    ? 'service-account (self-refreshing)'
    : process.env.CT_OIDC_TOKEN
      ? 'static bearer token (will expire, no refresh)'
      : readSecret('CT_PORTAL_SESSION_COOKIE')
        ? 'portal session cookie (will expire in ~8h, no refresh; login-allowlist add/remove needs this regardless)'
        : 'NONE -- registration will fail';
  console.log(`webconference-demo-bridge listening on ${LISTEN} (cp=${CP_URL}, registration auth: ${authMode})`);
});
