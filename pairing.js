// ============ Device pairing (#87) ============
// Honest scoping note (also in the #87 completion comment): the account
// owner asked for this to go over the existing ct_channel (ws_channel/
// Noise_IK) transport -- that would need a new grant type from
// `ct-video-call-grant`, a separately-compiled binary this repo doesn't
// build or control, so it's out of reach here. This uses the browser's
// native WebCrypto (ECDH P-256 + AES-GCM) instead, relayed through
// /api/pair/* -- the SAME security property (the bridge only ever sees
// public keys and a ciphertext it cannot decrypt, holding neither side's
// private key) over a different transport. Still live, still ephemeral,
// still requires both devices online within the pairing window.
//
// Split out of app.js as part of the client-code consolidation
// (CADS-webconference-demo#91); every function/const here is a verbatim
// move, comments included, with no behavior change. `api` is imported from
// contacts.js (its permanent home as of that consolidation cycle) -- a
// module-level import like any other now, no longer a circular one.

import { storageKeyFor, loadOrCreateIdentity, identityCreatedAt } from './identity.js';
import { api } from './contacts.js';

const PAIRING_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789'; // matches the bridge's PAIRING_CODE_RE
function generatePairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = '';
  for (let i = 0; i < 8; i++) code += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  return code;
}
async function pairingKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
}
async function pairingSharedKey(myPrivateKey, theirPubJwk, usage) {
  const theirPublicKey = await crypto.subtle.importKey('jwk', theirPubJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return crypto.subtle.deriveKey({ name: 'ECDH', public: theirPublicKey }, myPrivateKey, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
async function pairingEncrypt(sharedKey, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
}
async function pairingDecrypt(sharedKey, iv, ciphertext) {
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, sharedKey, new Uint8Array(ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// NEW device side: generates an ephemeral keypair, publishes it under a
// fresh code, shows the code to the user, and polls until an
// already-paired device delivers the real identity encrypted to it (or
// the 5-minute window lapses). Applies the Bully-style tie-break
// (#87: oldest createdAt wins) against any identity this browser may
// already hold for the same email, so pairing can never silently discard
// a genuinely older, real local identity in favor of a newer one.
async function pairAsNewDevice(email) {
  const keyPair = await pairingKeyPair();
  const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const code = generatePairingCode();
  const offerResp = await api('/pair/offer', { body: { email, code, tempPubKeyJwk: pubJwk } });
  if (offerResp.error) throw new Error(offerResp.error);
  alert(
    `Pairing code: ${code}\n\nOn your OTHER (already set up) device: open the menu -> ` +
      `"Pair a new device" and enter this code. This continues automatically once paired ` +
      `-- times out in 5 minutes.`
  );
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const poll = await api(`/pair/poll?code=${encodeURIComponent(code)}`);
    if (poll.ready) {
      const sharedKey = await pairingSharedKey(keyPair.privateKey, poll.oldDevicePubKeyJwk, 'decrypt');
      const receivedIdentity = await pairingDecrypt(sharedKey, poll.iv, poll.ciphertext);
      const key = storageKeyFor(email);
      const existingRaw = localStorage.getItem(key);
      if (existingRaw) {
        const existing = JSON.parse(existingRaw);
        // This browser already independently held a DIFFERENT identity for
        // this email (e.g. used before pairing existed) -- the older key
        // wins; a tie also keeps the existing one (arbitrary but
        // deterministic, and never discards what was already here).
        if (identityCreatedAt(existing) <= identityCreatedAt(receivedIdentity)) return existing;
      }
      localStorage.setItem(key, JSON.stringify(receivedIdentity));
      return receivedIdentity;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('pairing timed out -- the other device never delivered within 5 minutes');
}

// Offers pairing ONLY when this browser has no local identity for this
// email yet -- an existing local identity always just loads normally
// (unchanged behavior), so this never interrupts the common case of
// reopening the app on a device that's already set up.
async function loadOrPairIdentity(email) {
  if (localStorage.getItem(storageKeyFor(email))) return loadOrCreateIdentity(email);
  const wantsPairing = confirm(
    'No account found on this device yet. Pair with an already-set-up device instead of ' +
      'starting a brand-new, empty account here? (Cancel to start fresh on this device.)'
  );
  if (wantsPairing) {
    try {
      return await pairAsNewDevice(email);
    } catch (e) {
      alert(`Pairing failed: ${e.message || e}. Starting a new, empty account on this device instead.`);
    }
  }
  return loadOrCreateIdentity(email);
}

export {
  PAIRING_CODE_ALPHABET,
  generatePairingCode,
  pairingKeyPair,
  pairingSharedKey,
  pairingEncrypt,
  pairingDecrypt,
  pairAsNewDevice,
  loadOrPairIdentity,
};
