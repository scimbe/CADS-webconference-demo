// The pre-call assembly layer: identity bootstrap (runIdentityScreen -- gate-
// verified login, device pairing, or free-text entry) and the dialer/
// messenger screen (runDialer -- registration, presence, incoming-call
// handling, outgoing calls, and wiring together every already-extracted
// pre-call module: contacts, chat-glue, access-requests, sync, pairing,
// messenger-ui). Split out of app.js as part of the client-code
// consolidation (CADS-webconference-demo#91); every function/const here is
// a verbatim move, comments included, with no behavior change.
//
// Done after the modules it assembles (3-10) so its own imports are stable.
// The page-reload-based identity<->call transition (startCallFromIdentity's
// location.search reload -- see contacts.js) is untouched: this module still
// only ever gets as far as kicking that reload off, never reaching into
// run()'s own call-setup path itself.

import init from './pkg/ct_agent_wasm.js';
import { ChatStore } from './chatStore.js';
import {
  setupScreen, siteHero, landingMain, messengerShell, myEmailEl, revokeAccessDetails,
  accessRequestsDetails, logoutLink, dialForm, dialEmailInput, incomingCard, incomingFrom,
  btnAccept, btnDecline, btnCancelCall, transportChannelCheckbox, onlyContactsToggle,
  log, notifyIfHidden, playIncomingCallSound, isValidEmail, ensureNotificationPermission,
  showSetupScreen, idEntry, idForm, idEmailInput, idVerifyError, idVerifyErrorDetail, idVerifyRetry,
  idGateRequired, idGateLoginBtn,
} from './ui-dom.js';
import { computeAttestation } from './identity.js';
import { loadOrPairIdentity } from './pairing.js';
import { syncNow } from './sync.js';
import { refreshAccessRequests } from './access-requests.js';
import { renderBlockedList } from './messenger-ui.js';
import { tryBackgroundDeliver, autoAcceptChatDelivery, setDialerChatStore } from './chat-glue.js';
import {
  setCallNote, pollEvery, api, pollCallStatus, startCallFromIdentity, localSetFor, nameMapFor,
  myContacts, blockedEmails, onlyAcceptFromContacts, pendingRequests, renderRequests,
  outgoingChannel, setOutgoingChannel, setMyEmail, setMyIdentity, setMyContacts, setMyNames,
  setBlockedEmails, setOnlyAcceptFromContacts, identityMismatchDetected, refreshContacts,
} from './contacts.js';

