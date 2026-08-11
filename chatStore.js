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
// CADS-webconference-demo#77: bounds resident IndexedDB footprint (and
// therefore history()'s in-memory Promise.all working set) PER
// CONVERSATION -- the shared per-origin quota is what a flood actually
// exhausts (bricking every other conversation too, not just the flooded
// one), so capping each conversation independently is what stops a single
// peer from claiming an unbounded share of it. 2000 messages * the
// per-message ~64KB frame ceiling (readFramed's 2-byte length prefix caps
// a single chat frame at 65535 bytes, see app.js) is a worst case of
// ~128MB for one fully-flooded conversation -- generous for legitimate use
// (thousands of real messages), bounded against a flood.
const MAX_MESSAGES_PER_CONVERSATION = 2000;

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
      // CADS-webconference-demo#50: a file record has no `text` at all
      // (fileName/fileMimeType/fileSize + a Blob instead) -- shape-check
      // each kind on its own terms rather than requiring every message to
      // look like a text one.
      const contentValid = d && (d.kind === 'file'
        ? typeof d.fileName === 'string' && d.blob instanceof Blob
        : typeof d.text === 'string');
      if (
        !d || typeof d !== 'object'
        || typeof d.peerEmail !== 'string' || !d.peerEmail
        || (d.from !== 'me' && d.from !== 'peer')
        || !contentValid
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

  // CADS-webconference-demo#74: each stored row's `conversation`/
  // `peerEmail`/`from`/`seq`/`kind` (and the file fields) sit in plaintext
  // NEXT TO the AES-GCM ciphertext, but weren't bound into its tag -- GCM
  // authenticates only the bytes handed to it, not a record's other
  // columns. An adversary with IndexedDB write access but NOT the AES key
  // (a browser extension, forensic disk access -- exactly the adversary
  // this file's own header already treats as in-scope for confidentiality,
  // #22) could flip `from`/`seq`/`conversation` on an existing row with a
  // STILL-VALID tag: silent sender-forgery or cross-conversation message
  // planting, undetected by history()'s existing corrupted:true check
  // (which only fires on a ciphertext/tag mismatch). Does NOT help against
  // the same-origin adversary (they hold the key, so they can just
  // re-encrypt with a valid tag over anything) -- same limit this file's
  // #23 comment already states for the BroadcastChannel shape checks;
  // this closes a DIFFERENT, narrower gap for a different adversary.
  // Space-separated (not JSON) so the AAD's shape can't be reinterpreted by
  // a value containing the delimiter -- none of these fields should ever
  // legitimately contain one, and if some pathological input did, the
  // result is just a decrypt failure (fails closed), never a downgrade.
  _buildAad({ conversation, peerEmail, from, seq, kind, fileName, fileMimeType, fileSize }) {
    const parts = [conversation, peerEmail, from, String(seq), kind || 'text'];
    if (kind === 'file') parts.push(fileName ?? '', fileMimeType ?? '', String(fileSize ?? ''));
    return new TextEncoder().encode(parts.join(' '));
  }
  // CADS-webconference-demo#77-adjacent fix: the ORIGINAL #74 commit
  // (1c8bd11) intended a space separator (this method's own comment already
  // said "space-separated") but an encoding slip put a raw NUL byte (0x00)
  // in the shipped join() call instead of an actual space character --
  // functionally identical for AES-GCM (any fixed separator works), but a
  // real byte-for-byte difference from what _buildAad now produces, AND a
  // genuinely corrupted source file (confirmed via `file chatStore.js`
  // reporting "data" instead of text, and grep silently matching nothing in
  // the whole file once it hit the NUL byte). This live deployment ran with
  // that NUL-separator version for real between 1c8bd11 and this fix, so
  // any message recorded in that window has a NUL-separated AAD baked into
  // its tag -- decrypting those with the space-separated AAD would mismatch
  // and wrongly surface as corrupted, the exact regression #74's own no-AAD
  // fallback exists to avoid, just one AAD-shape generation later.
  // _decryptBytes tries this as a second candidate before falling all the
  // way back to no AAD. String.fromCharCode(0), not a literal/escaped
  // character in this source file -- deliberate, so this exact bug (a raw
  // byte landing in the file instead of the intended separator) can't
  // recur here.
  _buildLegacyNulAad(record) {
    const { conversation, peerEmail, from, seq, kind, fileName, fileMimeType, fileSize } = record;
    const parts = [conversation, peerEmail, from, String(seq), kind || 'text'];
    if (kind === 'file') parts.push(fileName ?? '', fileMimeType ?? '', String(fileSize ?? ''));
    const nul = String.fromCharCode(0);
    return new TextEncoder().encode(parts.join(nul));
  }

  // CADS-webconference-demo#50: generalized to raw bytes (text was always
  // just UTF-8-encoded bytes under the hood) so file attachments use the
  // exact same AES-GCM encrypt-at-rest path as chat text -- industry
  // standard for this class of app (Signal/WhatsApp-style: encrypt the
  // attachment with a key only the conversation participants hold, same
  // as the message body), not a separate mechanism bolted on for files.
  // AES-GCM has no meaningful size ceiling for a single-shot browser
  // encrypt/decrypt at the sizes this app's own attachment cap allows
  // (tens of MB) -- no streaming/chunked-encryption scheme needed.
  async _encryptBytes(bytes, aad) {
    const key = await this.keyPromise;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, ...(aad ? { additionalData: aad } : {}) }, key, bytes);
    return { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
  }

  // CADS-webconference-demo#77-adjacent fix: `record` is now an optional
  // full stored-row object (not just the aad bytes) -- when given, this
  // tries the CURRENT space-separated AAD first, then the legacy
  // NUL-separated AAD (see _buildLegacyNulAad's comment) as a second
  // candidate, before finally falling back to no AAD at all (#74's original
  // pre-AAD-binding compat path). Covers all three generations of records
  // this app has ever written: pre-#74 (no AAD), the accidentally-shipped
  // NUL-separator window, and the corrected space-separator version.
  async _decryptBytes(iv, ciphertext, record) {
    const key = await this.keyPromise;
    const ivBytes = new Uint8Array(iv);
    const ctBytes = new Uint8Array(ciphertext);
    if (record) {
      try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes, additionalData: this._buildAad(record) }, key, ctBytes));
      } catch (e) {
        try {
          return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes, additionalData: this._buildLegacyNulAad(record) }, key, ctBytes));
        } catch (e2) {
          // CADS-webconference-demo#74: a record written before AAD binding
          // existed was encrypted with NO additionalData at all -- decrypting
          // it WITH one now always mismatches the tag, not because of
          // tampering but because the binding didn't exist yet when it was
          // written. This live deployment has real pre-existing chat
          // history, so silently treating every one of those rows as
          // corrupted would be a severe regression, not a security win.
          // Retry without it as the legitimate old-record case -- a
          // genuinely tampered record still fails this attempt too and
          // propagates out to history()'s existing corrupted:true handling.
          return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ctBytes));
        }
      }
    }
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ctBytes));
  }

  async _encrypt(text, aad) {
    return this._encryptBytes(new TextEncoder().encode(text), aad);
  }

  async _decrypt(iv, ciphertext, record) {
    return new TextDecoder().decode(await this._decryptBytes(iv, ciphertext, record));
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

  // CADS-webconference-demo#50: decrypts a stored row back into the shape
  // callers actually want -- text records return {text}; file records
  // decrypt the attachment bytes and hand back a Blob (native, easy to
  // wrap in an <img>/download link) plus the in-the-clear metadata
  // (fileName/fileMimeType/fileSize -- same trust tier as every other
  // piece of metadata this store already keeps unencrypted, see the
  // class's own header comment on that tradeoff). Shared by record()'s
  // own duplicate-return path, history(), and pendingOutbox() so all
  // three decode identically.
  async _decodeRecord(r) {
    const base = { peerEmail: r.peerEmail, seq: r.seq, from: r.from, ts: r.ts, pending: !!r.pending, kind: r.kind || 'text' };
    // CADS-webconference-demo#74: the row itself is handed to _decryptBytes,
    // which rebuilds and tries the AAD from its own plaintext fields -- if
    // any of them were tampered since encrypt time, none of the AAD
    // candidates match what was bound into the tag and decrypt throws,
    // which history()'s existing catch already turns into a corrupted:true
    // placeholder instead of silently trusting the now-mismatched metadata.
    if (r.kind === 'file') {
      const bytes = await this._decryptBytes(r.iv, r.ciphertext, r);
      return { ...base, fileName: r.fileName, fileMimeType: r.fileMimeType, fileSize: r.fileSize, blob: new Blob([bytes], { type: r.fileMimeType || 'application/octet-stream' }) };
    }
    return { ...base, text: await this._decrypt(r.iv, r.ciphertext, r) };
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
  // CADS-webconference-demo#50: kind defaults to 'text' (unchanged
  // behavior, text param required as before); kind:'file' instead
  // encrypts fileBytes (a Uint8Array -- the raw attachment) and stores
  // fileName/fileMimeType/fileSize alongside it, using the exact same
  // AES-GCM-at-rest path text already used (see _encryptBytes's comment).
  //
  // CADS-webconference-demo#77: per-conversation cap with FIFO pruning --
  // an in-call (or background-chat) peer with no rate limit could otherwise
  // flood this SHARED per-origin IndexedDB store unbounded (every
  // identity's every conversation shares the same quota), eventually
  // hitting QuotaExceededError for writes in ANY conversation, not just the
  // flooded one -- one peer bricking every other contact's chat history.
  // Enforced here (not just capped in history()'s read path) so the DB
  // itself never grows past the cap regardless of how a caller later reads
  // it.
  async record({ peerEmail, from, text, seq, received = false, pending = false, kind = 'text', fileName, fileMimeType, fileSize, fileBytes }) {
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
    //
    // Robustness audit finding (proactive review, not forced to reproduce
    // live -- needs two genuinely concurrent writes for the exact same
    // (conversation, seq, from), e.g. the same message arriving both over
    // a live channel and an overlapping cross-device sync pull around the
    // same moment): the check and the add used to run in TWO SEPARATE
    // transactions (a readonly getAll, then a later readwrite add). Nothing
    // stopped a second, concurrent record() call from also passing the
    // duplicate check before either had committed its write -- both would
    // then add their own row, defeating the exactly-once guarantee this
    // whole check exists for. The primary key is auto-incrementing
    // (openDb's own createObjectStore call), not derived from
    // (conversation, seq, from), so IndexedDB's own add() would not itself
    // reject the second row as a collision.
    //
    // Fixed below by running the check AND the (conditional) add inside
    // ONE 'readwrite' transaction instead of two -- IndexedDB gives a
    // readwrite transaction exclusive write access to the store for its
    // whole lifetime, so no other transaction can commit a conflicting
    // write in between anymore. Encryption still happens BEFORE this
    // transaction opens, not inside it: crypto.subtle is a real async
    // operation on a different event queue, and awaiting one while an
    // IndexedDB transaction is open lets that transaction auto-commit out
    // from under this code (a real IndexedDB gotcha) -- exactly why the
    // original code needed two transactions to begin with once you factor
    // encryption in. Doing the check-and-maybe-add as pure, uninterrupted
    // IndexedDB-request callbacks (no intervening await on anything else)
    // is what keeps it inside one transaction.
    const aadRecord = { conversation, peerEmail: peerEmail.toLowerCase(), from, seq, kind, fileName, fileMimeType, fileSize };
    const aad = this._buildAad(aadRecord);
    const { iv, ciphertext } = kind === 'file' ? await this._encryptBytes(fileBytes, aad) : await this._encrypt(text, aad);
    const record = {
      conversation,
      peerEmail: peerEmail.toLowerCase(),
      seq,
      from, // 'me' | 'peer'
      ts: Date.now(),
      pending,
      kind,
      iv,
      ciphertext,
      ...(kind === 'file' ? { fileName, fileMimeType, fileSize } : {}),
    };
    let duplicateRow = null;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      if (received) {
        const idx = store.index('byConversation');
        const req = idx.getAll(IDBKeyRange.only([conversation, seq]));
        req.onsuccess = () => {
          const duplicate = req.result.find((r) => r.from === from);
          if (duplicate) {
            duplicateRow = duplicate; // don't add -- let this transaction complete with nothing written
            return;
          }
          store.add(record);
        };
        req.onerror = () => reject(req.error);
      } else {
        store.add(record); // 'me' sends are never duplicate-checked -- see the comment above
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    if (duplicateRow) return this._decodeRecord(duplicateRow);
    // CADS-webconference-demo#77: prune the oldest records past
    // MAX_MESSAGES_PER_CONVERSATION, oldest-first, right after a successful
    // write -- keeps this conversation's own row count (and therefore its
    // share of the shared per-origin quota) bounded regardless of how many
    // messages a peer sends. Never prunes a pending (not-yet-delivered)
    // outgoing message -- losing an unsent draft silently would be worse
    // than the flood this guards against; a real flood is peer-authored
    // (from:'peer', received:true) or a runaway local sender hitting its
    // own cap, neither of which this exemption weakens in practice.
    await this._pruneConversation(db, conversation);
    const decoded = kind === 'file'
      ? { peerEmail: record.peerEmail, seq, from, ts: record.ts, pending, kind, fileName, fileMimeType, fileSize, blob: new Blob([fileBytes], { type: fileMimeType || 'application/octet-stream' }) }
      : { peerEmail: record.peerEmail, seq, from, text, ts: record.ts, pending, kind };
    // Blob is part of the structured-clone algorithm BroadcastChannel uses,
    // same as every other field here -- no special-casing needed for the
    // file case versus text.
    if (!pending) this.channel.postMessage(decoded); // other tabs don't need to see a not-yet-sent draft
    return decoded;
  }

  // CADS-webconference-demo#77: FIFO-prunes one conversation down to
  // MAX_MESSAGES_PER_CONVERSATION, oldest (lowest seq) first, skipping any
  // row still marked pending (see record()'s own comment on why). Runs
  // inline after every write rather than on a timer/idle callback -- the
  // cost is one indexed cursor scan bounded by MAX_MESSAGES_PER_CONVERSATION
  // + a handful of deletes, not a full-table scan, so it stays cheap enough
  // to not need decoupling from the write path.
  async _pruneConversation(db, conversation) {
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const idx = tx.objectStore(STORE).index('byConversation');
      const range = IDBKeyRange.bound([conversation, -Infinity], [conversation, Infinity]);
      const req = idx.count(range);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const overflow = count - MAX_MESSAGES_PER_CONVERSATION;
    if (overflow <= 0) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const idx = tx.objectStore(STORE).index('byConversation');
      const range = IDBKeyRange.bound([conversation, -Infinity], [conversation, Infinity]);
      let deleted = 0;
      idx.openCursor(range).onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor || deleted >= overflow) return resolve();
        if (cursor.value.pending) {
          cursor.continue(); // never prune an undelivered outgoing draft -- see record()'s comment
          return;
        }
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      tx.onerror = () => reject(tx.error);
    });
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
          return await this._decodeRecord(r);
        } catch {
          return { peerEmail: r.peerEmail, seq: r.seq, from: r.from, ts: r.ts, pending: false, kind: r.kind || 'text', text: '', corrupted: true };
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
        // CADS-webconference-demo#50: a file item needs raw bytes to chunk
        // and send over the wire, not the Blob _decodeRecord wraps them in
        // for display -- decrypted directly here instead of going through
        // that helper.
        // CADS-webconference-demo#77-adjacent fix: neither branch here
        // passed the row (and therefore no AAD) to the decrypt calls below
        // -- since #74, every record() write binds a real AAD into the GCM
        // tag, so decrypting without one always failed for any pending
        // message recorded after that fix landed, silently losing the
        // ability to resend it (caught by the catch below, which leaves it
        // stuck pending forever instead of surfacing why). Passing `r` now,
        // same as _decodeRecord already does.
        if (r.kind === 'file') {
          const fileBytes = await this._decryptBytes(r.iv, r.ciphertext, r);
          out.push({ peerEmail: r.peerEmail, seq: r.seq, from: r.from, ts: r.ts, pending: true, kind: 'file', fileName: r.fileName, fileMimeType: r.fileMimeType, fileSize: r.fileSize, fileBytes });
        } else {
          out.push({ peerEmail: r.peerEmail, seq: r.seq, from: r.from, ts: r.ts, pending: true, kind: 'text', text: await this._decrypt(r.iv, r.ciphertext, r) });
        }
      } catch {
        // Undecryptable pending row -- can't resend content we can't read.
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

  // CADS-webconference-demo#87/#88: raw (still-encrypted) rows for a
  // conversation past a given seq, for the cross-device sync push. Pending
  // (not-yet-delivered) drafts are excluded -- a second device must never
  // attempt to re-deliver an outgoing message the originating device
  // hasn't actually sent yet; once it's genuinely sent, markDelivered()
  // flips pending false and the next push picks it up normally.
  async rowsSince(peerEmail, sinceSeq) {
    const records = await this._recordsForConversation(peerEmail);
    return records.filter((r) => r.seq > (sinceSeq || 0) && !r.pending);
  }

  // CADS-webconference-demo#87/#88: writes a row that arrived ALREADY
  // ENCRYPTED from another of this SAME identity's own devices (the sync
  // pull path) -- never re-encrypts, since the ciphertext is already valid
  // under this identity's own key (only this identity's own paired
  // devices ever hold it). Reuses the exact dedupe-by-(conversation,seq,
  // from) check record()'s own `received` path already does, so a row
  // synced twice (a retried pull, an overlapping sync tick) is a no-op,
  // and the same prune + BroadcastChannel notify record() already does --
  // a synced message shows up live in any other open tab exactly like one
  // received over a live channel would. Returns null if it was already
  // present (nothing new to show).
  async mergeEncryptedRow(peerEmail, row) {
    const conversation = conversationKey(this.identity.email, peerEmail);
    const db = await this._getDb();
    const record = {
      conversation,
      peerEmail: peerEmail.toLowerCase(),
      seq: row.seq,
      from: row.from,
      ts: row.ts,
      pending: false,
      kind: row.kind || 'text',
      iv: row.iv,
      ciphertext: row.ciphertext,
      ...(row.kind === 'file' ? { fileName: row.fileName, fileMimeType: row.fileMimeType, fileSize: row.fileSize } : {}),
    };
    // Robustness audit finding, same shape and same fix as record()'s own
    // (see its comment): the check-for-existing and the add used to run in
    // two separate transactions, leaving a real TOCTOU window for two
    // concurrent syncs (or a sync overlapping a live receive of the same
    // message) to both pass the check before either committed. No
    // encryption step needed here (this row arrives already-encrypted from
    // another of this identity's own devices), so the check and the add
    // fit inside one transaction directly, no restructuring needed beyond
    // that.
    let isDuplicate = false;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const idx = store.index('byConversation');
      const req = idx.getAll(IDBKeyRange.only([conversation, row.seq]));
      req.onsuccess = () => {
        if (req.result.some((r) => r.from === row.from)) {
          isDuplicate = true;
          return;
        }
        store.add(record);
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    if (isDuplicate) return null;
    await this._pruneConversation(db, conversation);
    this.clock.observe(row.seq);
    let decoded;
    try {
      decoded = await this._decodeRecord(record);
    } catch {
      decoded = { peerEmail: record.peerEmail, seq: record.seq, from: record.from, ts: record.ts, pending: false, kind: record.kind, text: '', corrupted: true };
    }
    this.channel.postMessage(decoded);
    this._notify(decoded);
    return decoded;
  }
}
