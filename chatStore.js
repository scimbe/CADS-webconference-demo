// Persistent, encrypted, CRDT-ordered chat history.
//
// Storage: IndexedDB, one 'messages' object store, indexed by conversation
// (deterministic key: the two emails, sorted) + a Lamport `seq` for
// deterministic, causally-consistent ordering -- required because messages
// can arrive both from the live WebRTC peer AND from this SAME identity's
// other open tabs (via BroadcastChannel below), and wall-clock timestamps
// alone can't be trusted to order concurrent/interleaved writes correctly.
//
// Encryption: AES-GCM, key derived (HKDF) from this identity's own
// holderPriv -- the same private key material already generated in this
// browser and never transmitted anywhere. Only someone holding that key
// (this browser, this identity) can ever decrypt a message's TEXT.
// CADS-webconference-demo#22 -- corrected from an earlier, overbroad claim
// ("IndexedDB itself never sees plaintext"): only the message body is
// encrypted. conversation/peerEmail/from/ts/seq/pending are stored in the
// clear (conversation and seq specifically have to be, to stay queryable/
// sortable via the byConversation index below -- IndexedDB can't
// efficiently range-query encrypted bytes). Anyone with IndexedDB access
// (a same-origin script, a browser extension, forensic disk access) can
// see who this identity has talked to, when, how often, and in which
// direction, without decrypting a single message body. Real gap, not
// fixed in this pass -- closing it properly means hashing the
// conversation key for the index (so it stays queryable without leaking
// the actual emails) and moving from/ts/pending into the encrypted blob
// alongside text, which is a real schema change best done together with
// the other chatStore.js structural issues, not bolted on independently.
//
// Multi-tab sync (same device, same identity): a BroadcastChannel keyed by
// email relays every new local message to any other open tab for the same
// identity, so switching tabs shows a live-updating, consistent history.
// This does NOT sync across separate DEVICES -- that would need a real
// signaling path (e.g. relaying through the existing Agent-Fabric channel
// to a second registered device), which doesn't exist yet in this demo.
// Documented gap, not silently faked as "multi-device."

const DB_NAME = 'ct-webconference-chat';
const DB_VERSION = 1;
const STORE = 'messages';

// Deliberately NOT sorted. IndexedDB (DB_NAME below) is one shared,
// origin-wide database -- it's how a browser that has EVER held more than
// one local identity (loadOrCreateIdentity supports switching between
// several) keeps each one's history separate. A sorted [a,b] key made two
// DIFFERENT identities' stores land on the IDENTICAL row set whenever they
// shared the same peer pair -- each identity's records are encrypted with
// its OWN key (chatStore.js's header comment), so the other identity's
// ChatStore.history() would try to AES-GCM-decrypt ciphertext it has no key
// for and throw OperationError. Keying by (this store's OWN email, peer) --
// always the same for a given instance -- scopes rows per-owner instead,
// with no behavior change for the common single-identity-per-browser case.
function conversationKey(myEmail, peerEmail) {
  return `${myEmail.toLowerCase()}->${peerEmail.toLowerCase()}`;
}

// CADS-webconference-demo#26: no onblocked/onversionchange handling meant
// the FIRST future schema bump would silently deadlock every open tab --
// this tab's open() request would fire onblocked (unhandled, so the
// returned promise just hung forever) if another tab held an older
// version open, and this tab never released its own connection for
// another tab's upgrade either (no onversionchange). DB_VERSION is still
// 1 today so neither path can trigger yet, but the fix needs to exist
// BEFORE the first bump, not be written in a panic after it hangs
// everyone's chat history. onVersionChange lets the caller (ChatStore)
// know its cached connection just closed itself, so it can reopen on next
// use instead of every subsequent operation hanging on a closed db.
function openDb(onVersionChange) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('byConversation', ['conversation', 'seq']);
    };
    req.onblocked = () => reject(new Error('IndexedDB open blocked -- another tab is holding an older version open; close other tabs and reload'));
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close(); // let the other tab's upgrade proceed instead of blocking it
        if (onVersionChange) onVersionChange();
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

