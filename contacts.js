// Dialer/directory & presence: the generic api() fetch wrapper and its
// connection-trouble/identity-mismatch bookkeeping, backoff-aware polling,
// call placement/acceptance, local contacts/block-list/display-name storage,
// and the contacts + non-contact-request list rendering. Split out of
// app.js as part of the client-code consolidation
// (CADS-webconference-demo#91); every function/const here is a verbatim
// move, comments included, with no behavior change.
//
// Circular with messenger-ui.js, on purpose: this module needs
// currentConversationEmail/openConversation/closeConversation/formatMsgTime
// (messenger-ui.js), and messenger-ui.js needs myContacts/blockedEmails/
// myNames/api/refreshContacts (here) -- same safe live-binding/hoisted-
// function reasoning as every other circular import in this consolidation
// (see pairing.js's header comment for the full explanation). dialerChatStore
// comes from chat-glue.js, its permanent home as of that consolidation cycle.

import {
  callNote, contactsList, contactsEmpty, requestsList, requestsEmpty, requestsBadge,
  dialForm, convStatus, log,
} from './ui-dom.js';
import { formatMsgTime, openConversation, closeConversation, currentConversationEmail } from './messenger-ui.js';
import { dialerChatStore } from './chat-glue.js';

function setCallNote(kind, text) {
  callNote.className = kind ? `call-note ${kind}` : '';
  callNote.textContent = text;
}

// CADS-webconference-demo#38 (finding 1): consecutive api() failures (a
// non-2xx response, or the network-error catch below) toggle a shared
// "connection trouble" banner in the messenger shell. Previously a downed
// bridge's 502s were parsed as if they were real JSON responses -- every
// background poll (heartbeat/incoming/contacts/access-requests) kept
// hammering it at full cadence with no visible sign anything was wrong.
// This also feeds pollEvery below (#38 finding 3) -- the same counter
// that surfaces the outage to the user is what backs the pollers off.
let apiConsecutiveFailures = 0;
// CADS-webconference-demo (live-reported): a 403 with code:'identity_mismatch'
// means identity.email (fixed at page load from the gate's verified email at
// that time) no longer matches the CURRENT gate session on this same open
// tab -- every identity-scoped call will keep failing this way forever, no
// amount of retrying fixes it, only a reload (which re-fetches /api/whoami
// fresh) does. Distinct from a transient outage: shown instead of, not
// alongside, #conn-trouble-banner/#presence-lost-banner, and skips their
// "maybe it'll recover" framing for a direct, actionable one. Sticky once
// set -- a stale identity doesn't un-become stale on its own, so there's no
// case where clearing this back to false on some later unrelated success
// would be correct.
let identityMismatchDetected = false;
function noteApiResult(ok, body) {
  apiConsecutiveFailures = ok ? 0 : apiConsecutiveFailures + 1;
  if (!ok && body && body.code === 'identity_mismatch' && !identityMismatchDetected) {
    identityMismatchDetected = true;
    const mismatchBanner = document.getElementById('identity-mismatch-banner');
    const connBanner = document.getElementById('conn-trouble-banner');
    const presenceBanner = document.getElementById('presence-lost-banner');
    if (connBanner) connBanner.hidden = true;
    if (presenceBanner) presenceBanner.hidden = true;
    // CADS-webconference-demo#80: identityMismatchDetected is a plain
    // module-level `let` -- it resets to false on every page load, so it
    // can only ever stop a SECOND timer within the SAME page lifetime, not
    // across a reload. If the mismatch is persistent (the gate session
    // stays genuinely unstable rather than a one-off drift -- live-reported:
    // this recurred for the same user even across manual reloads before
    // 05fe090 existed), the previous unconditional 4s auto-reload had
    // nothing stopping it from reloading into the SAME mismatch, reloading
    // again, forever -- turning the fix meant to remove one manual click
    // into an involuntary reload hammer: unusable tab, real battery/CPU
    // cost on a backgrounded-but-alive mobile tab. sessionStorage survives
    // a reload (unlike this module-level flag), so it's the right place for
    // a marker THAT auto-reload just happened -- checked before scheduling
    // another one.
    const RELOAD_LOOP_WINDOW_MS = 60000;
    const lastReloadAt = Number(sessionStorage.getItem('ct-webconference-last-mismatch-reload') || 0);
    const reloadedRecently = Date.now() - lastReloadAt < RELOAD_LOOP_WINDOW_MS;
    if (reloadedRecently) {
      log('identity mismatch detected again shortly after an auto-reload -- not reloading again automatically (would loop); sign out and back in if this persists');
      if (mismatchBanner) {
        const span = mismatchBanner.querySelector('span');
        if (span) span.textContent = "Your saved login doesn't match your current session, even after reloading. Your login session may be unstable -- try signing out and back in.";
        mismatchBanner.hidden = false;
      }
      return;
    }
    if (mismatchBanner) mismatchBanner.hidden = false;
    log('identity mismatch detected (saved identity no longer matches the current gate session) -- reload required, will not self-resolve by retrying; auto-reloading shortly');
    // CADS-webconference-demo (live-reported): unlike the transient-network
    // banners, a mismatch has exactly one fix (reload) with no ambiguity --
    // there's no "maybe it recovers on its own" case to wait out, so making
    // the user find and click the button themselves is a pointless extra
    // step, not a safety margin. Auto-reloads after a few seconds (enough
    // to actually read the message first); the button stays for an
    // immediate manual reload too.
    sessionStorage.setItem('ct-webconference-last-mismatch-reload', String(Date.now()));
    setTimeout(() => location.reload(), 4000);
    return;
  }
  if (identityMismatchDetected) return; // sticky -- see comment above, don't let a later generic failure/success touch the other banners
  const banner = document.getElementById('conn-trouble-banner');
  if (banner) banner.hidden = apiConsecutiveFailures < 3;
}

