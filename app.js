// The video-conferencing browser demo page's client logic: a real browser tab
// joining an Agent-Fabric channel over ws_channel.rs, running a real Noise_IK
// handshake, and using encrypted WebRTC signaling (crates/agent-wasm's
// SignalMessage) to drive a real RTCPeerConnection. This mirrors exactly the
// sequence proved end-to-end (against the real ct-edge binary) by
// scripts/e2e-video-call -- the same primitives, driven by real browser APIs
// (WebSocket, RTCPeerConnection, getUserMedia) instead of a Node.js test
// double for the WebSocket transport and no WebRTC stack at all.
//
// Configured entirely via URL query params (no build step, no bundler, matching
// this repo's other examples/*):
//   ws          the ws_channel.rs WebSocket URL (e.g. wss://host/ws/channel)
//   grant       this peer's hex-encoded SignedChannelGrant (ct-video-call-grant)
//   holderPriv  this peer's holder private key hex
//   noisePriv   this peer's Noise static private key hex
//   role        "caller" (Noise initiator, sends the SDP offer) or "callee"
//               (Noise responder, sends the SDP answer)
//
// Chat is a second, separate real WebRTC data channel ('chat') alongside the
// media tracks -- end-to-end DTLS-encrypted the same as the audio/video, not a
// simulation layered on top.

import init, * as wasm from './pkg/ct_agent_wasm.js';
import { ChatStore } from './chatStore.js';
import {
  MAX_FILE_BYTES,
} from './call-protocol.js';
import {
  setupScreen, callScreen, btnMic, btnCam, btnHangup,
  routeYou, routeSignal,
  idEntry, idVerifyError, idVerifyErrorDetail, idVerifyRetry,
  dialForm, logoutLink, contactsList,
  accessRemoveForm, accessRemoveEmail, accessNote, accessRemoveConsoleLink,
  videoGrid, localTile, btnSwitchCamera, btnVideoFilters, filterMenu, msgMenuToggle,
  msgMenu, msgSearchForm, msgSearchInput, msgBackBtn,
  msgCallBtn, msgBlockBtn, msgComposeForm, msgComposeInput, msgAttachBtn, msgAttachInput,
  convName, convRenameBtn, onlyContactsToggle,
  tabChats, tabRequests, requestsList,
  sanitizeErrorMessage, isValidEmail,
  log, setStatus, showConnecting,
  hideConnecting, setCtlLabel, showSetupScreen, showCallScreen,
} from './ui-dom.js';
import {
  forgetIdentityKeys,
  loadOrCreateIdentity,
} from './identity.js';
import {
  pairingKeyPair,
  pairingSharedKey,
  pairingEncrypt,
} from './pairing.js';
import {
  writeFramed,
  readFramed,
  joinChannel,
} from './call-transport-shared.js';
import { keycloakAdminConsoleLink } from './access-requests.js';
import {
  renderBlockedList,
  currentConversationEmail,
  openConversation,
  formatFileSize,
  appendConvMessage,
  closeConversation,
} from './messenger-ui.js';
import {
  tryBackgroundDeliver,
  dialerChatStore,
} from './chat-glue.js';
import { runIdentityScreen } from './dialer.js';
import { switchCamera } from './camera.js';
import { selectFilterStyle, toggleFilterMenu, closeFilterMenu, stopVideoFilterCompositor } from './video-filters.js';
import { runChannelMediaCall } from './call-channel.js';
import { runWebrtcMediaCall } from './call-webrtc.js';
import {
  setCallNote,
  api,
  startCallFromIdentity,
  myContacts,
  myNames,
  blockedEmails,
  onlyAcceptFromContacts,
  myEmail,
  myIdentity,
  refreshContacts,
  setOnlyAcceptFromContacts,
} from './contacts.js';

