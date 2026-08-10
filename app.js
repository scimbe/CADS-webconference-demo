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
  TAG_MEDIA_INIT,
  TAG_MEDIA_CHUNK,
  TAG_CHAT,
  TAG_BYE,
  TAG_FALLBACK,
  MAX_FILE_BYTES,
  NO_CAMERA_SENTINEL,
  NO_CODEC_SENTINEL,
} from './call-protocol.js';
import {
  setupScreen, callScreen, statusEl, iceEl, logEl, statusPill,
  statusText, localVideo, remoteVideo, localEmpty, remoteEmpty, btnMic, btnCam, btnHangup,
  chatLog, chatForm, chatInput, chatSend, routeYou, routeSignal, routeWebrtc, routePeer,
  connectingBanner, connectingBannerText,
  idEntry, idVerifyError, idVerifyErrorDetail, idVerifyRetry,
  dialForm, callNote, logoutLink, contactsList, contactsEmpty,
  accessRemoveForm, accessRemoveEmail, accessNote, accessRemoveConsoleLink,
  accessRequestsBadge, accessRequestsList, accessRequestsEmpty,
  videoGrid, localTile, btnSwitchCamera, btnVideoFilters, msgMenuToggle,
  msgMenu, msgSearchForm, msgSearchInput, msgConvPlaceholder, msgConversation, msgBackBtn,
  msgCallBtn, msgBlockBtn, msgComposeForm, msgComposeInput, msgAttachBtn, msgAttachInput,
  convAvatar, convName, convRenameBtn, convStatus, convMessages, onlyContactsToggle,
  blockedList, blockedEmpty, tabChats, tabRequests, requestsBadge, requestsList, requestsEmpty,
  sanitizeErrorMessage, isValidEmail,
  playMessageSound, log, setStatus, setIceState, showConnecting,
  hideConnecting, addChatMessage, setCtlLabel, showSetupScreen, showCallScreen,
} from './ui-dom.js';
import {
  hexToBytes,
  bytesToHex,
  concatBytes,
  memberNoiseAttestBytes,
  forgetIdentityKeys,
  storageKeyFor,
  loadOrCreateIdentity,
  identityCreatedAt,
} from './identity.js';
import {
  pairingKeyPair,
  pairingSharedKey,
  pairingEncrypt,
} from './pairing.js';
import {
  WsByteStream,
  writeFramed,
  withTimeout,
  readFramed,
  readChallengeOrRefusal,
  joinChannel,
  sendTaggedFrame,
} from './call-transport-shared.js';
import { keycloakAdminConsoleLink } from './access-requests.js';
import {
  formatMsgTime,
  renderBlockedList,
  currentConversationEmail,
  openConversation,
  formatFileSize,
  appendConvMessage,
  markConvMessageDelivered,
  closeConversation,
} from './messenger-ui.js';
import {
  createAckWaiter,
  flushOutbox,
  tryBackgroundDeliver,
  setupChatChannel,
  dialerChatStore,
} from './chat-glue.js';
import { runIdentityScreen } from './dialer.js';
import { getLocalMedia, switchCamera } from './camera.js';
import { cycleVideoFilter, stopVideoFilterCompositor } from './video-filters.js';
import {
  setCallNote,
  noteApiResult,
  api,
  startCallFromIdentity,
  myContacts,
  myNames,
  blockedEmails,
  onlyAcceptFromContacts,
  myEmail,
  myIdentity,
  refreshContacts,
  doRefreshContacts,
  renderContacts,
  apiConsecutiveFailures,
  setOnlyAcceptFromContacts,
} from './contacts.js';