// CADS-webconference-demo#38 (finding 3): the six independent background
// polls (heartbeat/incoming/contacts/access-requests/contact-requests/
// background-delivery sweep) all used to fire at full fixed cadence
// regardless of whether the bridge was reachable -- during a sustained
// outage that's ~0.9 req/s of guaranteed-failing requests until the bridge
// recovers or the tab closes. Rather than a full poller-coordinator object,
// this reuses the outage signal finding 1 already maintains: once 3+
// consecutive api() failures are showing the "connection trouble" banner,
// each poll's own next tick backs off (capped at 60s) instead of a real
// coordinator with per-poller state -- deliberately the smaller of the two
// shapes, since the outage is already visible to the user via the banner;
// this only reduces wasted request volume during it. setTimeout recursion
// rather than setInterval also means a slow/hung fn() can't overlap itself
// (setInterval's own latent risk) -- fn is always fire-and-forget here
// (each caller's own .catch(()=>{})), so that shift in effective cadence
// is negligible. Auto-resets to base cadence the moment apiConsecutiveFailures
// next reaches 0 (the next successful call), no manual un-backoff needed.
function pollEvery(fn, baseMs) {
  const tick = () => {
    // CADS-webconference-demo#72: a detected identity mismatch is terminal
    // (see noteApiResult's comment) -- backing off the cadence like a
    // transient outage still means every one of the six background pollers
    // keeps firing a doomed 403 forever, just slower. Stop rescheduling
    // entirely once it's known; the banner already told the user a reload
    // is what fixes this, retrying can't.
    if (identityMismatchDetected) return;
    fn();
    const down = apiConsecutiveFailures >= 3;
    const next = down ? Math.min(baseMs * 4, 60000) : baseMs;
    setTimeout(tick, next);
  };
  setTimeout(tick, baseMs);
}

