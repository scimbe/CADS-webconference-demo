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

// A byte-stream reader over a browser WebSocket's inbound binary messages --
// concatenates every inbound message into one buffer and serves however many
// bytes are asked for, matching the server's own WsByteStream semantics
// exactly (message boundaries carry no meaning on this transport).
// Backstop for WsByteStream._waitForBytes -- see its own comment. 60s is
// generous enough not to fire during a real quiet call (long gaps between
// chat messages are normal), just there to fail loudly instead of hanging
// silently forever if something ever stalls the underlying byte stream.
const STALL_TIMEOUT_MS = 60000;
// See readLine()'s own comment -- its one real caller expects at most a few
// hundred bytes; this is a generous multiple of that, not a tight fit.
const MAX_LINE_BYTES = 4096;

class WsByteStream {
  constructor(ws) {
    this.ws = ws;
    this.chunks = [];
    this.totalLen = 0;
    this.waiters = [];
    this.closed = false;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (ev) => {
      this.chunks.push(new Uint8Array(ev.data));
      this.totalLen += ev.data.byteLength;
      this._wake();
    });
    ws.addEventListener('close', (ev) => {
      this.closed = true;
      log(`byte stream socket closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ''}, clean=${ev.wasClean})`);
      this._wake();
    });
    ws.addEventListener('error', () => log('byte stream socket error'));
  }
  _concat() {
    if (this.chunks.length <= 1) return this.chunks[0] || new Uint8Array(0);
    const out = new Uint8Array(this.totalLen);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    this.chunks = [out];
    return out;
  }
  _wake() {
    // Only settle a waiter once totalLen genuinely satisfies what it asked
    // for -- see _waitForBytes's comment for why "any bytes at all" was wrong.
    for (const w of this.waiters) {
      if (!w.done && (this.totalLen >= w.need || this.closed)) w.settle();
    }
    this.waiters = this.waiters.filter((w) => !w.done);
  }
  // Suspends until at least `need` bytes are buffered (or the socket
  // closes). The previous version resolved as soon as ANY byte existed,
  // regardless of `need` -- readExact(n) would then immediately re-check
  // `totalLen < n`, find it still true, and call this again, which
  // immediately resolved again: a tight microtask loop with no real
  // suspension at all. That starves the renderer's macrotask queue solid --
  // no clicks, no repaints, not even DevTools console input gets processed
  // -- without ever throwing or crashing, exactly the "frozen tab, had to
  // force-quit" symptom hit in both Safari and Chrome. `timeoutMs` is a
  // backstop against any *other*, not-yet-understood stall of this shape:
  // it turns a silent hang into a clean, catchable error instead.
  async _waitForBytes(need, timeoutMs = STALL_TIMEOUT_MS) {
    if (this.totalLen >= need || this.closed) return;
    await new Promise((resolve, reject) => {
      const entry = {
        need,
        done: false,
        settle: () => {
          if (entry.done) return;
          entry.done = true;
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        if (entry.done) return;
        entry.done = true;
        reject(new Error(`stalled: no new data for ${timeoutMs}ms while waiting for ${need} bytes (have ${this.totalLen})`));
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }
  async readExact(n, timeoutMs) {
    while (this.totalLen < n) {
      if (this.closed) throw new Error(`connection closed while reading ${n} bytes`);
      await this._waitForBytes(n, timeoutMs);
    }
    const buf = this._concat();
    const out = buf.slice(0, n);
    this.chunks = [buf.slice(n)];
    this.totalLen -= n;
    return out;
  }
  async readLine() {
    while (true) {
      const buf = this._concat();
      const idx = buf.indexOf(0x0a);
      if (idx !== -1) {
        const out = buf.slice(0, idx + 1);
        this.chunks = [buf.slice(idx + 1)];
        this.totalLen -= idx + 1;
        return new TextDecoder().decode(out);
      }
      // CADS-webconference-demo#38 (finding 8): the only caller (joinChannel,
      // reading the bridge's one-line ack response) expects at most a few
      // hundred bytes -- STALL_TIMEOUT_MS above only bounds growth if bytes
      // stop arriving entirely; a server streaming continuous bytes with no
      // '\n' would otherwise never stall and grow this buffer unboundedly.
      // A generous cap catches that case without touching readExact, which
      // legitimately needs to handle large media-chunk frames.
      if (buf.length > MAX_LINE_BYTES) throw new Error(`readLine exceeded ${MAX_LINE_BYTES} bytes with no newline -- treating as a malformed/hostile stream`);
      if (this.closed) throw new Error('connection closed while reading a line');
      // No fixed target length here (we don't know where '\n' will land) --
      // wait for strictly more bytes than we currently have, so this
      // properly re-suspends instead of spinning the same way readExact did.
      await this._waitForBytes(this.totalLen + 1);
    }
  }
  send(bytes) {
    this.ws.send(bytes);
  }
}

async function writeFramed(stream, bytes) {
  stream.send(wasm.frame_message(bytes));
}

// CADS-webconference-demo#69: bounds an arbitrary promise to a deadline
// without cancelling the underlying work (join/handshake in-flight network
// calls have no cancellation hook here) -- just stops waiting on it and lets
// the caller treat a too-slow attempt the same as a failed one. The original
// `promise` keeps running after losing the race (e.g. a channel reconnect
// attempt stuck in WsByteStream's own 60s STALL_TIMEOUT_MS, well past this
// function's shorter deadline) and settles on its own later with nothing
// else awaiting it. Tested this directly rather than assuming: Promise.race
// already subscribes to every input promise internally to detect which
// settles first, and that alone is enough to suppress the browser's
// unhandled-rejection reporting for a losing promise that rejects later --
// confirmed empirically, no unhandledrejection event fires even with zero
// explicit .catch() here. So the no-op .catch() below is harmless defense-
// in-depth (a second, redundant handler), not a fix for a reproduced bug.
function withTimeout(promise, ms, message) {
  promise.catch(() => {});
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

async function readFramed(stream, timeoutMs) {
  const lenBytes = await stream.readExact(2, timeoutMs);
  const len = (lenBytes[0] << 8) | lenBytes[1];
  return stream.readExact(len, timeoutMs);
}

// The join response is either a 2-byte b"NO" refusal or a 32-byte challenge --
// two fixed lengths with no framing to disambiguate up front.
async function readChallengeOrRefusal(stream) {
  const first2 = await stream.readExact(2);
  if (first2[0] === 0x4e && first2[1] === 0x4f) {
    return { refused: true };
  }
  const rest = await stream.readExact(30);
  const challenge = new Uint8Array(32);
  challenge.set(first2, 0);
  challenge.set(rest, 2);
  return { refused: false, challenge };
}

async function joinChannel(wsUrl, grantHex, holderPrivHex) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });
  const stream = new WsByteStream(ws);

  const joinReq = wasm.buildChannelJoinRequest(grantHex, 'relay-only');
  await writeFramed(stream, joinReq);

  const resp = await readChallengeOrRefusal(stream);
  if (resp.refused) throw new Error('channel join refused');
  const sig = wasm.holderSign(holderPrivHex, resp.challenge);
  stream.send(sig);

  const ackLine = await stream.readLine();
  log(`ack: ${ackLine.trim()}`);
  if (!ackLine.startsWith('OK ')) throw new Error(`unexpected ack line: ${ackLine}`);
  const parts = ackLine.trim().split(' ');
  const peerNoiseHex = parts.length === 5 ? parts[2] : null;

  return { ws, stream, peerNoiseHex };
}

// CADS-webconference-demo (user feedback): this used to be acquired as soon
// as the dialer/messenger screen came up (preloadLocalMedia, called from
// runDialer) rather than only once a call actually starts -- trading a real
// cost (the camera/mic light stays on the entire time someone's just
// browsing contacts or chatting, not only while actually calling) for
// shaving getUserMedia's latency off the start of a call. Not worth it,
// especially now that most time in this app has nothing to do with calling
// at all. Acquired fresh at getLocalMedia() call time now -- i.e. only once
// a call is actually starting -- accepting the latency this trades back in.
// 'user' (front/selfie) is the sane default on a device with two cameras;
// meaningless-but-harmless on a desktop webcam, which just ignores facingMode.
let currentFacingMode = 'user';
let cameraSwitchAvailable = false;

async function getLocalMedia() {
  let media;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: currentFacingMode } });
    log('real camera/microphone acquired');
    media = { kind: 'media', stream };
  } catch (e) {
    log(`getUserMedia unavailable (${e.name || e}); falling back to a data channel probe -- \
the same RTCPeerConnection/ICE machinery a real audio/video call uses, just without a \
capture device attached in this environment`);
    media = { kind: 'probe' };
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameraSwitchAvailable = devices.filter((d) => d.kind === 'videoinput').length > 1;
  } catch (_) {
    // enumerateDevices itself failing isn't fatal -- the switch button just
    // stays hidden, same as genuinely having only one camera.
  }
  btnSwitchCamera.hidden = !cameraSwitchAvailable;
  return media;
}

