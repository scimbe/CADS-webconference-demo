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
  async readLine(timeoutMs) {
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
      // timeoutMs (optional) is threaded through same as readExact's own --
      // see joinChannel's own comment for why its call here passes a much
      // shorter budget than the default STALL_TIMEOUT_MS.
      await this._waitForBytes(this.totalLen + 1, timeoutMs);
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
// two fixed lengths with no framing to disambiguate up front. timeoutMs
// (optional) threaded through same as readExact's own -- see joinChannel's
// own comment for why its call here passes a shorter budget than the
// default STALL_TIMEOUT_MS.
async function readChallengeOrRefusal(stream, timeoutMs) {
  const first2 = await stream.readExact(2, timeoutMs);
  if (first2[0] === 0x4e && first2[1] === 0x4f) {
    return { refused: true };
  }
  const rest = await stream.readExact(30, timeoutMs);
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
// Live-reported (follow-up): with real two-device calls, this timeout was
// firing on essentially every fresh call attempt -- not a reload-conflict
// case, a first-time join between two genuinely active devices. 15000ms was
// sized purely around the ORIGINAL bug's own UX concern ("a full
// unexplained minute of 'Connecting…' reads as frozen", see the comment
// below) -- it was never validated against real end-to-end join+handshake
// timing, which includes a full page reload, WASM re-initialization, and
// real network round-trips for BOTH sides independently reaching this same
// point (each side's own reload is triggered by its own poll of the SAME
// shared accepted_and_registered state, so real-world variance between two
// different devices -- one slower to reload/reinit than the other -- adds
// up quickly against a 15s budget). Raised to 30000: still meaningfully
// faster than the original 60s default for the reload-conflict case #116
// was fixing (so that UX improvement isn't fully reverted), while giving a
// healthy first-time join realistic headroom to actually complete instead
// of being killed mid-flight.
const CHANNEL_OPEN_TIMEOUT_MS = 30000;
// Live-reported: a hard page reload mid-call re-enters run() fresh (a
// reload replays the same call-screen URL params, including ws/grant/
// holderPriv), attempting a brand-new joinChannel() against a channel/
// grant the bridge may still consider tied to the just-abandoned
// connection -- reproduced live as the ack-line read below stalling for
// the FULL default STALL_TIMEOUT_MS (60s) with zero user-facing feedback
// in the meantime ("stalled: no new data for 60000ms while waiting for 1
// bytes (have 0)", console-confirmed). This wasn't a genuine JS deadlock
// (the error DID eventually fire and get caught/logged -- WsByteStream's
// own real-suspension fix from #38 is intact, not regressed), but a full
// unexplained minute of an apparently-unresponsive "Connecting…" screen
// reads as "frozen" to a real user regardless. The WS-open wait already
// got a shorter timeout (CHANNEL_OPEN_TIMEOUT_MS, see the comment further
// below) -- this closes the same gap for the REST of the join handshake
// (challenge read + ack-line read), which had no timeout override at all
// and so silently inherited the full 60s ambient default meant for an
// already-established, ongoing call's quiet periods, not a fresh setup
// attempt that should fail fast. Wrapping the whole post-connect
// exchange in one try/catch (not just the open wait) means ANY setup
// failure -- connect, join-request, challenge, or ack -- closes the
// dangling ws the same way, instead of only the connect step doing so.
// CADS-webconference-demo#130 (live-reproduced: 8/11 real two-party runs, a
// perfectly normal second call to the same contact after a clean hangup):
// the channel id is deterministic from (operator, holder_a, holder_b) --
// see video-call-grant/src/main.rs's own channel_id_for_link comment -- so
// every call between the same two people reuses the SAME channel, forever.
// A fresh grant is minted per call, but the channel identity is stable,
// which leaves any lingering per-channel membership/session state from the
// PREVIOUS call as a real hazard for the next one: the caller stalls
// waiting for an ack that never comes, or the callee is actively refused
// admission to a channel it was legitimately in moments earlier. A genuine
// fix (a per-call nonce folded into the channel id) needs a protocol change
// in ct_common (channel_id_for_link's own crate, outside this repo) plus a
// matching bridge-side change -- real, but too large for a client-only
// patch. This is the client-side mitigation the issue itself proposes:
// retry a `refused` or stalled/timed-out join a couple of times with a
// short backoff, on the theory that lingering server-side state from the
// prior call is transient and often clears within a second or two -- turns
// most of these failures into a slightly slower but successful call
// instead of a hard failure after a silent 30s wait.
const JOIN_RETRY_ATTEMPTS = 3;
const JOIN_RETRY_BACKOFF_MS = [0, 600, 1800];
// Retries use a much shorter per-attempt timeout than the first attempt --
// a lingering-state condition either clears in a couple of seconds or it
// doesn't, and #130's own fix #4 explicitly calls out not making the user
// wait a full CHANNEL_OPEN_TIMEOUT_MS (30s) per attempt. Worst case with
// this is one full 30s first attempt + two 8s retries + backoff ≈ 48s, not
// the ~92s three full-length attempts would otherwise add up to.
const JOIN_RETRY_TIMEOUT_MS = 8000;

async function joinChannelOnce(wsUrl, grantHex, holderPrivHex, timeoutMs) {
  const ws = new WebSocket(wsUrl);
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
      }),
      timeoutMs,
      `channel connection timed out after ${timeoutMs / 1000}s`,
    );
    const stream = new WsByteStream(ws);

    const joinReq = wasm.buildChannelJoinRequest(grantHex, 'relay-only');
    await writeFramed(stream, joinReq);

    const resp = await readChallengeOrRefusal(stream, timeoutMs);
    if (resp.refused) throw new Error('channel join refused');
    const sig = wasm.holderSign(holderPrivHex, resp.challenge);
    stream.send(sig);

    const ackLine = await stream.readLine(timeoutMs);
    log(`ack: ${ackLine.trim()}`);
    if (!ackLine.startsWith('OK ')) throw new Error(`unexpected ack line: ${ackLine}`);
    const parts = ackLine.trim().split(' ');
    // Live incident (2026-08-15): the edge (crates/edge/src/channel_broker.rs,
    // finish_rendezvous_pair/finish_relay_pair) always appends trailing `r=<observed-addr>`
    // (#121 B1-follow) and `sp=<0|1>` (#276 piece 1) tokens now -- "OK <endpoint> [<noise>
    // <holder> <attest>] r=... sp=...". Both are explicitly documented edge-side as
    // purely additive / backward-compatible ("a legacy client that doesn't look for r=/sp=
    // is unaffected"), but this parser's exact `parts.length === 5` check took the full-
    // suffix case's length literally -- it silently broke the moment the edge actually
    // started sending r=/sp= (7 tokens, not 5), reading peerNoiseHex as null on every real
    // call ("no peer Noise key in ack" -- calling completely broken, both transports, since
    // app.js's run() and call-channel.js's establishChannelSession/chat-glue.js's
    // connectBackgroundChannel all join through this one shared function). Strip any
    // trailing r=/sp= tokens before checking length instead -- the noise/holder/attest
    // suffix, when present, is always the same 3 tokens immediately after the endpoint,
    // regardless of how many additive tags the edge appends after it. Same peerNoiseHex
    // semantics either way: null when the peer genuinely has no registered Noise key (the
    // edge's own member_ack_suffix all-or-nothing convention), the real key otherwise.
    const coreParts = parts.filter((p) => !/^(r|sp)=/.test(p));
    const peerNoiseHex = coreParts.length === 5 ? coreParts[2] : null;

    return { ws, stream, peerNoiseHex };
  } catch (e) {
    try { ws.close(); } catch (_) {}
    throw e;
  }
}

