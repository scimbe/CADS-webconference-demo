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
// (this browser, this identity) can ever decrypt the stored history;
// IndexedDB itself never sees plaintext.
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

function conversationKey(myEmail, peerEmail) {
  return [myEmail.toLowerCase(), peerEmail.toLowerCase()].sort().join('|');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('byConversation', ['conversation', 'seq']);
    };
    req.onsuccess = () => resolve(req.result);
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
  }
  tick() {
    this.value += 1;
    localStorage.setItem(this.key, String(this.value));
    return this.value;
  }
  observe(remoteSeq) {
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
    this.dbPromise = openDb();
    this.listeners = new Set();
    // Same-device, same-identity tab sync -- see header comment. Scoped by
    // email so a shared/kiosk browser's other identities never cross-talk.
    this.channel = new BroadcastChannel(`ct-webconference-chat:${identity.email.toLowerCase()}`);
    this.channel.addEventListener('message', (ev) => {
      this.clock.observe(ev.data.seq);
      this._notify(ev.data);
    });
  }

  onMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
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
  nextSeqForSend() {
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
    const { iv, ciphertext } = await this._encrypt(text);
    const record = {
      conversation: conversationKey(this.identity.email, peerEmail),
      peerEmail: peerEmail.toLowerCase(),
      seq,
      from, // 'me' | 'peer'
      ts: Date.now(),
      pending,
      iv,
      ciphertext,
    };
    const db = await this.dbPromise;
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

  // Full history for one contact, decrypted, in causal (seq) order.
  async history(peerEmail) {
    const db = await this.dbPromise;
    const conversation = conversationKey(this.identity.email, peerEmail);
    const records = await new Promise((resolve, reject) => {
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
    return Promise.all(
      records.map(async (r) => ({
        peerEmail: r.peerEmail,
        seq: r.seq,
        from: r.from,
        ts: r.ts,
        pending: !!r.pending,
        text: await this._decrypt(r.iv, r.ciphertext),
      })),
    );
  }

  // Outbox: every not-yet-delivered outgoing message for one peer, oldest
  // first -- what setupChatChannel's 'open' handler flushes the moment a
  // live channel to that peer actually exists.
  async pendingOutbox(peerEmail) {
    const all = await this.history(peerEmail);
    return all.filter((m) => m.from === 'me' && m.pending);
  }

  // Flip a queued message to delivered once it's actually gone out over the
  // live channel. Matched by (peerEmail, seq) -- unique per conversation
  // since seq comes from this identity's own strictly-increasing clock.
  async markDelivered(peerEmail, seq) {
    const db = await this.dbPromise;
    const conversation = conversationKey(this.identity.email, peerEmail);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const idx = tx.objectStore(STORE).index('byConversation');
      const range = IDBKeyRange.bound([conversation, -Infinity], [conversation, Infinity]);
      idx.openCursor(range).onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor) return resolve();
        if (cursor.value.seq === seq && cursor.value.pending) {
          const updated = { ...cursor.value, pending: false };
          cursor.update(updated);
          return resolve();
        }
        cursor.continue();
      };
      tx.onerror = () => reject(tx.error);
    });
  }
}
