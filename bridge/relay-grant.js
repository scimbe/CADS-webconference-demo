// Relay grant for the My Daily Idea file tool ("Datei rueber"): the TURN relay is for paying accounts only.
// The wrapper (CADS-DEMO-wrapper, POST /api/duell/relay-grant) checks the account's credit and signs a short-lived grant;
// this bridge only verifies it. Both share DUELL_RELAY_GRANT_SECRET (never logged, never sent to a client).
//
//   grant = "rg1." + b64url(payload) + "." + b64url(HMAC-SHA256(secret, "rg1." + b64url(payload)))
//   payload = { sub, purpose: "file", ch: <channel hex64>, iat, exp }   (seconds since the epoch)
//
// Fail closed: no secret, a short secret, a bad signature, another purpose, another channel, an expired grant or one that
// lives longer than MAX_TTL_S all mean "no relay". The same format and test vector live in CADS-DEMO-wrapper lib/relay-grant.mjs.
'use strict';
const crypto = require('crypto');

const PREFIX = 'rg1.';
const MAX_TTL_S = 15 * 60;       // the wrapper never signs longer; a longer grant is refused (secret misuse, clock jump)
const SKEW_S = 30;
const MAX_LEN = 1024;
const MIN_SECRET = 32;
const HEX64 = /^[0-9a-f]{64}$/;
const B64U = /^[A-Za-z0-9_-]+$/;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const mac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();

/** For tests and tooling: the same signing the wrapper does. */
function signRelayGrant({ sub, ch, purpose = 'file', ttlS = MAX_TTL_S, now = Date.now() }, secret) {
  const iat = Math.floor(now / 1000);
  const body = PREFIX + b64u(JSON.stringify({ sub, purpose, ch, iat, exp: iat + ttlS }));
  return body + '.' + b64u(mac(secret, body));
}

/** -> { ok: true, sub } | { ok: false, why }. why is a short code for counting, never the grant itself. */
function verifyRelayGrant(token, secret, { channel, purpose = 'file', now = Date.now() } = {}) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET) return { ok: false, why: 'off' };
  if (typeof token !== 'string' || !token || token.length > MAX_LEN || !token.startsWith(PREFIX)) return { ok: false, why: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 3 || !B64U.test(parts[1]) || !B64U.test(parts[2])) return { ok: false, why: 'form' };
  const got = Buffer.from(parts[2], 'base64url');
  const want = mac(secret, PREFIX + parts[1]);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, why: 'sig' };
  let p;
  try { p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return { ok: false, why: 'form' }; }
  if (!p || typeof p !== 'object') return { ok: false, why: 'form' };
  if (p.purpose !== purpose) return { ok: false, why: 'purpose' };
  const t = Math.floor(now / 1000);
  if (!Number.isInteger(p.exp) || !Number.isInteger(p.iat) || p.exp <= t || p.iat > t + SKEW_S || p.exp - p.iat > MAX_TTL_S) return { ok: false, why: 'time' };
  if (typeof channel !== 'string' || !HEX64.test(channel.toLowerCase()) || p.ch !== channel.toLowerCase()) return { ok: false, why: 'channel' };
  if (typeof p.sub !== 'string' || !p.sub || p.sub.length > 64) return { ok: false, why: 'sub' };
  return { ok: true, sub: p.sub };
}

module.exports = { signRelayGrant, verifyRelayGrant, MAX_TTL_S, PREFIX };