// CADS-webconference-demo#38 (finding 7): switchCamera needs the active
// RTCPeerConnection but is declared outside run()'s closure (it's shared by
// both transports' hangup/control wiring) -- this used to be reached via
// `window.__ctVideoCallDemo.pc`, a live handle any script on the page
// (extension, or an XSS if one ever landed despite the CSP) could use to
// drive the call, decrypt/encrypt arbitrary Noise frames, or inject
// signaling. A module-private variable gives switchCamera the same access
// without handing it to the whole page. Only ever set/cleared from run()'s
// own webrtc branch below.
let activeWebrtcPc = null;

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

// Live front/back swap. Always correct for the local preview (video elements
// track live additions/removals on the SAME MediaStream object). For an
// active WebRTC call, also pushes the new track to the peer via
// RTCRtpSender.replaceTrack -- the API this exists for, no renegotiation
// needed. The experimental direct-channel transport (MediaRecorder-based, no
// RTCPeerConnection) only gets the corrected LOCAL preview here -- its
// recorder was already told a fixed stream, so switching mid-call keeps
// sending the callee the outgoing track (before the swap), not a hard bug.
async function switchCamera(media) {
  if (media.kind !== 'media' || !cameraSwitchAvailable) return;
  const nextFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: nextFacingMode } });
    const newTrack = newStream.getVideoTracks()[0];
    const oldTrack = media.stream.getVideoTracks()[0];
    if (oldTrack) {
      media.stream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    media.stream.addTrack(newTrack);
    currentFacingMode = nextFacingMode;
    if (activeWebrtcPc) {
      const sender = activeWebrtcPc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }
  } catch (e) {
    log(`camera switch failed: ${e.message || e}`);
  }
}

// Sentinel chat message (not user-enterable -- \0 can't come from the text
// input) so a peer whose getLocalMedia() fell back to a data-channel-only
// probe (no camera/mic acquired: permission denied, in use elsewhere, or no
// hardware) can tell the other side, instead of the other side just seeing
// no video with no explanation of why -- easy to mistake for an app bug
// rather than the peer's own capture failure.
const NO_CAMERA_SENTINEL = '\u0000no-camera';

// Distinct from NO_CAMERA_SENTINEL: the peer has a working camera, but their
// browser can't produce any of this transport's supported codecs (notably
// Safari/WebKit, whose MediaSource Extensions support neither WebM nor
// VP8/VP9/Opus at all) -- telling them "no camera" here would be flat wrong.
const NO_CODEC_SENTINEL = '\u0000no-codec';

