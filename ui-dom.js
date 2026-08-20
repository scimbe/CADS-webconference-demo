// Generic DOM-ref lookups and UI helpers shared across every concern area of
// this app (identity, dialer, chat, both call transports, video filters,
// pairing, access-requests) -- pure presentation glue, no protocol/crypto
// logic of its own. Split out of app.js as part of the client-code
// consolidation (CADS-webconference-demo#91); every function/const here is a
// verbatim move, comments included, with no behavior change.

const bootLoading = document.getElementById('boot-loading');
const setupScreen = document.getElementById('setup-screen');
const callScreen = document.getElementById('call-screen');
const siteHero = document.getElementById('site-hero');
const landingMain = document.getElementById('landing-main');
const statusEl = document.getElementById('status');
const iceEl = document.getElementById('ice-state');
const logEl = document.getElementById('log');
const statusPill = document.getElementById('status-pill');
const statusText = document.getElementById('status-text');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const localEmpty = document.getElementById('local-empty');
const remoteEmpty = document.getElementById('remote-empty');
const btnMic = document.getElementById('btn-mic');
const btnCam = document.getElementById('btn-cam');
const btnHangup = document.getElementById('btn-hangup');
const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const routeYou = document.getElementById('route-you');
const routeSignal = document.getElementById('route-signal');
const routeWebrtc = document.getElementById('route-webrtc');
const routePeer = document.getElementById('route-peer');
const connectingBanner = document.getElementById('connecting-banner');
const connectingBannerText = document.getElementById('connecting-banner-text');
const offlineBanner = document.getElementById('offline-banner');