// CADS-webconference-demo#38 (finding 6): a closed tab/navigation away from
// an active call previously sent no 'bye' at all -- the peer only learned
// via the heartbeat timeout (35s) or ICE 'failed'. Best-effort, not a
// replacement for either: 'pagehide' fires for tab close/navigation/mobile
// suspend (unlike 'beforeunload', which is unreliable and increasingly
// blocked), but a send during pagehide teardown isn't guaranteed to flush
// before the page is gone. For the common graceful-close case it usually
// does, and the peer learns ~instantly instead of waiting out the
// heartbeat; for the hard cases (crash, kill, dropped network) no bye was
// ever going to fly regardless, and the heartbeat/ICE-failed paths (#19,
// with an active ICE-restart attempt) remain the reliable fallback,
// unchanged. Deliberately NOT navigator.sendBeacon -- that's HTTP-only, and
// there is no HTTP path from this client to the peer's media transport (the
// WASM agent connects straight to the edge's ws_channel; the bridge isn't
// in the media path) -- it could only ever reach the bridge, not the peer.
// Set when either transport's call setup completes, cleared at the single
// choke point every termination path already funnels through
// (returnToDialerAfterHangup) so a later pagehide never fires a stale bye
// against an already-torn-down connection.
// CADS-webconference-demo#91: exported with a setter -- both this module's
// own webrtc call setup AND call-channel.js's runChannelMediaCall assign
// this (see the cycle 9 lesson: a variable reassigned from code that isn't
// moving with it needs a setter, not a plain live-binding import, since an
// imported binding is read-only from the importing module's side).
let activeCallBye = null;
function setActiveCallBye(v) { activeCallBye = v; }
window.addEventListener('pagehide', () => {
  // Best-effort: onHangup's own close calls are normally reached only via
  // a real button click, where the underlying connection is expected to
  // still be healthy. Fired here instead during page teardown, where the
  // browser may already be proactively tearing down resources before this
  // handler finishes -- swallow rather than let a mid-teardown exception
  // abort whatever cleanup steps were still going to run after it.
  try {
    if (activeCallBye) activeCallBye();
  } catch (e) {}
});

// Live-reported: mobile screen lock/backgrounding can bfcache-freeze this
// page instead of destroying it -- pagehide above already ran (and sent a
// 'bye', so the call is genuinely over from the peer's side), but nothing
// resets THIS page's own UI: a bfcache restore resumes execution from
// exactly the frozen DOM snapshot it suspended with, so if call-screen was
// showing when suspended, it's still showing now, with a dead/frozen
// underlying connection -- looks stuck on the call dialog (on mobile: a
// frozen local-camera frame with no working remote video/overlay) instead
// of back at the messenger shell, and nothing the user does short of a
// manual reload gets them out of it. Scoped to persisted restores while
// call-screen is actually visible: a fresh navigation (persisted=false)
// already runs the normal startup path correctly, and a bfcache restore
// back to the messenger shell (not in a call when suspended) has nothing
// broken to recover from -- its pollers/sockets are already covered by the
// visibilitychange handler elsewhere in this file. A full reload is the
// same guaranteed-correct recovery already used for identity-mismatch/
// presence-lost: there's no live call left to preserve, pagehide already
// ended it.
window.addEventListener('pageshow', (ev) => {
  if (ev.persisted && !callScreen.hidden) location.reload();
});