// CADS-webconference-demo#21: markDelivered() used to run immediately after
// send(), with nothing confirming the peer actually got the frame -- a
// channel/tab/network death between send() and the peer processing it
// silently and PERMANENTLY lost the message (already marked delivered
// locally, so it would never be retried). Every place that handles an
// incoming TAG_CHAT frame now sends a small {ack:seq} envelope right back
// over the same channel (see each receive loop's own comment); an
// AckWaiter matches those to the sends still waiting on them. One per
// live channel/session -- never shared across connections, so a stale ack
// from a previous session can't spuriously resolve a new one.
function createAckWaiter() {
  const pending = new Map(); // seq -> {resolve, reject}
  return {
    wait(seq, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(seq);
          reject(new Error(`no ack for seq ${seq} within ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(seq, { resolve: () => { clearTimeout(timer); pending.delete(seq); resolve(); } });
      });
    },
    resolve(seq) {
      pending.get(seq)?.resolve();
    },
  };
}

// Sends every message composed while offline (chatStore.pendingOutbox) the
// moment a live channel to that peer actually opens -- called from both
// transports' own "channel just opened" point. `send` is transport-specific
// (WebRTC datachannel.send(str) vs. the Noise-channel sendText(TAG_CHAT, str))
// so this stays agnostic to which one is live. Only marks a message
// delivered once its ack actually arrives; stops flushing (leaving the rest
// pending) the moment one doesn't -- a dead channel mid-flush shouldn't
// spray the remaining queue into the void, just leave it for next time.
// CADS-webconference-demo#49: onDelivered is an optional callback fired
// with each message's seq right after it's actually confirmed delivered --
// added specifically so the messenger conversation pane (appendConvMessage)
// can flip an already-rendered "sending…" bubble to delivered live,
// without this function needing to know anything about that DOM. Before
// this, a message delivered entirely in the background (no call, no page
// reload -- the whole point of the async chat-delivery feature) left its
// bubble showing "sending…" forever, even though it had genuinely gone
// through -- the only way to see the correct state was to close and reopen
// the conversation (a fresh history() read). Not wired into the in-call
// chat panels' own two flushOutbox call sites (a separate DOM, #chat-log,
// that doesn't have a "pending" concept at all -- addChatMessage renders
// a live send immediately, no bubble to update).
// CADS-webconference-demo#50: sendFile is an optional transport-specific
// callback for a kind:'file' outbox item -- (m) => Promise<void>, expected
// to have fully sent the file's init+chunks by the time it resolves (the
// ack this function awaits right after is what actually confirms
// delivery, same contract as a text send). Only backgroundChatSession
// passes one today (the async/offline-capable delivery path -- the same
// one text already uses, per the "offline behaves like messages" design);
// the two in-call chat panels don't, so a file outbox item reaching
// either of those two call sites is simply skipped rather than sent as
// malformed text -- correct today since composing a file attachment only
// ever happens from the messenger pane, which always delivers through
// backgroundChatSession.
async function flushOutbox(chatStore, peerEmail, send, ackWaiter, onDelivered, sendFile) {
  if (!chatStore || !peerEmail) return;
  const outbox = await chatStore.pendingOutbox(peerEmail);
  for (const m of outbox) {
    if (m.kind === 'file' && !sendFile) continue; // this transport can't send files -- leave it pending for a transport that can
    // CADS-webconference-demo#43 (finding 3): only ackWaiter.wait() was
    // wrapped -- send() itself could throw synchronously (e.g. a data
    // channel raising InvalidStateError mid-close) and propagate straight
    // out of this function. Both call sites are fire-and-forget with no
    // .catch(), so that surfaced as an unhandled promise rejection. The
    // message was never actually lost either way (it just stays pending,
    // same as an ack timeout) -- this only changes whether the failure is
    // handled cleanly or crashes out as unhandled.
    try {
      if (m.kind === 'file') await sendFile(m);
      else send(JSON.stringify({ seq: m.seq, text: m.text }));
      await ackWaiter.wait(m.seq);
    } catch (e) {
      log(`flushOutbox: stopping (seq ${m.seq} to ${peerEmail} not confirmed: ${e.message || e}) -- rest stays queued for next attempt`);
      break;
    }
    await chatStore.markDelivered(peerEmail, m.seq);
    onDelivered?.(m.seq);
  }
}

// ============ Background chat delivery (no call, no page reload) ============
// Being mutual contacts and both online was never enough on its own for a
// queued message to actually leave the device -- delivery only ever
// happened as a side effect of a REAL call's chat channel opening. This
// closes that gap with its own lightweight session over the exact same
// grant/attest/channel/Noise_IK machinery a real call uses (bridge's
// /api/call now accepts kind:'chat-delivery' -- see server.js), just
// without ever reaching startCallFromIdentity's location.search reload:
// run() and its call-screen UI are never involved, so a message send can't
// visibly interrupt whatever the recipient is doing. Both sides run the
// SAME backgroundChatSession once connected -- there's no "sender vs.
// receiver" asymmetry once the channel is up, only caller-vs-callee for
// the Noise handshake's own initiator/responder roles.

let wasmInitPromise = null;
function ensureWasmInit() {
  return wasmInitPromise || (wasmInitPromise = init('./pkg/ct_agent_wasm_bg.wasm'));
}

// How long a background session keeps listening for a reply after sending
// its own outbox -- bounded so an idle WS doesn't linger forever holding a
// channel open. Generous enough to comfortably cover the peer's own
// symmetric flush-then-listen sequence on a slow connection.
const BACKGROUND_CHAT_WINDOW_MS = 8000;
// CADS-webconference-demo#50: BACKGROUND_CHAT_WINDOW_MS above was sized
// for tiny text messages -- nowhere near enough for a chunked multi-MB
// file transfer over a relayed connection. fileTransferWindowMs extends
// the session's deadline (see backgroundChatSession) based on the
// declared file size the moment a transfer starts, assuming a
// deliberately pessimistic ~50KB/s floor throughput, capped at 5 minutes
// so a stalled/hostile peer still can't hold the connection open forever.
function fileTransferWindowMs(sizeBytes) {
  return Math.min(5 * 60 * 1000, Math.max(BACKGROUND_CHAT_WINDOW_MS, (sizeBytes / 1024) * 50));
}

async function connectBackgroundChannel(wsUrl, grantHex, holderPrivHex, noisePrivHex, isCaller) {
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

// Flushes this identity's own outbox, then listens for up to
// BACKGROUND_CHAT_WINDOW_MS for anything the peer sends back (their own
// symmetric flush) -- decrypts and records it via the SAME chatStore the
// messenger pane reads from, and live-appends it if that conversation
// happens to be open right now. Never touches call-status/ringing state;
// a plain WS close at the end is a normal, expected end to this session,
// not a "peer hung up" signal the way it would be mid-call.
async function backgroundChatSession(stream, noiseTransport, isCaller, chatStore, peerEmail) {
  const sendTagged = (tag, bytes) => writeFramed(stream, noiseTransport.encrypt(concatBytes(new Uint8Array([tag]), bytes)));
  const send = (text) => sendTagged(TAG_CHAT, new TextEncoder().encode(text));
  // CADS-webconference-demo#50: sends a pending file outbox item's
  // TAG_FILE_INIT header (seq/name/mimeType/size, so the receiver knows
  // what's coming and how to reassemble it) followed by its bytes chunked
  // at FILE_CHUNK_BYTES -- same shape as TAG_MEDIA_INIT/CHUNK already used
  // for the experimental video path. Resolves once every chunk has been
  // handed to the socket; flushOutbox (the caller) then awaits the ack the
  // same way it does for a text send.
  const sendFile = async (m) => {
    deadline = Math.max(deadline, Date.now() + fileTransferWindowMs(m.fileBytes.length));
    sendTagged(TAG_FILE_INIT, new TextEncoder().encode(JSON.stringify({ seq: m.seq, name: m.fileName, mimeType: m.fileMimeType, size: m.fileSize })));
    for (let off = 0; off < m.fileBytes.length; off += FILE_CHUNK_BYTES) {
      sendTagged(TAG_FILE_CHUNK, m.fileBytes.subarray(off, off + FILE_CHUNK_BYTES));
    }
  };
  const ackWaiter = createAckWaiter();
  // Runs CONCURRENTLY with the receive loop below, not before it -- flushOutbox
  // now awaits an ack for each send, and that ack can only ever arrive via
  // this same function's own receive loop, so awaiting the flush first would
  // deadlock waiting for a reply nothing is listening for yet.
  // CADS-webconference-demo#49: this is the async/background delivery path
  // (no call, no page reload) -- exactly the case a message could go from
  // pending to delivered while the messenger conversation pane is sitting
  // open, so it's the one flushOutbox call site that needs to keep an
  // already-rendered bubble in sync. Scoped to the currently-open
  // conversation only -- markConvMessageDelivered itself already no-ops if
  // its bubble isn't on screen, but checking here too avoids searching the
  // DOM at all for the (common) case where a different or no conversation
  // is open.
  const flushPromise = flushOutbox(chatStore, peerEmail, send, ackWaiter, (seq) => {
    if (currentConversationEmail === peerEmail.toLowerCase()) markConvMessageDelivered(seq);
  }, sendFile);
  // CADS-webconference-demo#50: an in-progress incoming file transfer --
  // only one at a time can be in flight (the sender's own flushOutbox is
  // ack-gated, one outbox item fully delivered before the next starts), so
  // tracking a single "current" transfer by seq is enough, no need to key
  // this by anything else.
  let incomingFile = null;
  // CADS-webconference-demo#50: mutable (not const) -- extended by
  // fileTransferWindowMs whenever a file transfer starts, in either
  // direction (sendFile below, and the TAG_FILE_INIT receive handler),
  // since BACKGROUND_CHAT_WINDOW_MS alone is nowhere near enough for a
  // multi-MB chunked transfer.
  let deadline = Date.now() + BACKGROUND_CHAT_WINDOW_MS;
  try {
    while (Date.now() < deadline) {
      const cipher = await readFramed(stream, deadline - Date.now());
      const plain = noiseTransport.decrypt(cipher);
      const tag = plain[0];
      const payload = plain.slice(1);
      if (tag === TAG_FILE_INIT) {
        let header;
        try {
          header = JSON.parse(new TextDecoder().decode(payload));
        } catch {
          continue; // malformed header -- nothing to reassemble
        }
        // CADS-webconference-demo#58 (secondary finding): the cap check
        // only ever rejected a `size` that WAS a number and over the cap --
        // a missing/non-number/negative size skipped the check entirely,
        // and `received < size` (below) is immediately false for a
        // negative/zero/undefined size, so the very first chunk completed
        // reassembly with the declared size never actually validated
        // against anything. Coerced to a safe non-negative integer up
        // front instead; anything that doesn't coerce cleanly is treated
        // as a hostile/malformed header, same as exceeding the cap.
        const declaredSize = Number(header.size);
        if (!Number.isInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_FILE_BYTES) {
          log(`incoming file from ${peerEmail} has an invalid or over-cap declared size (${header.size}) -- refusing to buffer it`);
          incomingFile = null;
          continue;
        }
        // CADS-webconference-demo#75: a single pre-sized buffer, written at
        // an advancing offset, instead of an array of per-chunk Uint8Arrays
        // concatenated at the end. The byte cap above (declaredSize <=
        // MAX_FILE_BYTES) bounds cumulative BYTES but not CHUNK COUNT -- a
        // peer sending an under-cap file as millions of 1-byte chunks paid
        // no penalty from that check at all: each chunk is its own
        // Uint8Array/ArrayBuffer (V8 per-object overhead runs to hundreds
        // of bytes even for a 1-byte view), so `chunks` could balloon to
        // multiple GB well before `received` ever approached the byte cap,
        // and concatBytes(...chunks) then spread millions of arguments onto
        // one call, which V8 either hangs on or throws "Maximum call stack
        // size exceeded" for. A fixed buffer makes both impossible
        // regardless of how the peer chunks the transfer: resident memory
        // is capped at declaredSize (one allocation, not N), and there's no
        // spread left to blow up.
        incomingFile = { seq: header.seq, name: header.name, mimeType: header.mimeType, size: declaredSize, buf: new Uint8Array(declaredSize), received: 0 };
        deadline = Math.max(deadline, Date.now() + fileTransferWindowMs(declaredSize));
        continue;
      }
      if (tag === TAG_FILE_CHUNK) {
        if (!incomingFile) continue; // chunk with no preceding (or an already-abandoned) init -- nothing to append to
        // CADS-webconference-demo#75: a chunk that would overshoot the
        // buffer sized to the DECLARED size is abandoned outright, not
        // silently truncated -- a sender that can't stick to its own
        // declared size is either lying or buggy, and truncating a chunk
        // instead of failing loudly would deliver a corrupted file with no
        // indication anything was wrong. This also closes the pre-existing
        // wrinkle where the final chunk could overshoot `size` and the
        // whole oversized chunk still got concatenated in. No separate
        // MAX_FILE_BYTES check needed here anymore -- TAG_FILE_INIT above
        // already rejects any declaredSize over that cap, so `size` (and
        // therefore this buffer) can never itself exceed MAX_FILE_BYTES.
        if (incomingFile.received + payload.length > incomingFile.size) {
          log(`incoming file from ${peerEmail} sent more data than its declared size -- abandoning it`);
          incomingFile = null;
          continue;
        }
        incomingFile.buf.set(payload, incomingFile.received);
        incomingFile.received += payload.length;
        if (incomingFile.received < incomingFile.size) continue; // more chunks still coming
        const fileBytes = incomingFile.buf.subarray(0, incomingFile.received);
        const { seq, name, mimeType } = incomingFile;
        incomingFile = null;
        if (chatStore && peerEmail) {
          // CADS-webconference-demo#58 (secondary finding): record the
          // ACTUAL reassembled byte length, not the sender's declared
          // size -- a sender can freely lie about the header (declare 100,
          // send 200), and storing the declared value would persist that
          // mismatch as fileSize metadata forever. fileBytes.length is
          // exactly what's really there.
          const recorded = await chatStore.record({ peerEmail, from: 'peer', seq, received: true, kind: 'file', fileName: name, fileMimeType: mimeType, fileSize: fileBytes.length, fileBytes });
          send(JSON.stringify({ ack: seq }));
          if (currentConversationEmail === peerEmail.toLowerCase()) appendConvMessage(recorded);
          refreshContacts();
          notifyIfHidden(peerEmail, `📎 ${name || 'Sent a file'}`); // CADS-webconference-demo#55/#56
          playMessageSound();
        }
        continue;
      }
      if (tag !== TAG_CHAT) continue;
      const raw = new TextDecoder().decode(payload);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // sentinel or malformed frame -- nothing to record
      }
      if (parsed.ack != null) {
        ackWaiter.resolve(parsed.ack);
        continue;
      }
      const { seq, text } = parsed;
      if (chatStore && peerEmail && seq != null && text != null) {
        // CADS-webconference-demo#43 (finding 2): used to send the ack
        // BEFORE persisting -- if record() ever threw, the sender would
        // already have its ack and mark the message delivered even though
        // this side never actually stored it, a narrow window where #21's
        // "ack implies persisted" guarantee didn't fully hold. Persist
        // first, ack only once that succeeds.
        await chatStore.record({ peerEmail, from: 'peer', text, seq, received: true });
        send(JSON.stringify({ ack: seq })); // CADS-webconference-demo#21 -- see createAckWaiter's comment
        if (currentConversationEmail === peerEmail.toLowerCase()) appendConvMessage({ from: 'peer', text, pending: false });
        refreshContacts(); // updates the list-pane preview text
        notifyIfHidden(peerEmail, text); // CADS-webconference-demo#55/#56
        playMessageSound();
      }
    }
  } catch {
    // Timed out waiting for more, or the peer closed -- a normal end to a
    // background session, not an error worth surfacing anywhere.
  } finally {
    await flushPromise.catch(() => {}); // let any still-in-flight send finish before we close under it
    stream.ws.close();
  }
}

// Per-peer guard so the compose-time trigger and the periodic sweep below
// can't both open a second background session for the same peer at once.
const deliveryInFlight = new Set();

// Caller-initiated half: called (a) right after composing a message, and
// (b) periodically for any contact with a non-empty outbox, so a message
// composed while the peer was offline still gets picked up once they come
// back online without needing another explicit action. No-ops quietly if
// there's nothing queued or the peer isn't online -- this is a background
// sweep, not a user-facing action, so it never surfaces its own errors.
async function tryBackgroundDeliver(identity, peerEmail) {
  const key = peerEmail.toLowerCase();
  if (deliveryInFlight.has(key)) return;
  if (!dialerChatStore) return;
  // CADS-webconference-demo#39 (finding 1): blocking someone is supposed to
  // stop them being reached "at all" (see showIncoming's own comment on the
  // inbound side, which already checks this) -- this outbound sweep never
  // did, so a queued outbox message to a peer blocked AFTER composing it
  // still got delivered on the next sweep.
  if (blockedEmails.has(key)) return;
  // CADS-webconference-demo#39 (finding 2): used to add(key) only after
  // awaiting pendingOutbox()/presence below -- two concurrent triggers for
  // the same peer (the compose-time call and the 10s periodic sweep landing
  // together) both passed the has() check above before either finished
  // those awaits, both proceeded, and both delivered the entire outbox --
  // every queued message sent twice. Marking in-flight synchronously here,
  // before any await, closes that window; the try/finally below now covers
  // every return path so this always gets cleared.
  deliveryInFlight.add(key);
  try {
    const outbox = await dialerChatStore.pendingOutbox(peerEmail);
    if (!outbox.length) return;
    const presence = await api(`/presence?email=${encodeURIComponent(peerEmail)}`);
    if (!presence.online) return;
    await ensureWasmInit();
    const resp = await api('/call', { body: { fromEmail: identity.email, toEmail: peerEmail, transport: 'channel', kind: 'chat-delivery' } });
    if (resp.error || resp.status === 'offline') return;
    const attestation = computeAttestation(resp.channel, identity.holderPriv, identity.holderPub, identity.noisePub);
    const attestResp = await api('/attest', {
      body: { channel: resp.channel, role: 'caller', holderPub: identity.holderPub, noisePub: identity.noisePub, attestation },
    });
    if (attestResp.error) return;
    if (attestResp.status?.state !== 'accepted_and_registered') {
      // The callee auto-attests near-instantly (no human ringing wait for
      // chat-delivery) -- a short poll covers the one real round-trip delay
      // (their attest + this bridge's own tryRegister control-plane calls).
      let accepted = false;
      await pollCallStatus(resp.channel, {
        timeoutMs: 10000,
        intervalMs: 500,
        onDone: (ok) => { accepted = ok; },
      });
      if (!accepted) return;
    }
    const { stream, noiseTransport } = await connectBackgroundChannel(resp.ws, resp.grant, identity.holderPriv, identity.noisePriv, true);
    await backgroundChatSession(stream, noiseTransport, true, dialerChatStore, peerEmail);
  } catch (e) {
    log(`background chat delivery to ${peerEmail} failed (will retry next sweep): ${e.message || e}`);
  } finally {
    deliveryInFlight.delete(key);
  }
}

// Callee-initiated half: showIncoming branches here for kind:'chat-delivery'
// instead of ever showing the ringing card -- see its own comment.
async function autoAcceptChatDelivery(incoming, identity) {
  const key = incoming.fromEmail.toLowerCase();
  if (deliveryInFlight.has(key)) return;
  deliveryInFlight.add(key);
  try {
    await ensureWasmInit();
    const attestation = computeAttestation(incoming.channel, identity.holderPriv, identity.holderPub, identity.noisePub);
    const attestResp = await api('/attest', {
      body: { channel: incoming.channel, role: 'callee', holderPub: identity.holderPub, noisePub: identity.noisePub, attestation },
    });
    // The callee's incoming WS push fires the instant the bridge mints the
    // channel -- BEFORE the caller has even issued its own /api/attest call
    // (a separate, later HTTP round-trip on the caller's side). This attest
    // call almost always lands first, with the caller's own callerAttest
    // still null -- the bridge's tryRegister() then no-ops (needs both
    // sides) and this response's status stays 'ringing', not
    // 'accepted_and_registered'. The channel's members are only actually
    // registered with the control plane once BOTH attestations are in, and
    // the edge refuses a join for a not-yet-registered member -- joining
    // immediately here, without waiting for that, is exactly what produced
    // a consistent, reproducible "channel join refused" on every background
    // delivery tested live. tryBackgroundDeliver (the caller-initiated half
    // of this same feature) already polls for this same reason; this was
    // the one call site that didn't.
    if (attestResp.status?.state !== 'accepted_and_registered') {
      let accepted = false;
      await pollCallStatus(incoming.channel, {
        timeoutMs: 10000,
        intervalMs: 500,
        onDone: (ok) => { accepted = ok; },
      });
      if (!accepted) return;
    }
    const { stream, noiseTransport } = await connectBackgroundChannel(incoming.ws, incoming.grant, identity.holderPriv, identity.noisePriv, false);
    await backgroundChatSession(stream, noiseTransport, false, dialerChatStore, incoming.fromEmail);
  } catch (e) {
    log(`background chat delivery from ${incoming.fromEmail} failed: ${e.message || e}`);
  } finally {
    deliveryInFlight.delete(key);
  }
}

// chatStore/peerEmail are both optional (see startCallFromIdentity's
// comment -- a manually-built call link has no identity to key a store to).
// When present: past history for this contact is loaded and rendered
// before any live message, every send/receive is persisted (encrypted,
// Lamport-ordered), and a message recorded by this SAME
// identity's OTHER open tab (via chatStore's BroadcastChannel) also renders
// live here if it's for this same conversation.
function setupChatChannel(channel, localHasCamera, chatStore, peerEmail) {
  const ackWaiter = createAckWaiter(); // CADS-webconference-demo#21 -- see createAckWaiter's own comment
  if (chatStore && peerEmail) {
    chatStore.history(peerEmail).then((history) => {
      for (const m of history) addChatMessage(m.text, m.from);
    });
    chatStore.onMessage((msg) => {
      if (msg.peerEmail === peerEmail.toLowerCase()) addChatMessage(msg.text, msg.from);
    });
  }
  channel.addEventListener('open', () => {
    chatInput.disabled = false;
    chatSend.disabled = false;
    addChatMessage('chat connected (real WebRTC data channel, DTLS-encrypted)', 'system');
    if (!localHasCamera) channel.send(NO_CAMERA_SENTINEL);
    flushOutbox(chatStore, peerEmail, (payload) => channel.send(payload), ackWaiter);
  });
  channel.addEventListener('close', () => {
    chatInput.disabled = true;
    chatSend.disabled = true;
  });
  channel.addEventListener('message', async (ev) => {
    if (ev.data === NO_CAMERA_SENTINEL) {
      addChatMessage('Your peer joined without a working camera/microphone -- that\'s why you can\'t see or hear them, not a bug.', 'system');
      remoteEmpty.textContent = 'peer has no camera';
      return;
    }
    // JSON envelope carries the sender's Lamport seq so record({received:true})
    // can preserve causal order -- tolerate a plain-text payload too (e.g. an
    // older/manual-link peer with no chatStore of its own) by just showing it.
    let parsed;
    try {
      parsed = JSON.parse(ev.data);
    } catch (_) {
      addChatMessage(ev.data, 'peer');
      return;
    }
    if (parsed.ack != null) {
      ackWaiter.resolve(parsed.ack);
      return;
    }
    const { seq, text } = parsed;
    addChatMessage(text, 'peer');
    if (chatStore && peerEmail && seq != null) {
      // CADS-webconference-demo#43 (finding 2) -- see backgroundChatSession's
      // matching comment. Used to send the ack (and not even await record()
      // at all) before persisting; persist first now, ack only once that
      // succeeds.
      await chatStore.record({ peerEmail, from: 'peer', text, seq, received: true });
      channel.send(JSON.stringify({ ack: seq }));
    }
  });
  chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = chatInput.value.trim();
    if (!text || channel.readyState !== 'open') return;
    if (chatStore && peerEmail) {
      const seq = await chatStore.nextSeqForSend();
      // CADS-webconference-demo#44: used to record(...) with pending left
      // at its default (false, i.e. "delivered") immediately after send(),
      // the same silent-loss class #21 already fixed for the outbox path --
      // a channel/tab/network death in the small window between send()
      // succeeding locally and the peer actually persisting the message
      // marked it delivered and dropped it for good, with no retry. Record
      // pending, same as the outbox does, and only flip it once the peer's
      // own {ack:seq} reply actually arrives -- a dead channel before that
      // just leaves it in the outbox for the normal background-delivery
      // sweep to pick up later, instead of losing it.
      chatStore.record({ peerEmail, from: 'me', text, seq, pending: true });
      channel.send(JSON.stringify({ seq, text }));
      ackWaiter.wait(seq).then(() => chatStore.markDelivered(peerEmail, seq)).catch(() => {});
    } else {
      channel.send(JSON.stringify({ text }));
    }
    addChatMessage(text, 'me');
    chatInput.value = '';
  });
}

function setCtlLabel(btn, icon, label) {
  btn.querySelector('.ctl-icon').textContent = icon;
  btn.querySelector('.ctl-label').textContent = label;
  btn.setAttribute('aria-label', label);
}

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
  btnHangup.onclick = () => {
    try { onHangup(); } catch {}
    setStatus('you-hung-up');
    for (const t of (media.kind === 'media' ? media.stream.getTracks() : [])) t.stop();
    returnToDialerAfterHangup();
  };
}

function showSetupScreen() {
  setupScreen.hidden = false;
  callScreen.hidden = true;
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
  setTimeout(() => {
    location.href = location.pathname;
  }, delayMs);
}

function showCallScreen() {
  setupScreen.hidden = true;
  siteHero.hidden = true;
  landingMain.hidden = true;
  messengerShell.hidden = true;
  callScreen.hidden = false;
}

// ============ Directory / dialer (email-based calling, no manual grant needed) ============
// See bridge/server.js's header comment for the full design and the one gated
// step (control-plane channel registration -- CADS-Tunnel#214). This section
// generates real key material locally, computes a real per-channel Noise-key
// attestation (matching ct_common::channel::member_noise_attest_bytes byte
// for byte), and talks to the bridge only in public keys / signatures.

// CADS-webconference-demo#40 (finding 2): used to silently truncate an
// odd-length input (new Uint8Array(hex.length / 2) floors) and never
// validated the characters -- parseInt('zz', 16) is NaN, silently baked
// into the output as byte 0. A malformed hex string produced a different,
// but still valid-looking, byte sequence instead of an error pointing at
// the actual problem.
function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`hexToBytes: not a valid even-length hex string (got ${JSON.stringify(hex)})`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
// Preimage::new(domain).fixed(channel).fixed(holder).fixed(noise_pubkey) --
// u32-LE(domain.len()) || domain || channel(32) || holder(32) || noise_pubkey(32).
function memberNoiseAttestBytes(channelHex, holderHex, noisePubHex) {
  const domain = new TextEncoder().encode('ct-a2a-noise-attest-v1');
  const lenPrefix = new Uint8Array(4);
  new DataView(lenPrefix.buffer).setUint32(0, domain.length, true);
  return concatBytes(lenPrefix, domain, hexToBytes(channelHex), hexToBytes(holderHex), hexToBytes(noisePubHex));
}
function computeAttestation(channelHex, holderPrivHex, holderPubHex, noisePubHex) {
  const preimage = memberNoiseAttestBytes(channelHex, holderPubHex, noisePubHex);
  return bytesToHex(wasm.holderSign(holderPrivHex, preimage));
}

const idEntry = document.getElementById('id-entry');
const idForm = document.getElementById('id-form');
const idEmailInput = document.getElementById('id-email');
const idVerifyError = document.getElementById('id-verify-error');
const idVerifyErrorDetail = document.getElementById('id-verify-error-detail');
const idVerifyRetry = document.getElementById('id-verify-retry');
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
// CADS-webconference-demo#42: factored out of the logout handler so the
// same "purge this identity's keys" action is available on its own (Forget
// this identity, and hangup's forget prompt) without also ending the
// Keycloak/gate session the way logout does.
function forgetIdentityKeys(email) {
  if (email) {
    const suffix = `:${email.toLowerCase()}`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('ct-webconference-') && key.endsWith(suffix)) localStorage.removeItem(key);
    }
  } else {
    localStorage.clear(); // no identity was ever established this session -- nothing identity-scoped to preserve
  }
}

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

// Set while an outgoing call is ringing (placed but not yet accepted/declined/
// registered), cleared once it resolves either way. Lets the Cancel button
// (added alongside /api/cancel) abort pollCallStatus's wait from the outside.
let outgoingChannel = null;

function storageKeyFor(email) {
  return `ct-webconference-identity:${email.toLowerCase()}`;
}

// CADS-webconference-demo#42: run()'s #13-era key recovery (myEmail ->
// localStorage) needs to tell "no identity here yet" apart from "found the
// existing one" -- silently minting a FRESH identity in that case (this
// function's normal, correct behavior for the real registration/login path)
// would hand run() keys that don't match what the grant/attestation was
// actually issued for, producing an opaque join failure instead of an
// honest "this browser/profile doesn't have it" error. requireExisting is
// only ever passed true from that one call site.
function loadOrCreateIdentity(email, { requireExisting = false } = {}) {
  const key = storageKeyFor(email);
  const existing = localStorage.getItem(key);
  if (existing) return JSON.parse(existing);
  if (requireExisting) {
    throw new Error(`no local identity found for ${email} -- this call link only works in the same browser profile that placed or accepted it`);
  }
  const holder = wasm.generate_holder_identity();
  const noise = wasm.generate_noise_identity();
  const identity = {
    email,
    holderPub: holder.public_hex,
    holderPriv: holder.private_hex,
    noisePub: noise.public_hex,
    noisePriv: noise.private_hex,
  };
  localStorage.setItem(key, JSON.stringify(identity));
  return identity;
}

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
document.getElementById('identity-mismatch-reload-btn')?.addEventListener('click', () => location.reload());

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
function localSetFor(kind, email) {
  const key = `ct-webconference-${kind}:${email.toLowerCase()}`;
  return {
    all() {
      try {
        return JSON.parse(localStorage.getItem(key) || '[]');
      } catch (_) {
        return [];
      }
    },
    has(e) {
      return this.all().includes(e.toLowerCase());
    },
    add(e) {
      const s = new Set(this.all());
      s.add(e.toLowerCase());
      localStorage.setItem(key, JSON.stringify([...s]));
    },
    remove(e) {
      const s = new Set(this.all());
      s.delete(e.toLowerCase());
      localStorage.setItem(key, JSON.stringify([...s]));
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
const KEYCLOAK_ADMIN_CONSOLE_BASE = 'https://auth.bunsenbrenner.org/admin/master/console/#/ct-demo/users';
function keycloakAdminConsoleLink(email) {
  return `${KEYCLOAK_ADMIN_CONSOLE_BASE}?search=${encodeURIComponent(email)}`;
}
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

function formatMsgTime(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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

// CADS-webconference-demo#36: admin-only panel listing everyone who hit
// /request-access.html because the login allow-list rejected them.
// Approve grants login (same control-plane call /allowlist/add uses) and
// clears the request; Decline just clears it. Both server-side calls are
// admin-gated independently of this UI (see the bridge's own comment).
async function refreshAccessRequests() {
  const resp = await api('/access-requests');
  renderAccessRequests(resp.error ? [] : resp.requests || []);
}

function renderAccessRequests(requests) {
  accessRequestsList.querySelectorAll('li:not(#access-requests-empty)').forEach((li) => li.remove());
  accessRequestsEmpty.hidden = requests.length > 0;
  accessRequestsBadge.hidden = requests.length === 0;
  accessRequestsBadge.textContent = String(requests.length);
  for (const { email } of requests) {
    const li = document.createElement('li');
    li.style.cursor = 'default';
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-row-body';
    nameEl.textContent = email;
    const actions = document.createElement('div');
    actions.className = 'msg-request-actions';
    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'accept';
    approveBtn.textContent = 'Admit';
    approveBtn.addEventListener('click', async () => {
      approveBtn.disabled = true;
      // CADS-webconference-demo#41 (finding 1): no callerEmail to send --
      // the bridge derives the admin check from X-Gate-Email itself now,
      // same as /api/is-admin (#46). Never actually a real admin proof to
      // begin with; sending it was misleading.
      const resp = await api('/access-requests/approve', { body: { email } });
      if (resp.error) { approveBtn.disabled = false; log(`couldn't admit ${email}: ${resp.error}`); return; }
      refreshAccessRequests();
    });
    const declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.className = 'decline';
    declineBtn.textContent = 'Dismiss';
    declineBtn.addEventListener('click', async () => {
      declineBtn.disabled = true;
      await api('/access-requests/decline', { body: { email } });
      refreshAccessRequests();
    });
    actions.append(approveBtn, declineBtn);
    li.append(nameEl, actions);
    accessRequestsList.appendChild(li);
  }
}

function renderBlockedList() {
  blockedList.querySelectorAll('li:not(#blocked-empty)').forEach((li) => li.remove());
  const blocked = blockedEmails.all();
  blockedEmpty.hidden = blocked.length > 0;
  for (const email of blocked) {
    const li = document.createElement('li');
    li.style.cursor = 'default';
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-row-body';
    nameEl.textContent = email;
    const unblockBtn = document.createElement('button');
    unblockBtn.type = 'button';
    unblockBtn.className = 'decline';
    unblockBtn.style.flexShrink = '0';
    unblockBtn.textContent = 'Unblock';
    unblockBtn.addEventListener('click', () => {
      blockedEmails.remove(email);
      // Whether they landed on the block list via the conversation's Block
      // button or an admin's Revoke action, unblocking always means "back
      // in my contacts" -- it does NOT restore server login access on its
      // own if that was also revoked (see the revoke panel's own note).
      myContacts.add(email);
      renderBlockedList();
      refreshContacts();
    });
    li.append(nameEl, unblockBtn);
    blockedList.appendChild(li);
  }
}

// State for the currently-open conversation (messenger shell's right pane /
// mobile full-screen conversation view). null when nothing is selected.
let currentConversationEmail = null;
// CADS-webconference-demo#59: every blob: URL appendConvMessage creates for
// a file message is tracked here so it can be revoked before the next
// render replaces it -- without this, URL.createObjectURL was never
// balanced by a revokeObjectURL anywhere, so re-opening an attachment-heavy
// conversation leaked a fresh, unreclaimable set of blob URLs (each pinning
// up to MAX_FILE_BYTES of decrypted bytes) every single time.
let convBlobUrls = [];
function revokeConvBlobUrls() {
  for (const url of convBlobUrls) URL.revokeObjectURL(url);
  convBlobUrls = [];
}

async function openConversation(email) {
  currentConversationEmail = email;
  dialEmailInput.value = email; // dial-form's existing submit handler reads this as the call target
  msgConvPlaceholder.hidden = true;
  msgConversation.hidden = false;
  messengerShell.dataset.conversationOpen = '1';
  convAvatar.textContent = (email[0] || '?').toUpperCase();
  convName.textContent = myNames?.get(email) || email; // CADS-webconference-demo#54
  const presence = await api(`/presence?email=${encodeURIComponent(email)}`);
  convStatus.textContent = presence.online ? 'online' : 'offline';
  convStatus.dataset.online = presence.online ? '1' : '0';
  revokeConvBlobUrls(); // #59 -- release the previous render's file-attachment blob URLs before creating new ones
  convMessages.innerHTML = '';
  if (dialerChatStore) {
    const history = await dialerChatStore.history(email);
    for (const m of history) appendConvMessage(m);
  }
  await refreshContacts(); // updates the .active row highlight
}

// Shared by history load (openConversation) and a just-composed message
// (msgComposeForm below) so both render identically. `pending` (queued,
// not yet sent over any live channel -- see chatStore's outbox) shows a
// dimmed bubble with "sending…" instead of "you". data-seq (only set for
// my own messages, where seq is always present and unique per
// conversation) lets markConvMessageDelivered below find this exact bubble
// again later and flip it live -- see #49's comment on flushOutbox's
// onDelivered for why that's needed now.
// CADS-webconference-demo#50: formats a byte count the same way any real
// file-transfer UI does (nearest sensible unit, not a raw byte count).
// CADS-webconference-demo#58: an explicit allowlist of raster formats that
// can NEVER carry executable content, not a blocklist of the one bad case
// found so far. `startsWith('image/')` let image/svg+xml through -- SVG is
// XML, can embed <script>, and blob: URLs inherit the ORIGIN of the page
// that created them (this app's own origin). The inline <img src=blob:>
// itself is safe (browsers sandbox SVG loaded that way, no script runs) --
// the actual hole was the "open full-size" link doing a top-level
// target=_blank NAVIGATION to that same blob: URL, which for an SVG
// document DOES execute its script, in this app's own origin, with full
// access to localStorage (identity private keys), IndexedDB, and the gate
// session. A real PoC confirmed this exfiltrates ct-webconference-
// identity:<email> (holderPriv/noisePriv) via one click on a peer-sent
// "image". Anything not in this allowlist (SVG included) now falls
// through to the existing download-only branch below, which never
// navigates to or renders the blob at all -- safe regardless of content,
// same as any other unrecognized file type already was.
const SAFE_INLINE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'image/x-icon']);
function formatFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function appendConvMessage({ from, text, pending, corrupted, seq, kind, fileName, fileMimeType, fileSize, blob }) {
  const div = document.createElement('div');
  div.className = `chat-msg ${from}${pending ? ' pending' : ''}`;
  if (from === 'me' && seq != null) div.dataset.seq = seq;
  const body = document.createElement('div');
  if (corrupted) {
    // CADS-webconference-demo#24: a record chatStore.history() couldn't
    // decrypt (corrupted/tampered row) comes back with corrupted:true and
    // no text -- show that honestly instead of rendering an empty bubble
    // as if it were a genuine blank message.
    body.textContent = '⚠ this message could not be decrypted';
    body.style.opacity = '.6';
  } else if (kind === 'file') {
    // CADS-webconference-demo#50: an image renders inline (click to open
    // full-size in a new tab, same pattern any real messenger uses);
    // anything else renders as a filename + size + download link -- no
    // in-page preview attempted for arbitrary file types.
    const url = URL.createObjectURL(blob);
    convBlobUrls.push(url); // #59 -- revoked by revokeConvBlobUrls() on the next render or conversation close
    if (SAFE_INLINE_IMAGE_MIME_TYPES.has(fileMimeType || '')) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.src = url;
      img.alt = fileName || 'image';
      img.className = 'chat-file-image';
      link.appendChild(img);
      body.appendChild(link);
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName || 'file';
      link.className = 'chat-file-link';
      link.textContent = `📎 ${fileName || 'file'}`;
      const size = document.createElement('span');
      size.className = 'chat-file-size';
      size.textContent = formatFileSize(fileSize);
      body.append(link, size);
    }
  } else {
    body.textContent = text;
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = from === 'me' ? (pending ? 'sending…' : 'you') : 'peer';
  div.append(body, meta);
  convMessages.appendChild(div);
  convMessages.scrollTop = convMessages.scrollHeight;
}

