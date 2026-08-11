// Identity/key-management: hex<->bytes helpers, the per-channel Noise-key
// attestation preimage/signature (matching ct_common::channel::
// member_noise_attest_bytes byte for byte), local-identity storage
// (generate-or-load, keyed by email), and the lazy WASM-init guard every
// crypto call in this app depends on. Split out of app.js as part of the
// client-code consolidation (CADS-webconference-demo#91); every function/
// const here is a verbatim move, comments included, with no behavior change.

import init, * as wasm from './pkg/ct_agent_wasm.js';

// CADS-webconference-demo#40 (finding 2): used to silently truncate an
// odd-length input (new Uint8Array(hex.length / 2) floors) and never
// validated the characters -- parseInt('zz', 16) is NaN, silently baked
// into the output as byte 0. A malformed hex string produced a different,
// but still valid-looking, byte sequence instead of an error pointing at
// the actual problem.
function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`hexToBytes: not a valid even-length hex string (got ${JSON.stringify(hex)})`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
// Preimage::new(domain).fixed(channel).fixed(holder).fixed(noise_pubkey) --
// u32-LE(domain.len()) || domain || channel(32) || holder(32) || noise_pubkey(32).
function memberNoiseAttestBytes(channelHex, holderHex, noisePubHex) {
  const domain = new TextEncoder().encode('ct-a2a-noise-attest-v1');
  const lenPrefix = new Uint8Array(4);
  new DataView(lenPrefix.buffer).setUint32(0, domain.length, true);
  return concatBytes(lenPrefix, domain, hexToBytes(channelHex), hexToBytes(holderHex), hexToBytes(noisePubHex));
}
function computeAttestation(channelHex, holderPrivHex, holderPubHex, noisePubHex) {
  const preimage = memberNoiseAttestBytes(channelHex, holderPubHex, noisePubHex);
  return bytesToHex(wasm.holderSign(holderPrivHex, preimage));
}

// A real account switch needs BOTH halves cleared -- confirmed live (2026-08-03):
// /gate/logout alone clears ct_gate_session, but the gate's own check silently
// re-mints a fresh one from the still-active Keycloak SSO session with no
// visible prompt at all, landing back on the exact same account. /portal/logout
// alone ends that Keycloak SSO session (confirmed via its own interactive
// "sign in again" prompt afterward) but never touches ct_gate_session, which
// stays valid on its own until it expires regardless of Keycloak's state.
// So: clear the gate cookie first via a credentialed no-cors beacon fetch
// (Set-Cookie still applies even though the opaque response can't be read),
// then navigate to /portal/logout for the real interactive Keycloak logout.
// CADS-webconference-demo#33: scoped to exactly one identity's own keys, not
// a blanket localStorage.clear() -- localStorage is shared across every
// identity this browser has ever held (loadOrCreateIdentity explicitly
// supports switching between several), so clearing everything would destroy
// every OTHER identity's keys, contacts, blocklist, and Lamport clock too.
// On a shared/kiosk browser that's silent, irreversible data loss for
// whoever else's identity happened to be sitting in this browser -- their
// encrypted IndexedDB history survives, but its keying material
// (holderPriv) doesn't, so it becomes permanently undecryptable.
// CADS-webconference-demo#42: factored out of the logout handler so the
// same "purge this identity's keys" action is available on its own (Forget
// this identity, and hangup's forget prompt) without also ending the
// Keycloak/gate session the way logout does.
function forgetIdentityKeys(email) {
  if (email) {
    const suffix = `:${email.toLowerCase()}`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('ct-webconference-') && key.endsWith(suffix)) localStorage.removeItem(key);
    }
  } else {
    localStorage.clear(); // no identity was ever established this session -- nothing identity-scoped to preserve
  }
}

function storageKeyFor(email) {
  return `ct-webconference-identity:${email.toLowerCase()}`;
}