// Never throws -- a network blip, a dropped connection, or a non-JSON error
// page all collapse to `{ error: '...' }` instead of an unhandled rejection
// that would otherwise leave whatever UI state was set right before this
// call (e.g. "Connecting…") stuck forever with no way forward. A non-2xx
// response no longer silently returns as if it were a success (#38 finding
// 1): the body is still returned as-is when it already carries its own
// `error` (e.g. the bridge's own `{error:"admin only"}`), but always gets
// `_status` set so a caller can distinguish "the bridge said no" from "the
// bridge is unreachable" without re-deriving it from response shape.
async function api(path, opts) {
  try {
    const resp = await fetch(`/api${path}`, {
      method: opts?.body ? 'POST' : 'GET',
      headers: opts?.body ? { 'content-type': 'application/json' } : undefined,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      if (!body.error) body.error = `http ${resp.status}`;
      body._status = resp.status;
    }
    noteApiResult(resp.ok, body);
    return body;
  } catch (e) {
    noteApiResult(false);
    return { error: `network error: ${e.message || e}` };
  }
}

async function pollCallStatus(channel, { onDone, timeoutMs = 15000, intervalMs = 1000, shouldAbort }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Checked before each round-trip so a caller-initiated Cancel (which
    // updates its own UI directly) stops this loop without racing onDone.
    if (shouldAbort && shouldAbort()) return;
    // api() no longer throws, so a single failed poll (transient network
    // blip) just retries on the next tick instead of aborting the whole
    // ringing/registration wait with an unhandled rejection.
    const { status } = await api(`/call-status?channel=${channel}`);
    if (status?.state === 'accepted_and_registered') return onDone(true, status);
    if (status?.state === 'pending_core_credential') return onDone(false, status);
    if (status?.state === 'declined') return onDone(false, status);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return onDone(false, { state: 'timeout' });
}

function startCallFromIdentity(identity, { role, channel, grant, ws, transport, peerEmail }) {
  // CADS-webconference-demo#63: the ONLY places that persist a contact were
  // the Requests-tab "Add" button, the block-list "Unblock" button, and the
  // "add a contact by email" search form -- placing or accepting a CALL
  // (this function, the single choke point for both the caller's dialForm
  // submit and the callee's #btn-accept) never touched myContacts at all.
  // A user who invites someone by calling them, or accepts an incoming
  // call, ended up with no durable contact record on either side -- lost on
  // the next reload/session, and the relationship had to be re-established
  // from scratch every time. On-attempt (here, before the reload) rather
  // than gated on the call actually connecting: simpler and more
  // messenger-like ("I called/answered this person" is itself the
  // relationship-forming act), matching how the search-form's own add
  // already works (adds immediately, not contingent on them ever replying).
  // myContacts.add is idempotent (Set-based dedup in localSetFor), so this
  // is safe to call on every call attempt without growing unbounded.
  if (peerEmail && myContacts) myContacts.add(peerEmail);
  // CADS-webconference-demo#13: holderPriv/noisePriv deliberately left out
  // of this URL -- see run()'s matching comment for why (localStorage
  // recovery via myEmail instead). myEmail is now unconditional rather than
  // peerEmail-gated, since it's load-bearing for that recovery on every
  // in-app call, not just an optional chat-store-keying nicety anymore.
  const params = new URLSearchParams({ ws, grant, role, myEmail: identity.email });
  if (transport === 'channel') params.set('transport', 'channel');
  // peerEmail alone stays optional/chat-store-keying-only, same as before.
  if (peerEmail) params.set('peerEmail', peerEmail);
  location.search = params.toString(); // reload into the call screen -- keeps run() as the single entry point
}

// ============ Local contacts / block list / privacy setting ============
// Purely client-side (localStorage), scoped per identity like chatStore's
// Lamport clock -- distinct from BOTH presence (/api/contacts: who's
// actually online right now) and the tunnel's login allow-list (who's
// PERMITTED to authenticate at all). This is MY OWN curated "people I
// actually talk to" list. Adding someone here also grants them login
// access (see msgSearchForm's submit handler below) -- from the user's
// side these were never two different actions, just two different admin
// surfaces for the same intent. Removing/blocking, deliberately, does NOT
// revoke that access -- it only changes what *I* see; a real access-revoke
// stays a separate, explicit action (the "Revoke someone's login access"
// panel in the menu), since conflating "I don't want to see them" with
// "they may never log in again" would be a much bigger, easy-to-regret
// action to hide behind a small ✕.
// CADS-webconference-demo#87: entries are {present, ts} pairs, not a plain
// array -- a plain set union can't represent DELETION, so a stale remote
// sync state that still has an email A removed would resurrect it on merge.
// A tombstone (present:false, ts:<removal time>) lets remove() win over an
// older add() the same way a newer add() wins over an older remove() --
// last-write-wins per email, symmetric in both directions. Public API
// (all/has/add/remove) is unchanged so existing call sites don't need to
// change; merge() is new, used only by the sync loop.
function localSetFor(kind, email) {
  const key = `ct-webconference-${kind}:${email.toLowerCase()}`;
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || '{"entries":{}}');
      if (Array.isArray(raw)) {
        // Migrate the pre-#87 plain-array format transparently: every
        // existing email becomes present, stamped "now" -- there's no real
        // historical timestamp for legacy entries, and "now" is the safe
        // default (it can only ever look too-recently-added, never
        // wrongly lose to an older remote tombstone it has no way to know
        // about).
        const entries = {};
        for (const e of raw) entries[e.toLowerCase()] = { present: true, ts: Date.now() };
        return { entries };
      }
      return raw && raw.entries ? raw : { entries: {} };
    } catch (_) {
      return { entries: {} };
    }
  }
  function save(state) {
    localStorage.setItem(key, JSON.stringify(state));
  }
  return {
    all() {
      const { entries } = load();
      return Object.keys(entries).filter((e) => entries[e].present);
    },
    has(e) {
      const { entries } = load();
      return !!entries[e.toLowerCase()]?.present;
    },
    add(e) {
      const state = load();
      state.entries[e.toLowerCase()] = { present: true, ts: Date.now() };
      save(state);
    },
    remove(e) {
      const state = load();
      state.entries[e.toLowerCase()] = { present: false, ts: Date.now() };
      save(state);
    },
    entriesRaw() {
      return load().entries;
    },
    // Last-write-wins merge against a remote {email: {present, ts}} map,
    // used by the sync loop -- whichever side (local or remote) has the
    // newer ts for a given email wins; a tie keeps the local value.
    merge(remoteEntries) {
      const state = load();
      for (const [email, remote] of Object.entries(remoteEntries || {})) {
        const local = state.entries[email];
        if (!local || remote.ts > local.ts) {
          state.entries[email] = remote;
        }
      }
      save(state);
    },
  };
}