function setupControls(media, onHangup) {
  let micOn = true;
  let camOn = true;
  // CADS-webconference-demo#67: property assignment, not addEventListener --
  // a webrtc->channel transport fallback mid-call (attemptChannelFallback)
  // calls runChannelMediaCall, which calls this a SECOND time for the same
  // call. addEventListener would have stacked a second listener per button
  // on top of the first (double-fired Hang Up, double-toggled mic/cam,
  // and -- worse -- the stale first onHangup closure closing over the
  // now-reused signaling `stream` out from under the fallback's own call).
  // Direct property assignment fully replaces the prior handler instead,
  // making a second setupControls() call for the same call safe by
  // construction, with no behavior change for the single-call case.
  btnMic.onclick = () => {
    if (media.kind !== 'media') return;
    micOn = !micOn;
    for (const t of media.stream.getAudioTracks()) t.enabled = micOn;
    setCtlLabel(btnMic, micOn ? '🎤' : '🔇', micOn ? 'Mute' : 'Unmute');
    btnMic.dataset.off = micOn ? '0' : '1';
    // CADS-webconference-demo#97 (live-reported, GUI-coverage test): the
    // label text/icon already changed on click, but nothing exposed the
    // toggle state to assistive tech -- aria-pressed mirrors dataset.off
    // (true once the mic is muted, the button's "engaged" state).
    btnMic.setAttribute('aria-pressed', String(!micOn));
  };
  btnCam.onclick = () => {
    if (media.kind !== 'media') return;
    camOn = !camOn;
    for (const t of media.stream.getVideoTracks()) t.enabled = camOn;
    setCtlLabel(btnCam, '📷', camOn ? 'Camera off' : 'Camera on');
    btnCam.dataset.off = camOn ? '0' : '1';
    // CADS-webconference-demo#98: same fix as #97 above, mirrored for the
    // camera toggle -- aria-pressed true once the camera is switched off.
    btnCam.setAttribute('aria-pressed', String(!camOn));
  };
  btnSwitchCamera.onclick = () => switchCamera(media);
  // CADS-webconference-demo#95: opens the filter-picker menu instead of
  // cycling styles directly -- filterMenu.onclick (item selection) and
  // document.onclick (outside-click-to-close) are both property
  // assignments too, same "setupControls may run twice" reasoning as
  // every other handler here.
  btnVideoFilters.onclick = () => toggleFilterMenu(media);
  filterMenu.onclick = (ev) => {
    const item = ev.target.closest('.filter-menu-item');
    if (!item || item.disabled) return;
    selectFilterStyle(media, item.dataset.style || null);
    closeFilterMenu();
  };
  document.onclick = (ev) => {
    if (!filterMenu.hidden && !filterMenu.contains(ev.target) && !btnVideoFilters.contains(ev.target)) {
      closeFilterMenu();
    }
  };
  btnHangup.onclick = () => {
    try { onHangup(); } catch {}
    setStatus('you-hung-up');
    for (const t of (media.kind === 'media' ? media.stream.getTracks() : [])) t.stop();
    closeFilterMenu();
    returnToDialerAfterHangup();
  };
}

// Neither a local hang-up nor a received 'bye' used to navigate anywhere --
// the call screen just sat there with a status label changed underneath it,
// with no way back to the dialer short of manually editing the URL. Strips
// the call's query params (ws/grant/holderPriv/noisePriv/role/transport) and
// reloads into a clean setup screen, after a short pause so the "you hung
// up"/"peer hung up" status is actually visible first.
function returnToDialerAfterHangup(delayMs = 1200) {
  // CADS-webconference-demo#38 (finding 6): every termination path (local
  // hangup, peer bye, peer-loss, bad frame) funnels through here -- the
  // single choke point to clear activeCallBye so a later pagehide never
  // fires a stale bye against a connection that's already torn down.
  activeCallBye = null;
  // Video filters (if ever enabled this call) hold a live rAF loop, a
  // detection setInterval, AND the original raw camera track detached from
  // media.stream (swapped out in favor of the canvas-capture track) -- none
  // of which the reload below implicitly cleans up fast enough to stop the
  // camera's in-use indicator right away. Same choke-point reasoning as
  // activeCallBye just above: every termination path funnels through here.
  stopVideoFilterCompositor();
  setTimeout(() => {
    location.href = location.pathname;
  }, delayMs);
}
// CADS-webconference-demo#91: exported (read-only, live-binding functions
// -- see camera.js's header comment for the same circular-import stopgap
// pattern) so call-channel.js's runChannelMediaCall can reach them; both
// stay owned by app.js since they're shared plumbing between transports
// (setupControls references switchCamera/the filter menu/btnHangup;
// returnToDialerAfterHangup is the single termination choke point every
// transport funnels through). To be repointed once call-webrtc.js exists
// and this shared plumbing finds a permanent, non-app.js home.
export { setupControls, returnToDialerAfterHangup, setActiveCallBye };