const idEntry = document.getElementById('id-entry');
const idForm = document.getElementById('id-form');
const idEmailInput = document.getElementById('id-email');
const idVerifyError = document.getElementById('id-verify-error');
const idVerifyErrorDetail = document.getElementById('id-verify-error-detail');
const idVerifyRetry = document.getElementById('id-verify-retry');
const idGateRequired = document.getElementById('id-gate-required');
const idGateLoginBtn = document.getElementById('id-gate-login-btn');
const idGateRegisterForm = document.getElementById('id-gate-register-form');
const idGateRegisterEmail = document.getElementById('id-gate-register-email');
const myEmailEl = document.getElementById('my-email');
const dialForm = document.getElementById('dial-form');
const dialEmailInput = document.getElementById('dial-email');
const callNote = document.getElementById('call-note');
const incomingCard = document.getElementById('incoming-card');
const incomingFrom = document.getElementById('incoming-from');
const btnAccept = document.getElementById('btn-accept');
const btnDecline = document.getElementById('btn-decline');
const btnCancelCall = document.getElementById('btn-cancel-call');
const logoutLink = document.getElementById('logout-link');
const transportChannelCheckbox = document.getElementById('transport-channel');
const contactsList = document.getElementById('contacts-list');
const contactsEmpty = document.getElementById('contacts-empty');
const accessRemoveForm = document.getElementById('access-remove-form');
const accessRemoveEmail = document.getElementById('access-remove-email');
const accessNote = document.getElementById('access-note');
const revokeAccessDetails = document.getElementById('revoke-access-details');
const accessRemoveConsoleLink = document.getElementById('access-remove-console-link');
const accessRequestsDetails = document.getElementById('access-requests-details');
const accessRequestsBadge = document.getElementById('access-requests-badge');
const accessRequestsList = document.getElementById('access-requests-list');
const accessRequestsEmpty = document.getElementById('access-requests-empty');
const videoGrid = document.getElementById('video-grid');
const localTile = document.getElementById('local-tile');
const btnSwitchCamera = document.getElementById('btn-switch-camera');
const btnVideoFilters = document.getElementById('btn-video-filters');
const filterMenu = document.getElementById('filter-menu');
const filterMenuNote = document.getElementById('filter-menu-note');
const filterMenuItems = document.querySelectorAll('.filter-menu-item');
const messengerShell = document.getElementById('messenger-shell');
// Live-requested: a large-button call screen for kids/grandparents
// (dialer.js's renderSimpleScreen/enterSimpleMode/exitSimpleMode) and a
// local-only filter practice screen (practice-mode.js) -- both new,
// independent top-level screens, same "hidden until shown" convention as
// setupScreen/callScreen/messengerShell above.
const simpleModeEnterBtn = document.getElementById('simple-mode-enter-btn');
const simpleScreen = document.getElementById('simple-screen');
const simpleExitBtn = document.getElementById('simple-exit-btn');
const simpleTiles = document.getElementById('simple-tiles');
const simpleTilesEmpty = document.getElementById('simple-tiles-empty');
const simplePracticeBtn = document.getElementById('simple-practice-btn');
const practiceScreen = document.getElementById('practice-screen');
const practiceVideo = document.getElementById('practice-video');
const practiceFilterRow = document.getElementById('practice-filter-row');
const practiceDoneBtn = document.getElementById('practice-done-btn');
const practiceEmpty = document.getElementById('practice-empty');
const msgMenuToggle = document.getElementById('msg-menu-toggle');
const msgMenu = document.getElementById('msg-menu');
const msgSearchForm = document.getElementById('msg-search-form');
const msgSearchInput = document.getElementById('msg-search');
const msgConvPlaceholder = document.getElementById('msg-conv-placeholder');
const msgConversation = document.getElementById('msg-conversation');
const msgBackBtn = document.getElementById('msg-back-btn');
const msgCallBtn = document.getElementById('msg-call-btn');
const msgBlockBtn = document.getElementById('msg-block-btn');
const msgComposeForm = document.getElementById('msg-compose-form');
const msgComposeInput = document.getElementById('msg-compose-input');
const msgAttachBtn = document.getElementById('msg-attach-btn');
const msgAttachInput = document.getElementById('msg-attach-input');
const convAvatar = document.getElementById('conv-avatar');
const convName = document.getElementById('conv-name');
const convRenameBtn = document.getElementById('conv-rename-btn');
const convStatus = document.getElementById('conv-status');
const convMessages = document.getElementById('conv-messages');
const onlyContactsToggle = document.getElementById('only-contacts-toggle');
const blockedList = document.getElementById('blocked-list');
const blockedEmpty = document.getElementById('blocked-empty');
const tabChats = document.getElementById('tab-chats');
const tabRequests = document.getElementById('tab-requests');
const requestsBadge = document.getElementById('requests-badge');
const requestsList = document.getElementById('requests-list');
const requestsEmpty = document.getElementById('requests-empty');
const confirmOverlay = document.getElementById('confirm-overlay');
const confirmOverlayTitle = document.getElementById('confirm-overlay-title');
const confirmOverlayBody = document.getElementById('confirm-overlay-body');
const confirmOverlayOk = document.getElementById('confirm-overlay-ok');
const confirmOverlayCancel = document.getElementById('confirm-overlay-cancel');

// CADS-webconference-demo#31: a WASM-thrown crypto error (holderSign,
// NoiseHandshake, encrypt/decrypt, etc.) can echo its offending input in
// the message string -- common in Rust-derived panic/error text -- and
// every key/secret this app ever handles (holderPriv, noisePriv, the
// operator pubkey, channel/grant hex) is exactly 64 hex characters. Applied
// at log()'s single choke point below (every log(...) call site in the
// file goes through it) rather than patched at each of the dozen+
// individual call sites, so this can't be defeated by a future call site
// someone forgets to sanitize by hand.
function sanitizeErrorMessage(msg) {
  return String(msg).replace(/\b[0-9a-fA-F]{64}\b/g, '[redacted]');
}

// CADS-webconference-demo#40 (finding 4): every real email entry point
// (identity screen, add-contact search, revoke access) uses an
// `<input type="email">`, which DOES block obviously-malformed input at the
// browser's own native-constraint-validation layer before the submit event
// even fires -- but that's not a substitute for an explicit check the app
// itself owns: it doesn't fire for requestSubmit()-driven submissions in
// every browser, isn't guaranteed if a future change adds `novalidate`, and
// gives no control over the error message shown. One shared, deliberately
// simple (not full RFC 5322) helper, applied at each real entry point below.
function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// CADS-webconference-demo#55: requested once per session, lazily -- not on
// page load (bad practice, browsers increasingly auto-suppress a
// permission prompt fired before any real interaction) but the first time
// runDialer actually establishes a real identity, which is itself already
// downstream of at least one real user action (the identity form, or an
// already-verified gate login). `default` is the only state worth acting
// on: 'granted'/'denied' both mean the user already decided.
let notificationPermissionRequested = false;
function ensureNotificationPermission() {
  if (typeof Notification === 'undefined' || notificationPermissionRequested) return;
  notificationPermissionRequested = true;
  if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
// Only actually notifies if permission is granted AND the tab genuinely
// isn't what the user is looking at right now (hidden OR unfocused) --
// a real messenger doesn't also toast-notify you about a message you're
// already reading. Clicking the notification focuses this tab back, same
// as any real chat app's own notifications.
function notifyIfHidden(title, body) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!document.hidden && document.hasFocus()) return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (_) {}
}