// CADS-webconference-demo#49: flips a specific "sending…" bubble to
// delivered once flushOutbox's onDelivered callback confirms its ack --
// finds it by the data-seq appendConvMessage sets above. No-ops quietly if
// the bubble isn't on screen right now (a different conversation is open,
// or this pane hasn't been opened at all this session) -- chatStore itself
// already has the correct pending:false state either way; this only keeps
// whatever's currently rendered in sync with it.
function markConvMessageDelivered(seq) {
  const bubble = convMessages.querySelector(`.chat-msg.me[data-seq="${seq}"]`);
  if (!bubble) return;
  bubble.classList.remove('pending');
  const meta = bubble.querySelector('.meta');
  if (meta) meta.textContent = 'you';
}

function closeConversation() {
  revokeConvBlobUrls(); // #59 -- nothing left open to re-render into, so release now rather than waiting for the next openConversation
  currentConversationEmail = null;
  messengerShell.dataset.conversationOpen = '0';
  // data-conversation-open only gates layout below the 859px breakpoint
  // (index.html's media query) -- on desktop's always-visible split pane,
  // these two hidden flags are the only thing selecting placeholder vs.
  // conversation, so both paths need resetting here too.
  msgConvPlaceholder.hidden = false;
  msgConversation.hidden = true;
}

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
  onlyAcceptFromContacts = onlyContactsToggle.checked;
  localStorage.setItem(`ct-webconference-settings:${dialerChatStore.identity.email.toLowerCase()}`, onlyAcceptFromContacts ? '1' : '0');
});

