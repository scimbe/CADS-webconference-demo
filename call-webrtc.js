// The inline WebRTC call path: RTCPeerConnection setup, active ICE-restart
// recovery, the heartbeat data channel, chat-channel wiring, the offer/
// answer/ICE signaling loop, and the WebRTC->direct-channel fallback
// handoff (attemptChannelFallback). Split out of app.js's run() as part of
// the client-code consolidation (CADS-webconference-demo#91).
//
// Not a pure verbatim move in the strictest sense: this code was inline in
// run(), not already its own function, so extracting it necessarily means
// wrapping it in a new function boundary (runWebrtcMediaCall) rather than
// just cutting an existing one. The body itself is byte-for-byte identical;
// the new function takes exactly the same 9 parameters
// (stream/noiseTransport/isCaller/chatStore/peerEmail/wsUrl/grantHex/
// holderPrivHex/noisePrivHex) that runChannelMediaCall (call-channel.js)
// already established as this pair's shared shape -- app.js's run() now
// dispatches to whichever transport function symmetrically, instead of one
// being a real function call and the other an implicit fall-through. Every
// comment is preserved verbatim; every closure variable this code used to
// capture from run()'s outer scope is now either an explicit parameter
// (the 9 above) or a local declared at the top of this function (pc,
// sessionEnded, capturedMedia, etc. -- all still function-scoped exactly as
// before, just one function down).
//
// Per Ground rule 2 (never unify the Noise_IK handshake's 3x duplication):
// this file does NOT include run()'s own initial join+handshake -- that
// stays inline in app.js's run(), deliberately duplicated against this
// same dance in call-channel.js's establishChannelSession and chat-glue.js's
// connectBackgroundChannel, exactly as before this consolidation.
//
// CADS-webconference-demo#91 (cycle 17): the raw activeWebrtcPc handle
// (CADS-webconference-demo#38, finding 7's own module-private-variable
// fix, so switchCamera never needed a page-global `window.__ctVideoCallDemo.pc`)
// is retired in favor of call-session.js's session interface --
// createWebrtcCallSession(pc, media, notifyPeerFallback) wraps `pc` behind
// replaceOutgoingVideoTrack/requestFallbackToChannel/onFallback/getStream,
// registered via setActiveSession at the exact point `activeWebrtcPc = pc;`
// used to sit, and cleared via setActiveSession(null) at every one of this
// function's own termination paths (mirroring every former
// `activeWebrtcPc = null;` site 1:1) -- confirmed via a whole-file grep
// that activeWebrtcPc had zero internal readers here, only writes, so this
// is a mechanical 1:1 replacement, not a new design. camera.js/
// video-filters.js now read the session back via getActiveSession instead
// of importing activeWebrtcPc directly.
//
// attemptChannelFallback's own inline peer-notify block
// (`if (!peerInitiated) { try { sendSignal(...) } catch {...} }`) is
// replaced by session.requestFallbackToChannel(reason, peerInitiated) --
// the notifyPeerFallback callback passed at session construction below
// contains the exact same try/catch/log body, so the one observable
// difference (this session interface's own catch is silent, by design --
// see call-session.js's header comment) never actually applies: this
// callback catches and logs internally, so the interface's own outer catch
// never has anything to swallow. Every OTHER attemptChannelFallback side
// effect (channelFallbackAttempted latch, sessionEnded, logging, UI
// updates, pc.close(), session clearing, capturedMedia cleanup,
// transport-badge/chat-transport-note text, the runChannelMediaCall call
// itself) is untouched, in the same order, byte-for-byte -- re-read
// line-by-line against the pre-cycle version to confirm nothing was
// dropped or reordered.
//
// Constructed right after `const media = await getLocalMedia();` below
// (not at the original `activeWebrtcPc = pc;` point, much later in this
// function) so a session reference exists before attemptChannelFallback
// could theoretically ever run -- pc's event handlers (oniceconnectionstatechange
// etc.) are attached even earlier than that, so `session` is still guarded
// with `session?.` at its one call site as defense in depth against that
// narrow (in practice unreachable -- real ICE state transitions can't
// resolve within the handful of synchronous statements between handler
// attachment and this construction point) window, never a hard dependency
// on the timing being exactly right.
//
// setupControls/returnToDialerAfterHangup/setActiveCallBye stay imported
// back from app.js as a stopgap (same pattern call-channel.js's cycle 15
// already established) -- they're shared plumbing between both transports,
// genuinely owned by app.js, not something this cycle's scope redesigns.
// runChannelMediaCall is imported directly from call-channel.js (not
// through app.js) for the fallback hand-off -- a real, permanent
// cross-module dependency between the two transport siblings, not a
// stopgap.

