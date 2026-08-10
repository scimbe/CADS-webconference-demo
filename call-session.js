// A minimal, transport-agnostic wrapper around exactly one live call, so
// camera.js / video-filters.js / the WebRTC<->channel fallback handoff never
// need to reach into a raw activeWebrtcPc variable or a closure-captured
// stream/noiseTransport again -- part of the client-code consolidation
// (CADS-webconference-demo#91).
//
// NOT YET WIRED IN. Nothing imports this file today -- camera.js and
// video-filters.js still reach `activeWebrtcPc` via the circular-import
// stopgap back to app.js established in cycles 12/13. This is written now,
// reviewable in isolation, with zero behavior-change risk; the actual
// rewire (repointing camera.js/video-filters.js/call-webrtc.js/
// call-channel.js at this interface and retiring the activeWebrtcPc
// stopgap) is its own later, carefully-isolated cycle (see the
// consolidation plan's cycle 17).
//
// Two factories, one per transport, both returning the same 4-method shape.
// noiseTransport is deliberately never exposed on this interface -- it
// stays closure-captured within whichever transport module owns the live
// session (call-webrtc.js / call-channel.js), same as today.
//
// - getStream(): read accessor for the local MediaStream currently being
//   sent -- the same object switchCamera/the video-filter compositor
//   already mutate today (removeTrack/addTrack on `media.stream`), just
//   reached through the session instead of a raw `media` closure variable.
//   Local-preview mutation stays the CALLER's job (unchanged from today):
//   the caller mutates the stream returned here for the preview, then
//   separately calls replaceOutgoingVideoTrack below for the peer-facing
//   side -- this interface only ever does the latter.
//
// - replaceOutgoingVideoTrack(track): replaces the 3 duplicated
//   activeWebrtcPc.getSenders()...replaceTrack call sites (camera.js's
//   switchCamera, video-filters.js's startVideoFilterCompositor/
//   disableVideoFilterAndRestoreCamera). For a channel session this is a
//   true no-op: the direct-channel transport's MediaRecorder was already
//   handed a fixed stream at call setup (see runChannelMediaCall) and never
//   re-reads it mid-call, so there was never a peer-visible track swap on
//   that path to begin with -- matches today's behavior exactly, not a new
//   limitation introduced by this interface.
//
// - requestFallbackToChannel(reason, peerInitiated = false): mirrors
//   today's attemptChannelFallback(reason, peerInitiated) -- still inline
//   in app.js's run(), itself already at the orchestration layer per the
//   plan's own note (attemptChannelFallback doesn't live inside webrtc-
//   specific code today either). This method does NOT perform the handoff
//   itself: with peerInitiated=false it best-effort notifies the peer
//   (TAG_FALLBACK) via the notifyPeerFallback callback supplied at
//   construction, then fires this session's onFallback listeners;
//   app.js's orchestration is what actually constructs the replacement
//   call-channel.js session, swaps it in, and re-uses the still-open
//   stream/noiseTransport -- exactly as attemptChannelFallback does today.
//   peerInitiated=true is how call-webrtc.js's own signaling receive loop
//   reports an incoming TAG_FALLBACK frame from the peer (today's line
//   ~1443-1446): same method, skips the peer-notify (no point echoing a
//   fallback notice back to whoever just sent one), still fires
//   onFallback so the hang-up choke point sees a handoff rather than a
//   real end. One fallback per session -- see makeFallbackEmitter's own
//   comment for the one-shot-then-terminal guard (matches
//   channelFallbackAttempted's existing latch shape). Only meaningful on a
//   webrtc session; a channel session has nowhere further to fall back to,
//   so its own requestFallbackToChannel is a no-op.
//
// - onFallback(cb): registers a callback fired once, right before this
//   session is about to be replaced by a different transport (either
//   direction above). Lets the single hang-up choke point
//   (returnToDialerAfterHangup) tell "handed off, call continues under a
//   new session" apart from "actually ended."

// One fallback per session -- same one-shot-then-terminal shape as
// channelFallbackAttempted today: a second call after the first already
// fired is silently ignored rather than re-notifying listeners, matching
// attemptChannelFallback's own channelFallbackAttempted guard (a second
// failure after the fallback is already running goes through
// endCallDueToPeerLoss instead, unchanged -- this emitter only ever
// concerns itself with the ONE handoff, not what happens after).
function makeFallbackEmitter() {
  const callbacks = [];
  let fired = false;
  return {
    onFallback(cb) {
      callbacks.push(cb);
    },
    fireFallback(reason) {
      if (fired) return;
      fired = true;
      for (const cb of callbacks) {
        try {
          cb(reason);
        } catch (e) {
          // A listener's own bug shouldn't block the handoff it's reacting to.
        }
      }
    },
  };
}

// pc: the live RTCPeerConnection (today's activeWebrtcPc). media: the
// {kind, stream} object getLocalMedia() returns. notifyPeerFallback: the
// transport-specific "tell the peer I'm switching" send (today's
// sendSignal(new Uint8Array([TAG_FALLBACK]))) -- passed in rather than
// baked in here, since sending it needs run()'s own noiseTransport/stream
// closure, which this module deliberately doesn't reach into.
function createWebrtcCallSession(pc, media, notifyPeerFallback) {
  const emitter = makeFallbackEmitter();
  return {
    async replaceOutgoingVideoTrack(track) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(track);
    },
    requestFallbackToChannel(reason, peerInitiated = false) {
      if (!peerInitiated) {
        try {
          notifyPeerFallback?.();
        } catch (e) {
          // Best-effort, same as attemptChannelFallback's own try/catch
          // today -- a failed notify shouldn't block the local fallback.
        }
      }
      emitter.fireFallback(reason);
    },
    onFallback: emitter.onFallback,
    getStream() {
      return media.stream;
    },
  };
}

// media: the {kind, stream} object for the direct-channel transport's own
// getLocalMedia() call.
function createChannelCallSession(media) {
  const emitter = makeFallbackEmitter();
  return {
    async replaceOutgoingVideoTrack(_track) {
      // No peer-visible effect on this transport -- see header comment.
    },
    requestFallbackToChannel(_reason, _peerInitiated = false) {
      // No-op -- already on the channel transport, nowhere further to fall back to.
    },
    onFallback: emitter.onFallback,
    getStream() {
      return media.stream;
    },
  };
}

export {
  createWebrtcCallSession,
  createChannelCallSession,
};
