// The direct-channel media transport: an experimental alternative to WebRTC
// that tunnels audio/video/chat straight through the already-encrypted
// Noise_IK Agent-Fabric channel instead of negotiating a separate WebRTC/
// ICE/DTLS-SRTP path. No RTCPeerConnection, no STUN/TURN, no SDP -- just a
// tiny custom message envelope (1-byte tag + payload) sent the exact same
// way signaling bytes already travel: writeFramed(stream,
// noiseTransport.encrypt(bytes)). Trade-off, stated plainly: everything is
// relayed through the edge over one WebSocket connection rather than
// negotiated peer-to-peer, so latency is higher and total throughput is
// capped by that single relayed connection -- but it needs nothing beyond
// what channel-join already requires, so it works in networks where
// WebRTC's ICE negotiation can't punch through (symmetric NATs,
// UDP-blocking firewalls) without needing a TURN server.
//
// Split out of app.js as part of the client-code consolidation
// (CADS-webconference-demo#91); every function/const here is a verbatim
// move, comments included, with no behavior change.
//
// The plan's cycle 5 flagged a possible second TAG-dispatch decode dedup
// against setupChatChannel/backgroundChatSession (chat-glue.js) -- re-
// checked here: still declined, same reasoning as cycle 5's own commit.
// The TAG_CHAT branch below has real, non-cosmetic differences from both of
// those (NO_CAMERA_SENTINEL/NO_CODEC_SENTINEL handling that's specific to
// this transport, plain-text-tolerance fallback shaped differently, and
// different UI-update/notification side effects) -- unifying it would risk
// a subtle behavior change for a purely cosmetic win, so it stays
// duplicated, same "prefer duplication over risk" call as before.
//
// CADS-webconference-demo#91 (temporary, per the consolidation plan): same
// circular-import stopgap camera.js/video-filters.js already use, for
// setupControls/returnToDialerAfterHangup (shared plumbing still owned by
// app.js -- see its own header comment there) and activeCallBye (shared
// mutable state between this transport and the webrtc one; setActiveCallBye
// is a real setter, not a read-only stopgap, since this module genuinely
// reassigns it, not just reads it -- see the cycle 9 lesson on why that
// needs a setter rather than a plain import). To be repointed if
// setupControls/returnToDialerAfterHangup/activeCallBye ever move out of
// app.js.
//
// CADS-webconference-demo#91 (cycle 17): constructs its own
// createChannelCallSession(media) and registers it via setActiveSession,
// same as call-webrtc.js's own session for its transport -- camera.js/
// video-filters.js read whichever is currently active via getActiveSession
// without needing to know which transport is live. This session's
// replaceOutgoingVideoTrack/requestFallbackToChannel are both true no-ops
// (see call-session.js's own header comment) -- this transport never had a
// peer-visible track swap or a further fallback target, so registering it
// changes nothing observable; it exists so a mid-channel-call camera
// switch resolves to a real (no-op) session instead of finding none at
// all. Constructed right after `const media = await getLocalMedia();`
// below, matching call-webrtc.js's own timing choice; cleared via
// setActiveSession(null) at every one of this function's own termination
// paths (reconnect-exhausted, reconnect-failed, TAG_BYE, bad frame,
// onHangup).

import * as wasm from './pkg/ct_agent_wasm.js';
import {
  TAG_MEDIA_INIT, TAG_MEDIA_CHUNK, TAG_CHAT, TAG_BYE, TAG_PING, TAG_PONG, NO_CAMERA_SENTINEL, NO_CODEC_SENTINEL,
} from './call-protocol.js';
import { joinChannel, writeFramed, readFramed, withTimeout, sendTaggedFrame, closeAfterFlush, CHANNEL_OPEN_TIMEOUT_MS } from './call-transport-shared.js';
import {
  setStatus, routeWebrtc, connectingBanner, connectingBannerText, hideConnecting, addChatMessage, chatForm, chatInput, chatSend,
  remoteVideo, remoteEmpty, localVideo, localEmpty, log, setIceState,
} from './ui-dom.js';
import { createAckWaiter, flushOutbox } from './chat-glue.js';
import { getLocalMedia } from './camera.js';
import { createChannelCallSession, setActiveSession } from './call-session.js';
import { setupControls, returnToDialerAfterHangup, setActiveCallBye } from './app.js';