async function runDialer(identity, { verified = false } = {}) {
  setupScreen.hidden = true;
  siteHero.hidden = true;
  landingMain.hidden = true;
  messengerShell.hidden = false;
  setDialerChatStore(new ChatStore(identity));
  setMyEmail(identity.email);
  setMyIdentity(identity);
  setMyContacts(localSetFor('contacts', identity.email));
  setMyNames(nameMapFor(identity.email));
  setBlockedEmails(localSetFor('blocked', identity.email));
  setOnlyAcceptFromContacts(localStorage.getItem(`ct-webconference-settings:${identity.email.toLowerCase()}`) === '1');
  onlyContactsToggle.checked = onlyAcceptFromContacts;
  renderBlockedList();
  myEmailEl.textContent = identity.email + (verified ? ' (verified via login)' : '');
  // Revoke-access is admin-only -- hidden until proven otherwise. is-admin
  // only ever returns a boolean (never the admin list itself), and (#46) now
  // answers only about the gate-verified caller -- no ?email= to send, the
  // bridge reads X-Gate-Email itself; identity.email here may not even be a
  // gate-verified identity (free-text/local login), so it was never actually
  // meaningful to send anyway. The bridge also still enforces the real gate
  // server-side on the revoke call itself regardless of what this shows.
  api('/is-admin').then((resp) => {
    revokeAccessDetails.hidden = !resp.isAdmin;
    accessRequestsDetails.hidden = !resp.isAdmin;
    if (resp.isAdmin) {
      refreshAccessRequests();
      pollEvery(refreshAccessRequests, 15000);
    }
  });
  // Only meaningful for a real gate-verified session (X-Gate-Email) -- a
  // free-text identity was never actually logged in anywhere to log out of.
  logoutLink.hidden = !verified;

  await api('/register', { body: { email: identity.email, holderPub: identity.holderPub, noisePub: identity.noisePub } });
  pollEvery(() => api('/heartbeat', { body: { email: identity.email } }), 15000);
  ensureNotificationPermission(); // CADS-webconference-demo#55

  dialForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const toEmail = dialEmailInput.value.trim();
    if (!toEmail) return;
    setCallNote('info', `Calling ${toEmail}…`);
    const transport = transportChannelCheckbox.checked ? 'channel' : 'webrtc';
    const resp = await api('/call', { body: { fromEmail: identity.email, toEmail, transport } });
    if (resp.status === 'offline') {
      setCallNote('warn', `${toEmail} isn't online right now.`);
      return;
    }
    if (resp.error) {
      setCallNote('warn', resp.error);
      return;
    }
    const attestation = computeAttestation(resp.channel, identity.holderPriv, identity.holderPub, identity.noisePub);
    const attestResp = await api('/attest', {
      body: { channel: resp.channel, role: 'caller', holderPub: identity.holderPub, noisePub: identity.noisePub, attestation },
    });
    if (attestResp.error) {
      setCallNote('warn', `Couldn't reach ${toEmail}: ${attestResp.error}`);
      return;
    }
    if (attestResp.status?.state === 'accepted_and_registered') {
      startCallFromIdentity(identity, { role: 'caller', channel: resp.channel, grant: resp.grant, ws: resp.ws, transport: resp.transport, peerEmail: toEmail });
      return;
    }
    setCallNote('info', `Ringing ${toEmail}… waiting for them to accept.`);
    setOutgoingChannel(resp.channel);
    btnCancelCall.hidden = false;
    await pollCallStatus(resp.channel, {
      timeoutMs: 60000, // a real ringing phase -- give the callee time to actually notice and answer
      shouldAbort: () => outgoingChannel !== resp.channel,
      onDone: (ok, status) => {
        btnCancelCall.hidden = true;
        setOutgoingChannel(null);
        if (ok) {
          startCallFromIdentity(identity, { role: 'caller', channel: resp.channel, grant: resp.grant, ws: resp.ws, transport: resp.transport, peerEmail: toEmail });
        } else if (status.state === 'pending_core_credential') {
          setCallNote('warn', `Couldn't complete channel registration: ${status.detail || 'unknown reason'}`);
        } else if (status.state === 'declined') {
          setCallNote('warn', `${toEmail} declined the call.`);
        } else {
          setCallNote('warn', `${toEmail} didn't answer.`);
        }
      },
    });
  });

  btnCancelCall.addEventListener('click', () => {
    if (!outgoingChannel) return;
    const channel = outgoingChannel;
    setOutgoingChannel(null);
    btnCancelCall.hidden = true;
    setCallNote('info', 'Call cancelled.');
    api('/cancel', { body: { channel } }).catch(() => {});
  });

  let currentIncoming = null;
  let currentIncomingTimer = null;
  // Matches the bridge's own CALL_TTL_MS (60s) minus a safety margin -- a
  // caller who never proceeds (closed their tab, lost connection, or was
  // just a stray test call) otherwise leaves this card showing forever with
  // no way to clear it except a manual Decline.
  const INCOMING_CARD_TIMEOUT_MS = 45000;

  function clearIncoming() {
    incomingCard.hidden = true;
    currentIncoming = null;
    if (currentIncomingTimer) {
      clearTimeout(currentIncomingTimer);
      currentIncomingTimer = null;
    }
  }

  function showIncoming(incoming) {
    const from = incoming.fromEmail.toLowerCase();
    // Blocked: silently declined, never rings, never shows up in Requests
    // either -- the whole point of blocking is not having to think about
    // them again, not just not being interrupted this once. Applies to a
    // background chat-delivery attempt exactly the same as a real call --
    // blocking someone should stop them reaching you at all, not just stop
    // your phone from ringing.
    if (blockedEmails.has(from)) {
      api('/decline', { body: { channel: incoming.channel } }).catch(() => {});
      return;
    }
    // Privacy mode on and this isn't someone I've actually added: don't
    // ring (or silently auto-accept a delivery) -- decline this specific
    // attempt (by the time anyone reviews Requests, its own ~60s ringing
    // window has likely already passed anyway) and hold it in Requests so
    // accepting there means "let them reach me next time," not a claim
    // this live attempt can still connect.
    if (onlyAcceptFromContacts && !myContacts.has(from)) {
      api('/decline', { body: { channel: incoming.channel } }).catch(() => {});
      if (!pendingRequests.some((r) => r.email === from)) {
        pendingRequests.push({ email: from });
        renderRequests();
      }
      return;
    }
    // Silent path: no ringing card, no currentIncoming state at all -- a
    // background delivery must never block on (or be blocked by) a real
    // call that happens to be ringing at the same moment.
    if (incoming.kind === 'chat-delivery') {
      autoAcceptChatDelivery(incoming, identity);
      return;
    }
    // The exact call already showing gets redelivered here constantly: the
    // /api/incoming fallback poll (3s cadence, "kept running regardless" as
    // this WS push's backstop) keeps returning the same still-ringing
    // channel every tick until it's accepted/declined/expired, since
    // incomingByEmail on the bridge doesn't clear until one of those
    // happens. Without this check, that redelivery fell straight into the
    // "busy, decline it" branch below and auto-declined the very call the
    // user was looking at -- usually within 3s of it arriving, well before
    // a human has time to click Accept. Live-reported: caller sees
    // "declined" even though the callee never touched Decline and later
    // did click Accept -- the poll's spurious decline had already landed
    // and (per the bridge's own tryRegister) only got silently overwritten
    // back to accepted_and_registered *after* the caller's own
    // pollCallStatus had already exited on the earlier 'declined' and given
    // up polling. Not a multi-tab issue -- reproducible single-tab, every
    // time Accept isn't clicked within the poll interval.
    if (currentIncoming && currentIncoming.channel === incoming.channel) {
      return;
    }
    // Live-reported: after several unanswered rings, EVERY later call to the
    // same recipient started getting auto-declined immediately, forever --
    // not a multi-tab issue, single browser. Root cause: the busy-branch
    // below trusts `currentIncoming` to accurately mean "a call is still
    // genuinely showing," but the only thing that ever clears it (besides
    // Accept/Decline) is the 45s setTimeout in currentIncomingTimer below --
    // and setTimeout in a backgrounded/throttled tab (browsers routinely
    // clamp background timers, sometimes indefinitely) can simply never
    // fire. Once that happens, currentIncoming is permanently stuck
    // pointing at a long-dead call, and every subsequent real incoming call
    // -- to that recipient, in that one tab -- silently hits the busy
    // branch and gets declined, with no way to recover short of reloading
    // the tab. Self-heal instead of trusting the timer alone: if the
    // currently-shown call is already older than its own timeout would
    // have allowed, it's stale by definition (its own timer should have
    // already fired) -- clear it and treat this delivery as a fresh call,
    // not a busy-decline.
    if (currentIncoming && Date.now() - currentIncoming.receivedAt > INCOMING_CARD_TIMEOUT_MS) {
      clearIncoming();
    }
    // CADS-webconference-demo#39 (finding 3): a second, genuinely different
    // incoming call while one is already showing used to just be dropped
    // here -- no /decline, so that second caller kept ringing (from their
    // own side) for the full 60s bridge CALL_TTL with no indication
    // anything had happened on this end at all. Declining it explicitly
    // gives them the same prompt "not available" feedback a real busy line
    // would.
    if (currentIncoming) {
      api('/decline', { body: { channel: incoming.channel } }).catch(() => {});
      return;
    }
    currentIncoming = { ...incoming, receivedAt: Date.now() };
    incomingFrom.textContent = incoming.fromEmail;
    incomingCard.hidden = false;
    // CADS-webconference-demo#55/#56: a real incoming call is exactly the
    // moment a notification/sound matters most -- notifyIfHidden itself
    // no-ops if the tab is already visible+focused (you're already looking
    // at the ringing card).
    notifyIfHidden('Incoming call', `${incoming.fromEmail} is calling…`);
    playIncomingCallSound();
    currentIncomingTimer = setTimeout(() => {
      // CADS-webconference-demo#39 (finding 4): this only ever cleared
      // local state -- the bridge/caller had no idea this side gave up,
      // and kept the channel "ringing" until its own 60s CALL_TTL expired
      // 15s later. Declining here tells the caller immediately instead of
      // leaving them hanging for that extra window.
      api('/decline', { body: { channel: incoming.channel } }).catch(() => {});
      clearIncoming();
      setCallNote('warn', `${incoming.fromEmail}'s call is no longer available (it expired).`);
    }, INCOMING_CARD_TIMEOUT_MS);
  }

  // Primary path: a push over a WebSocket to the bridge, so the incoming-call
  // card appears the instant a call comes in instead of on the next poll
  // tick. The poll below is kept running regardless as a fallback -- if this
  // socket never connects, drops, or reconnection logic has a gap, the
  // callee still sees the call within one poll interval, just not instantly.
  // Exponential backoff with jitter, capped at 30s -- a fixed 3s retry would
  // hammer the bridge with reconnect attempts from every open tab if it's
  // down for a while, and have every disconnected tab retry in lockstep.
  // Resets to 0 on a successful connection. The /api/incoming poll below
  // still covers for this socket being down the whole time regardless.
  // CADS-webconference-demo#38 (finding 2): previously unbounded -- an
  // abandoned background tab would reconnect every ~30s forever. Once
  // MAX_INCOMING_SOCKET_ATTEMPTS is hit, this stops retrying automatically
  // and shows #presence-lost-banner with a manual Reconnect button instead
  // -- the /api/incoming poll fallback (below) keeps covering incoming
  // calls regardless, so giving up here loses only the instant WS push,
  // never the calls themselves.
  // CADS-webconference-demo#65: live-diagnosed (real account, real login,
  // corroborated independently by an automated harness the same day) a
  // /api/ws upgrade that gets redirected (302, not 101) specifically in the
  // window right after a fresh gate login completes, even though regular
  // /api/* calls succeed the whole time -- a session-propagation race in
  // the gate's WS-upgrade auth check, confirmed (by reading bridge/server.js's
  // upgrade handler) to originate before the request ever reaches this
  // bridge. 10 attempts * up to 30s backoff (~a couple minutes total) wasn't
  // always enough to outlast it on a slower link. Raised to 20/60s (same cap
  // pollEvery already uses elsewhere) purely to give the race more time to
  // resolve on its own -- doesn't change anything about the successful case,
  // strictly a longer runway before giving up.
  const MAX_INCOMING_SOCKET_ATTEMPTS = 20;
  let incomingSocketAttempt = 0;
  const presenceLostBanner = document.getElementById('presence-lost-banner');
  // Live-reported: on mobile (screen lock in particular), the OS can kill the
  // underlying connection without the WebSocket ever firing its own 'close'
  // event -- a "zombie" socket that still reports readyState OPEN from JS's
  // perspective. The reconnect chain below only ever runs off a real 'close',
  // so a zombie socket never triggers it: nothing recovers until a manual
  // reload. incomingSocket/incomingSocketGeneration let the visibilitychange
  // handler below unconditionally supersede whatever socket currently exists
  // the moment the tab is foregrounded again, without needing to trust
  // readyState (unreliable for exactly this case) -- the generation counter
  // makes the old (possibly zombie) socket's eventual close a no-op instead
  // of double-triggering handleIncomingSocketClose for a socket that was
  // deliberately replaced, not one that failed on its own.
  let incomingSocket = null;
  let incomingSocketGeneration = 0;
  function connectIncomingSocket() {
    if (presenceLostBanner) presenceLostBanner.hidden = true;
    const myGeneration = ++incomingSocketGeneration;
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${wsProto}//${location.host}/api/ws?email=${encodeURIComponent(identity.email)}`);
    incomingSocket = sock;
    sock.addEventListener('open', () => {
      if (incomingSocketAttempt > 0) log(`presence socket reconnected (after ${incomingSocketAttempt} attempt(s))`);
      incomingSocketAttempt = 0;
    });
    sock.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'incoming') showIncoming(msg);
        else if (msg.type === 'cancelled' && currentIncoming?.channel === msg.channel) {
          const fromEmail = currentIncoming.fromEmail;
          clearIncoming();
          setCallNote('info', `${fromEmail} cancelled the call.`);
        }
      } catch (_) {}
    });
    sock.addEventListener('close', (ev) => {
      if (myGeneration !== incomingSocketGeneration) return; // superseded (e.g. by visibility-return) -- not a real failure
      handleIncomingSocketClose(ev.code);
    });
    sock.addEventListener('error', () => sock.close());
  }
  // Factored out of the 'close' listener above so the cap/banner decision
  // (pure bookkeeping, no real socket needed) can be exercised directly --
  // this is exactly what the real listener calls, not a parallel copy.
  function handleIncomingSocketClose(code) {
    // CADS-webconference-demo#72: the WS upgrade reject path (bridge's
    // server.on('upgrade')) can't carry code:'identity_mismatch' at all --
    // it's a raw socket.destroy(), no HTTP response body to put it in (see
    // cc6aae5's rejection logging, which is what surfaces this server-side
    // instead). So this loop can never detect a mismatch from its OWN
    // transport; it has to defer to the HTTP pollers' identityMismatchDetected
    // flag. Without this check it would keep reconnecting -> rejected ->
    // backoff -> reconnect for up to MAX_INCOMING_SOCKET_ATTEMPTS, each one
    // logging a doomed rejection server-side, then show #presence-lost-banner
    // on top of the already-sticky #identity-mismatch-banner -- both wrong:
    // more reconnects can't help, and a second banner would contradict the
    // "reload, not reconnect" guidance the mismatch banner already gives.
    if (identityMismatchDetected) return;
    incomingSocketAttempt++;
    if (incomingSocketAttempt > MAX_INCOMING_SOCKET_ATTEMPTS) {
      log(`presence socket closed (code ${code}); giving up after ${incomingSocketAttempt - 1} attempts -- incoming calls still arrive via polling, click Reconnect to restore the instant push`);
      if (presenceLostBanner) presenceLostBanner.hidden = false;
      return;
    }
    const base = Math.min(1000 * 2 ** incomingSocketAttempt, 60000);
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    log(`presence socket closed (code ${code}); reconnecting in ~${Math.round(delay / 1000)}s (attempt ${incomingSocketAttempt})`);
    setTimeout(connectIncomingSocket, delay);
  }
  connectIncomingSocket();
  // Live-reported: mobile screen lock (or the tab simply being backgrounded
  // long enough for the OS to freeze it) reliably kills connectIncomingSocket's
  // WS in a way that never fires 'close' -- see the comment on
  // incomingSocket/incomingSocketGeneration above. Unlike that dead socket,
  // this listener itself keeps firing: 'visibilitychange' is delivered
  // immediately on foreground even for a tab whose other timers were frozen
  // the whole time it was hidden. identityMismatchDetected is checked first
  // for the same reason handleIncomingSocketClose checks it -- a mismatch
  // needs a real reload (a fresh /api/whoami), not another socket, and this
  // must not fight that banner's own already-scheduled auto-reload.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || identityMismatchDetected) return;
    incomingSocketAttempt = 0;
    incomingSocket?.close();
    connectIncomingSocket();
  });
  // CADS-webconference-demo#65: an in-page retry (just calling
  // connectIncomingSocket() again) never re-runs the initial gate/session
  // handshake a fresh top-level navigation does, so it can't help if the
  // race is specifically in that handshake's propagation -- a full reload
  // at least gives it a fresh shot at the same window that (usually,
  // not provably always -- one live report still saw the banner survive a
  // reload) succeeds. The manual button only fires on an explicit click from
  // someone already looking at "connection lost", who would reload manually
  // next anyway -- doing it for them here can only help or be a no-op, never
  // a surprise mid-task the way an automatic reload without a click would be.
  document.getElementById('presence-reconnect-btn')?.addEventListener('click', () => {
    location.reload();
  });

  // Fallback poll -- unchanged base cadence, stays as the safety net described above.
  // CADS-webconference-demo#65 (automated-review refinement): a successful
  // round-trip here proves the SAME bridge the presence WS gave up on is
  // reachable again -- exactly the signal #presence-lost-banner's manual
  // Reconnect click is standing in for. Auto re-arm the instant-push socket
  // on that signal instead of waiting for the user to notice and click;
  // still bounded by this poll's own 3s cadence (not a blind faster timer),
  // so it can't retry the bridge any harder than the fallback poll already
  // does on its own.
  pollEvery(() => api(`/incoming?email=${encodeURIComponent(identity.email)}`).then((r) => {
    if (r.error) return;
    if (r.incoming) showIncoming(r.incoming);
    if (presenceLostBanner && !presenceLostBanner.hidden) {
      incomingSocketAttempt = 0;
      connectIncomingSocket();
    }
  }).catch(() => {}), 3000);

  refreshContacts();
  pollEvery(refreshContacts, 5000);

  // CADS-webconference-demo#87/#88: cross-device delta sync -- see
  // syncNow's own header comment. 20s cadence: heavier than a presence
  // poll (pushes/pulls real content, not just an online flag), lighter
  // than something a user would notice lagging for a background
  // reconciliation between their own devices.
  syncNow().catch(() => {});
  pollEvery(() => syncNow().catch(() => {}), 20000);

  // Catches the case the compose-time trigger can't: a message queued
  // while the peer was offline, delivered once they come back -- without
  // this, "compose any time, it goes out once you're both connected" would
  // only ever be true if you happened to compose AFTER they reconnected.
  pollEvery(() => {
    for (const email of myContacts.all()) tryBackgroundDeliver(identity, email);
  }, 10000);

  // Someone added ME as a contact -- merge into the same Requests list
  // showIncoming's privacy-gate already populates (see its "Wants to be
  // added to your contacts" copy, which was already the right shape for
  // this). Blocked senders never show up (server has no notion of my block
  // list, so filter client-side, same as showIncoming's own check).
  // CADS-webconference-demo#47: this had no immediate call before starting
  // the interval -- every other poll in this function (refreshContacts,
  // refreshAccessRequests) explicitly calls once immediately, THEN starts
  // its interval, specifically so state that already exists by page-load
  // time (e.g. someone added you moments before you opened the app) shows
  // up right away instead of waiting a full interval. This is also the
  // ONLY notification path for a contact request at all -- unlike
  // /api/incoming, which has connectIncomingSocket's WS push as the real
  // primary path and this poll as just its fallback -- so the missing
  // immediate call mattered more here: a request sent just before the
  // recipient's page finished loading waited a full 4s (reported live as
  // "no request appeared within 5s", plausibly landing right at that edge
  // once real network latency is added).
  function pollContactRequests() {
    api(`/contact-requests?email=${encodeURIComponent(identity.email)}`).then((r) => {
      for (const { fromEmail } of r.requests || []) {
        const email = fromEmail.toLowerCase();
        if (blockedEmails.has(email) || myContacts.has(email)) continue;
        if (!pendingRequests.some((p) => p.email === email)) {
          pendingRequests.push({ email });
          renderRequests();
        }
      }
    }).catch(() => {});
  }
  pollContactRequests();
  pollEvery(pollContactRequests, 4000);

  btnDecline.addEventListener('click', () => {
    const declined = currentIncoming;
    clearIncoming();
    if (declined) api('/decline', { body: { channel: declined.channel } }).catch(() => {});
  });
  btnAccept.addEventListener('click', async () => {
    const incoming = currentIncoming;
    if (!incoming) return;
    // Clear immediately -- not just hiding the card -- so a failed or expired
    // accept doesn't leave currentIncoming permanently set, which would
    // otherwise silently swallow every subsequent incoming call forever
    // (showIncoming() bails out early whenever currentIncoming is non-null).
    clearIncoming();
    setCallNote('info', `Connecting to ${incoming.fromEmail}…`);
    const attestation = computeAttestation(incoming.channel, identity.holderPriv, identity.holderPub, identity.noisePub);
    const attestResp = await api('/attest', {
      body: { channel: incoming.channel, role: 'callee', holderPub: identity.holderPub, noisePub: identity.noisePub, attestation },
    });
    if (attestResp.error) {
      setCallNote('warn', `Couldn't accept ${incoming.fromEmail}'s call: ${attestResp.error}`);
      return;
    }
    await pollCallStatus(incoming.channel, {
      timeoutMs: 10000, // just waiting on the registration round-trip, not on a human
      onDone: (ok, status) => {
        if (ok) {
          startCallFromIdentity(identity, { role: 'callee', channel: incoming.channel, grant: incoming.grant, ws: incoming.ws, transport: incoming.transport, peerEmail: incoming.fromEmail });
        } else {
          setCallNote('warn', status.state === 'pending_core_credential'
            ? `Couldn't complete channel registration: ${status.detail || 'unknown reason'}`
            : 'The call could not be established.');
        }
      },
    });
  });
}

