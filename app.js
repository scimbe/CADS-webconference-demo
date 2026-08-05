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

function log(msg) {
  // Timestamped (HH:MM:SS.mmm) so the Technical readout panel can show how
  // far apart events actually happened -- important for diagnosing stalls/
  // reconnects, where "it happened eventually" vs "it happened instantly"
  // is the whole question.
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
  }
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
    const pc = window.__ctVideoCallDemo?.pc;
    if (pc) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
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
async function flushOutbox(chatStore, peerEmail, send, ackWaiter) {
  if (!chatStore || !peerEmail) return;
  const outbox = await chatStore.pendingOutbox(peerEmail);
  for (const m of outbox) {
    send(JSON.stringify({ seq: m.seq, text: m.text }));
    try {
      await ackWaiter.wait(m.seq);
    } catch {
      break;
    }
    await chatStore.markDelivered(peerEmail, m.seq);
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
  const send = (text) => writeFramed(stream, noiseTransport.encrypt(concatBytes(new Uint8Array([TAG_CHAT]), new TextEncoder().encode(text))));
  const ackWaiter = createAckWaiter();
  // Runs CONCURRENTLY with the receive loop below, not before it -- flushOutbox
  // now awaits an ack for each send, and that ack can only ever arrive via
  // this same function's own receive loop, so awaiting the flush first would
  // deadlock waiting for a reply nothing is listening for yet.
  const flushPromise = flushOutbox(chatStore, peerEmail, send, ackWaiter);
  const deadline = Date.now() + BACKGROUND_CHAT_WINDOW_MS;
  try {
    while (Date.now() < deadline) {
      const cipher = await readFramed(stream, deadline - Date.now());
      const plain = noiseTransport.decrypt(cipher);
      if (plain[0] !== TAG_CHAT) continue;
      const raw = new TextDecoder().decode(plain.slice(1));
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
        send(JSON.stringify({ ack: seq })); // CADS-webconference-demo#21 -- see createAckWaiter's comment
        await chatStore.record({ peerEmail, from: 'peer', text, seq, received: true });
        if (currentConversationEmail === peerEmail.toLowerCase()) appendConvMessage({ from: 'peer', text, pending: false });
        refreshContacts(); // updates the list-pane preview text
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
  const outbox = await dialerChatStore.pendingOutbox(peerEmail);
  if (!outbox.length) return;
  const presence = await api(`/presence?email=${encodeURIComponent(peerEmail)}`);
  if (!presence.online) return;
  deliveryInFlight.add(key);
  try {
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
    await api('/attest', {
      body: { channel: incoming.channel, role: 'callee', holderPub: identity.holderPub, noisePub: identity.noisePub, attestation },
    });
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
  channel.addEventListener('message', (ev) => {
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
      channel.send(JSON.stringify({ ack: seq }));
      chatStore.record({ peerEmail, from: 'peer', text, seq, received: true });
    }
  });
  chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = chatInput.value.trim();
    if (!text || channel.readyState !== 'open') return;
    if (chatStore && peerEmail) {
      const seq = await chatStore.nextSeqForSend();
      channel.send(JSON.stringify({ seq, text }));
      chatStore.record({ peerEmail, from: 'me', text, seq });
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
  btnMic.addEventListener('click', () => {
    if (media.kind !== 'media') return;
    micOn = !micOn;
    for (const t of media.stream.getAudioTracks()) t.enabled = micOn;
    setCtlLabel(btnMic, micOn ? '🎤' : '🔇', micOn ? 'Mute' : 'Unmute');
    btnMic.dataset.off = micOn ? '0' : '1';
  });
  btnCam.addEventListener('click', () => {
    if (media.kind !== 'media') return;
    camOn = !camOn;
    for (const t of media.stream.getVideoTracks()) t.enabled = camOn;
    setCtlLabel(btnCam, '📷', camOn ? 'Camera off' : 'Camera on');
    btnCam.dataset.off = camOn ? '0' : '1';
  });
  btnSwitchCamera.addEventListener('click', () => switchCamera(media));
  btnHangup.addEventListener('click', () => {
    try { onHangup(); } catch {}
    setStatus('you-hung-up');
    for (const t of (media.kind === 'media' ? media.stream.getTracks() : [])) t.stop();
    returnToDialerAfterHangup();
  });
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

function hexToBytes(hex) {
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
const convAvatar = document.getElementById('conv-avatar');
const convName = document.getElementById('conv-name');
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
logoutLink.addEventListener('click', async (ev) => {
  ev.preventDefault();
  // A third piece, found by testing the full flow end-to-end: even once
  // both server-side sessions are genuinely gone (confirmed -- /api/whoami
  // correctly stops returning an email), runIdentityScreen()'s own
  // localStorage fallback ("if any identity already exists in this
  // browser, use the most recently used one automatically") silently
  // reuses the just-logged-out identity on the next visit instead of
  // prompting fresh. Clear it here too, or the other two fixes are moot.
  // CADS-webconference-demo#33: this used to be a blanket localStorage.clear()
  // -- localStorage is shared across every identity this browser has ever
  // held (loadOrCreateIdentity explicitly supports switching between
  // several), so logging out as one identity destroyed every OTHER
  // identity's keys, contacts, blocklist, and Lamport clock too. On a
  // shared/kiosk browser that's silent, irreversible data loss for whoever
  // else's identity happened to be sitting in this browser -- their
  // encrypted IndexedDB history survives, but its keying material
  // (holderPriv) doesn't, so it becomes permanently undecryptable. Scope
  // the clear to exactly this identity's own keys instead.
  if (myEmail) {
    const suffix = `:${myEmail.toLowerCase()}`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('ct-webconference-') && key.endsWith(suffix)) localStorage.removeItem(key);
    }
  } else {
    localStorage.clear(); // no identity was ever established this session -- nothing identity-scoped to preserve
  }
  try {
    await fetch('https://bunsenbrenner.org/gate/logout?host=bunsenbrenner.org', {
      credentials: 'include',
      mode: 'no-cors',
    });
  } catch (_) {}
  location.href = 'https://bunsenbrenner.org/portal/logout';
});

// Set while an outgoing call is ringing (placed but not yet accepted/declined/
// registered), cleared once it resolves either way. Lets the Cancel button
// (added alongside /api/cancel) abort pollCallStatus's wait from the outside.
let outgoingChannel = null;

function storageKeyFor(email) {
  return `ct-webconference-identity:${email.toLowerCase()}`;
}

function loadOrCreateIdentity(email) {
  const key = storageKeyFor(email);
  const existing = localStorage.getItem(key);
  if (existing) return JSON.parse(existing);
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

// Never throws -- a network blip, a dropped connection, or a non-JSON error
// page all collapse to `{ error: '...' }` instead of an unhandled rejection
// that would otherwise leave whatever UI state was set right before this
// call (e.g. "Connecting…") stuck forever with no way forward.
async function api(path, opts) {
  try {
    const resp = await fetch(`/api${path}`, {
      method: opts?.body ? 'POST' : 'GET',
      headers: opts?.body ? { 'content-type': 'application/json' } : undefined,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    return await resp.json();
  } catch (e) {
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
  const params = new URLSearchParams({ ws, grant, holderPriv: identity.holderPriv, noisePriv: identity.noisePriv, role });
  if (transport === 'channel') params.set('transport', 'channel');
  // Optional: only used to key the encrypted local chat store (chatStore.js)
  // to the right (me, peer) conversation. A hand-built manual call link
  // (see index.html's "manual call link" fallback) won't have these -- chat
  // persistence just quietly stays off for that link, same as it always has.
  if (peerEmail) {
    params.set('myEmail', identity.email);
    params.set('peerEmail', peerEmail);
  }
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

let myContacts = null;
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
async function refreshContacts() {
  const mine = myContacts.all();
  // CADS-webconference-demo#11: scoped to exactly the emails this call
  // needs presence for -- see the endpoint's own comment for why.
  const resp = mine.length ? await api(`/contacts?emails=${encodeURIComponent(mine.join(','))}`) : { contacts: [] };
  const presence = new Map((resp.error ? [] : resp.contacts || []).map((c) => [c.email, c.online]));
  const contacts = mine.map((email) => ({ email, online: presence.get(email) || false }));
  await renderContacts(contacts);
  renderRequests();
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
    nameEl.textContent = email;
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
        preview.textContent = last.from === 'me' ? `You: ${last.text}` : last.text;
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

async function openConversation(email) {
  currentConversationEmail = email;
  dialEmailInput.value = email; // dial-form's existing submit handler reads this as the call target
  msgConvPlaceholder.hidden = true;
  msgConversation.hidden = false;
  messengerShell.dataset.conversationOpen = '1';
  convAvatar.textContent = (email[0] || '?').toUpperCase();
  convName.textContent = email;
  const presence = await api(`/presence?email=${encodeURIComponent(email)}`);
  convStatus.textContent = presence.online ? 'online' : 'offline';
  convStatus.dataset.online = presence.online ? '1' : '0';
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
// dimmed bubble with "sending…" instead of "you"; there's no separate
// live-update path to flip it once delivered because sending only actually
// happens after startCallFromIdentity's location.search reload takes the
// page to #call-screen -- a fresh load of this conversation pane re-reads
// history from chatStore (now delivered) next time it's opened.
function appendConvMessage({ from, text, pending, corrupted }) {
  const div = document.createElement('div');
  div.className = `chat-msg ${from}${pending ? ' pending' : ''}`;
  const body = document.createElement('div');
  // CADS-webconference-demo#24: a record chatStore.history() couldn't
  // decrypt (corrupted/tampered row) comes back with corrupted:true and no
  // text -- show that honestly instead of rendering an empty bubble as if
  // it were a genuine blank message.
  body.textContent = corrupted ? '⚠ this message could not be decrypted' : text;
  if (corrupted) body.style.opacity = '.6';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = from === 'me' ? (pending ? 'sending…' : 'you') : 'peer';
  div.append(body, meta);
  convMessages.appendChild(div);
  convMessages.scrollTop = convMessages.scrollHeight;
}

function closeConversation() {
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
  const email = accessRemoveEmail.value.trim();
  if (!email) return;
  accessRemoveConsoleLink.hidden = true;
  setAccessNote('info', `Revoking access for ${email}…`);
  const resp = await api('/allowlist/remove', { body: { email, callerEmail: myEmail } });
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
  blockedEmails = localSetFor('blocked', identity.email);
  onlyAcceptFromContacts = localStorage.getItem(`ct-webconference-settings:${identity.email.toLowerCase()}`) === '1';
  onlyContactsToggle.checked = onlyAcceptFromContacts;
  renderBlockedList();
  myEmailEl.textContent = identity.email + (verified ? ' (verified via login)' : '');
  // Revoke-access is admin-only -- hidden until proven otherwise. is-admin
  // only ever returns a boolean (never the admin list itself), so this is
  // safe to call unauthenticated; the bridge enforces the real gate
  // server-side on the revoke call itself regardless of what this shows.
  api(`/is-admin?email=${encodeURIComponent(identity.email)}`).then((resp) => {
    revokeAccessDetails.hidden = !resp.isAdmin;
  });
  // Only meaningful for a real gate-verified session (X-Gate-Email) -- a
  // free-text identity was never actually logged in anywhere to log out of.
  logoutLink.hidden = !verified;

  await api('/register', { body: { email: identity.email, holderPub: identity.holderPub, noisePub: identity.noisePub } });
  setInterval(() => api('/heartbeat', { body: { email: identity.email } }), 15000);

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
    if (currentIncoming) return;
    currentIncoming = incoming;
    incomingFrom.textContent = incoming.fromEmail;
    incomingCard.hidden = false;
    currentIncomingTimer = setTimeout(() => {
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
  let incomingSocketAttempt = 0;
  function connectIncomingSocket() {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${wsProto}//${location.host}/api/ws?email=${encodeURIComponent(identity.email)}`);
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
      incomingSocketAttempt++;
      const base = Math.min(1000 * 2 ** incomingSocketAttempt, 30000);
      const delay = Math.round(base / 2 + Math.random() * (base / 2));
      log(`presence socket closed (code ${ev.code}); reconnecting in ~${Math.round(delay / 1000)}s (attempt ${incomingSocketAttempt})`);
      setTimeout(connectIncomingSocket, delay);
    });
    sock.addEventListener('error', () => sock.close());
  }
  connectIncomingSocket();

  // Fallback poll -- unchanged cadence, stays as the safety net described above.
  setInterval(() => api(`/incoming?email=${encodeURIComponent(identity.email)}`).then((r) => {
    if (r.incoming) showIncoming(r.incoming);
  }).catch(() => {}), 3000);

  refreshContacts();
  setInterval(refreshContacts, 5000);

  // Catches the case the compose-time trigger can't: a message queued
  // while the peer was offline, delivered once they come back -- without
  // this, "compose any time, it goes out once you're both connected" would
  // only ever be true if you happened to compose AFTER they reconnected.
  setInterval(() => {
    for (const email of myContacts.all()) tryBackgroundDeliver(identity, email);
  }, 10000);

  // Someone added ME as a contact -- merge into the same Requests list
  // showIncoming's privacy-gate already populates (see its "Wants to be
  // added to your contacts" copy, which was already the right shape for
  // this). Blocked senders never show up (server has no notion of my block
  // list, so filter client-side, same as showIncoming's own check).
  setInterval(() => api(`/contact-requests?email=${encodeURIComponent(identity.email)}`).then((r) => {
    for (const { fromEmail } of r.requests || []) {
      const email = fromEmail.toLowerCase();
      if (blockedEmails.has(email) || myContacts.has(email)) continue;
      if (!pendingRequests.some((p) => p.email === email)) {
        pendingRequests.push({ email });
        renderRequests();
      }
    }
  }).catch(() => {}), 4000);

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
    const email = idEmailInput.value.trim();
    if (!email) return;
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

async function runChannelMediaCall(byteStream, noiseTransport, isCaller, chatStore, peerEmail) {
  setStatus('connecting-media');
  routeWebrtc.classList.add('live');

  if (chatStore && peerEmail) {
    chatStore.history(peerEmail).then((history) => {
      for (const m of history) addChatMessage(m.text, m.from);
    });
    chatStore.onMessage((msg) => {
      if (msg.peerEmail === peerEmail.toLowerCase()) addChatMessage(msg.text, msg.from);
    });
  }

  function sendTagged(tag, payloadBytes) {
    writeFramed(byteStream, noiseTransport.encrypt(concatBytes(new Uint8Array([tag]), payloadBytes)));
  }
  function sendText(tag, text) {
    sendTagged(tag, new TextEncoder().encode(text));
  }

  const mediaSource = new MediaSource();
  remoteVideo.src = URL.createObjectURL(mediaSource);
  let sourceBuffer = null;
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
  // Set the moment an appendBuffer call fails -- once the <video> element's
  // own .error is non-null (a fatal MSE decode error), Chrome rejects EVERY
  // subsequent appendBuffer with the exact same "HTMLMediaElement.error
  // attribute is not null" message forever. Observed live: 100+ identical
  // log lines flooding the Technical readout for the rest of the call, with
  // zero new diagnostic value past the first one. Root cause of the
  // original decode error is still unconfirmed (needs a real camera to
  // reproduce against) -- this just stops the pipeline from spinning on an
  // already-fatal stream instead of fixing the fatal error itself.
  let remoteMediaFatal = false;
  function flushPending() {
    if (remoteMediaFatal) { pendingChunks.length = 0; return; }
    if (sourceBuffer && !sourceBuffer.updating && pendingChunks.length) {
      const next = pendingChunks.shift();
      try {
        sourceBuffer.appendBuffer(next);
      } catch (e) {
        remoteMediaFatal = true;
        pendingChunks.length = 0;
        log(`remote video stream failed permanently, giving up on it (further chunks dropped): ${e.message}`);
      }
    }
  }
  function appendChunk(bytes) {
    if (mediaUnsupported || remoteMediaFatal) return; // can never be played -- drop instead of buffering forever
    if (!sourceBuffer || sourceBuffer.updating) { pendingChunks.push(bytes); return; }
    try {
      sourceBuffer.appendBuffer(bytes);
    } catch (e) {
      remoteMediaFatal = true;
      pendingChunks.length = 0;
      log(`remote video stream failed permanently, giving up on it (further chunks dropped): ${e.message}`);
    }
  }

  chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    if (chatStore && peerEmail) {
      const seq = await chatStore.nextSeqForSend();
      sendText(TAG_CHAT, JSON.stringify({ seq, text }));
      chatStore.record({ peerEmail, from: 'me', text, seq });
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
  (async () => {
    while (true) {
      let cipher;
      try {
        cipher = await readFramed(byteStream);
      } catch (e) {
        // The channel itself is this transport's only connection to the peer
        // -- unlike WebRTC mode there's no separate end-to-end link to
        // heartbeat over, so a read failure here (crashed tab, dropped
        // network, killed process, or the STALL_TIMEOUT_MS backstop firing)
        // IS the direct, real signal the peer is gone, exactly like a
        // received TAG_BYE just without one ever arriving. Previously this
        // silently returned with no UI feedback or navigation at all,
        // leaving the call screen stuck, and didn't say why.
        log(`channel receive loop ended: ${e.message}`);
        setStatus('peer-hung-up');
        addChatMessage('peer connection lost', 'system');
        returnToDialerAfterHangup();
        return;
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
                sendText(TAG_CHAT, JSON.stringify({ ack: seq })); // CADS-webconference-demo#21
                chatStore.record({ peerEmail, from: 'peer', text, seq, received: true });
              }
            }
          }
        } else if (tag === TAG_BYE) {
          setStatus('peer-hung-up');
          addChatMessage('peer hung up', 'system');
          returnToDialerAfterHangup();
          return;
        }
      } catch (e) {
        log(`channel receive loop: bad frame, ending call: ${e.message}`);
        setStatus('peer-hung-up');
        addChatMessage('connection lost (a corrupted or unexpected frame arrived)', 'system');
        returnToDialerAfterHangup();
        return;
      }
    }
  })();

  const media = await getLocalMedia();
  let recorder = null;
  if (media.kind === 'media') {
    localVideo.srcObject = media.stream;
    localEmpty.style.display = 'none';
    const mimeCandidates = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
    const mimeType = mimeCandidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (mimeType) {
      sendText(TAG_MEDIA_INIT, mimeType);
      recorder = new MediaRecorder(media.stream, { mimeType });
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
        } catch (e) {
          // Was previously an uncaught promise rejection spamming the
          // console on every ~200ms timeslice with no visible diagnosis --
          // now a single clear log line, and media just drops that one
          // chunk instead of the call silently never showing video at all.
          log(`failed to send a media chunk: ${e.message || e}`);
        }
      };
      recorder.start(200); // 200ms timeslices -- a reasonable latency/overhead trade-off for a relayed path
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

  setupControls(media, () => {
    sendTagged(TAG_BYE, new Uint8Array(0));
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  });

  setIceState('connected'); // no real ICE in this mode -- 'connected' just reflects the channel being fully up
  setStatus('in-call');
  window.__ctVideoCallDemo = { sendBye: () => sendTagged(TAG_BYE, new Uint8Array(0)) };
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
  const holderPrivHex = params.get('holderPriv');
  const noisePrivHex = params.get('noisePriv');
  const role = params.get('role'); // 'caller' | 'callee'
  const transportMode = params.get('transport') === 'channel' ? 'channel' : 'webrtc';
  // Optional -- see startCallFromIdentity's comment. A manually-built call
  // link won't have these; chat just isn't persisted for that session.
  const myEmail = params.get('myEmail');
  const peerEmail = params.get('peerEmail');

  if (!wsUrl || !grantHex || !holderPrivHex || !noisePrivHex || !role) {
    await runIdentityScreen();
    return;
  }
  showCallScreen();
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
    await runChannelMediaCall(stream, noiseTransport, isCaller, chatStore, peerEmail);
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
  function endCallDueToPeerLoss(reason) {
    if (sessionEnded) return;
    sessionEnded = true;
    setStatus('peer-hung-up');
    addChatMessage(`peer connection lost (${reason})`, 'system');
    pc.close();
    returnToDialerAfterHangup();
  }

  pc.oniceconnectionstatechange = () => setIceState(pc.iceConnectionState);
  pc.onconnectionstatechange = () => {
    log(`connection state: ${pc.connectionState}`);
    // 'disconnected' can be transient (a brief network blip WebRTC itself
    // recovers from) -- only 'failed' is a genuine, unrecoverable end-to-end
    // loss. 'closed' after our own local hang-up is the expected, already-
    // handled case (sessionEnded is already true by then, so this no-ops).
    if (pc.connectionState === 'failed') endCallDueToPeerLoss('ICE failed');
  };
  pc.ontrack = (ev) => {
    remoteVideo.srcObject = ev.streams[0];
    remoteEmpty.style.display = 'none';
    log(`remote track received: ${ev.track.kind}`);
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
      const watchdog = setInterval(() => {
        if (sessionEnded) {
          clearInterval(sendTimer);
          clearInterval(watchdog);
          return;
        }
        if (Date.now() - lastSeen > HEARTBEAT_TIMEOUT_MS) {
          clearInterval(sendTimer);
          clearInterval(watchdog);
          endCallDueToPeerLoss('heartbeat timeout');
        }
      }, HEARTBEAT_INTERVAL_MS);
    });
    channel.addEventListener('message', () => {
      lastSeen = Date.now();
    });
    channel.addEventListener('close', () => endCallDueToPeerLoss('heartbeat channel closed'));
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
  setupControls(media, () => {
    sessionEnded = true; // before pc.close(), so the heartbeat/connection-state
    // watchdogs above see the session as already-ended and don't also fire
    // a redundant "peer connection lost" on top of our own local hang-up.
    window.__ctVideoCallDemo?.sendSignal(wasm.encodeSignalBye());
    pc.close();
  });

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
          returnToDialerAfterHangup();
          return;
        }
      } catch (e) {
        log(`signaling loop: bad frame, ending call: ${e.message}`);
        sessionEnded = true;
        setStatus('peer-hung-up');
        addChatMessage('connection lost (a corrupted or unexpected signaling frame arrived)', 'system');
        pc.close();
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
  window.__ctVideoCallDemo = { pc, noiseTransport, sendSignal };
}

run().catch((e) => {
  console.error(e);
  setStatus('error: ' + (e.message || e));
  log(`error: ${e.message || e}`);
});