// CADS-webconference-demo#54: contacts showed only the raw email with no
// way to label them -- a real gap versus any basic messenger. Local-only
// (same trust/durability tier as myContacts/blockedEmails above -- this
// identity's own private labels, never sent to the bridge or the peer),
// keyed the same way localSetFor's own storage key is.
function nameMapFor(email) {
  const key = `ct-webconference-names:${email.toLowerCase()}`;
  function all() {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}');
    } catch (_) {
      return {};
    }
  }
  return {
    get(e) {
      return all()[e.toLowerCase()] || null;
    },
    set(e, name) {
      const map = all();
      const trimmed = (name || '').trim();
      if (trimmed) map[e.toLowerCase()] = trimmed;
      else delete map[e.toLowerCase()]; // empty name clears the label, falls back to the email
      localStorage.setItem(key, JSON.stringify(map));
    },
  };
}
let myContacts = null;
let myNames = null;
let blockedEmails = null;
let onlyAcceptFromContacts = false;
let myEmail = null; // set once in runDialer -- the logged-in identity's own email
let myIdentity = null; // set once in runDialer -- full identity object (needed by background delivery, which lives outside runDialer's own closure)
// CADS-webconference-demo#91: ES module imports are read-only from the
// importing side -- runDialer (still in app.js until a later dialer.js
// cycle) needs to actually ASSIGN these on login/logout, not just read
// them, so a plain live-binding export (which works fine for read-only
// consumers like sync.js/messenger-ui.js) isn't enough here. These setters
// are the minimal, necessary way to let app.js mutate this module's own
// state -- not a design embellishment, this app is genuinely broken
// without them (an imported binding can't be assigned to directly).
function setMyEmail(v) { myEmail = v; }
function setMyIdentity(v) { myIdentity = v; }
function setMyContacts(v) { myContacts = v; }
function setMyNames(v) { myNames = v; }
function setBlockedEmails(v) { blockedEmails = v; }
function setOnlyAcceptFromContacts(v) { onlyAcceptFromContacts = v; }
// Non-contact incoming attempts held for review instead of ringing
// immediately (only populated when onlyAcceptFromContacts is on) -- see
// showIncoming's gating logic. In-memory only: a real "missed request"
// notification that outlives a reload would need server-side storage this
// bridge doesn't have; this is deliberately a same-session convenience,
// not pretended to be more durable than it is.
let pendingRequests = [];