// CADS-webconference-demo#101 follow-up (live-reported): once the login
// gate stopped covering static asset serving, a genuinely-unauthenticated
// visitor on a gated tunnel reaches this screen and its /api/whoami check
// -- which the gate still denies with a redirect to the (cross-origin)
// Keycloak login page. A plain fetch() auto-follows that redirect, and this
// app's own CSP (connect-src 'self') then blocks the resulting cross-origin
// request outright, so the fetch throws a raw "Failed to fetch" that landed
// on the id-verify-error panel forever (its own Retry button can never
// succeed, since the same redirect fires every time). redirect:'manual'
// stops the browser from ever issuing that second, CSP-blocked request --
// a denied gate check now resolves to response.type === 'opaqueredirect'
// (no exception, no cross-origin request attempted at all).
//
// CADS-webconference-demo#101 second follow-up (live-reported): an
// opaqueredirect is NOT the same thing as a real {email:null} JSON body,
// and treating them identically (this function's first version) was itself
// a bug -- {email:null} genuinely means the tunnel doesn't enforce login at
// all, so free-text e-mail entry works end-to-end. An opaqueredirect means
// the tunnel DOES enforce login and this visitor just isn't authenticated
// -- /api/* and /ws/channel (see Caddyfile's @gated matcher) stay gated
// regardless, so routing that case into the SAME free-text flow let
// someone "go online" with a typed e-mail and then hit the exact same
// CSP-blocked-redirect wall on every subsequent call (register, presence
// socket, pairing) -- confusing, half-working, not a real fix. `gateDenied`
// distinguishes the two so the caller can send a gate-denied visitor to a
// real login prompt instead. A genuine network failure (DNS, connection
// refused, server down) still throws in the catch below and keeps showing
// the id-verify-error panel, unchanged from before.
async function checkGateIdentity() {
  try {
    const resp = await fetch('/api/whoami', { redirect: 'manual' });
    if (resp.type === 'opaqueredirect') return { email: null, gateDenied: true };
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok && !body.error) body.error = `http ${resp.status}`;
    return body;
  } catch (e) {
    return { error: `network error: ${e.message || e}` };
  }
}