// ============ Directory / dialer (email-based calling, no manual grant needed) ============
// See bridge/server.js's header comment for the full design and the one gated
// step (control-plane channel registration -- CADS-Tunnel#214). This section
// generates real key material locally, computes a real per-channel Noise-key
// attestation (matching ct_common::channel::member_noise_attest_bytes byte
// for byte), and talks to the bridge only in public keys / signatures.

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
logoutLink.addEventListener('click', async (ev) => {
  ev.preventDefault();
  // A third piece, found by testing the full flow end-to-end: even once
  // both server-side sessions are genuinely gone (confirmed -- /api/whoami
  // correctly stops returning an email), runIdentityScreen()'s own
  // localStorage fallback ("if any identity already exists in this
  // browser, use the most recently used one automatically") silently
  // reuses the just-logged-out identity on the next visit instead of
  // prompting fresh. Clear it here too, or the other two fixes are moot.
  forgetIdentityKeys(myEmail);
  try {
    await fetch('https://bunsenbrenner.org/gate/logout?host=bunsenbrenner.org', {
      credentials: 'include',
      mode: 'no-cors',
    });
  } catch (_) {}
  location.href = 'https://bunsenbrenner.org/portal/logout';
});

// CADS-webconference-demo#42: purges just this identity's local keys (and,
// as a consequence, its own chat history -- see forgetIdentityKeys' own
// comment) WITHOUT ending the Keycloak/gate session the way logout does.
// Reloading afterward is deliberate rather than trying to hand-reset every
// piece of in-memory state (contacts, chatStore, open sockets, ...) --
// run()'s normal bootstrap already handles "no matching identity in
// localStorage" correctly on a fresh load, so reusing that path is both
// simpler and less error-prone than a manual partial reset.
document.getElementById('forget-identity-btn')?.addEventListener('click', () => {
  if (!confirm(`Forget this identity (${myEmail || 'this browser\'s current identity'})? Its local chat history becomes permanently unreadable here. You'll stay signed in and can create or switch to a different identity.`)) return;
  forgetIdentityKeys(myEmail);
  location.reload();
});

// ALREADY-PAIRED device side: looks up a code the user read off the new
// device, encrypts the CURRENT real identity to that device's ephemeral
// public key, and delivers it. myIdentity is the same global runDialer
// already sets for background delivery's own use.
document.getElementById('pair-device-btn')?.addEventListener('click', async () => {
  const code = (prompt('Enter the pairing code shown on the new device:') || '').trim().toUpperCase();
  if (!code) return;
  try {
    const lookup = await api(`/pair/lookup?code=${encodeURIComponent(code)}`);
    if (lookup.error) {
      alert(`Pairing failed: ${lookup.error}`);
      return;
    }
    const keyPair = await pairingKeyPair();
    const myPubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const sharedKey = await pairingSharedKey(keyPair.privateKey, lookup.tempPubKeyJwk, 'encrypt');
    const { iv, ciphertext } = await pairingEncrypt(sharedKey, myIdentity);
    const resp = await api('/pair/deliver', { body: { code, oldDevicePubKeyJwk: myPubJwk, iv, ciphertext } });
    if (resp.error) {
      alert(`Pairing failed: ${resp.error}`);
      return;
    }
    alert('Paired. The other device should finish connecting within a few seconds.');
  } catch (e) {
    alert(`Pairing failed: ${e.message || e}`);
  }
});

document.getElementById('identity-mismatch-reload-btn')?.addEventListener('click', () => location.reload());

function setAccessNote(kind, text) {
  accessNote.textContent = text;
  accessNote.dataset.kind = kind;
}

accessRemoveForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  // CADS-webconference-demo#40 (finding 1): localSetFor's own add()/has()
  // already lowercase internally, so blockedEmails.add(email) below was
  // never actually bypassable by case alone -- but /allowlist/remove sends
  // this straight to the control plane's own login-allowlist endpoint with
  // no normalization at all, and every OTHER email this codebase touches
  // (identity storage, contacts, block list) is treated case-insensitively.
  // Normalizing here too, consistently.
  const email = accessRemoveEmail.value.trim().toLowerCase();
  if (!email) return;
  if (!isValidEmail(email)) return setAccessNote('error', `"${email}" doesn't look like a valid email address.`);
  accessRemoveConsoleLink.hidden = true;
  setAccessNote('info', `Revoking access for ${email}…`);
  // CADS-webconference-demo#9/#10: no callerEmail to send -- the bridge
  // derives the admin check from X-Gate-Email itself now, same as
  // /api/is-admin (#46) and approve/decline (#41).
  const resp = await api('/allowlist/remove', { body: { email } });
  if (resp.error) return setAccessNote('error', `Couldn't revoke access: ${resp.error}`);
  // Revoking someone's login is also "I don't want to hear from them" --
  // fold in the same local block+remove-from-contacts side effects the
  // conversation-header Block button applies, so the two paths agree.
  blockedEmails.add(email);
  myContacts.remove(email);
  renderBlockedList();
  refreshContacts();
  setAccessNote('ok', `${email} can no longer log in, and has been added to your Blocked list.`);
  accessRemoveConsoleLink.href = keycloakAdminConsoleLink(email);
  accessRemoveConsoleLink.hidden = false;
  accessRemoveEmail.value = '';
});

// Mobile full-screen call view: tapping the small self PiP swaps it with the
// big remote video (pure CSS, see index.html's #video-grid.swapped rules) --
// no-op on desktop, which never applies that class visually.
localTile.addEventListener('click', () => videoGrid.classList.toggle('swapped'));

msgMenuToggle.addEventListener('click', () => { msgMenu.hidden = !msgMenu.hidden; });
document.addEventListener('click', (ev) => {
  if (!msgMenu.hidden && !msgMenu.contains(ev.target) && ev.target !== msgMenuToggle) msgMenu.hidden = true;
});
// Adding a contact IS granting them access (see localSetFor's comment) --
// one action, both effects: /api/allowlist/add (server-side, so they can
// actually log in) and myContacts.add (client-side, so they show up in
// MY list). The allowlist call is best-effort -- report it, but still add
// the contact locally either way, since a duplicate/already-listed email
// isn't a real failure worth blocking on.
msgSearchForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = msgSearchInput.value.trim().toLowerCase();
  if (!email) return;
  // CADS-webconference-demo#40 (finding 4): this input's own type="email"
  // already blocks obviously-malformed values via the browser's native
  // constraint validation before submit even fires -- an explicit check
  // here is defense in depth (doesn't depend on that always firing) using
  // the input's own built-in validity UI rather than a new note element.
  if (!isValidEmail(email)) {
    msgSearchInput.reportValidity();
    return;
  }
  msgSearchInput.value = '';
  myContacts.add(email);
  const resp = await api('/allowlist/add', { body: { email } });
  if (resp.error) log(`allowlist/add for ${email} failed (added as a local contact anyway): ${resp.error}`);
  // Let them know: shows up in THEIR Requests tab next time they poll (see
  // pollContactRequests below), same as any real messenger's "X added you".
  // Best-effort -- a failure here doesn't block adding the contact locally.
  api('/contact-requests', { body: { fromEmail: myEmail, toEmail: email } }).catch(() => {});
  await refreshContacts();
  openConversation(email);
});
msgBackBtn.addEventListener('click', closeConversation);
msgCallBtn.addEventListener('click', () => dialForm.requestSubmit());
// CADS-webconference-demo#54: a real display name, editable per contact --
// local-only (see nameMapFor's own comment), never sent anywhere. prompt()
// is a deliberately minimal editor (pre-filled with the current label or
// the email itself) rather than a custom inline-edit UI, matching this
// app's existing pattern for simple one-off text entry (see the identity
// screen's own free-text form).
convRenameBtn.addEventListener('click', () => {
  if (!currentConversationEmail || !myNames) return;
  const current = myNames.get(currentConversationEmail) || '';
  const next = prompt(`Display name for ${currentConversationEmail}:`, current);
  if (next === null) return; // cancelled
  myNames.set(currentConversationEmail, next);
  convName.textContent = myNames.get(currentConversationEmail) || currentConversationEmail;
  refreshContacts(); // updates the list-pane row's own name
});
msgComposeForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = msgComposeInput.value.trim();
  if (!text || !currentConversationEmail || !dialerChatStore) return;
  msgComposeInput.value = '';
  const seq = await dialerChatStore.nextSeqForSend();
  const recorded = await dialerChatStore.record({ peerEmail: currentConversationEmail, from: 'me', text, seq, pending: true });
  appendConvMessage(recorded);
  refreshContacts(); // updates the list-pane preview text
  if (myIdentity) tryBackgroundDeliver(myIdentity, currentConversationEmail);
});
// CADS-webconference-demo#50: attaching a file goes through the exact
// same pending-record -> outbox -> tryBackgroundDeliver path composing
// text does (see msgComposeForm's own handler just above) -- "offline
// behaves like messages" was the explicit design call here, so a file
// picked while the peer is offline queues and delivers automatically once
// they're back, same guarantee text already has.
msgAttachBtn.addEventListener('click', () => msgAttachInput.click());
msgAttachInput.addEventListener('change', async () => {
  const file = msgAttachInput.files[0];
  msgAttachInput.value = ''; // let the same file be picked again later
  if (!file || !currentConversationEmail || !dialerChatStore) return;
  if (file.size > MAX_FILE_BYTES) {
    setCallNote('warn', `"${file.name}" is ${formatFileSize(file.size)} -- the limit is ${formatFileSize(MAX_FILE_BYTES)}.`);
    return;
  }
  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const seq = await dialerChatStore.nextSeqForSend();
  const recorded = await dialerChatStore.record({
    peerEmail: currentConversationEmail, from: 'me', seq, pending: true,
    kind: 'file', fileName: file.name, fileMimeType: file.type, fileSize: file.size, fileBytes,
  });
  appendConvMessage(recorded);
  refreshContacts();
  if (myIdentity) tryBackgroundDeliver(myIdentity, currentConversationEmail);
});
msgBlockBtn.addEventListener('click', () => {
  if (!currentConversationEmail) return;
  const email = currentConversationEmail;
  blockedEmails.add(email);
  myContacts.remove(email);
  renderBlockedList();
  closeConversation();
  refreshContacts();
});

