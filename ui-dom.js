// Generic DOM-ref lookups and UI helpers shared across every concern area of
// this app (identity, dialer, chat, both call transports, video filters,
// pairing, access-requests) -- pure presentation glue, no protocol/crypto
// logic of its own. Split out of app.js as part of the client-code
// consolidation (CADS-webconference-demo#91); every function/const here is a
// verbatim move, comments included, with no behavior change.

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
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setCtlLabel(btn, icon, label) {
  btn.querySelector('.ctl-icon').textContent = icon;
  btn.querySelector('.ctl-label').textContent = label;
  btn.setAttribute('aria-label', label);
}

function showSetupScreen() {
  setupScreen.hidden = false;
  callScreen.hidden = true;
}

function showCallScreen() {
  setupScreen.hidden = true;
  siteHero.hidden = true;
  landingMain.hidden = true;
  messengerShell.hidden = true;
  callScreen.hidden = false;
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
  msgMenu, msgSearchForm, msgSearchInput, msgConvPlaceholder, msgConversation, msgBackBtn,
  msgCallBtn, msgBlockBtn, msgComposeForm, msgComposeInput, msgAttachBtn, msgAttachInput,
  convAvatar, convName, convRenameBtn, convStatus, convMessages, onlyContactsToggle,
  blockedList, blockedEmpty, tabChats, tabRequests, requestsBadge, requestsList, requestsEmpty,
  sanitizeErrorMessage, isValidEmail, ensureNotificationPermission, notifyIfHidden,
  playIncomingCallSound, playMessageSound, log, setStatus, setIceState, showConnecting,
  hideConnecting, addChatMessage, setCtlLabel, showSetupScreen, showCallScreen,
};