async function joinChannel(wsUrl, grantHex, holderPrivHex) {
  let lastErr;
  for (let attempt = 0; attempt < JOIN_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      log(`channel join attempt ${attempt + 1}/${JOIN_RETRY_ATTEMPTS} (previous: ${lastErr.message}) -- retrying after ${JOIN_RETRY_BACKOFF_MS[attempt]}ms`);
      await new Promise((r) => setTimeout(r, JOIN_RETRY_BACKOFF_MS[attempt]));
    }
    try {
      const timeoutMs = attempt === 0 ? CHANNEL_OPEN_TIMEOUT_MS : JOIN_RETRY_TIMEOUT_MS;
      return await joinChannelOnce(wsUrl, grantHex, holderPrivHex, timeoutMs);
    } catch (e) {
      lastErr = e;
      // Only retry the two failure shapes #130 actually documents as
      // transient lingering-state symptoms (an explicit refusal, or the
      // setup stalling/timing out) -- a WebSocket-level connect failure is a
      // real network/reachability problem retrying with the SAME url won't
      // fix, so that one fails fast on the first attempt as before.
      if (!/refused|timed out|stalled/i.test(e.message)) throw e;
    }
  }
  throw lastErr;
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

// Live-reported: after a hangup-triggered reload, a real mobile device got
// stuck showing #boot-loading ("Loading…", visible from first paint, see
// index.html's own comment) forever, with no error and no way forward short
// of a manual re-navigation. Root cause: both run() and runIdentityScreen()
// (app.js, dialer.js) start with a bare `await init('./pkg/ct_agent_wasm_bg.wasm')`
// -- a real network fetch + WebAssembly.instantiate with no timeout of its
// own (same class of gap CHANNEL_OPEN_TIMEOUT_MS above already closed for
// the channel-join sequence, and STALL_TIMEOUT_MS for the byte stream). A
// fetch() that stalls (not errors -- a genuinely dead/degraded connection,
// plausible right after a call that was just using real bandwidth) never
// resolves NOR rejects, so it hangs forever -- and since it never rejects,
// run().catch()'s own top-level error handling (app.js) never fires either,
// leaving the page frozen on whatever was visible before the throw, which
// for a fresh reload is exactly the boot-loading spinner and nothing else.
// Wrapping this call in withTimeout turns a silent hang into a real
// rejection, which DOES reach the existing run().catch() handler and its
// already-correct fallback UI (the id-verify-error panel, with a working
// Retry-via-reload button) -- no new error-display code needed, just
// making sure the existing one actually gets a chance to run. 20s is
// generous for a real (if slow) WASM fetch+instantiate on mobile, while
// still failing well within what a user would wait before giving up and
// reloading manually anyway.
const WASM_INIT_TIMEOUT_MS = 20000;

export {
  WsByteStream,
  writeFramed,
  withTimeout,
  readFramed,
  readChallengeOrRefusal,
  joinChannel,
  sendTaggedFrame,
  closeAfterFlush,
  WASM_INIT_TIMEOUT_MS,
  CHANNEL_OPEN_TIMEOUT_MS,
};