// Live-reported (call-transport-shared.js's joinChannel own comment has
// the full root-cause detail): the Noise handshake's own readFramed calls
// below had no timeout override, silently inheriting the full 60s ambient
// STALL_TIMEOUT_MS meant for an ongoing call's quiet periods -- same class
// of "fresh setup attempt should fail fast" gap joinChannel's own
// challenge/ack reads just got fixed for, applied here too since this is
// squarely still the initial-setup phase, not a steady-state read.
async function establishChannelSession(wsUrl, grantHex, holderPrivHex, noisePrivHex, isCaller) {
  const { stream, peerNoiseHex } = await joinChannel(wsUrl, grantHex, holderPrivHex);
  if (!peerNoiseHex) throw new Error('no peer Noise key in ack -- peer not registered with a Noise key');
  const hs = isCaller ? wasm.NoiseHandshake.newInitiator(noisePrivHex, peerNoiseHex) : wasm.NoiseHandshake.newResponder(noisePrivHex);
  if (isCaller) {
    await writeFramed(stream, hs.writeMessage(new Uint8Array(0)));
    hs.readMessage(await readFramed(stream, CHANNEL_OPEN_TIMEOUT_MS));
  } else {
    hs.readMessage(await readFramed(stream, CHANNEL_OPEN_TIMEOUT_MS));
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
  // Real gap found live 2026-08-24: the sender's own MEDIA_BACKPRESSURE_*
  // watermarks (below) only throttle a well-behaved local MediaRecorder --
  // they do nothing to bound how fast a REMOTE peer's TAG_MEDIA_CHUNK frames
  // arrive here. A slow/paused sourceBuffer.appendBuffer (backgrounded tab,
  // a burst of QuotaExceededError evictions, or simply a remote peer sending
  // faster than real-time) let pendingChunks grow without limit -- unlike
  // ui-dom.js's LOG_MAX_LINES/CHAT_LOG_MAX_LINES, nothing capped it. A flood
  // of chunks (malicious or buggy remote peer, or just sustained backlog)
  // exhausts the receiving tab's memory. ~150 chunks at the sender's
  // existing ~200ms cadence is ~30s of buffered media -- generous headroom
  // for a real transient stall, small enough to bound worst-case memory.
  const MAX_PENDING_CHUNKS = 150;
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

  // Active liveness watchdog (see TAG_PING/TAG_PONG's own comment in
  // call-protocol.js for why this transport needed one) -- same interval/
  // timeout values as call-webrtc.js's heartbeat data channel, for
  // consistency between the two transports' peer-loss detection latency.
  const HEARTBEAT_INTERVAL_MS = 8000;
  const HEARTBEAT_TIMEOUT_MS = 35000;
  let heartbeatLastSeen = Date.now();
  let heartbeatSendTimer = null;
  let heartbeatWatchdogTimer = null;
  function stopHeartbeat() {
    if (heartbeatSendTimer) clearInterval(heartbeatSendTimer);
    if (heartbeatWatchdogTimer) clearInterval(heartbeatWatchdogTimer);
    heartbeatSendTimer = null;
    heartbeatWatchdogTimer = null;
  }
  function startHeartbeat() {
    heartbeatLastSeen = Date.now();
    heartbeatSendTimer = setInterval(() => {
      try {
        sendTagged(TAG_PING, new Uint8Array(0));
      } catch (e) {
        log(`ping send failed: ${e.message || e}`);
      }
    }, HEARTBEAT_INTERVAL_MS);
    // Same "remote media still advancing -- don't treat heartbeat silence
    // alone as peer loss" escape hatch as call-webrtc.js's #79 fix -- this
    // transport also feeds remoteVideo (via mediaSource, see remoteVideo.src
    // above), so the identical currentTime-advancing check applies here.
    let lastWatchdogVideoTime = remoteVideo.currentTime;
    heartbeatWatchdogTimer = setInterval(() => {
      const videoTimeNow = remoteVideo.currentTime;
      const videoAdvancing = videoTimeNow > lastWatchdogVideoTime;
      lastWatchdogVideoTime = videoTimeNow;
      if (Date.now() - heartbeatLastSeen <= HEARTBEAT_TIMEOUT_MS) return;
      if (videoAdvancing) {
        log('heartbeat silent but remote media still advancing -- not treating as peer loss');
        return;
      }
      stopHeartbeat();
      log('heartbeat timeout -- declaring peer lost');
      setStatus('peer-hung-up');
      addChatMessage('peer connection lost (heartbeat timeout)', 'system');
      if (activeMediaBackpressureInterval) clearInterval(activeMediaBackpressureInterval);
      byteStream.ws.close(); // CADS-webconference-demo#38 (finding 9) -- see onHangup's matching comment
      setActiveSession(null);
      returnToDialerAfterHangup();
    }, HEARTBEAT_INTERVAL_MS);
  }
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
    if (!sourceBuffer || sourceBuffer.updating) {
      if (pendingChunks.length >= MAX_PENDING_CHUNKS) {
        // Drop the newest chunk rather than the oldest: 'sequence' mode
        // appends chunks in FIFO order regardless of which ones survive, so
        // dropping from the middle/front would corrupt playback order --
        // dropping the incoming one just means a dropped frame, the same
        // visible degradation MAX_MEDIA_RECREATE_ATTEMPTS already accepts
        // elsewhere in this file.
        log(`pendingChunks at its cap of ${MAX_PENDING_CHUNKS} -- dropping incoming media chunk rather than growing memory unbounded`);
        return;
      }
      pendingChunks.push(bytes);
      return;
    }
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
          stopHeartbeat();
          setActiveSession(null);
          returnToDialerAfterHangup();
          return;
        }
        channelReconnectAttempted = true;
        log(`channel receive loop ended: ${e.message} -- attempting to reconnect`);
        addChatMessage('connection lost -- attempting to reconnect…', 'system');
        setStatus('connecting-media');
        // CADS-webconference-demo#102 (live-reported): the chat message and
        // status-pill text above already existed, but the chat panel is
        // hidden entirely on the mobile full-screen call view (see
        // index.html's mobile media query), and the status-pill text is
        // small and easy to miss -- a real test run measured up to ~24s
        // (CHANNEL_RECONNECT_GRACE_MS + detection latency) of the call
        // screen just sitting there with no obviously-visible sign a
        // recovery was even in progress. Reuses the same #connecting-banner
        // element/positioning the initial call-setup phase already shows
        // (visible on both desktop and mobile), repurposed here for a
        // mid-call reconnect instead of leaving it exclusively for initial
        // connect.
        connectingBannerText.textContent = 'Reconnecting to the other side…';
        connectingBanner.hidden = false;
        try {
          const fresh = await withTimeout(
            establishChannelSession(wsUrl, grantHex, holderPrivHex, noisePrivHex, isCaller),
            CHANNEL_RECONNECT_GRACE_MS,
            `reconnect timed out after ${CHANNEL_RECONNECT_GRACE_MS / 1000}s`
          );
          // Real leak found live 2026-08-24: readFramed()'s failure above is a
          // client-side read stall (STALL_TIMEOUT_MS et al), not necessarily
          // the underlying WebSocket actually closing -- on lossy links (the
          // exact condition #69/#102/#129 target) the old socket can still be
          // genuinely open on the wire. Swapping byteStream to the fresh
          // session without closing the old one first left one abandoned,
          // still-open WebSocket per reconnect episode, accumulating across
          // repeated reconnects in a single long call. Best-effort: a socket
          // that's already dead just throws/no-ops here, same as every other
          // byteStream.ws.close() call site in this file.
          try {
            byteStream.ws.close();
          } catch (closeErr) {
            log(`old channel socket close (pre-reconnect) failed harmlessly: ${closeErr.message}`);
          }
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
          hideConnecting();
          continue;
        } catch (e2) {
          log(`channel reconnect failed: ${e2.message}`);
          setStatus('peer-hung-up');
          addChatMessage('peer connection lost', 'system');
          hideConnecting();
          if (activeMediaBackpressureInterval) clearInterval(activeMediaBackpressureInterval);
          stopHeartbeat();
          setActiveSession(null);
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
        // Any successfully-decrypted frame is real proof this transport is still
        // alive end-to-end -- not just an explicit TAG_PONG reply. Updated here,
        // once, rather than per-branch below.
        heartbeatLastSeen = Date.now();
        const tag = plain[0];
        const payload = plain.slice(1);
        if (tag === TAG_PING) {
          try {
            sendTagged(TAG_PONG, new Uint8Array(0));
          } catch (e) {
            log(`pong reply failed: ${e.message || e}`);
          }
        } else if (tag === TAG_MEDIA_INIT) {
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
          stopHeartbeat();
          byteStream.ws.close(); // CADS-webconference-demo#38 (finding 9) -- see setupControls' onHangup callback's matching comment
          setActiveSession(null);
          returnToDialerAfterHangup();
          return;
        }
      } catch (e) {
        log(`channel receive loop: bad frame, ending call: ${e.message}`);
        setStatus('peer-hung-up');
        addChatMessage('connection lost (a corrupted or unexpected frame arrived)', 'system');
        if (activeMediaBackpressureInterval) clearInterval(activeMediaBackpressureInterval); // CADS-webconference-demo#70 (review follow-up) -- see the TAG_BYE branch's matching comment above
        stopHeartbeat();
        byteStream.ws.close();
        setActiveSession(null);
        returnToDialerAfterHangup();
        return;
      }
    }
  })();

  const media = await getLocalMedia();
  // CADS-webconference-demo#91 (cycle 17): see this file's header comment --
  // a true no-op session, registered so camera.js/video-filters.js resolve
  // to a real (inert) session during a channel call instead of finding none.
  setActiveSession(createChannelCallSession(media));
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
    setActiveCallBye(null); // #38 finding 6 -- see returnToDialerAfterHangup's matching clear
    // Live-reported, same root cause + fix as call-webrtc.js's onHangup (see its own
    // fuller comment): sendTagged -> sendTaggedFrame's noiseTransport.encrypt() call is
    // synchronous and can throw on an already-dead transport, which used to abort this
    // whole function before recorder.stop()/setActiveSession(null) below ever ran --
    // clicking Hang Up on a long-gone peer did nothing. try/catch makes the bye
    // notify best-effort without blocking local teardown.
    try {
      sendTagged(TAG_BYE, new Uint8Array(0));
    } catch (e) {
      log(`bye notify failed (peer likely already gone): ${e.message || e}`);
    }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    // CADS-webconference-demo#70: the backpressure poll interval outlives
    // the recorder otherwise -- same leaked-timer shape #38 already fixed
    // for the signaling WS below.
    if (activeMediaBackpressureInterval) clearInterval(activeMediaBackpressureInterval);
    stopHeartbeat();
    setActiveSession(null);
    // CADS-webconference-demo#38 (finding 9): neither hangup path closed the
    // underlying signaling WS -- it lingered open until
    // returnToDialerAfterHangup's ~1200ms-delayed reload tore down the whole
    // page. Explicit close here (mirrors backgroundChatSession's own
    // stream.ws.close() in its finally block) frees it immediately instead.
    // CADS-webconference-demo (live-reported): closeAfterFlush, not a bare
    // close() -- see its own comment in call-transport-shared.js. The
    // TAG_BYE frame just queued above needs a real chance to actually
    // leave the socket before it's torn down, especially over a slow/lossy
    // connection -- this transport's own bye is exactly as vulnerable to
    // the same immediate-close-drops-the-final-frame failure mode as the
    // webrtc path's sendSignal(bye).
    closeAfterFlush(byteStream.ws);
  };
  // #38 finding 6 -- same close logic runs on an explicit Hang Up click or a
  // pagehide (tab close/navigation) while this transport's call is live.
  setActiveCallBye(onHangup);
  setupControls(media, onHangup);

  setIceState('connected'); // no real ICE in this mode -- 'connected' just reflects the channel being fully up
  setStatus('in-call');
  startHeartbeat();
}

export {
  establishChannelSession,
  runChannelMediaCall,
};
