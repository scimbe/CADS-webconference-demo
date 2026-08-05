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
const OPERATOR_KEY = process.env.CT_CHANNEL_OPERATOR_KEY; // 64-hex private key, from `ct-agent channel operator-init`
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
if (ADMIN_EMAILS.size === 0) {
  console.warn('bridge: WEBCONFERENCE_ADMIN_EMAILS not set -- /api/allowlist/remove is open to any caller');
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
    socket.write(wsFrame(obj));
    return true;
  } catch (_) {
    return false;
  }
}

// Drains client->server frames (unmasking per spec, since client frames are
// always masked) just enough to keep the TCP stream flowing and detect a
// close frame -- this channel is push-only (server->client), the client
// never sends application data over it.
function wsAttachReader(socket, onClose) {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
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
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return; // wait for the rest
      const opcode = buf[0] & 0x0f;
      buf = buf.slice(offset + maskLen + len);
      if (opcode === 0x8) {
        onClose();
        try { socket.end(); } catch (_) {}
        return;
      }
    }
  };
  socket.on('data', onData);
  socket.on('close', onClose);
  socket.on('error', onClose);
}

function isOnline(entry) {
  return !!entry && Date.now() - entry.lastSeen < PRESENCE_TTL_MS;
}

function mintGrants(holderAPub, holderBPub) {
  return new Promise((resolve, reject) => {
    execFile(GRANT_BIN, [holderAPub, holderBPub, '--operator-private', OPERATOR_KEY, '--ttl-secs', '3600'], (err, stdout) => {
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
const OIDC_CLIENT_SECRET = process.env.CT_OIDC_CLIENT_SECRET;
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
  const sessionCookie = process.env.CT_PORTAL_SESSION_COOKIE;
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
  const sessionCookie = process.env.CT_PORTAL_SESSION_COOKIE;
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sweepExpired() {
  const now = Date.now();
  for (const [channel, call] of pendingCalls) {
    if (now - call.createdAt > CALL_TTL_MS && call.status?.state !== 'accepted_and_registered') {
      pendingCalls.delete(channel);
      if (incomingByEmail.get(call.calleeEmail) === channel) incomingByEmail.delete(call.calleeEmail);
    }
  }
}
setInterval(sweepExpired, 10_000).unref();

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
      directory.set(email.toLowerCase(), { holderPub, noisePub, lastSeen: Date.now() });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
      const { email } = await readBody(req);
      const entry = directory.get((email || '').toLowerCase());
      if (!entry) return json(res, 404, { error: 'not registered' });
      entry.lastSeen = Date.now();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/presence') {
      const email = (url.searchParams.get('email') || '').toLowerCase();
      return json(res, 200, { online: isOnline(directory.get(email)) });
    }

    // Address-book contact list -- everyone who has ever registered presence
    // here (not the gate's login allow-list, which this bridge can write to
    // below but has no JSON API to read; see login_allowlist_add_route in
    // CADS-Tunnel). "online" reuses the same PRESENCE_TTL_MS freshness check
    // /api/presence already applies to a single email.
    if (req.method === 'GET' && url.pathname === '/api/contacts') {
      const contacts = [...directory.entries()]
        .map(([email, entry]) => ({ email, online: isOnline(entry) }))
        .sort((a, b) => a.email.localeCompare(b.email));
      return json(res, 200, { contacts });
    }

    // Lets the frontend decide whether to show admin-only UI (the revoke
    // panel) at all -- returns only a boolean, never the admin list itself,
    // so this can't be used to enumerate who's an admin.
    if (req.method === 'GET' && url.pathname === '/api/is-admin') {
      const email = (url.searchParams.get('email') || '').trim().toLowerCase();
      return json(res, 200, { isAdmin: ADMIN_EMAILS.size > 0 && ADMIN_EMAILS.has(email) });
    }

    // Add/remove an email on the tunnel's login allow-list (who's permitted
    // to pass the gate at all) -- proxies the control plane's own portal
    // form-POST routes (login_allowlist_add_route/_remove_route in
    // CADS-Tunnel's portal_api.rs), reusing the exact same session-cookie
    // credential cpFetch() already holds for channel registration. Adding is
    // still open to any gate-verified caller (that's the same action as
    // adding a contact, from the user's side -- see msgSearchForm in app.js);
    // removing is gated to ADMIN_EMAILS above, since letting any caller
    // revoke *anyone's* access was a real privilege gap, not a deliberate
    // design choice.
    if (req.method === 'POST' && url.pathname === '/api/allowlist/add') {
      if (!TUNNEL_ID) return json(res, 503, { error: 'WEBCONFERENCE_TUNNEL_ID not configured' });
      const { email } = await readBody(req);
      if (!email) return json(res, 400, { error: 'email required' });
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
      const to = toEmail.trim().toLowerCase();
      const list = contactRequests.get(to) || [];
      if (!list.some((r) => r.fromEmail.toLowerCase() === fromEmail.trim().toLowerCase())) {
        list.push({ fromEmail: fromEmail.trim(), createdAt: Date.now() });
        contactRequests.set(to, list);
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/contact-requests') {
      const email = (url.searchParams.get('email') || '').trim().toLowerCase();
      return json(res, 200, { requests: contactRequests.get(email) || [] });
    }
    if (req.method === 'POST' && url.pathname === '/api/contact-requests/clear') {
      const { email, fromEmail } = await readBody(req);
      const to = (email || '').trim().toLowerCase();
      const list = contactRequests.get(to);
      if (list) {
        contactRequests.set(to, list.filter((r) => r.fromEmail.toLowerCase() !== (fromEmail || '').trim().toLowerCase()));
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/allowlist/remove') {
      if (!TUNNEL_ID) return json(res, 503, { error: 'WEBCONFERENCE_TUNNEL_ID not configured' });
      const { email, callerEmail } = await readBody(req);
      if (!email) return json(res, 400, { error: 'email required' });
      if (ADMIN_EMAILS.size > 0 && !ADMIN_EMAILS.has((callerEmail || '').trim().toLowerCase())) {
        return json(res, 403, { error: 'admin only' });
      }
      const resp = await cpFetchForm(`/portal/tunnels/${TUNNEL_ID}/login-allowlist/${encodeURIComponent(email)}/remove`, {});
      if (resp.status >= 400) return json(res, 502, { error: `control plane -> ${resp.status}` });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/call') {
      const { fromEmail, toEmail, transport } = await readBody(req);
      const from = (fromEmail || '').toLowerCase();
      const to = (toEmail || '').toLowerCase();
      const caller = directory.get(from);
      const callee = directory.get(to);
      if (!caller) return json(res, 400, { error: 'caller not registered' });
      if (!isOnline(callee)) return json(res, 200, { status: 'offline' });
      let minted;
      try {
        minted = await mintGrants(caller.holderPub, callee.holderPub);
      } catch (e) {
        return json(res, 500, { error: `grant minting failed: ${e.message}` });
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
        createdAt: Date.now(),
        callerAttest: null,
        calleeAttest: null,
        status: { state: 'ringing' },
      };
      pendingCalls.set(call.channel, call);
      incomingByEmail.set(to, call.channel);
      // Push immediately if the callee has a live WS connection -- falls back
      // to their own /api/incoming poll (still running regardless) if not.
      wsPush(to, { type: 'incoming', channel: call.channel, fromEmail: call.callerEmail, grant: call.grantForCallee, ws: WS_URL, transport: call.transport });
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
      const email = (url.searchParams.get('email') || '').toLowerCase();
      const channel = incomingByEmail.get(email);
      if (!channel) return json(res, 200, { incoming: null });
      const call = pendingCalls.get(channel);
      if (!call) {
        incomingByEmail.delete(email);
        return json(res, 200, { incoming: null });
      }
      return json(res, 200, { incoming: { channel: call.channel, fromEmail: call.callerEmail, grant: call.grantForCallee, ws: WS_URL, transport: call.transport } });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://bridge');
  const email = (url.searchParams.get('email') || '').toLowerCase();
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/api/ws' || !email || !key) {
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

const [host, port] = LISTEN.split(':');
server.listen(Number(port), host, () => {
  const authMode = OIDC_CLIENT_ID && OIDC_CLIENT_SECRET
    ? 'service-account (self-refreshing)'
    : process.env.CT_OIDC_TOKEN
      ? 'static bearer token (will expire, no refresh)'
      : process.env.CT_PORTAL_SESSION_COOKIE
        ? 'portal session cookie (will expire in ~8h, no refresh; login-allowlist add/remove needs this regardless)'
        : 'NONE -- registration will fail';
  console.log(`webconference-demo-bridge listening on ${LISTEN} (cp=${CP_URL}, registration auth: ${authMode})`);
});
