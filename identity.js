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

// See app.js's logoutLink handler (where this is set) for the full story --
// shared here since both that handler and runIdentityScreen's auto-login
// fallback (dialer.js) need the exact same key.
const SUPPRESS_AUTO_IDENTITY_KEY = 'ct-webconference-suppress-auto-identity';

function storageKeyFor(email) {
  return `ct-webconference-identity:${email.toLowerCase()}`;
}

// --- encryption-at-rest for the stored identity blob (CADS-webconference-demo#133) ---
// #42's "Forget this identity" gave users an exit but never reduced the exposure DURING
// normal use -- holderPriv/noisePriv sat in localStorage as plain JSON the whole time an
// identity was active. Wraps the blob in AES-GCM before it ever reaches localStorage,
// using a non-extractable key held in IndexedDB: readable only by script running in THIS
// origin via the CryptoKey handle, never as raw exportable bytes. This closes pure
// data-exfiltration reads of storage (a misconfigured logging/analytics library, a
// storage-reading browser extension, a sync/backup tool, physical access to browser
// profile files) -- it does NOT stop a full same-origin XSS with arbitrary script
// execution (that could still call the CryptoKey's own decrypt operation directly). No
// client-side scheme can close that without a passphrase-unlock step, which this app
// deliberately avoids for UX reasons (see #133's own tradeoff discussion) -- the
// wrapping key is generated once per browser profile and never leaves it, no prompt.
const IDB_NAME = 'ct-webconference-keystore';
const IDB_STORE = 'wrapping-keys';
const IDB_KEY_ID = 'identity-wrapping-key-v1';
const ENCRYPTED_MARKER = 'ctenc1:'; // distinguishes an encrypted blob from a pre-#133 plaintext one

function openKeystoreDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Memoized like ensureWasmInit's own wasmInitPromise just above -- and the same failure
// shape applies: a rejected attempt must NOT stay poisoned forever, or every later
// save/load this session would keep hitting the same stale error instead of retrying.
let wrappingKeyPromise = null;
function getWrappingKey() {
  if (!wrappingKeyPromise) {
    wrappingKeyPromise = (async () => {
      const db = await openKeystoreDb();
      const existing = await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(IDB_KEY_ID);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (existing) return existing;
      // extractable=false: the raw key bytes can never leave this CryptoKey handle,
      // not even to this file's own code -- only encrypt/decrypt operations against it.
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(key, IDB_KEY_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return key;
    })().catch((e) => { wrappingKeyPromise = null; throw e; });
  }
  return wrappingKeyPromise;
}

async function encryptForStorage(obj) {
  const key = await getWrappingKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return ENCRYPTED_MARKER + JSON.stringify({ iv: bytesToHex(iv), ct: bytesToHex(new Uint8Array(ciphertext)) });
}

async function decryptFromStorage(raw) {
  const { iv, ct } = JSON.parse(raw.slice(ENCRYPTED_MARKER.length));
  const key = await getWrappingKey();
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(iv) }, key, hexToBytes(ct));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Reads (and transparently, silently migrates) whatever identity is stored at `key` --
// null if nothing is there yet. A pre-#133 plaintext blob decodes as plain JSON (no
// ENCRYPTED_MARKER prefix) and is re-saved encrypted immediately, a one-time upgrade
// that never discards or changes an existing real identity, just its at-rest form.
async function loadStoredIdentity(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    if (!raw.startsWith(ENCRYPTED_MARKER)) {
      const identity = JSON.parse(raw); // pre-#133 plaintext
      await saveStoredIdentity(key, identity); // best-effort upgrade; identity is still returned even if this fails
      return identity;
    }
    return await decryptFromStorage(raw);
  } catch (e) {
    console.error(`identity.js: failed to read stored identity at ${key} -- treating as absent:`, e.message);
    return null;
  }
}

// Fails open (not closed) to plaintext on genuine WebCrypto/IndexedDB unavailability --
// matches this app's established "an unusual environment gets today's trust level, not
// a broken demo" pattern (see server.js's identityAllowed comment for the same call made
// there). A real deployment losing keys entirely because a locked-down browser disabled
// IndexedDB would be a worse outcome than the plaintext exposure #133 is closing.
async function saveStoredIdentity(key, identity) {
  try {
    localStorage.setItem(key, await encryptForStorage(identity));
  } catch (e) {
    console.error(`identity.js: encryption-at-rest unavailable (${e.message}) -- storing this identity in plaintext as a fallback`);
    localStorage.setItem(key, JSON.stringify(identity));
  }
}

// CADS-webconference-demo#42: run()'s #13-era key recovery (myEmail ->
// localStorage) needs to tell "no identity here yet" apart from "found the
// existing one" -- silently minting a FRESH identity in that case (this
// function's normal, correct behavior for the real registration/login path)
// would hand run() keys that don't match what the grant/attestation was
// actually issued for, producing an opaque join failure instead of an
// honest "this browser/profile doesn't have it" error. requireExisting is
// only ever passed true from that one call site.
//
// Robustness audit finding (round 2 re-read, not yet forced to reproduce
// live -- needs the SAME brand-new email submitted from two separate tabs
// of the same browser within a genuinely narrow window): this whole
// check-then-write body used to run synchronously with no cross-tab
// atomicity -- fine within a single tab (JS has no yield point in here for
// another call to interleave through), but two SEPARATE tabs each running
// their own independent, uninterrupted execution of this same function for
// the same never-before-seen email could both read `existing` as null,
// both generate their OWN distinct keypair, and both localStorage.setItem
// the same key -- whichever tab's write lands LAST silently wins, leaving
// the OTHER tab holding (and about to register with the server) an
// in-memory identity object that no longer matches what's actually
// persisted. That tab would work for the rest of this page load, but a
// LATER reload would load the other tab's keys instead, no longer matching
// what the server has on file for it -- a real, if confusing, silent
// mismatch, not immediately obvious as "the same bug" when it eventually
// surfaces. Same shape and same fix as chatStore.js's own LamportClock.tick
// (#25): navigator.locks serializes this across tabs for real, scoped per
// email (via `key`, already email-specific) so unrelated identities never
// contend with each other; falls back to the old non-atomic behavior only
// if genuinely unavailable, same risk profile as before, not worse.
async function loadOrCreateIdentity(email, { requireExisting = false } = {}) {
  const key = storageKeyFor(email);
  const create = async () => {
    const existing = await loadStoredIdentity(key);
    if (existing) return existing;
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
    await saveStoredIdentity(key, identity);
    return identity;
  };
  if (typeof navigator === 'undefined' || !navigator.locks) return create();
  return navigator.locks.request(`ct-webconference-identity-lock:${key}`, create);
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
  loadStoredIdentity,
  saveStoredIdentity,
  identityCreatedAt,
  ensureWasmInit,
  SUPPRESS_AUTO_IDENTITY_KEY,
};