import * as wasm from './pkg/ct_agent_wasm.js';
import { TAG_FALLBACK } from './call-protocol.js';
import { writeFramed, readFramed } from './call-transport-shared.js';
import {
  setStatus, hideConnecting, addChatMessage, log, setIceState,
  localVideo, remoteVideo, localEmpty, remoteEmpty,
} from './ui-dom.js';
import { setupChatChannel } from './chat-glue.js';
import { getLocalMedia } from './camera.js';
import { runChannelMediaCall } from './call-channel.js';
import { createWebrtcCallSession, setActiveSession } from './call-session.js';
import { setupControls, returnToDialerAfterHangup, setActiveCallBye } from './app.js';

async function runWebrtcMediaCall(stream, noiseTransport, isCaller, chatStore, peerEmail, wsUrl, grantHex, holderPrivHex, noisePrivHex) {
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
  // CADS-webconference-demo#91 (cycle 17): this call's own call-session.js
  // session -- constructed once media is available (see below), read by
  // attemptChannelFallback below. `session?.` at that one call site guards
  // the narrow window before construction -- see this file's header comment.
  let session = null;
  function endCallDueToPeerLoss(reason) {
    if (sessionEnded) return;
    sessionEnded = true;
    setStatus('peer-hung-up');
    addChatMessage(`peer connection lost (${reason})`, 'system');
    pc.close();
    setActiveSession(null);
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
    // CADS-webconference-demo#91 (cycle 17): delegates the peer-notify to
    // call-session.js's requestFallbackToChannel -- see this file's header
    // comment for why the notifyPeerFallback callback (passed at session
    // construction below) preserves this exact try/catch/log body, and why
    // `session?.` is defense in depth, not an expected real path.
    session?.requestFallbackToChannel(reason, peerInitiated);
    pc.close();
    setActiveSession(null);
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
  // CADS-webconference-demo#91 (cycle 17): registers this call's session so
  // camera.js/video-filters.js can reach replaceOutgoingVideoTrack without
  // a raw pc handle -- see this file's header comment for why this exact
  // point (not the original, much-later `activeWebrtcPc = pc;` timing) was
  // chosen, and why that's a strictly narrower-or-equal race window, not a
  // wider one.
  session = createWebrtcCallSession(pc, media, () => {
    try {
      sendSignal(new Uint8Array([TAG_FALLBACK]));
    } catch (e) {
      log(`failed to notify peer of channel fallback: ${e.message || e}`);
    }
  });
  setActiveSession(session);

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
    setActiveCallBye(null); // #38 finding 6 -- see returnToDialerAfterHangup's matching clear
    sessionEnded = true; // before pc.close(), so the heartbeat/connection-state
    // watchdogs above see the session as already-ended and don't also fire
    // a redundant "peer connection lost" on top of our own local hang-up.
    sendSignal(wasm.encodeSignalBye()); // already in scope here -- no need to bounce through the (now-removed) window global
    pc.close();
    setActiveSession(null);
    stream.ws.close(); // CADS-webconference-demo#38 (finding 9) -- see endCallDueToPeerLoss's matching comment
  };
  // #38 finding 6 -- same close logic runs on an explicit Hang Up click or a
  // pagehide (tab close/navigation) while this transport's call is live.
  setActiveCallBye(onHangup);
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
          setActiveSession(null);
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
        setActiveSession(null);
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
}

export {
  runWebrtcMediaCall,
};
