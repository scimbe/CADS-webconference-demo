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
  for (const peerEmail of myContacts.all()) {
    const sinceSeq = cursor.pushedSeq[peerEmail] || 0;
    const rows = await dialerChatStore.rowsSince(peerEmail, sinceSeq);
    if (!rows.length) continue;
    const messages = rows.map((r) => ({
      conversation: r.conversation,
      seq: r.seq,
      from: r.from,
      ts: r.ts,
      kind: r.kind,
      iv: r.iv,
      ciphertext: r.ciphertext,
      ...(r.kind === 'file' ? { fileName: r.fileName, fileMimeType: r.fileMimeType, fileSize: r.fileSize } : {}),
    }));
    const resp = await api('/sync/push', { body: { email: myEmail, messages } });
    if (!resp.error) cursor.pushedSeq[peerEmail] = Math.max(sinceSeq, ...rows.map((r) => r.seq));
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