// Instantiated once identity is known so the chat list can show last-message
// previews (chatStore.history()) even before any call has been placed this
// session -- a separate instance from run()'s call-scoped one (different
// module load, this page never reaches run()'s call-setup path at all until
// a call actually starts and reloads into it).
let dialerChatStore = null;

async function runDialer(identity, { verified = false } = {}) {
  setupScreen.hidden = true;
  siteHero.hidden = true;
  landingMain.hidden = true;
  messengerShell.hidden = false;
  dialerChatStore = new ChatStore(identity);
  myEmail = identity.email;
  myIdentity = identity;
  myContacts = localSetFor('contacts', identity.email);
  myNames = nameMapFor(identity.email);
  blockedEmails = localSetFor('blocked', identity.email);
  onlyAcceptFromContacts = localStorage.getItem(`ct-webconference-settings:${identity.email.toLowerCase()}`) === '1';
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
    outgoingChannel = resp.channel;
    btnCancelCall.hidden = false;
    await pollCallStatus(resp.channel, {
      timeoutMs: 60000, // a real ringing phase -- give the callee time to actually notice and answer
      shouldAbort: () => outgoingChannel !== resp.channel,
      onDone: (ok, status) => {
        btnCancelCall.hidden = true;
        outgoingChannel = null;
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
    outgoingChannel = null;
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
    currentIncoming = incoming;
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

async function runIdentityScreen() {
  await init('./pkg/ct_agent_wasm_bg.wasm');
  showSetupScreen();

  // CADS-Tunnel#214: a verified login-gate identity (X-Gate-Email, forwarded
  // by the origin's Caddyfile from the control-plane's /gate/check) always
  // wins over free-text entry or a stale localStorage identity -- otherwise
  // a gate-authenticated user could still go online as anyone they type in.
  // A genuine {email: null} response just means the tunnel isn't gated (or
  // the gate isn't enforcing yet), not an error -- falls through to the
  // existing free-text flow below, same as always.
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
  const whoamiResp = await api('/whoami');
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
  const verifiedEmail = whoamiResp.email;
  if (verifiedEmail) {
    const identity = loadOrCreateIdentity(verifiedEmail);
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
    const identity = loadOrCreateIdentity(email);
    await runDialer(identity);
  });
}

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
const TAG_MEDIA_INIT = 1;
const TAG_MEDIA_CHUNK = 2;
const TAG_CHAT = 3;
const TAG_BYE = 4;
// CADS-webconference-demo#50: same tagged-frame pattern as TAG_MEDIA_*
// above (used for the experimental video path) -- FILE_INIT carries a
// small JSON header (seq/name/mimeType/size) as a text frame, FILE_CHUNK
// carries raw chunked bytes, reassembled by total size on the receiving
// end exactly like TAG_MEDIA_CHUNK already is.
const TAG_FILE_INIT = 5;
const TAG_FILE_CHUNK = 6;
// 25MB: a well-known, widely-recognized web-app attachment ceiling (the
// same order of magnitude as Gmail's own long-standing attachment limit) --
// generous for a real file/image/document, small enough that a chunked
// transfer over a relayed channel finishes in a reasonable time instead of
// minutes.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const FILE_CHUNK_BYTES = 49152; // matches TAG_MEDIA_CHUNK's own chunk size below

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

  function sendTagged(tag, payloadBytes) {
    // CADS-webconference-demo#69 (review follow-up): writeFramed's
    // returned promise was never awaited or caught here -- a failed send
    // (ws.send throwing on an already-dead socket, which the ~20s
    // reconnect grace window now makes a real, not just theoretical,
    // possibility) surfaced as a genuinely unhandled promise rejection,
    // not caught by ondataavailable's own nearby try/catch (that catch
    // only ever covered synchronous failures before this call, since
    // sendTagged itself was already fire-and-forget). Catching it here,
    // at the source, fixes that for every tag (chat/bye/media-init/media-
    // chunk alike), not just the media-chunk call site.
    writeFramed(byteStream, noiseTransport.encrypt(concatBytes(new Uint8Array([tag]), payloadBytes))).catch((e) => {
      log(`failed to send (tag ${tag}): ${e.message || e}`);
    });
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
  function attemptChannelFallback(reason) {
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