// ============ Contacts / address book ============
// The list itself is now MY CONTACTS (myContacts, local), not raw presence
// -- /api/contacts (presence) is only consulted to annotate each contact's
// online/offline status, not to decide who's shown at all.
// CADS-webconference-demo#38 (finding 4): called from a 5s setInterval AND
// directly after almost every user action (send, open conversation, add/
// remove contact...) without awaiting/serializing either. On a slow network
// -- where the earlier /contacts round-trip is still in flight when the
// next trigger fires -- multiple overlapping calls raced renderContacts's
// own clear-and-rebuild of the list DOM, and each one recomputed the same
// currentConversationEmail status independently. Callers that DO await
// refreshContacts() (e.g. openConversation) still need a real completion
// signal, not a silent no-op, so an in-flight overlap joins the SAME
// promise instead of being dropped.
let refreshContactsInFlight = null;
async function refreshContacts() {
  if (refreshContactsInFlight) return refreshContactsInFlight;
  refreshContactsInFlight = doRefreshContacts();
  try {
    await refreshContactsInFlight;
  } finally {
    refreshContactsInFlight = null;
  }
}
async function doRefreshContacts() {
  const mine = myContacts.all();
  // CADS-webconference-demo#11: scoped to exactly the emails this call
  // needs presence for -- see the endpoint's own comment for why. Already
  // bounded by MY OWN contact list, not by total account count -- this
  // poll's cost is O(my contacts), the same regardless of how many other
  // accounts exist on the server, so it stays cheap even at a very large
  // total user count.
  const resp = mine.length ? await api(`/contacts?emails=${encodeURIComponent(mine.join(','))}`) : { contacts: [] };
  const presence = new Map((resp.error ? [] : resp.contacts || []).map((c) => [c.email, c.online]));
  const contacts = mine.map((email) => ({ email, online: presence.get(email) || false }));
  await renderContacts(contacts);
  renderRequests();
  // The open conversation's own header used to be set once, in
  // openConversation(), and never touched again -- if the peer's presence
  // changed while you kept that conversation open, the header just sat
  // there stale (confirmed live: still showed "offline" 7+ seconds after
  // the peer had genuinely come online and started heartbeating). Reusing
  // this SAME already-scoped poll instead of adding a second one -- the
  // open conversation's peer is always a contact (openConversation is only
  // ever reached from the contacts list), so its presence is already in
  // the map above at zero extra request cost.
  if (currentConversationEmail && presence.has(currentConversationEmail)) {
    const online = presence.get(currentConversationEmail);
    convStatus.textContent = online ? 'online' : 'offline';
    convStatus.dataset.online = online ? '1' : '0';
  }
}

// Renders the chat list (messenger-row: avatar, name, last-message preview,
// timestamp, online dot, + chat/call/remove action icons) -- a real chat
// list, not a bare directory. Pulls the last message per contact from
// chatStore (if one exists yet) so a contact you've actually talked to
// shows a preview, same as any real messenger; a contact with no history
// yet just shows online/offline.
async function renderContacts(contacts) {
  contactsList.querySelectorAll('li:not(#contacts-empty)').forEach((li) => li.remove());
  contactsEmpty.hidden = contacts.length > 0;
  for (const { email, online } of contacts) {
    const li = document.createElement('li');
    li.dataset.online = online ? '1' : '0';
    if (email === currentConversationEmail) li.classList.add('active');
    const avatar = document.createElement('div');
    avatar.className = 'contact-avatar';
    avatar.textContent = (email[0] || '?').toUpperCase();
    const body = document.createElement('div');
    body.className = 'msg-row-body';
    const top = document.createElement('div');
    top.className = 'msg-row-top';
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-row-name';
    // CADS-webconference-demo#54: shows the display name if one's been set
    // (myNames, local-only -- see nameMapFor's own comment), the raw email
    // otherwise -- exactly the same fallback openConversation's header uses.
    nameEl.textContent = myNames?.get(email) || email;
    top.appendChild(nameEl);
    const preview = document.createElement('div');
    preview.className = 'msg-row-preview';
    preview.textContent = 'No messages yet';
    if (dialerChatStore) {
      const history = await dialerChatStore.history(email);
      const last = history[history.length - 1];
      if (last) {
        const time = document.createElement('span');
        time.className = 'msg-row-time';
        time.textContent = formatMsgTime(last.ts);
        top.appendChild(time);
        // CADS-webconference-demo#50: a file record has no .text at all.
        const lastSummary = last.kind === 'file' ? `📎 ${last.fileName || 'file'}` : last.text;
        preview.textContent = last.from === 'me' ? `You: ${lastSummary}` : lastSummary;
      }
    }
    body.append(top, preview);

    const actions = document.createElement('div');
    actions.className = 'msg-row-actions';
    const chatBtn = document.createElement('button');
    chatBtn.type = 'button';
    chatBtn.setAttribute('aria-label', `Chat with ${email}`);
    chatBtn.textContent = '💬';
    chatBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openConversation(email);
    });
    const callBtn = document.createElement('button');
    callBtn.type = 'button';
    callBtn.setAttribute('aria-label', `Call ${email}`);
    callBtn.textContent = '📞';
    callBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openConversation(email).then(() => dialForm.requestSubmit());
    });
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.setAttribute('aria-label', `Remove ${email} from contacts`);
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      myContacts.remove(email);
      if (currentConversationEmail === email) closeConversation();
      refreshContacts();
    });
    actions.append(chatBtn, callBtn, removeBtn);

    li.append(avatar, body, actions);
    li.addEventListener('click', () => openConversation(email));
    contactsList.appendChild(li);
  }
}