tabChats.addEventListener('click', () => {
  tabChats.classList.add('active');
  tabRequests.classList.remove('active');
  contactsList.hidden = false;
  requestsList.hidden = true;
});
tabRequests.addEventListener('click', () => {
  tabRequests.classList.add('active');
  tabChats.classList.remove('active');
  contactsList.hidden = true;
  requestsList.hidden = false;
});

onlyContactsToggle.addEventListener('change', () => {
  setOnlyAcceptFromContacts(onlyContactsToggle.checked);
  localStorage.setItem(`ct-webconference-settings:${dialerChatStore.identity.email.toLowerCase()}`, onlyAcceptFromContacts ? '1' : '0');
});

async function run() {
  // CADS-webconference-demo#87: without this, this origin's IndexedDB
  // (chatStore.js's encrypted chat history) sits in the browser's
  // "best-effort" storage bucket -- eligible for eviction under storage
  // pressure for any origin not visited recently, which independently
  // explains losing chat history even in the SAME browser after a long
  // gap. Best-effort and silently ignored on failure/unsupported browsers
  // (the browser may still deny it, e.g. without a user gesture on first
  // visit in some engines) -- this only ever improves retention odds, never
  // required for correctness.
  try { await navigator.storage?.persist?.(); } catch (_) {}
  const params = new URLSearchParams(location.search);
  // CADS-webconference-demo#14: the ?ws= value used to be trusted verbatim
  // from the URL -- a crafted link could point this at an attacker's own
  // WebSocket endpoint, which would then receive this browser's channel-
  // join handshake, including a signature over the "challenge" that
  // endpoint itself gets to choose (holderSign(holderPrivHex, ...) in
  // joinChannel), using the REAL holder private key straight out of the
  // same URL. There's no legitimate case where this should ever differ
  // from this deployment's own channel endpoint -- a grant is minted
  // against THIS deployment's operator key (mintGrants in the bridge), so
  // it's only ever usable against this same host's /ws/channel, whether
  // the link was auto-generated by startCallFromIdentity or hand-built via
  // the CLI's manual-link fallback. Deriving it from location.host instead
  // of trusting the query string closes the redirect entirely rather than
  // just validating it (still keying the "is this a call link at all"
  // check on the param's presence, so an old shared link with a stale/
  // wrong host still just works against THIS host, harmlessly).
  const wsUrl = params.has('ws') ? `wss://${location.host}/ws/channel` : null;
  const grantHex = params.get('grant');
  let holderPrivHex = params.get('holderPriv');
  let noisePrivHex = params.get('noisePriv');
  // CADS-webconference-demo#40 (finding 5): role used to be accepted as
  // whatever string showed up in the URL -- isCaller below just checked
  // `=== 'caller'`, so ANY other value (a typo, a stale/hand-edited link)
  // silently became "callee" instead of failing. Narrowed to the only two
  // real values.
  const roleParam = params.get('role');
  const role = roleParam === 'caller' || roleParam === 'callee' ? roleParam : null;
  const transportMode = params.get('transport') === 'channel' ? 'channel' : 'webrtc';
  // Optional for a manually-built call link, which has no identity to key
  // the chat store to -- chat just isn't persisted for that session, same
  // as always. Unconditional (not just chat-store keying) for every
  // in-app call now -- see the #13 key-recovery block right below.
  // CADS-webconference-demo#40 (finding 3): these come straight from the
  // URL with no shape check -- an invalid value would still key the
  // encrypted chat store's IndexedDB rows under whatever garbage was in the
  // query string. Treated the same as "absent" (chat just isn't persisted)
  // rather than used as-is, same reasoning as the length checks above.
  const myEmailParam = params.get('myEmail');
  const peerEmailParam = params.get('peerEmail');
  const myEmail = isValidEmail(myEmailParam) ? myEmailParam : null;
  const peerEmail = isValidEmail(peerEmailParam) ? peerEmailParam : null;

  if (!wsUrl || !grantHex || !role) {
    await runIdentityScreen();
    return;
  }
  // CADS-webconference-demo#13: holderPriv/noisePriv used to ride in this
  // same URL for every in-app call (startCallFromIdentity's reload) --
  // meaning both private keys sat in browser history and in every proxy/
  // server access log for that page-load GET, for as long as those persist.
  // Neither key ever actually needs to leave the tab: this identity's keys
  // are already sitting in localStorage (loadOrCreateIdentity's own
  // storage, keyed by email) from whenever this identity was first created,
  // long before this call was placed or accepted. myEmail is enough to load
  // them straight back out of there -- loadOrCreateIdentity is idempotent,
  // and this identity necessarily already exists, since it's what placed or
  // accepted the call in the first place. requireExisting: true (#42) --
  // "necessarily already exists" only holds for the SAME browser profile
  // that placed/accepted the call; opening this same URL in a different
  // browser/private window has no such identity, and silently minting a
  // fresh one here would hand the rest of run() keys that don't match what
  // the grant/attestation were actually issued for -- an opaque join
  // failure instead of an honest error about why.
  if ((!holderPrivHex || !noisePrivHex) && myEmail) {
    const identity = loadOrCreateIdentity(myEmail, { requireExisting: true });
    holderPrivHex = identity.holderPriv;
    noisePrivHex = identity.noisePriv;
  }
  // Falls through here for a manually-built/CLI call link, which has no
  // myEmail to recover keys from locally and so still carries them in the
  // URL -- that's a separate, pre-existing sharing mechanism (its whole
  // point is to be pasted somewhere else), not something this pass
  // redesigns; flagged as remaining scope on the issue.
  if (!holderPrivHex || !noisePrivHex) {
    await runIdentityScreen();
    return;
  }
  showCallScreen();
  showConnecting(peerEmail);
  document.getElementById('transport-badge').textContent = transportMode === 'channel' ? 'direct-channel' : 'webrtc';
  document.getElementById('chat-transport-note').textContent =
    transportMode === 'channel' ? '— tunneled through the same Noise_IK channel' : '— over a real WebRTC data channel';

  await init('./pkg/ct_agent_wasm_bg.wasm');

  setStatus('joining');
  routeYou.classList.add('live');
  const { stream, peerNoiseHex } = await joinChannel(wsUrl, grantHex, holderPrivHex);
  if (!peerNoiseHex) throw new Error('no peer Noise key in ack -- peer not registered with a Noise key');

  setStatus('noise-handshake');
  const isCaller = role === 'caller';
  const hs = isCaller ? wasm.NoiseHandshake.newInitiator(noisePrivHex, peerNoiseHex) : wasm.NoiseHandshake.newResponder(noisePrivHex);
  if (isCaller) {
    await writeFramed(stream, hs.writeMessage(new Uint8Array(0)));
    hs.readMessage(await readFramed(stream));
  } else {
    hs.readMessage(await readFramed(stream));
    await writeFramed(stream, hs.writeMessage(new Uint8Array(0)));
  }
  if (!hs.isFinished()) throw new Error('Noise handshake did not finish after 2 messages');
  const noiseTransport = hs.intoTransport();
  log('Noise_IK handshake complete -- signaling channel is now authenticated + encrypted');
  routeSignal.classList.add('live');

  // Only constructed when both emails are known (see startCallFromIdentity) --
  // a manually-built call link has no identity to key the store to, and
  // chat for that session just isn't persisted, same as always.
  const chatStore = myEmail && peerEmail ? new ChatStore({ email: myEmail, holderPriv: holderPrivHex }) : null;

  if (transportMode === 'channel') {
    await runChannelMediaCall(stream, noiseTransport, isCaller, chatStore, peerEmail, wsUrl, grantHex, holderPrivHex, noisePrivHex);
    return;
  }

  await runWebrtcMediaCall(stream, noiseTransport, isCaller, chatStore, peerEmail, wsUrl, grantHex, holderPrivHex, noisePrivHex);
}