// CADS-webconference-demo#38 (finding 7): switchCamera needs the active
// RTCPeerConnection but is declared outside run()'s closure (it's shared by
// both transports' hangup/control wiring) -- this used to be reached via
// `window.__ctVideoCallDemo.pc`, a live handle any script on the page
// (extension, or an XSS if one ever landed despite the CSP) could use to
// drive the call, decrypt/encrypt arbitrary Noise frames, or inject
// signaling. A module-private variable gives switchCamera the same access
// without handing it to the whole page. Only ever set/cleared from run()'s
// own webrtc branch below.
// CADS-webconference-demo#91: exported (read-only, live binding) so
// camera.js's switchCamera can reach it -- a temporary circular-import
// stopgap until the WebRTC call setup itself moves into its own
// call-webrtc.js module (a later consolidation cycle), at which point this
// export moves there instead and camera.js's import repoints to it.
let activeWebrtcPc = null;
export { activeWebrtcPc };

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
let activeCallBye = null;
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
  };
  btnCam.onclick = () => {
    if (media.kind !== 'media') return;
    camOn = !camOn;
    for (const t of media.stream.getVideoTracks()) t.enabled = camOn;
    setCtlLabel(btnCam, '📷', camOn ? 'Camera off' : 'Camera on');
    btnCam.dataset.off = camOn ? '0' : '1';
  };
  btnSwitchCamera.onclick = () => switchCamera(media);
  btnVideoFilters.onclick = () => cycleVideoFilter(media);
  btnHangup.onclick = () => {
    try { onHangup(); } catch {}
    setStatus('you-hung-up');
    for (const t of (media.kind === 'media' ? media.stream.getTracks() : [])) t.stop();
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

// ============ Direct-channel media transport (experimental alternative to WebRTC) ============
// Tunnels audio/video/chat straight through the already-encrypted Noise_IK
// Agent-Fabric channel instead of negotiating a separate WebRTC/ICE/DTLS-SRTP
// path. No RTCPeerConnection, no STUN/TURN, no SDP -- just a tiny custom
// message envelope (1-byte tag + payload) sent the exact same way signaling
// bytes already travel: writeFramed(stream, noiseTransport.encrypt(bytes)).
// Trade-off, stated plainly: everything is relayed through the edge over one
// WebSocket connection rather than negotiated peer-to-peer, so latency is
// higher and total throughput is capped by that single relayed connection --
// but it needs nothing beyond what channel-join already requires, so it
// works in networks where WebRTC's ICE negotiation can't punch through
// (symmetric NATs, UDP-blocking firewalls) without needing a TURN server.
// CADS-webconference-demo#69: same joinChannel + Noise_IK handshake dance
// run()'s own initial-join sequence does inline (deliberately NOT refactored
// to share this helper -- run()'s version interleaves UI status updates
// (setStatus('noise-handshake') etc.) between the join and handshake steps
// that this helper can't reproduce without changing that already-working
// path's UI timing; a small, safe duplication here beats touching it).
// Used by runChannelMediaCall's reconnect path below to redo the same
// sequence after a transient ws_channel drop. Grants are NOT single-use
// (checked video-call-grant/src/main.rs -- time-bound expires_at, no
// consumed/claimed tracking), and the edge's channel pairer removes a
// channel from its `waiting` map only on
// a successful match, not permanently (crates/edge/src/channel_broker.rs)
// -- a lone member re-joining an already-relayed channel id parks and waits
// for its partner exactly like a first-time join (see that file's own "a
// lone member with no partner parks instead of failing" test), so this is
// architecturally safe to call again mid-call, not just at call setup.
async function establishChannelSession(wsUrl, grantHex, holderPrivHex, noisePrivHex, isCaller) {
  const { stream, peerNoiseHex } = await joinChannel(wsUrl, grantHex, holderPrivHex);
  if (!peerNoiseHex) throw new Error('no peer Noise key in ack -- peer not registered with a Noise key');
  const hs = isCaller ? wasm.NoiseHandshake.newInitiator(noisePrivHex, peerNoiseHex) : wasm.NoiseHandshake.newResponder(noisePrivHex);
  if (isCaller) {
    await writeFramed(stream, hs.writeMessage(new Uint8Array(0)));
    hs.readMessage(await readFramed(stream));
  } else {
    hs.readMessage(await readFramed(stream));
    await writeFramed(stream, hs.writeMessage(new Uint8Array(0)));
  }
  if (!hs.isFinished()) throw new Error('Noise handshake did not finish after 2 messages');
  return { stream, noiseTransport: hs.intoTransport() };
}

async function runChannelMediaCall(byteStream, noiseTransport, isCaller, chatStore, peerEmail, wsUrl, grantHex, holderPrivHex, noisePrivHex) {
  setStatus('connecting-media');
  routeWebrtc.classList.add('live');
  // Real peer-to-peer connectivity for this transport is already up by the
  // time this function is called (the Noise_IK handshake in run() completes
  // first) -- 'connecting-media' above just means chat/video framing isn't
  // wired yet, not that the peer itself isn't there. Confirmed by chat being
  // immediately usable a few lines below ("chat connected") with no further
  // handshake in between.
  hideConnecting();

  if (chatStore && peerEmail) {
    chatStore.history(peerEmail).then((history) => {
      for (const m of history) addChatMessage(m.text, m.from);
    });
    chatStore.onMessage((msg) => {
      if (msg.peerEmail === peerEmail.toLowerCase()) addChatMessage(msg.text, msg.from);
    });
  }

  // CADS-webconference-demo#91: delegates to the shared implementation in
  // call-transport-shared.js (see sendTaggedFrame's own comment -- this was
  // the copy the shared version's catch+log behavior was adopted FROM,
  // originally added for #69's review follow-up).
  function sendTagged(tag, payloadBytes) {
    return sendTaggedFrame(byteStream, noiseTransport, tag, payloadBytes);
  }
  function sendText(tag, text) {
    sendTagged(tag, new TextEncoder().encode(text));
  }

  const mediaSource = new MediaSource();
  remoteVideo.src = URL.createObjectURL(mediaSource);
  let sourceBuffer = null;
  let sourceBufferMimeType = null; // CADS-webconference-demo#78 -- needed to recreate the sourceBuffer below
  const pendingChunks = [];
  // Set once we know the peer's codec can never be played here (e.g. Safari
  // receiving the WebM/VP8/Opus this transport hardcodes -- see
  // NO_CODEC_SENTINEL above). Without this, appendChunk kept pushing every
  // incoming ~200ms media chunk into pendingChunks forever, since a
  // sourceBuffer that's never created also never fires 'updateend' to drain
  // it -- an unbounded, silent memory leak for the rest of the call that
  // eventually exhausts that tab's heap (observed: Safari tab hangs solid,
  // force-quit required, while the rest of the browser stayed fine).
  let mediaUnsupported = false;
  // CADS-webconference-demo#78: previously set permanently on ANY appendBuffer
  // throw and never reset -- turned a QuotaExceededError (a normal, RECOVERABLE
  // resource condition on a long call or a backgrounded/paused receiver, where
  // MSE's own auto-eviction doesn't run) into a permanent "call connected but
  // remote media dead forever" state, and meant a #69 reconnect restored the
  // byte stream but never the render. Now only the true last-resort: quota
  // errors are handled by evicting old buffered data and retrying (below);
  // other append errors get a bounded number of sourceBuffer
  // recreate-and-continue attempts (dropping just the one bad chunk) before
  // this latches. Reset on a successful #69 reconnect (that code's own
  // comment) so recovering the connection also gives the render a fresh
  // chance, not just the byte stream.
  let remoteMediaFatal = false;
  let mediaRecreateAttempts = 0;
  const MAX_MEDIA_RECREATE_ATTEMPTS = 3;
  function handleAppendError(e, failedChunk) {
    if (e.name === 'QuotaExceededError') {
      // Standard MSE pattern for long-lived streams: evict buffered data
      // behind current playback, then retry the same chunk once the evict
      // completes (sourceBuffer.remove() fires the SAME 'updateend' event
      // flushPending already listens on, so no separate wiring needed).
      const canEvict = sourceBuffer.buffered.length > 0 && Math.max(0, remoteVideo.currentTime - 5) > sourceBuffer.buffered.start(0);
      if (canEvict) {
        pendingChunks.unshift(failedChunk);
        try {
          sourceBuffer.remove(sourceBuffer.buffered.start(0), Math.max(0, remoteVideo.currentTime - 5));
          log('remote video buffer quota hit -- evicting old data and retrying (not fatal)');
        } catch (removeErr) {
          pendingChunks.shift(); // eviction itself failed -- undo the unshift rather than leave a duplicate queued forever
          log(`remote video buffer eviction failed: ${removeErr.message}`);
        }
        return;
      }
      // Nothing safe to evict yet (buffer still short) -- fall through to
      // the bounded recreate-retry below rather than spin retrying the same
      // append against a buffer that has nowhere to shrink.
    }
    if (mediaRecreateAttempts < MAX_MEDIA_RECREATE_ATTEMPTS && sourceBufferMimeType) {
      mediaRecreateAttempts++;
      log(`remote video append failed (${e.message}) -- recreating the source buffer and continuing (recovery attempt ${mediaRecreateAttempts}/${MAX_MEDIA_RECREATE_ATTEMPTS}), dropping this one chunk`);
      try {
        mediaSource.removeSourceBuffer(sourceBuffer);
        sourceBuffer = mediaSource.addSourceBuffer(sourceBufferMimeType);
        sourceBuffer.mode = 'sequence';
        sourceBuffer.addEventListener('updateend', flushPending);
        pendingChunks.length = 0; // can't safely replay chunks queued for the OLD sourceBuffer into a fresh one mid-stream
      } catch (recreateErr) {
        remoteMediaFatal = true;
        pendingChunks.length = 0;
        log(`remote video stream failed permanently, recreating the source buffer also failed: ${recreateErr.message}`);
      }
      return;
    }
    remoteMediaFatal = true;
    pendingChunks.length = 0;
    log(`remote video stream failed permanently after ${mediaRecreateAttempts} recovery attempt(s): ${e.message}`);
  }
  function flushPending() {
    if (remoteMediaFatal) { pendingChunks.length = 0; return; }
    if (sourceBuffer && !sourceBuffer.updating && pendingChunks.length) {
      const next = pendingChunks.shift();
      try {
        sourceBuffer.appendBuffer(next);
      } catch (e) {
        handleAppendError(e, next);
      }
    }
  }
  function appendChunk(bytes) {
    if (mediaUnsupported || remoteMediaFatal) return; // can never be played -- drop instead of buffering forever
    if (!sourceBuffer || sourceBuffer.updating) { pendingChunks.push(bytes); return; }
    try {
      sourceBuffer.appendBuffer(bytes);
    } catch (e) {
      handleAppendError(e, bytes);
    }
  }

  chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    if (chatStore && peerEmail) {
      const seq = await chatStore.nextSeqForSend();
      // CADS-webconference-demo#44 -- see the WebRTC-path chatForm handler's
      // matching comment (setupChatChannel) for why: record pending, only
      // mark delivered once the peer's own {ack:seq} actually arrives.
      chatStore.record({ peerEmail, from: 'me', text, seq, pending: true });
      sendText(TAG_CHAT, JSON.stringify({ seq, text }));
      ackWaiter.wait(seq).then(() => chatStore.markDelivered(peerEmail, seq)).catch(() => {});
    } else {
      sendText(TAG_CHAT, JSON.stringify({ text }));
    }
    addChatMessage(text, 'me');
    chatInput.value = '';
  });
  chatInput.disabled = false;
  chatSend.disabled = false;
  addChatMessage('chat connected (tunneled through the Noise_IK channel, no separate data channel)', 'system');
  const ackWaiter = createAckWaiter(); // CADS-webconference-demo#21 -- see createAckWaiter's own comment
  flushOutbox(chatStore, peerEmail, (payload) => sendText(TAG_CHAT, payload), ackWaiter);

  // Background receive loop -- same framing/decrypt pattern as the WebRTC
  // path's signaling loop, just dispatching on our own 1-byte tag instead of
  // wasm.decodeSignalMessage's SDP/ICE-shaped SignalMessage.
  // CADS-webconference-demo#69: this transport had no transient-drop
  // recovery at all -- any readFramed failure (a dropped network, a
  // ws_channel blip on the edge, the STALL_TIMEOUT_MS backstop) went
  // straight to terminal teardown, asymmetric with the webrtc path's
  // active attemptIceRestart + grace window. One reconnect attempt per
  // failure episode (channelReconnectAttempted, same one-shot-then-reset
  // shape as attemptIceRestart's own iceRestartAttempted): re-run
  // establishChannelSession (reusing the same grant -- confirmed reusable)
  // and, on success, swap byteStream/noiseTransport in place and resume
  // this SAME loop -- deliberately NOT re-sending TAG_MEDIA_INIT or
  // touching mediaSource/sourceBuffer/recorder, all of which stay exactly
  // as they were. sourceBuffer's 'sequence' mode has no wall-clock
  // dependency, so a gap where no TAG_MEDIA_CHUNK arrived just reads as a
  // brief freeze on resume, not a fatal error -- and the sender's
  // MediaRecorder keeps running the whole time regardless (it's on the
  // local stream, independent of this channel), so nothing needs
  // restarting there either. Both sides run this same code and both
  // independently notice their own read failure, so both re-join the
  // channel -- physically symmetric, with the Noise handshake's own
  // initiator/responder roles (inside establishChannelSession) staying
  // asymmetric via isCaller exactly like the original call setup. The
  // edge's "lone member parks waiting for its partner" behavior (see
  // establishChannelSession's own comment) is what makes the timing of
  // which side reconnects first not matter.
  const CHANNEL_RECONNECT_GRACE_MS = 20000; // matches ICE_RESTART_GRACE_MS
  let channelReconnectAttempted = false;
  (async () => {
    while (true) {
      let cipher;
      try {
        cipher = await readFramed(byteStream);
      } catch (e) {
        if (channelReconnectAttempted) {
          log(`channel receive loop ended: ${e.message} (reconnect already attempted this episode)`);
          setStatus('peer-hung-up');
          addChatMessage('peer connection lost', 'system');
          if (activeMediaBackpressureInterval) clearInterval(activeMediaBackpressureInterval);
          returnToDialerAfterHangup();
          return;
        }
        channelReconnectAttempted = true;
        log(`channel receive loop ended: ${e.message} -- attempting to reconnect`);
        addChatMessage('connection lost -- attempting to reconnect…', 'system');
        setStatus('connecting-media');
        try {
          const fresh = await withTimeout(
            establishChannelSession(wsUrl, grantHex, holderPrivHex, noisePrivHex, isCaller),
            CHANNEL_RECONNECT_GRACE_MS,
            `reconnect timed out after ${CHANNEL_RECONNECT_GRACE_MS / 1000}s`
          );
          byteStream = fresh.stream;
          noiseTransport = fresh.noiseTransport;
          channelReconnectAttempted = false; // a fresh recovery -- a LATER drop gets its own attempt, same as attemptIceRestart's own reset
          // CADS-webconference-demo#78: recovering the byte stream previously
          // did NOT recover the render if remoteMediaFatal had already
          // latched before the drop -- the connection came back, remote
          // media stayed permanently dead. Reset both here too, giving the
          // (unchanged, still-alive) sourceBuffer a fresh chance on the next
          // chunk, same "a later problem gets its own attempt" reasoning as
          // channelReconnectAttempted just above.
          remoteMediaFatal = false;
          mediaRecreateAttempts = 0;
          log('channel reconnected -- resuming call');
          addChatMessage('reconnected', 'system');
          setStatus('in-call');
          continue;
        } catch (e2) {
          log(`channel reconnect failed: ${e2.message}`);
          setStatus('peer-hung-up');
          addChatMessage('peer connection lost', 'system');
          if (activeMediaBackpressureInterval) clearInterval(activeMediaBackpressureInterval);
          returnToDialerAfterHangup();
          return;
        }
      }
      // CADS-webconference-demo#20: readFramed() above is guarded, but
      // decrypt()/dispatch was not -- one malformed or undecryptable frame
      // (corrupted in transit, a desynced Noise counter, a media type this
      // browser rejects in addSourceBuffer) threw out of this async IIFE
      // with nothing awaiting it, silently ending the whole receive loop
      // with zero UI feedback -- the exact "call just stops working, no
      // error shown" symptom reported. Treated the same as a lost
      // connection (the existing catch above) rather than skip-and-continue:
      // a decrypt failure specifically can mean something is genuinely
      // wrong with this stream, not safe to just keep reading past.
      try {
        const plain = noiseTransport.decrypt(cipher);
        const tag = plain[0];
        const payload = plain.slice(1);
        if (tag === TAG_MEDIA_INIT) {
          const mimeType = new TextDecoder().decode(payload);
          if (mediaSource.readyState === 'open' && MediaSource.isTypeSupported(mimeType)) {
            sourceBufferMimeType = mimeType; // CADS-webconference-demo#78 -- needed if handleAppendError has to recreate this
            sourceBuffer = mediaSource.addSourceBuffer(mimeType);
            sourceBuffer.mode = 'sequence';
            sourceBuffer.addEventListener('updateend', flushPending);
            remoteEmpty.style.display = 'none';
            log(`remote media stream starting (${mimeType})`);
          } else {
            mediaUnsupported = true;
            log(`peer's media type unsupported here: ${mimeType}`);
          }
        } else if (tag === TAG_MEDIA_CHUNK) {
          appendChunk(payload);
        } else if (tag === TAG_CHAT) {
          const raw = new TextDecoder().decode(payload);
          if (raw === NO_CAMERA_SENTINEL) {
            addChatMessage('Your peer joined without a working camera/microphone -- that\'s why you can\'t see or hear them, not a bug.', 'system');
            remoteEmpty.textContent = 'peer has no camera';
          } else if (raw === NO_CODEC_SENTINEL) {
            addChatMessage('Your peer has a camera, but their browser can\'t encode video for this transport (e.g. Safari doesn\'t support the codecs used here) -- try WebRTC mode instead.', 'system');
            remoteEmpty.textContent = "peer's browser can't encode video here";
          } else {
            // Real chat rides as a {seq, text} JSON envelope -- see the send
            // side's comment. Tolerate plain text too (an older/manual-link peer).
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch (_) {
              addChatMessage(raw, 'peer');
              parsed = null;
            }
            if (parsed && parsed.ack != null) {
              ackWaiter.resolve(parsed.ack);
            } else if (parsed) {
              const { seq, text } = parsed;
              addChatMessage(text, 'peer');
              if (chatStore && peerEmail && seq != null) {
                // CADS-webconference-demo#43 (finding 2) -- see
                // backgroundChatSession's matching comment. Persist before
                // acking, not after (or not at all, as before).
                await chatStore.record({ peerEmail, from: 'peer', text, seq, received: true });
                sendText(TAG_CHAT, JSON.stringify({ ack: seq })); // CADS-webconference-demo#21
              }
            }
          }
        } else if (tag === TAG_BYE) {
          setStatus('peer-hung-up');
          addChatMessage('peer hung up', 'system');
          // CADS-webconference-demo#70 (review follow-up): clearInterval
          // alongside ws.close() here, same reasoning as #38 finding 9's
          // own comment on that close -- without it the backpressure poll
          // keeps firing every 250ms against a closing socket for the
          // ~1200ms until returnToDialerAfterHangup's reload tears down the
          // page. Harmless (caught by the interval's own recorder.state
          // check once recorder.stop() below eventually runs, and the ws
          // is already closing regardless), but not the clean immediate
          // teardown onHangup gets -- matching that shape here too.
          if (activeMediaBackpressureInterval) clearInterval(activeMediaBackpressureInterval);
          byteStream.ws.close(); // CADS-webconference-demo#38 (finding 9) -- see setupControls' onHangup callback's matching comment
          returnToDialerAfterHangup();
          return;
        }
      } catch (e) {
        log(`channel receive loop: bad frame, ending call: ${e.message}`);
        setStatus('peer-hung-up');
        addChatMessage('connection lost (a corrupted or unexpected frame arrived)', 'system');
        if (activeMediaBackpressureInterval) clearInterval(activeMediaBackpressureInterval); // CADS-webconference-demo#70 (review follow-up) -- see the TAG_BYE branch's matching comment above
        byteStream.ws.close();
        returnToDialerAfterHangup();
        return;
      }
    }
  })();

  const media = await getLocalMedia();
  let recorder = null;
  let activeMediaBackpressureInterval = null; // CADS-webconference-demo#70 -- cleared in onHangup below
  if (media.kind === 'media') {
    localVideo.srcObject = media.stream;
    localEmpty.style.display = 'none';
    const mimeCandidates = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
    const mimeType = mimeCandidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (mimeType) {
      sendText(TAG_MEDIA_INIT, mimeType);
      recorder = new MediaRecorder(media.stream, { mimeType });
      // CADS-webconference-demo#70: this transport is a raw byte pipe over
      // one WebSocket -- unlike the webrtc path (RTP congestion control /
      // bitrate adaptation built into RTCPeerConnection), nothing here
      // adapted the send rate to what the relayed channel could actually
      // carry. On a slow uplink, ws.send() kept accepting ~245KB/s of
      // offered load (49KB chunks every 200ms) regardless of drain rate,
      // so ws.bufferedAmount grew unbounded instead of the video degrading
      // -- exactly the kind of slow/lossy mobile link #65's live debugging
      // just confirmed is real on this deployment, not a hypothetical.
      // recorder.pause()/resume() is the only lever MediaRecorder exposes
      // to reduce offered load at the source (there's no bitrate knob
      // reliable enough across browsers to reach for instead) -- pausing
      // stops ondataavailable from firing at all, so nothing here can
      // re-check bufferedAmount to un-pause itself; a separate interval
      // below does that polling while paused.
      const MEDIA_BACKPRESSURE_HIGH_WATER = 262144; // pause once buffered exceeds this
      const MEDIA_BACKPRESSURE_LOW_WATER = 65536; // resume once drained below this
      let backpressurePaused = false;
      const backpressureCheck = setInterval(() => {
        if (recorder.state === 'inactive') return;
        if (backpressurePaused && byteStream.ws.bufferedAmount < MEDIA_BACKPRESSURE_LOW_WATER) {
          backpressurePaused = false;
          recorder.resume();
          log('media send resumed (channel drained)');
        }
      }, 250);
      recorder.ondataavailable = async (ev) => {
        if (!ev.data || ev.data.size === 0) return;
        try {
          const bytes = new Uint8Array(await ev.data.arrayBuffer());
          // The Noise Protocol spec caps a single transport message at 65535
          // bytes (including its 16-byte AEAD tag) -- a real camera's
          // MediaRecorder chunk can exceed that, and every encrypt() call
          // over the limit throws "input error", repeatedly, with zero
          // video ever getting through. Confirmed live: continuous
          // NoiseTransport.encrypt() failures, callee stuck on a blank
          // tile. Split any oversized chunk into safe sub-chunks instead --
          // appendChunk/sourceBuffer.appendBuffer on the receiving end
          // neither needs nor cares about original blob boundaries, so this
          // needs no matching change there.
          const MAX_CHUNK_BYTES = 49152;
          for (let off = 0; off < bytes.length; off += MAX_CHUNK_BYTES) {
            sendTagged(TAG_MEDIA_CHUNK, bytes.subarray(off, off + MAX_CHUNK_BYTES));
          }
          if (!backpressurePaused && byteStream.ws.bufferedAmount > MEDIA_BACKPRESSURE_HIGH_WATER) {
            backpressurePaused = true;
            recorder.pause();
            log(`media send paused (channel congested, ${byteStream.ws.bufferedAmount} bytes buffered) -- video will freeze briefly rather than the tab's memory growing unbounded`);
          }
        } catch (e) {
          // Was previously an uncaught promise rejection spamming the
          // console on every ~200ms timeslice with no visible diagnosis --
          // now a single clear log line, and media just drops that one
          // chunk instead of the call silently never showing video at all.
          log(`failed to send a media chunk: ${e.message || e}`);
        }
      };
      recorder.start(200); // 200ms timeslices -- a reasonable latency/overhead trade-off for a relayed path
      activeMediaBackpressureInterval = backpressureCheck;
    } else {
      log('MediaRecorder cannot produce a supported mimeType here -- sending no media, audio/video will not appear');
      sendText(TAG_CHAT, NO_CODEC_SENTINEL);
    }
  } else {
    localEmpty.textContent = 'no camera available';
    // Unlike the WebRTC path (setupChatChannel's 'open' handler), this
    // transport has no separate "channel ready" event to hang the sentinel
    // off of -- the byte stream is already live by the time we get here, so
    // send it immediately instead of leaving the peer's remote-video tile
    // stuck on a generic "waiting for peer..." forever with no explanation.
    sendText(TAG_CHAT, NO_CAMERA_SENTINEL);
  }

  const onHangup = () => {
    activeCallBye = null; // #38 finding 6 -- see returnToDialerAfterHangup's matching clear
    sendTagged(TAG_BYE, new Uint8Array(0));
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    // CADS-webconference-demo#70: the backpressure poll interval outlives
    // the recorder otherwise -- same leaked-timer shape #38 already fixed
    // for the signaling WS below.
    if (activeMediaBackpressureInterval) clearInterval(activeMediaBackpressureInterval);
    // CADS-webconference-demo#38 (finding 9): neither hangup path closed the
    // underlying signaling WS -- it lingered open until
    // returnToDialerAfterHangup's ~1200ms-delayed reload tore down the whole
    // page. Explicit close here (mirrors backgroundChatSession's own
    // stream.ws.close() in its finally block) frees it immediately instead.
    byteStream.ws.close();
  };
  // #38 finding 6 -- same close logic runs on an explicit Hang Up click or a
  // pagehide (tab close/navigation) while this transport's call is live.
  activeCallBye = onHangup;
  setupControls(media, onHangup);

  setIceState('connected'); // no real ICE in this mode -- 'connected' just reflects the channel being fully up
  setStatus('in-call');
}

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

  setStatus('connecting-webrtc');
  // CADS-webconference-demo#18: iceServers: [] meant ICE could only ever
  // find a candidate pair when both sides happened to be reachable directly
  // (same LAN, or one side has a real public IP) -- anyone behind NAT on
  // both ends failed silently. A public STUN server fixes the common case
  // (each side discovers its own reflexive address) but NOT symmetric NAT
  // or locked-down corporate networks, which need an actual TURN relay --
  // this demo has no TURN infrastructure/credentials to offer one, so
  // that harder case stays a known gap, not silently claimed as fixed. The
  // direct-channel transport (transportMode === 'channel', relayed over
  // this app's own WebSocket channel instead of raw ICE) remains the
  // reliable fallback for exactly those networks.
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  // Liveness above the relay, not through it: the Noise/ws_channel signaling
  // path only tells us the peer is gone if it manages to send a clean 'bye'
  // -- a crashed tab, killed process, or dropped network never will. Once
  // the actual end-to-end WebRTC connection is up, a heartbeat over its own
  // data channel (plus the browser's native connection-state signal) is what
  // actually reflects whether the peer is still there.
  let sessionEnded = false;
  let capturedMedia = null; // set once getLocalMedia() below resolves; used by attemptChannelFallback to release the pc-bound tracks before runChannelMediaCall grabs its own
  function endCallDueToPeerLoss(reason) {
    if (sessionEnded) return;
    sessionEnded = true;
    setStatus('peer-hung-up');
    addChatMessage(`peer connection lost (${reason})`, 'system');
    pc.close();
    activeWebrtcPc = null;
    // CADS-webconference-demo#38 (finding 9): the Noise/ws_channel signaling
    // socket is a separate connection from the RTCPeerConnection itself --
    // closing pc alone left it open until returnToDialerAfterHangup's
    // reload tore down the page.
    stream.ws.close();
    returnToDialerAfterHangup();
  }

  // CADS-webconference-demo#19: a network change (WiFi -> cellular, DHCP
  // renewal, a transient packet-loss burst) drives ICE to 'disconnected'
  // then 'failed', and previously the call just ended with no recovery
  // attempt -- purely passive, waiting on the browser's own ICE engine to
  // either self-heal or eventually give up. This adds one real, active
  // recovery attempt per failure episode: the caller re-negotiates with
  // pc.createOffer({iceRestart:true}) and sends it over the SAME
  // Noise-encrypted signaling channel already in use -- the receiving
  // side needs zero new code, since the signaling loop's existing 'offer'
  // branch (below) already handles setRemoteDescription/createAnswer for
  // ANY incoming offer generically, restart or not. Only the caller
  // initiates (matching the existing isCaller-gated initial-offer flow --
  // never both sides, which would glare).
  const ICE_RESTART_GRACE_MS = 20000;
  let iceRestartAttempted = false;
  let disconnectedGraceTimer = null;
  function attemptIceRestart(reason) {
    if (iceRestartAttempted) {
      attemptChannelFallback(`${reason} (restart already attempted this episode)`);
      return;
    }
    iceRestartAttempted = true;
    if (isCaller) {
      log(`${reason} -- attempting an ICE restart`);
      addChatMessage('connection lost -- attempting to reconnect…', 'system');
      pc.createOffer({ iceRestart: true }).then(async (offer) => {
        await pc.setLocalDescription(offer);
        sendSignal(wasm.encodeSignalOffer(offer.sdp));
      }).catch((e) => {
        log(`ICE restart offer failed: ${e.message}`);
        attemptChannelFallback(`${reason} (restart attempt itself failed: ${e.message})`);
      });
    } else {
      // Callee has nothing to actively send -- the caller's restart offer
      // (if it comes) arrives through the existing generic 'offer' handler.
      log(`${reason} -- waiting for the caller to attempt an ICE restart`);
    }
    // Whichever side, give the restart round-trip a real window before
    // declaring it failed for good -- ICE candidate gathering/connectivity
    // checks over a genuinely new network path can take several seconds,
    // not just the offer/answer exchange itself.
    setTimeout(() => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        attemptChannelFallback(`${reason} (no recovery within ${ICE_RESTART_GRACE_MS / 1000}s)`);
      }
    }, ICE_RESTART_GRACE_MS);
  }

  // CADS-webconference-demo#67: previously, once an ICE restart also failed
  // to recover within its grace window, the call just ended -- even though
  // the direct-channel transport (this same call's Noise_IK signaling
  // socket, `stream`/`noiseTransport`, already open and authenticated since
  // before the offer/answer exchange even started) was sitting right there
  // as exactly the fallback #18/#37 designed it to be. This is precisely
  // the STUN-only-ICE/no-TURN/cross-NAT gap those issues left open: webrtc
  // can fail to establish connectivity at all on a genuinely hard network,
  // and until now the only "fix" was retrying the same ICE path that just
  // failed. One fallback attempt per call (channelFallbackAttempted) --
  // same one-shot-then-terminal shape as every other recovery latch in this
  // file (iceRestartAttempted, channelReconnectAttempted); a SECOND failure
  // after the fallback itself is already running ends the call for real via
  // endCallDueToPeerLoss, same as before this fix existed.
  let channelFallbackAttempted = false;
  // peerInitiated=true means this side is reacting to the OTHER side's own
  // TAG_FALLBACK notification (see that constant's comment) -- skip sending
  // our own notification back in that case, both to avoid a pointless echo
  // and because sendSignal below assumes pc/the webrtc signaling path is
  // still the thing in charge of this channel, which is no longer true once
  // the peer has already announced its own switch.
  function attemptChannelFallback(reason, peerInitiated = false) {
    if (channelFallbackAttempted) {
      endCallDueToPeerLoss(`${reason} (channel fallback already attempted this call)`);
      return;
    }
    channelFallbackAttempted = true;
    // Stops every other webrtc-side watchdog (heartbeat close/timeout,
    // onconnectionstatechange) from also firing once pc.close() below runs
    // -- same "already ended, no-op" guard endCallDueToPeerLoss itself
    // relies on for a local hang-up, reused here since we're leaving pc
    // behind for good, not actually ending the call.
    sessionEnded = true;
    log(`${reason} -- WebRTC never established a working connection, falling back to the direct-channel transport`);
    addChatMessage('WebRTC connection failed -- falling back to a direct relay…', 'system');
    setStatus('connecting-media');
    // Tell the peer BEFORE tearing down pc, so it switches into channel
    // mode in lockstep instead of being left speaking the old wasm signal
    // protocol into a channel we're about to start reading raw TAG_* bytes
    // from (see TAG_FALLBACK's own comment for the failure this prevents).
    if (!peerInitiated) {
      try {
        sendSignal(new Uint8Array([TAG_FALLBACK]));
      } catch (e) {
        log(`failed to notify peer of channel fallback: ${e.message || e}`);
      }
    }
    pc.close();
    activeWebrtcPc = null;
    // Release the pc-bound camera/mic tracks -- runChannelMediaCall acquires
    // its own via a fresh getLocalMedia() call, and holding both open at
    // once would leave a dangling capture session for no reason.
    if (capturedMedia) capturedMedia.stream.getTracks().forEach((t) => t.stop());
    document.getElementById('transport-badge').textContent = 'direct-channel (fallback)';
    document.getElementById('chat-transport-note').textContent =
      '— tunneled through the same Noise_IK channel (fell back from WebRTC after ICE failed)';
    // Reuses the SAME stream/noiseTransport this whole call's Noise_IK
    // handshake already authenticated at the top of run() -- no re-dial,
    // no fresh grant/handshake needed, exactly the hand-off the #69/#67
    // threads worked out was safe (the channel was open for signaling the
    // whole time, just never carrying TAG_MEDIA_* traffic until now).
    runChannelMediaCall(stream, noiseTransport, isCaller, chatStore, peerEmail, wsUrl, grantHex, holderPrivHex, noisePrivHex);
  }

  pc.oniceconnectionstatechange = () => setIceState(pc.iceConnectionState);
  pc.onconnectionstatechange = () => {
    log(`connection state: ${pc.connectionState}`);
    // 'closed' after our own local hang-up is the expected, already-handled
    // case (sessionEnded is already true by then, so endCallDueToPeerLoss
    // below no-ops).
    if (pc.connectionState === 'failed') {
      if (disconnectedGraceTimer) { clearTimeout(disconnectedGraceTimer); disconnectedGraceTimer = null; }
      attemptIceRestart('ICE failed');
    } else if (pc.connectionState === 'disconnected' && !disconnectedGraceTimer) {
      // 'disconnected' is often transient -- WebRTC's own ICE engine keeps
      // retrying connectivity checks on the existing candidates without any
      // restart needed, and frequently self-heals within a few seconds. Only
      // escalate to an active restart if it's STILL disconnected (not
      // recovered, and not already escalated to 'failed' on its own, which
      // the branch above already handles on its own timeline) after a grace
      // period -- matches the issue's own "start a grace timer" suggestion.
      disconnectedGraceTimer = setTimeout(() => {
        disconnectedGraceTimer = null;
        if (pc.connectionState === 'disconnected') attemptIceRestart('ICE disconnected');
      }, ICE_RESTART_GRACE_MS / 2);
    } else if (pc.connectionState === 'connected') {
      if (disconnectedGraceTimer) { clearTimeout(disconnectedGraceTimer); disconnectedGraceTimer = null; }
      iceRestartAttempted = false; // a fresh recovery -- a LATER failure gets its own restart attempt
      // Reported live (both sides, consistently): the "Connecting to X..."
      // banner stayed up forever despite a fully working call -- audio/video
      // flowing, chat working. setIceState (fed by oniceconnectionstatechange
      // above) was the ONLY place hideConnecting() got called; a real capture
      // showed pc.connectionState reaching 'connected' while iceConnectionState
      // apparently never fired the matching 'connected'/'completed' transition
      // in that same run (browsers don't guarantee the two fire together, or
      // even both fire at all -- connectionState is the spec's own aggregate
      // signal, arguably the more authoritative one to begin with). Hooking
      // both, plus ontrack below, so any one of the three real-connectivity
      // signals that actually fires is enough to clear it.
      hideConnecting();
    }
  };
  pc.ontrack = (ev) => {
    remoteVideo.srcObject = ev.streams[0];
    remoteEmpty.style.display = 'none';
    log(`remote track received: ${ev.track.kind}`);
    hideConnecting(); // decrypted remote media arriving is itself unambiguous proof the call is live
  };

  function sendSignal(bytes) {
    // Synchronous start-to-finish (no `await` inside) so concurrent callers
    // (onicecandidate firing while the main flow awaits a peer message) can
    // never interleave two transport.encrypt() calls out of nonce order.
    writeFramed(stream, noiseTransport.encrypt(bytes));
  }

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    sendSignal(wasm.encodeSignalIceCandidate(ev.candidate.candidate, ev.candidate.sdpMid || undefined, ev.candidate.sdpMLineIndex ?? undefined));
  };

  const media = await getLocalMedia();
  capturedMedia = media; // CADS-webconference-demo#67 -- so attemptChannelFallback (defined above, but only ever called once ICE has actually failed, i.e. after this line has run) can release these tracks

  // Heartbeat: a third, dedicated real WebRTC data channel -- deliberately
  // separate from 'chat' so heartbeat traffic never touches the visible chat
  // log. This is genuine end-to-end liveness, not routed through the
  // Noise/ws_channel relay at all: once this data channel is up, it rides
  // the same DTLS/SCTP association as the media tracks, so its loss reflects
  // the real peer connection dying (crash, killed tab, dropped network) --
  // exactly the case an explicit 'bye' signal can never cover, since sending
  // one requires the peer's JS to still be running.
  const HEARTBEAT_INTERVAL_MS = 8000;
  // Deliberately forgiving: setInterval callbacks (both the sender's and this
  // watchdog's own) can get starved well past their nominal interval under
  // heavy host CPU contention or Chrome's background-tab timer throttling
  // (down to ~1/min) -- neither means the peer is actually gone. Confirmed
  // via testing on an overloaded host: a healthy call was killed by a 16s
  // timeout with no real connection issue. ~4 missed beats at this interval
  // is still far faster than waiting for ICE/TCP-level failure detection
  // (which can take minutes), while tolerating real-world scheduling jitter.
  const HEARTBEAT_TIMEOUT_MS = 35000;
  function setupHeartbeatChannel(channel) {
    let lastSeen = Date.now();
    channel.addEventListener('open', () => {
      lastSeen = Date.now();
      const sendTimer = setInterval(() => {
        if (channel.readyState === 'open') channel.send('ping');
      }, HEARTBEAT_INTERVAL_MS);
      // CADS-webconference-demo#79: heartbeat silence alone used to be
      // treated as proof of peer loss -- but a heartbeat channel can go
      // silent (an SCTP stream reset, #38 finding 5's own close handler
      // right below already accounts for the channel closing outright) while
      // the SAME peer connection keeps delivering real media, since
      // heartbeat rides its own separate data channel over the shared DTLS/
      // SCTP association. remoteVideo (this shared element, srcObject-fed
      // for the webrtc path at ev.streams[0] below) demonstrably advancing
      // is direct proof the connection is alive regardless of what happened
      // to the heartbeat channel specifically -- checked on every tick, not
      // just once, so the watchdog still correctly fires once media ALSO
      // actually stops.
      let lastHeartbeatCheckVideoTime = remoteVideo.currentTime;
      const watchdog = setInterval(() => {
        if (sessionEnded) {
          clearInterval(sendTimer);
          clearInterval(watchdog);
          return;
        }
        const videoTimeNow = remoteVideo.currentTime;
        const videoAdvancing = videoTimeNow > lastHeartbeatCheckVideoTime;
        lastHeartbeatCheckVideoTime = videoTimeNow;
        if (Date.now() - lastSeen > HEARTBEAT_TIMEOUT_MS) {
          if (videoAdvancing) {
            log('heartbeat silent but remote media still advancing -- not treating as peer loss');
            return;
          }
          clearInterval(sendTimer);
          clearInterval(watchdog);
          endCallDueToPeerLoss('heartbeat timeout');
        }
      }, HEARTBEAT_INTERVAL_MS);
    });
    channel.addEventListener('message', () => {
      lastSeen = Date.now();
    });
    channel.addEventListener('close', () => {
      // CADS-webconference-demo#38 (finding 5): a data channel can close on
      // its own -- e.g. a transient SCTP stream reset -- without the
      // underlying peer connection being dead. Treating ANY heartbeat-
      // channel close as fatal ended calls on a recoverable blip. Only
      // escalate immediately if the peer connection itself has ALSO
      // already failed; otherwise this is logged but not fatal on its
      // own. The HEARTBEAT_TIMEOUT_MS watchdog above (35s of heartbeat
      // silence) and pc.onconnectionstatechange's own 'failed' handling
      // (#19, with an active ICE-restart attempt) remain the real
      // peer-loss detectors -- this close event alone is no longer one.
      if (pc.connectionState === 'failed') {
        endCallDueToPeerLoss('heartbeat channel closed (peer connection also failed)');
      } else {
        log(`heartbeat channel closed (connection state: ${pc.connectionState}) -- not treating as fatal on its own`);
      }
    });
  }

  // Chat: a second, real WebRTC data channel alongside the media tracks --
  // the caller creates it, the callee receives it via ondatachannel. Set up
  // after getLocalMedia() resolves so setupChatChannel knows whether to send
  // the no-camera sentinel the moment the channel opens.
  let chatChannel;
  if (isCaller) {
    chatChannel = pc.createDataChannel('chat');
    setupChatChannel(chatChannel, media.kind === 'media', chatStore, peerEmail);
    setupHeartbeatChannel(pc.createDataChannel('heartbeat'));
  } else {
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === 'chat') {
        chatChannel = ev.channel;
        setupChatChannel(chatChannel, media.kind === 'media', chatStore, peerEmail);
      } else if (ev.channel.label === 'heartbeat') {
        setupHeartbeatChannel(ev.channel);
      }
    };
  }

  if (media.kind === 'media') {
    for (const track of media.stream.getTracks()) pc.addTrack(track, media.stream);
    localVideo.srcObject = media.stream;
    localEmpty.style.display = 'none';
  } else {
    pc.createDataChannel('probe');
    localEmpty.textContent = 'no camera available';
  }
  const onHangup = () => {
    activeCallBye = null; // #38 finding 6 -- see returnToDialerAfterHangup's matching clear
    sessionEnded = true; // before pc.close(), so the heartbeat/connection-state
    // watchdogs above see the session as already-ended and don't also fire
    // a redundant "peer connection lost" on top of our own local hang-up.
    sendSignal(wasm.encodeSignalBye()); // already in scope here -- no need to bounce through the (now-removed) window global
    pc.close();
    activeWebrtcPc = null;
    stream.ws.close(); // CADS-webconference-demo#38 (finding 9) -- see endCallDueToPeerLoss's matching comment
  };
  // #38 finding 6 -- same close logic runs on an explicit Hang Up click or a
  // pagehide (tab close/navigation) while this transport's call is live.
  activeCallBye = onHangup;
  setupControls(media, onHangup);

  // Background loop: every subsequent signaling message (from here on the
  // Noise session is established, so everything is encrypted) is decrypted,
  // decoded, and dispatched to the peer connection.
  (async () => {
    while (true) {
      let cipher;
      try {
        cipher = await readFramed(stream);
      } catch {
        return; // connection closed
      }
      // CADS-webconference-demo#20: readFramed() above is guarded, but
      // decrypt()/decode/dispatch was not -- one malformed or undecryptable
      // signaling frame (or an SDP/ICE candidate the browser itself rejects
      // via setRemoteDescription/addIceCandidate) threw out of this async
      // IIFE with nothing awaiting it, silently ending the whole signaling
      // loop with zero UI feedback -- "the call just stops working." Same
      // cleanup as an explicit 'bye', since from here on this signaling
      // channel can't be trusted to keep making sense.
      try {
        const plain = noiseTransport.decrypt(cipher);
        // Checked before wasm.decodeSignalMessage even runs -- see
        // TAG_FALLBACK's own comment. A real SDP/ICE/bye SignalMessage is
        // never a single byte, so this can't collide with a genuine one.
        if (plain.length === 1 && plain[0] === TAG_FALLBACK) {
          if (disconnectedGraceTimer) { clearTimeout(disconnectedGraceTimer); disconnectedGraceTimer = null; }
          attemptChannelFallback('peer switched to the direct-channel transport', true);
          return;
        }
        const msg = wasm.decodeSignalMessage(plain);
        if (msg.kind === 'offer') {
          await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal(wasm.encodeSignalAnswer(answer.sdp));
        } else if (msg.kind === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        } else if (msg.kind === 'ice-candidate') {
          await pc.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMlineIndex });
        } else if (msg.kind === 'bye') {
          sessionEnded = true; // before pc.close(), same reasoning as the local hang-up path above
          setStatus('peer-hung-up');
          addChatMessage('peer hung up', 'system');
          pc.close();
          activeWebrtcPc = null;
          stream.ws.close(); // CADS-webconference-demo#38 (finding 9) -- see endCallDueToPeerLoss's matching comment
          returnToDialerAfterHangup();
          return;
        }
      } catch (e) {
        log(`signaling loop: bad frame, ending call: ${e.message}`);
        sessionEnded = true;
        setStatus('peer-hung-up');
        addChatMessage('connection lost (a corrupted or unexpected signaling frame arrived)', 'system');
        pc.close();
        activeWebrtcPc = null;
        stream.ws.close();
        returnToDialerAfterHangup();
        return;
      }
    }
  })();

  if (isCaller) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(wasm.encodeSignalOffer(offer.sdp));
  }

  setStatus('signaling-active');
  activeWebrtcPc = pc; // CADS-webconference-demo#38 (finding 7) -- see activeWebrtcPc's own declaration comment
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
  }
  // Otherwise a failure here (joinChannel/handshake throwing before real
  // peer connectivity was ever reached) leaves the "Connecting to X…"
  // spinner banner sitting on screen forever with nothing telling the user
  // it actually failed -- the exact kind of misleading state this banner
  // was added to prevent, not reproduce.
  hideConnecting();
});