// ============ Requests (non-contact incoming attempts, held for review) ==
function renderRequests() {
  requestsList.querySelectorAll('li:not(#requests-empty)').forEach((li) => li.remove());
  requestsEmpty.hidden = pendingRequests.length > 0;
  requestsBadge.hidden = pendingRequests.length === 0;
  requestsBadge.textContent = String(pendingRequests.length);
  for (const { email } of pendingRequests) {
    const li = document.createElement('li');
    const avatar = document.createElement('div');
    avatar.className = 'contact-avatar';
    avatar.textContent = (email[0] || '?').toUpperCase();
    const body = document.createElement('div');
    body.className = 'msg-row-body';
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-row-name';
    nameEl.textContent = email;
    const note = document.createElement('div');
    note.className = 'msg-row-preview';
    note.textContent = 'Wants to be added to your contacts';
    body.append(nameEl, note);
    const actions = document.createElement('div');
    actions.className = 'msg-request-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'accept';
    acceptBtn.textContent = 'Add';
    acceptBtn.addEventListener('click', () => {
      myContacts.add(email);
      pendingRequests = pendingRequests.filter((r) => r.email !== email);
      api('/contact-requests/clear', { body: { email: myEmail, fromEmail: email } }).catch(() => {});
      refreshContacts();
    });
    const declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.className = 'decline';
    declineBtn.textContent = 'Dismiss';
    declineBtn.addEventListener('click', () => {
      pendingRequests = pendingRequests.filter((r) => r.email !== email);
      api('/contact-requests/clear', { body: { email: myEmail, fromEmail: email } }).catch(() => {});
      renderRequests();
    });
    actions.append(acceptBtn, declineBtn);
    li.append(avatar, body, actions);
    requestsList.appendChild(li);
  }
}

// Set while an outgoing call is ringing (placed but not yet accepted/declined/
// registered), cleared once it resolves either way. Lets the Cancel button
// (added alongside /api/cancel) abort pollCallStatus's wait from the outside.
let outgoingChannel = null;
// See setMyEmail's own comment -- same reasoning, app.js needs write access.
function setOutgoingChannel(v) { outgoingChannel = v; }

export {
  setCallNote,
  noteApiResult,
  pollEvery,
  api,
  pollCallStatus,
  startCallFromIdentity,
  localSetFor,
  nameMapFor,
  myContacts,
  myNames,
  blockedEmails,
  onlyAcceptFromContacts,
  myEmail,
  myIdentity,
  pendingRequests,
  refreshContacts,
  doRefreshContacts,
  renderContacts,
  renderRequests,
  outgoingChannel,
  apiConsecutiveFailures,
  identityMismatchDetected,
  setMyEmail,
  setMyIdentity,
  setMyContacts,
  setMyNames,
  setBlockedEmails,
  setOnlyAcceptFromContacts,
  setOutgoingChannel,
};
