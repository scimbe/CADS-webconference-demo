// ============ Cross-device sync (#87/#88) ============
// Delta push/pull against this bridge's /api/sync/{push,pull} -- NOT
// peer-to-peer, and NOT how a brand-new device gets the identity's keys in
// the first place (see pairing.js for that): this loop only ever runs
// once THIS device already holds the real holderPriv/noisePriv, letting
// multiple already-paired devices reconcile chat history + contacts/
// blocklist without needing to be online at the same time. Scoped to
// conversations in myContacts.all() -- a conversation with someone who was
// never added as a contact isn't covered by this pass (rare in practice;
// flagged, not silently pretended to be complete). nameMapFor's per-
// contact display-name labels are also out of scope for this pass -- see
// the bridge's own syncStore comment for why.
//
// Split out of app.js as part of the client-code consolidation
// (CADS-webconference-demo#91); every function/const here is a verbatim
// move, comments included, with no behavior change. myEmail/myContacts/
// blockedEmails/api/refreshContacts come from contacts.js, dialerChatStore
// from chat-glue.js (each module's permanent home as of its own
// consolidation cycle) -- see contacts.js's own header comment for why
// these particular cross-module reads are safe (live bindings/hoisted
// functions only ever touched at runtime, well after every module has
// evaluated).

import { myEmail, myContacts, blockedEmails, api, refreshContacts } from './contacts.js';
import { dialerChatStore } from './chat-glue.js';

function syncCursorKeyFor(email) {
  return `ct-webconference-sync-cursor:${email.toLowerCase()}`;
}
function loadSyncCursor(email) {
  try {
    const parsed = JSON.parse(localStorage.getItem(syncCursorKeyFor(email)) || '{}');
    return { pushedSeq: parsed.pushedSeq || {}, pulledRevision: parsed.pulledRevision || 0 };
  } catch (_) {
    return { pushedSeq: {}, pulledRevision: 0 };
  }
}
function saveSyncCursor(email, cursor) {
  localStorage.setItem(syncCursorKeyFor(email), JSON.stringify(cursor));
}

// CADS-webconference-demo#38 (finding 4)'s own pattern, reused here: an
// overlapping call (the pollEvery tick firing again before a slow sync
// finished) joins the SAME in-flight promise instead of racing a second
// concurrent push/pull cycle against the first.
let syncInFlight = null;
async function syncNow() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doSyncNow();
  try {
    await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}