// CADS-webconference-demo#56: a short synthesized tone via Web Audio
// instead of bundling an actual audio asset -- no file to fetch/host/
// license, works identically everywhere, and is trivially easy to change
// later if a real sound file is ever wanted instead. Wrapped in try/catch
// throughout: browser autoplay policy can reject audio before any user
// gesture has happened on the page at all (rare here in practice, since
// reaching a real identity already implies at least one prior
// interaction) -- a rejected chime should never be a reason to break the
// call/message flow it's just decorating.
let audioCtx = null;
function playChime(freqs, toneMs = 150) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    freqs.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const start = now + i * (toneMs / 1000);
      const end = start + toneMs / 1000;
      gain.gain.setValueAtTime(0.15, start);
      gain.gain.exponentialRampToValueAtTime(0.001, end);
      osc.start(start);
      osc.stop(end);
    });
  } catch (_) {}
}
function playIncomingCallSound() { playChime([880, 660], 180); }
function playMessageSound() { playChime([660], 100); }

// Robustness audit finding (proactive review, not yet live-reproduced --
// needs a genuinely long-running call/session to observe, not a timing
// race): log() and addChatMessage() below both appendChild a new DOM node
// per call with nothing anywhere in the codebase ever pruning either list
// -- confirmed by grep, zero removeChild/firstChild references to logEl or
// chatLog outside this file. log() in particular is this app's single
// choke point for virtually every network/signaling/reconnect/ICE event
// across the whole call lifecycle (call-webrtc.js, call-channel.js,
// chat-glue.js, video-filters.js all funnel through it), so an hours-long
// call accumulates thousands of DOM nodes in the Technical readout panel,
// each appendChild + the scrollTop reflow below it getting incrementally
// more expensive as the list grows -- a real, if slow-building, memory/
// render-cost leak on a long-running call, same class of issue as #59's
// already-fixed unbounded blob: URL accumulation. addChatMessage has the
// identical shape for the in-call chat panel (every real chat message
// sent/received during a call, not just system notices). Capping both to
// a bounded, generously-sized ring buffer (pruning the OLDEST entries)
// keeps them from growing without limit while never losing meaningfully
// recent diagnostic/chat history during normal use.
const LOG_MAX_LINES = 500;
function log(msg) {
  // Timestamped (HH:MM:SS.mmm) so the Technical readout panel can show how
  // far apart events actually happened -- important for diagnosing stalls/
  // reconnects, where "it happened eventually" vs "it happened instantly"
  // is the whole question.
  msg = sanitizeErrorMessage(msg);
  const ts = new Date().toISOString().slice(11, 23);
  const line = document.createElement('div');
  line.textContent = `[${ts}] ${msg}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > LOG_MAX_LINES) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(`[${ts}] ${msg}`);
}

function setStatus(s) {
  statusEl.textContent = s;
  statusEl.dataset.status = s;
  statusText.textContent = s;
  const live = s === 'signaling-active' || s === 'in-call';
  statusPill.dataset.live = live ? '1' : '0';
}

function setIceState(s) {
  iceEl.textContent = s;
  iceEl.dataset.iceState = s;
  if (s === 'connected' || s === 'completed') {
    setStatus('in-call');
    routeWebrtc.classList.add('live');
    routePeer.classList.add('live');
    hideConnecting();
  }
}

// Reported as "the camera page shows up right after you place the call,
// even though the other side hasn't picked up yet". Backend gating was
// verified correct -- accepted_and_registered (and so navigation into run()
// at all) already requires the callee's own attestation -- the actual gap is
// UX: showCallScreen() below turns on your own camera immediately (it has
// to, to show you a preview and let you place the call), well before the
// real peer-to-peer link (WebRTC ICE, or the channel transport's Noise
// session) is actually up. This banner is the explicit "not yet connected"
// signal that was missing in that gap; hideConnecting() is called once real
// connectivity is confirmed -- see setIceState above (webrtc) and
// runChannelMediaCall (direct-channel, already-connected by the time it
// starts since the Noise handshake completes before it's invoked).
function showConnecting(peerLabel) {
  connectingBannerText.textContent = peerLabel ? `Connecting to ${peerLabel}…` : 'Connecting…';
  connectingBanner.hidden = false;
}
function hideConnecting() {
  connectingBanner.hidden = true;
}

// Same unbounded-growth reasoning as log()'s own comment above -- kept as
// a separate constant (not a shared LOG_MAX_LINES) since these are two
// independent panels with no reason to share a cap value.
const CHAT_LOG_MAX_LINES = 500;
function addChatMessage(text, who) {
  const div = document.createElement('div');
  div.className = who === 'system' ? 'chat-msg system' : `chat-msg ${who}`;
  if (who === 'system') {
    div.textContent = text;
  } else {
    const body = document.createElement('div');
    body.textContent = text;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = who === 'me' ? 'you' : 'peer';
    div.appendChild(body);
    div.appendChild(meta);
  }
  chatLog.appendChild(div);
  while (chatLog.childElementCount > CHAT_LOG_MAX_LINES) chatLog.removeChild(chatLog.firstChild);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setCtlLabel(btn, icon, label) {
  btn.querySelector('.ctl-icon').textContent = icon;
  btn.querySelector('.ctl-label').textContent = label;
  btn.setAttribute('aria-label', label);
}

// Live-reported: pairing's "no account on this device yet" prompt used a
// native browser confirm() -- this in-page overlay replaces it (and
// alert(), via showAlertOverlay below), reusing the single shared
// #confirm-overlay markup (index.html). Built with re-entrancy in mind
// from the start, matching this session's established double-submit/
// re-entrancy-guard pattern: the overlay can only ever show ONE prompt at
// a time, so if a second call arrives while one is still showing, the
// FIRST call's promise is resolved (as cancelled) before the second one
// takes over -- no caller is ever left with a permanently-unresolved
// promise.
let activeOverlayResolve = null;
function closeConfirmOverlay(result) {
  confirmOverlay.hidden = true;
  confirmOverlayOk.onclick = null;
  confirmOverlayCancel.onclick = null;
  const resolve = activeOverlayResolve;
  activeOverlayResolve = null;
  if (resolve) resolve(result);
}
function showConfirmOverlay({ title, body, confirmLabel = 'OK', cancelLabel = 'Cancel' }) {
  if (activeOverlayResolve) closeConfirmOverlay(false);
  return new Promise((resolve) => {
    activeOverlayResolve = resolve;
    confirmOverlayTitle.textContent = title;
    confirmOverlayBody.textContent = body;
    confirmOverlayOk.textContent = confirmLabel;
    confirmOverlayCancel.textContent = cancelLabel;
    confirmOverlayCancel.hidden = false;
    confirmOverlayOk.onclick = () => closeConfirmOverlay(true);
    confirmOverlayCancel.onclick = () => closeConfirmOverlay(false);
    confirmOverlay.hidden = false;
  });
}
// Single-button variant (replaces alert()) -- same shared overlay, cancel
// button hidden, resolves once OK is clicked.
function showAlertOverlay({ title, body, okLabel = 'OK' }) {
  if (activeOverlayResolve) closeConfirmOverlay(false);
  return new Promise((resolve) => {
    activeOverlayResolve = () => resolve();
    confirmOverlayTitle.textContent = title;
    confirmOverlayBody.textContent = body;
    confirmOverlayOk.textContent = okLabel;
    confirmOverlayCancel.hidden = true;
    confirmOverlayOk.onclick = () => closeConfirmOverlay();
    confirmOverlayCancel.onclick = null;
    confirmOverlay.hidden = false;
  });
}

// Live-reported: after a call ends (hangup reload, or a hung/frozen peer
// finally getting torn down) the page could sit showing only the bare
// hero/eyebrow text for a real, user-perceptible stretch -- neither this
// function nor showCallScreen had run yet (both need a real WASM module
// load, and the verified-login path also a live /api/whoami round-trip,
// to complete first), with nothing signaling loading was in progress. On
// a degraded connection -- likely exactly the condition already true if
// what triggered the reload was a peer/connection problem -- this read as
// landing on an unrelated/broken page. #boot-loading (index.html, visible
// from first paint, no [hidden] there) covers that gap; hidden here since
// every real code path (runIdentityScreen, run()) calls one of these two
// functions before revealing anything else, so this is the single choke
// point where "we now know what to show" is first true.
function showSetupScreen() {
  bootLoading.hidden = true;
  setupScreen.hidden = false;
  callScreen.hidden = true;
}

function showCallScreen() {
  bootLoading.hidden = true;
  setupScreen.hidden = true;
  siteHero.hidden = true;
  landingMain.hidden = true;
  messengerShell.hidden = true;
  callScreen.hidden = false;
}

// Live-requested: same "hide everything else, show this one" pattern as
// showSetupScreen/showCallScreen above, for the two new screens. Simple
// mode and the messenger shell are mutually exclusive alternate views of
// the SAME logged-in dialer state (never both at once); the practice
// screen is reachable from either and returns to whichever one opened it.
function showSimpleScreen() {
  bootLoading.hidden = true;
  siteHero.hidden = true;
  landingMain.hidden = true;
  messengerShell.hidden = true;
  practiceScreen.hidden = true;
  simpleScreen.hidden = false;
}
function showMessengerShell() {
  simpleScreen.hidden = true;
  practiceScreen.hidden = true;
  messengerShell.hidden = false;
}
function showPracticeScreen() {
  simpleScreen.hidden = true;
  messengerShell.hidden = true;
  practiceScreen.hidden = false;
}

export {
  setupScreen, callScreen, siteHero, landingMain, statusEl, iceEl, logEl, statusPill,
  statusText, localVideo, remoteVideo, localEmpty, remoteEmpty, btnMic, btnCam, btnHangup,
  chatLog, chatForm, chatInput, chatSend, routeYou, routeSignal, routeWebrtc, routePeer,
  connectingBanner, connectingBannerText, offlineBanner,
  idEntry, idForm, idEmailInput, idVerifyError, idVerifyErrorDetail, idVerifyRetry,
  idGateRequired, idGateLoginBtn, idGateRegisterForm, idGateRegisterEmail, myEmailEl,
  dialForm, dialEmailInput, callNote, incomingCard, incomingFrom, btnAccept, btnDecline,
  btnCancelCall, logoutLink, transportChannelCheckbox, contactsList, contactsEmpty,
  accessRemoveForm, accessRemoveEmail, accessNote, revokeAccessDetails, accessRemoveConsoleLink,
  accessRequestsDetails, accessRequestsBadge, accessRequestsList, accessRequestsEmpty,
  videoGrid, localTile, btnSwitchCamera, btnVideoFilters, filterMenu, filterMenuNote, filterMenuItems, messengerShell, msgMenuToggle,
  simpleModeEnterBtn, simpleScreen, simpleExitBtn, simpleTiles, simpleTilesEmpty, simplePracticeBtn,
  practiceScreen, practiceVideo, practiceFilterRow, practiceDoneBtn, practiceEmpty,
  showSimpleScreen, showMessengerShell, showPracticeScreen,
  msgMenu, msgSearchForm, msgSearchInput, msgConvPlaceholder, msgConversation, msgBackBtn,
  msgCallBtn, msgBlockBtn, msgComposeForm, msgComposeInput, msgAttachBtn, msgAttachInput,
  convAvatar, convName, convRenameBtn, convStatus, convMessages, onlyContactsToggle,
  blockedList, blockedEmpty, tabChats, tabRequests, requestsBadge, requestsList, requestsEmpty,
  sanitizeErrorMessage, isValidEmail, ensureNotificationPermission, notifyIfHidden,
  playIncomingCallSound, playMessageSound, log, setStatus, setIceState, showConnecting,
  hideConnecting, addChatMessage, setCtlLabel, showSetupScreen, showCallScreen,
  showConfirmOverlay, showAlertOverlay,
};