run().catch((e) => {
  // See sanitizeErrorMessage's own comment -- log() already sanitizes what
  // it's given, but this is the one place an error can ALSO reach
  // console.error and #status directly, neither of which goes through it.
  const safeMessage = sanitizeErrorMessage(e.message || e);
  console.error('run() failed:', safeMessage);
  setStatus('error: ' + safeMessage);
  log(`error: ${safeMessage}`);
  // CADS-webconference-demo#83: setStatus/log above write into the call
  // screen (#status/#status-text/#status-pill/#log), which stays hidden
  // until a call actually starts -- fine for a failure mid-call (the
  // "Connecting to X…" case the comment below already covers), but useless
  // for a failure on a plain landing visit, where runIdentityScreen's very
  // first line (await init(wasm)) can throw BEFORE showSetupScreen() ever
  // runs. That left the page looking loaded-but-dead: no setup form, no
  // error, nothing but a blank hero and a console line nobody but a
  // developer would see. setupScreen.hidden here is exactly that
  // signature -- reuse the existing #id-verify-error panel (already
  // styled as an error with a working Retry-via-reload button) instead of
  // adding a new element, same "reload to recover" framing #32 and the
  // identity-mismatch banner already use elsewhere.
  if (setupScreen.hidden) {
    setupScreen.hidden = false;
    idEntry.hidden = true;
    idVerifyErrorDetail.textContent = `couldn't start: ${safeMessage}`;
    idVerifyError.hidden = false;
    idVerifyRetry.addEventListener('click', () => location.reload());
  } else {
    // Live-reported ("system frozen" after a mobile connection drop mid-
    // handshake): a failure here (joinChannel/handshake throwing before
    // real peer connectivity was ever reached) used to just hide the
    // "Connecting to X…" spinner and rely on the small #status-text pill
    // at the top of the call screen -- easy to miss entirely on mobile's
    // full-screen call view, leaving "waiting for peer…" sitting on
    // screen with no visible next step. setStatus/log above already show
    // the real error; this now ALSO funnels through the same single
    // termination choke point a normal Hang Up uses
    // (returnToDialerAfterHangup), so the page actually recovers back to
    // a working dialer instead of sitting stuck -- the status-pill error
    // text stays visible for the same ~1.2s delay every other hangup
    // already gives before the reload fires.
    returnToDialerAfterHangup();
  }
  hideConnecting();
});