// CADS-webconference-demo#42: run()'s #13-era key recovery (myEmail ->
// localStorage) needs to tell "no identity here yet" apart from "found the
// existing one" -- silently minting a FRESH identity in that case (this
// function's normal, correct behavior for the real registration/login path)
// would hand run() keys that don't match what the grant/attestation was
// actually issued for, producing an opaque join failure instead of an
// honest "this browser/profile doesn't have it" error. requireExisting is
// only ever passed true from that one call site.
function loadOrCreateIdentity(email, { requireExisting = false } = {}) {
  const key = storageKeyFor(email);
  const existing = localStorage.getItem(key);
  if (existing) return JSON.parse(existing);
  if (requireExisting) {
    throw new Error(`no local identity found for ${email} -- this call link only works in the same browser profile that placed or accepted it`);
  }
  const holder = wasm.generate_holder_identity();
  const noise = wasm.generate_noise_identity();
  const identity = {
    email,
    holderPub: holder.public_hex,
    holderPriv: holder.private_hex,
    noisePub: noise.public_hex,
    noisePriv: noise.private_hex,
    // CADS-webconference-demo#87: bully-style tie-break input for device
    // pairing -- when two browsers have independently minted DIFFERENT
    // keys under the same email (today's status quo whenever no local
    // identity exists yet), the older key wins and the newer one is
    // discarded in favor of it. Self-reported and not attested -- fine
    // here because pairing is a same-person, same-account action, not an
    // adversarial one; see identityCreatedAt()'s own comment for how a
    // pre-existing identity from before this field existed is treated.
    createdAt: Date.now(),
  };
  localStorage.setItem(key, JSON.stringify(identity));
  return identity;
}

// A real identity that predates this field (createdAt was added in #87)
// has no createdAt at all -- treat that as "older than anything," never 0
// (0 would tie-break AGAINST a genuinely ancient real identity if some
// other identity's createdAt were also missing/0). Number.NEGATIVE_INFINITY
// guarantees an identity that existed before this feature shipped always
// wins a pairing tie-break against a freshly-generated one, which is the
// only direction that can't silently discard someone's real, pre-existing
// account.
function identityCreatedAt(identity) {
  return typeof identity.createdAt === 'number' ? identity.createdAt : Number.NEGATIVE_INFINITY;
}

// Robustness audit finding (proactive review, not yet forced to reproduce
// live -- needs a real transient failure loading the .wasm binary, e.g. a
// network blip during initial fetch/instantiate): a rejected init() used to
// stay memoized in wasmInitPromise forever, since the old `||` short-circuit
// only ever assigned once. Every future call returned that exact same
// rejected promise for the rest of the page's life, with no retry -- for
// chat-glue.js's two callers (backgroundChatSession's periodic delivery
// sweep and autoAcceptChatDelivery), this silently defeated their own
// documented "will retry next sweep" resilience design: the outer sweep
// genuinely does retry, but ensureWasmInit() itself could never succeed
// again after one bad attempt, even once whatever caused the original
// failure (e.g. a transient network hiccup) had long since cleared up.
// Fix: on rejection, clear wasmInitPromise so the NEXT call re-attempts
// init() from scratch, while still rethrowing the original error to
// whichever caller's await was already in flight -- that caller's own
// error handling (chat-glue.js's try/catch) sees the exact same failure
// as before, only the poisoned-forever memoization is gone.
let wasmInitPromise = null;
function ensureWasmInit() {
  if (!wasmInitPromise) {
    wasmInitPromise = init('./pkg/ct_agent_wasm_bg.wasm').catch((e) => {
      wasmInitPromise = null;
      throw e;
    });
  }
  return wasmInitPromise;
}

export {
  hexToBytes,
  bytesToHex,
  concatBytes,
  memberNoiseAttestBytes,
  computeAttestation,
  forgetIdentityKeys,
  storageKeyFor,
  loadOrCreateIdentity,
  identityCreatedAt,
  ensureWasmInit,
};
