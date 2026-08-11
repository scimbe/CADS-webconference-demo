// Low-level transport primitives shared by both call transports (WebRTC
// signaling and the direct-channel media transport): the byte-stream reader
// over a WebSocket, message framing, and the channel-join handshake. Split
// out of app.js as part of the client-code consolidation
// (CADS-webconference-demo#91); every function/const here is a verbatim
// move, comments included, with no behavior change, EXCEPT sendTaggedFrame
// below, which is a deliberate, approved dedup (see its own comment).
//
// NOT unified here, on purpose: the Noise_IK handshake dance itself (each of
// run()'s inline copy, establishChannelSession, and connectBackgroundChannel
// in app.js does its own `wasm.NoiseHandshake.newInitiator/newResponder` +
// writeFramed/readFramed exchange). An existing code comment at each of
// those three sites already documents why: run()'s own copy interleaves
// call-site-specific UI status updates (setStatus('noise-handshake') etc.)
// between the join and handshake steps that a shared helper can't reproduce
// without an explicit callback/hook interface, and that risk wasn't judged
// worth taking in a live production demo. All three copies still use the
// writeFramed/readFramed primitives below -- only the handshake orchestration
// itself stays duplicated.

import * as wasm from './pkg/ct_agent_wasm.js';
import { log } from './ui-dom.js';
import { concatBytes } from './identity.js';

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

// Robustness audit finding (proactive review, not yet forced to reproduce
// live -- needs a real network black hole, e.g. a firewall silently
// dropping the TCP/TLS handshake or a proxy that accepts the connection
// but never completes the WS upgrade): the WebSocket open/error wait below
// had NO timeout of its own. If neither 'open' nor 'error' ever fires --
// exactly the failure shape a silent black hole produces, as opposed to an
// active refusal, which does fire 'error' -- this hung forever, and so did
// every caller awaiting it (run()'s own initial connection, this file's
// establishChannelSession, chat-glue.js's connectBackgroundChannel),
// leaving the user stuck on "Connecting…" with no error and no recovery.
// withTimeout (this same file, #69) was already built for exactly this
// shape but only ever got applied to the RECONNECT path (call-channel.js
// wraps its own establishChannelSession call in it) -- the first
// connection attempt had nothing. Applying it here instead of at each of
// the 3 call sites means every current and future caller gets it
// automatically, and it composes safely with the reconnect path's own
// outer timeout (whichever fires first just wins, same as any
// nested-timeout shape). Explicitly closes the dangling ws on a timeout
// too -- withTimeout's own contract is "stop waiting, don't cancel the
// underlying work" (see its own comment), which is correct for a promise
// with no cleanup handle, but a WebSocket DOES have one (.close()), so
// there's no reason to leave a doomed half-open connection attempt
// dangling once this function itself has already given up on it.
const CHANNEL_OPEN_TIMEOUT_MS = 15000;
async function joinChannel(wsUrl, grantHex, holderPrivHex) {
  const ws = new WebSocket(wsUrl);
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
      }),
      CHANNEL_OPEN_TIMEOUT_MS,
      `channel connection timed out after ${CHANNEL_OPEN_TIMEOUT_MS / 1000}s`,
    );
  } catch (e) {
    try { ws.close(); } catch (_) {}
    throw e;
  }
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

// CADS-webconference-demo#91: previously two near-identical closures existed
// (one inside backgroundChatSession, one inside runChannelMediaCall), both
// building the same tagged-frame envelope (1-byte tag + payload, encrypted,
// framed, sent) but with different error-handling maturity -- only the
// runChannelMediaCall copy (added for #69's review follow-up) caught a
// failed send and logged it; the backgroundChatSession copy left it as a
// genuinely unhandled promise rejection. Unified here on the strictly-more-
// correct (catch + log) behavior; both call sites now delegate to this via a
// thin local wrapper that supplies their own stream/noiseTransport, so
// neither call site's own signature changes.
function sendTaggedFrame(stream, noiseTransport, tag, payloadBytes) {
  return writeFramed(stream, noiseTransport.encrypt(concatBytes(new Uint8Array([tag]), payloadBytes))).catch((e) => {
    log(`failed to send (tag ${tag}): ${e.message || e}`);
  });
}

// CADS-webconference-demo (live-reported): "hanging up doesn't work
// reliably" -- both onHangup implementations (call-webrtc.js/
// call-channel.js) send a final bye/TAG_BYE frame and, in the very next
// synchronous statement, close() the same WebSocket. WebSocket.send()
// only QUEUES bytes for the underlying network layer to flush; it does not
// guarantee they've actually left the browser before a following close()
// runs. Per spec, a UA should flush queued data before completing a close
// handshake, but this is exactly the kind of ordering guarantee that's far
// more likely to be cut short on a slow/lossy connection (a mobile network
// specifically) than on a fast local one -- consistent with the live
// report not being reliably reproducible, and not being specific to
// either side initiating. Waits for the socket's own bufferedAmount to
// drain before closing, bounded by timeoutMs so a stalled/degraded
// connection still closes promptly rather than hanging the teardown UI --
// closing anyway once the bound is hit is strictly no worse than today's
// unconditional immediate close.
function closeAfterFlush(ws, timeoutMs = 300) {
  if (ws.bufferedAmount === 0) {
    ws.close();
    return;
  }
  const deadline = Date.now() + timeoutMs;
  (function poll() {
    if (ws.bufferedAmount === 0 || Date.now() >= deadline) {
      ws.close();
      return;
    }
    setTimeout(poll, 20);
  })();
}

export {
  WsByteStream,
  writeFramed,
  withTimeout,
  readFramed,
  readChallengeOrRefusal,
  joinChannel,
  sendTaggedFrame,
  closeAfterFlush,
};