// One Lamport clock per identity, persisted in localStorage so it survives
// a reload -- restarting from 0 after every reload would let a replayed old
// seq collide with genuinely new messages. tick() is called before sending;
// observe(remoteSeq) after receiving (from the peer OR from another local
// tab), so the local clock always exceeds every seq it has seen -- the
// standard Lamport-clock invariant that gives a total, causally-consistent
// order without a central sequencer.
class LamportClock {
  constructor(email) {
    this.key = `ct-webconference-lamport:${email.toLowerCase()}`;
    this.value = Number(localStorage.getItem(this.key) || 0);
    this.lockName = `ct-webconference-lamport-lock:${this.key}`;
  }
  // CADS-webconference-demo#25: two tabs could both read the same
  // localStorage value, both increment, both write the same result --
  // localStorage is synchronous per-tab but not atomic ACROSS tabs, so two
  // near-simultaneous composes in different tabs could mint the identical
  // seq. navigator.locks (Web Locks API, broadly supported in all current
  // browsers this app already targets for WebRTC/WASM) serializes this
  // across tabs for real; falls back to the old non-atomic behavior only
  // if it's genuinely unavailable, same risk profile as before, not worse.
  async tick() {
    const bump = () => {
      // Re-read here (not just at construction) -- another tab may have
      // ticked since this instance last touched localStorage, and this is
      // the one place that MUST see the latest value before advancing it.
      this.value = Math.max(this.value, Number(localStorage.getItem(this.key) || 0)) + 1;
      localStorage.setItem(this.key, String(this.value));
      return this.value;
    };
    if (typeof navigator === 'undefined' || !navigator.locks) return bump();
    return navigator.locks.request(this.lockName, bump);
  }
  // A malicious same-origin sender (see the BroadcastChannel-trust issue)
  // could otherwise post an unbounded or non-numeric seq and permanently
  // wedge this clock: this.value = 1e308, then tick()'s +1 is a no-op at
  // float64 precision, so every future outgoing message collides on the
  // same seq forever -- or worse, a string seq turns '+= 1' into string
  // concatenation. Reject anything that isn't a genuine, bounded integer
  // instead of trusting it.
  observe(remoteSeq) {
    if (!Number.isInteger(remoteSeq) || !Number.isSafeInteger(remoteSeq) || remoteSeq < 0) return;
    if (remoteSeq > this.value) {
      this.value = remoteSeq;
      localStorage.setItem(this.key, String(this.value));
    }
  }
}

function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
}