async function doSyncNow() {
  if (!myEmail || !dialerChatStore || !myContacts || !blockedEmails) return;
  const cursor = loadSyncCursor(myEmail);
  let changedContacts = false;

  // Push: new local rows per conversation this device knows about, plus
  // the current contacts/blocked tombstone state (small, always sent in
  // full -- see the bridge's own mergeEntries comment).
  //
  // CADS-webconference-demo#87 (live-reported): bundling every unsynced
  // row for a conversation into ONE /sync/push call could exceed the
  // bridge's 64KB MAX_BODY_BYTES cap (#12) outright -- confirmed live: a
  // conversation with a file/image attachment (whose iv/ciphertext are
  // JSON-encoded as plain number arrays, ~3.5-4x larger than the raw bytes
  // -- see chatStore.js's _encryptBytes) reliably 413'd, and since the
  // WHOLE push failed, the cursor never advanced -- silently stalling that
  // conversation's sync forever, including every OTHER, smaller row
  // bundled in the same call. The bridge's own comment on this route
  // already anticipated this ("a device with a large backlog just calls
  // this multiple times") -- this is that: rows are now batched by
  // estimated JSON size, well under the server's cap, each submitted as
  // its own push, with the cursor advanced per successful batch so a
  // later failure doesn't lose progress already made on earlier ones.
  const SYNC_PUSH_BATCH_BUDGET_BYTES = 32768; // half of MAX_BODY_BYTES -- headroom for the email field + JSON structure + this being a length-based estimate, not an exact byte count
  // CADS-webconference-demo#87 follow-up (live-reported): batching (above)
  // only helps when the PROBLEM is many small rows bundled together --
  // a single row whose own ciphertext already exceeds the batch budget
  // (a real file/image attachment; JSON-array encoding runs ~3.5-4x the
  // raw bytes) still 413'd on its own no matter how it was batched.
  // pushChunkedRow splits that one row's ciphertext into fixed-size
  // chunks, each sent as ITS OWN /sync/push call (mirrors the existing
  // direct-channel transport's own FILE_CHUNK_BYTES chunking, call-
  // protocol.js) -- the bridge reassembles them (see its own
  // pendingChunkedMessages comment) before the row ever lands in synced
  // state. 6144 raw bytes -> ~22KB of JSON-array-encoded chunk content
  // (worst case ~3.57 chars/byte), comfortably under the batch budget
  // with room for the envelope fields alongside it.
  const SYNC_CIPHERTEXT_CHUNK_BYTES = 6144;
  async function pushChunkedRow(r) {
    const chunkCount = Math.max(1, Math.ceil(r.ciphertext.length / SYNC_CIPHERTEXT_CHUNK_BYTES));
    for (let i = 0; i < chunkCount; i++) {
      const chunk = {
        conversation: r.conversation,
        seq: r.seq,
        from: r.from,
        ts: r.ts,
        kind: r.kind,
        iv: r.iv,
        chunkIndex: i,
        chunkCount,
        ciphertextChunk: r.ciphertext.slice(i * SYNC_CIPHERTEXT_CHUNK_BYTES, (i + 1) * SYNC_CIPHERTEXT_CHUNK_BYTES),
        ...(r.kind === 'file' ? { fileName: r.fileName, fileMimeType: r.fileMimeType, fileSize: r.fileSize } : {}),
      };
      const resp = await api('/sync/push', { body: { email: myEmail, messages: [chunk] } });
      // A failure partway through (network blip, server restart) leaves an
      // incomplete buffer server-side -- harmless: the very next attempt
      // starts again at chunkIndex 0, which the bridge treats as a clean
      // reset for this row's key, not an append onto the stale partial.
      if (resp.error) return false;
    }
    return true;
  }
  for (const peerEmail of myContacts.all()) {
    const sinceSeq = cursor.pushedSeq[peerEmail] || 0;
    const rows = await dialerChatStore.rowsSince(peerEmail, sinceSeq);
    if (!rows.length) continue;
    let batch = [];
    let batchBytes = 0;
    let pushedThrough = sinceSeq;
    const flushBatch = async () => {
      if (!batch.length) return true;
      const resp = await api('/sync/push', { body: { email: myEmail, messages: batch } });
      if (resp.error) return false;
      pushedThrough = Math.max(pushedThrough, ...batch.map((m) => m.seq));
      batch = [];
      batchBytes = 0;
      return true;
    };
    let stopped = false;
    for (const r of rows) {
      const msg = {
        conversation: r.conversation,
        seq: r.seq,
        from: r.from,
        ts: r.ts,
        kind: r.kind,
        iv: r.iv,
        ciphertext: r.ciphertext,
        ...(r.kind === 'file' ? { fileName: r.fileName, fileMimeType: r.fileMimeType, fileSize: r.fileSize } : {}),
      };
      const msgBytes = JSON.stringify(msg).length;
      if (msgBytes > SYNC_PUSH_BATCH_BUDGET_BYTES) {
        if (!(await flushBatch())) { stopped = true; break; }
        if (!(await pushChunkedRow(r))) { stopped = true; break; }
        pushedThrough = Math.max(pushedThrough, r.seq);
        continue;
      }
      if (batch.length && batchBytes + msgBytes > SYNC_PUSH_BATCH_BUDGET_BYTES) {
        if (!(await flushBatch())) { stopped = true; break; }
      }
      batch.push(msg);
      batchBytes += msgBytes;
    }
    if (!stopped) await flushBatch();
    cursor.pushedSeq[peerEmail] = pushedThrough;
    // Robustness audit finding (proactive review, not yet live-reproduced
    // -- needs a real IndexedDB failure, e.g. under real storage pressure,
    // mid-loop): saveSyncCursor used to only ever be called once, at the
    // very end of this whole function -- but dialerChatStore.rowsSince()
    // just above (unlike every other cross-boundary call in this loop,
    // which all either check resp.error or carry their own .catch()) has
    // no error handling at all. If it throws for some LATER contact in
    // myContacts.all(), the exception propagates straight out of
    // doSyncNow() uncaught, and the single end-of-function saveSyncCursor
    // never runs -- silently losing the push-cursor progress this loop
    // already made (and durably reflected server-side, via already-
    // successful /sync/push calls) for every EARLIER contact processed in
    // this same run, undermining the exact "a later failure doesn't lose
    // progress already made on earlier ones" guarantee this file's own
    // #87 comment above already promises for a single contact's own
    // batches. Persisting the cursor right here, after each contact's own
    // push loop completes, means that guarantee now actually holds across
    // contacts too, not just within one.
    saveSyncCursor(myEmail, cursor);
  }
  await api('/sync/push', {
    body: { email: myEmail, contacts: { entries: myContacts.entriesRaw() }, blocked: { entries: blockedEmails.entriesRaw() } },
  }).catch(() => {});

  // Pull: page through everything past our last-seen revision. Bounded to
  // 50 pages/tick (50 * the bridge's own 200-row page = 10,000 rows) --
  // generous for a real backlog, not unbounded; the next tick just picks
  // up where this one left off via the persisted cursor.
  for (let guard = 0; guard < 50; guard++) {
    const resp = await api(`/sync/pull?email=${encodeURIComponent(myEmail)}&since=${cursor.pulledRevision}`);
    if (resp.error) break;
    for (const row of resp.messages || []) {
      const prefix = `${myEmail.toLowerCase()}->`;
      if (!row.conversation.startsWith(prefix)) continue; // defense in depth -- should never happen, this identity's own pull can't return another identity's rows
      const peerEmail = row.conversation.slice(prefix.length);
      await dialerChatStore.mergeEncryptedRow(peerEmail, row).catch(() => {});
    }
    if (resp.contacts?.entries) {
      myContacts.merge(resp.contacts.entries);
      changedContacts = true;
    }
    if (resp.blocked?.entries) blockedEmails.merge(resp.blocked.entries);
    if (!resp.messages || resp.messages.length === 0 || resp.nextSince === cursor.pulledRevision) break;
    cursor.pulledRevision = resp.nextSince;
    // Same reasoning as the push loop's own incremental saveSyncCursor
    // above: myContacts.merge/blockedEmails.merge aren't guarded here
    // either, so persist each page's pull progress as it's made instead
    // of only once at the very end.
    saveSyncCursor(myEmail, cursor);
  }

  saveSyncCursor(myEmail, cursor);
  if (changedContacts) await refreshContacts();
}

export {
  syncCursorKeyFor,
  loadSyncCursor,
  saveSyncCursor,
  syncNow,
  doSyncNow,
};