async function runIdentityScreen() {
  await init('./pkg/ct_agent_wasm_bg.wasm');
  showSetupScreen();

  // CADS-Tunnel#214: a verified login-gate identity (X-Gate-Email, forwarded
  // by the origin's Caddyfile from the control-plane's /gate/check) always
  // wins over free-text entry or a stale localStorage identity -- otherwise
  // a gate-authenticated user could still go online as anyone they type in.
  // A genuine {email: null, gateDenied: undefined} response means the
  // tunnel isn't gated (or the gate isn't enforcing yet), not an error --
  // falls through to the existing free-text flow below, same as always.
  // {email: null, gateDenied: true} is the other, DIFFERENT "no email"
  // case -- the tunnel IS enforcing login and this visitor just isn't
  // authenticated -- routed to a real login prompt instead, see below.
  //
  // CADS-webconference-demo#32: api() never actually rejects (it catches
  // fetch failures internally and resolves to {error: '...'} instead), so
  // the `.catch(() => ({email: null}))` this used to have was dead code --
  // a genuine network failure reaching /whoami still resolved successfully
  // to {error: '...'}, destructured to verifiedEmail === undefined, and
  // fell through to this SAME unverified path silently. That's exactly
  // backwards: "couldn't determine whether there's a gate identity" was
  // being treated identically to "determined there isn't one," letting a
  // flaky network silently downgrade a real gate-verified user to a stale
  // local identity that may not even match their gate session, with the UI
  // presenting the dialer as if nothing were wrong. Now stops and asks for
  // an explicit retry instead of guessing.
  const whoamiResp = await checkGateIdentity();
  if (whoamiResp.error) {
    idEntry.hidden = true;
    idVerifyErrorDetail.textContent = whoamiResp.error;
    idVerifyError.hidden = false;
    // Reload rather than re-running this function's own setup in place --
    // avoids re-registering the idForm submit listener a second time (and
    // a third, on the retry after that...) for what's meant to be a rare
    // recovery path, not a common one worth building real re-entrant state
    // management for.
    idVerifyRetry.addEventListener('click', () => location.reload());
    return;
  }
  if (whoamiResp.gateDenied) {
    idEntry.hidden = true;
    idGateRequired.hidden = false;
    idGateLoginBtn.onclick = () => {
      location.href = `https://bunsenbrenner.org/gate/start?host=${encodeURIComponent(location.host)}&return=${encodeURIComponent(location.pathname)}`;
    };
    return;
  }
  const verifiedEmail = whoamiResp.email;
  if (verifiedEmail) {
    const identity = await loadOrPairIdentity(verifiedEmail);
    await runDialer(identity, { verified: true });
    return;
  }

  // If any identity already exists in this browser, use the most recently
  // used one automatically instead of asking again.
  const existingKeys = Object.keys(localStorage).filter((k) => k.startsWith('ct-webconference-identity:'));
  if (existingKeys.length > 0) {
    let identity = null;
    try {
      identity = JSON.parse(localStorage.getItem(existingKeys[existingKeys.length - 1]));
    } catch (e) {
      // CADS-webconference-demo#32: corrupted/tampered localStorage used to
      // throw here uncaught, crashing the whole setup screen (blank page,
      // no recovery). Drop the corrupted entry and fall through to a fresh
      // id-entry form instead.
      log(`stored identity was corrupted, ignoring it: ${e.message}`);
      localStorage.removeItem(existingKeys[existingKeys.length - 1]);
    }
    if (identity) {
      await runDialer(identity);
      return;
    }
  }

  idForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = idEmailInput.value.trim().toLowerCase();
    if (!email) return;
    // CADS-webconference-demo#40 (finding 4) -- see isValidEmail's own
    // comment. This is the identity that ends up keying localStorage/
    // IndexedDB for everything else in the app, so it's worth an explicit
    // check even beyond the input's own type="email".
    if (!isValidEmail(email)) {
      idEmailInput.reportValidity();
      return;
    }
    const identity = await loadOrPairIdentity(email);
    await runDialer(identity);
  });
}

export {
  runDialer,
  runIdentityScreen,
};