async function deriveKey(holderPrivHex) {
  const baseKey = await crypto.subtle.importKey('raw', hexToBytes(holderPrivHex), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('ct-webconference-chat-store-v1'), info: new Uint8Array() },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export class ChatStore {
  constructor(identity) {
    this.identity = identity;
    this.clock = new LamportClock(identity.email);
    this.keyPromise = deriveKey(identity.holderPriv);
    this._dbPromise = null; // lazily (re)opened by _getDb() -- see its own comment
    this.listeners = new Set();
    this._seenBroadcasts = new Set(); // dedup/replay guard for the channel listener below
    // Same-device, same-identity tab sync -- see header comment. Scoped by
    // email so a shared/kiosk browser's other identities never cross-talk.
    this.channel = new BroadcastChannel(`ct-webconference-chat:${identity.email.toLowerCase()}`);
    // CADS-webconference-demo#23: this used to forward ANY same-origin
    // BroadcastChannel post straight to the UI as a genuine peer message,
    // no shape check, no replay guard -- any same-origin script (an XSS
    // payload, a malicious extension content script, another same-origin
    // app) could post a forged {from:'peer', text:'...'} and it would
    // render as if the actual contact sent it. Note the real limit on how
    // much this closes: a script with same-origin access can typically
    // also read holderPriv straight out of localStorage and decrypt
    // everything anyway, so a MAC under that same key wouldn't add a
    // meaningful boundary here -- what these checks actually stop is
    // malformed/stale data (a stale tab, a genuine bug) getting rendered
    // as a real message, which is worth doing regardless of the same-
    // origin threat model's own limits.
    this.channel.addEventListener('message', (ev) => {
      const d = ev.data;
      if (
        !d || typeof d !== 'object'
        || typeof d.peerEmail !== 'string' || !d.peerEmail
        || (d.from !== 'me' && d.from !== 'peer')
        || typeof d.text !== 'string'
        || !Number.isInteger(d.seq) || !Number.isSafeInteger(d.seq) || d.seq < 0
        || !Number.isFinite(d.ts)
      ) {
        return;
      }
      const dedupeKey = `${d.peerEmail}:${d.from}:${d.seq}`;
      if (this._seenBroadcasts.has(dedupeKey)) return;
      this._seenBroadcasts.add(dedupeKey);
      if (this._seenBroadcasts.size > 500) {
        this._seenBroadcasts.delete(this._seenBroadcasts.values().next().value); // bound growth, oldest first
      }
      this.clock.observe(d.seq);
      this._notify(d);
    });
  }

  onMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // CADS-webconference-demo#26: openDb() closes the connection (and calls
  // this) if another tab needs to upgrade the schema -- caching a single
  // dbPromise forever meant every operation after that point awaited a
  // promise that resolved to an already-closed db and just failed. Reopen
  // on demand instead.
  // CADS-webconference-demo#45: a rejected promise is still truthy, so
  // `if (!this._dbPromise)` alone doesn't catch the onblocked path above
  // rejecting -- the SAME rejected promise then got returned forever,
  // wedging this instance until a page reload created a fresh ChatStore.
  // Clearing the cache on rejection too (not just on the onblocked
  // callback's own close-triggered reset) means the next call retries
  // instead of replaying a stale failure.
  _getDb() {
    if (!this._dbPromise) {
      this._dbPromise = openDb(() => { this._dbPromise = null; }).catch((e) => {
        this._dbPromise = null;
        throw e;
      });
    }
    return this._dbPromise;
  }

  _notify(msg) {
    for (const fn of this.listeners) fn(msg);
  }

  async _encrypt(text) {
    const key = await this.keyPromise;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
  }

  async _decrypt(iv, ciphertext) {
    const key = await this.keyPromise;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, new Uint8Array(ciphertext));
    return new TextDecoder().decode(plain);
  }

  // Ticks this identity's Lamport clock for a new outgoing message -- call
  // ONCE per send, embed the result in the outgoing wire payload (so the
  // peer's own record() can observe() it), and pass the SAME value into
  // record() below. Kept separate from record() (rather than record()
  // ticking internally) so the wire payload and the locally-persisted copy
  // can never end up with two different seqs for the same message.
  async nextSeqForSend() {
    return this.clock.tick();
  }

  // Records a message this device sent (seq from nextSeqForSend()) or
  // received -- live over the real WebRTC data channel, or relayed from
  // this identity's other open tabs via BroadcastChannel. `seq` is always
  // required and explicit: for a receive, observe() first so this clock
  // stays ahead of everything it's seen, keeping future local ticks
  // causally after it.
  // `pending: true` marks a message composed while no live chat channel to
  // this peer is open yet (see the outbox comment on the class) -- stored
  // and shown immediately from the sender's own view, same as any real
  // messenger, cleared by markDelivered() once it actually goes out over
  // the live channel. Never true for a received message.
  async record({ peerEmail, from, text, seq, received = false, pending = false }) {
    if (received) this.clock.observe(seq);
    const conversation = conversationKey(this.identity.email, peerEmail);
    const db = await this._getDb();
    // CADS-webconference-demo#43 (finding 1): flushOutbox breaks (without
    // marking delivered) when an ack times out even though the peer DID
    // receive and persist the message -- the ack was just lost/slow in
    // transit. The sender then retries the same seq next session; without
    // this check the receiver recorded (and rendered) it a second time,
    // directly contradicting the "exactly-once" intent of the ack-confirmed
    // delivery work #21 added. byConversation is [conversation, seq], not
    // unique per `from` -- a real schema change (compound unique index)
    // would need a DB_VERSION bump, more than this pass covers; a
    // get-before-add check against the existing index reaches the same
    // outcome without touching the schema. 'me' sends aren't checked here:
    // their seq always comes fresh from nextSeqForSend() (this identity's
    // own Lamport tick), never replayed the way a resent peer seq is.
    if (received) {
      const existing = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const idx = tx.objectStore(STORE).index('byConversation');
        const req = idx.getAll(IDBKeyRange.only([conversation, seq]));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const duplicate = existing.find((r) => r.from === from);
      if (duplicate) {
        return { peerEmail: duplicate.peerEmail, seq, from, text: await this._decrypt(duplicate.iv, duplicate.ciphertext), ts: duplicate.ts, pending: duplicate.pending };
      }
    }
    const { iv, ciphertext } = await this._encrypt(text);
    const record = {
      conversation,
      peerEmail: peerEmail.toLowerCase(),
      seq,
      from, // 'me' | 'peer'
      ts: Date.now(),
      pending,
      iv,
      ciphertext,
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const decoded = { peerEmail: record.peerEmail, seq, from, text, ts: record.ts, pending };
    if (!pending) this.channel.postMessage(decoded); // other tabs don't need to see a not-yet-sent draft
    return decoded;
  }

  async _recordsForConversation(peerEmail) {
    const db = await this._getDb();
    const conversation = conversationKey(this.identity.email, peerEmail);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const idx = tx.objectStore(STORE).index('byConversation');
      const range = IDBKeyRange.bound([conversation, -Infinity], [conversation, Infinity]);
      const out = [];
      idx.openCursor(range).onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor) return resolve(out);
        out.push(cursor.value);
        cursor.continue();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  // Full history for one contact, decrypted, in causal (seq) order.
  // CADS-webconference-demo#24: one corrupted/tampered row used to fail
  // the whole Promise.all -- a single bad record made the ENTIRE
  // conversation (and, since pendingOutbox() used to just filter this
  // same list, the whole outbox) permanently inaccessible. Decrypt each
  // record independently now; an undecryptable one is skipped and
  // surfaced as its own placeholder entry instead of taking the rest of
  // the conversation down with it.
  async history(peerEmail) {
    const records = await this._recordsForConversation(peerEmail);
    return Promise.all(
      records.map(async (r) => {
        try {
          return {
            peerEmail: r.peerEmail,
            seq: r.seq,
            from: r.from,
            ts: r.ts,
            pending: !!r.pending,
            text: await this._decrypt(r.iv, r.ciphertext),
          };
        } catch {
          return { peerEmail: r.peerEmail, seq: r.seq, from: r.from, ts: r.ts, pending: false, text: '', corrupted: true };
        }
      }),
    );
  }

  // Outbox: every not-yet-delivered outgoing message for one peer, oldest
  // first -- what setupChatChannel's 'open' handler flushes the moment a
  // live channel to that peer actually exists. CADS-webconference-demo#24:
  // its own direct query now (scanning only from==='me' && pending) rather
  // than decrypting the ENTIRE history just to filter it down -- a bad row
  // anywhere else in the conversation can no longer block outbox delivery,
  // and this also means one fewer bulk-decrypt on every flush attempt.
  async pendingOutbox(peerEmail) {
    const records = await this._recordsForConversation(peerEmail);
    const out = [];
    for (const r of records) {
      if (r.from !== 'me' || !r.pending) continue;
      try {
        out.push({ peerEmail: r.peerEmail, seq: r.seq, from: r.from, ts: r.ts, pending: true, text: await this._decrypt(r.iv, r.ciphertext) });
      } catch {
        // Undecryptable pending row -- can't resend text we can't read.
        // Leave it in place (still marked pending) rather than silently
        // dropping it; surfaces via history()'s own corrupted:true entry.
      }
    }
    return out;
  }

  // Flip a queued message to delivered once it's actually gone out over the
  // live channel. Matched by (peerEmail, seq) -- unique per conversation
  // in normal operation since seq comes from this identity's own
  // strictly-increasing, now cross-tab-atomic clock (see LamportClock.tick)
  // -- but CADS-webconference-demo#25 also asked this continue scanning
  // past a match instead of stopping, so a duplicate-seq row surviving
  // from before that fix (or from a peer that never got it) still gets
  // fully cleared instead of leaving a stray duplicate stuck pending.
  async markDelivered(peerEmail, seq) {
    const db = await this._getDb();
    const conversation = conversationKey(this.identity.email, peerEmail);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const idx = tx.objectStore(STORE).index('byConversation');
      const range = IDBKeyRange.bound([conversation, -Infinity], [conversation, Infinity]);
      idx.openCursor(range).onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor) return resolve();
        if (cursor.value.seq === seq && cursor.value.pending) {
          cursor.update({ ...cursor.value, pending: false });
        }
        cursor.continue();
      };
      tx.onerror = () => reject(tx.error);
    });
  }
}
