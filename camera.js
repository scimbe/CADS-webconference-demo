// Camera acquisition and front/back switching. Split out of app.js as part
// of the client-code consolidation (CADS-webconference-demo#91); every
// function/const here is a verbatim move, comments included, with no
// behavior change.
//
// CADS-webconference-demo#91 (cycle 17): switchCamera reaches the current
// call's session via call-session.js's getActiveSession() -- registered by
// whichever transport is live (call-webrtc.js / call-channel.js), cleared
// between calls -- instead of importing a transport-specific raw handle
// (the former activeWebrtcPc stopgap). replaceOutgoingVideoTrack is a true
// no-op on a channel session, matching this function's existing behavior
// exactly (channel calls never had a peer-visible track swap).

import { btnSwitchCamera, log } from './ui-dom.js';
import { getActiveSession } from './call-session.js';

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
// Robustness audit finding (proactive review, not yet live-reproduced --
// needs two genuinely overlapping camera-switch requests, hard to force
// deterministically even with a real double-click): nothing stopped a
// rapid double-click on the switch-camera button from starting a second
// switchCamera() while the first was still awaiting its own getUserMedia
// (a real hardware round-trip, not instant). Two concrete problems, not
// just wasted work:
// 1. `nextFacingMode` is computed from `currentFacingMode` BEFORE either
//    call's own await -- if both start before either finishes, both read
//    the SAME stale currentFacingMode and request the SAME target facing
//    mode, so what should have been "toggle, toggle back" instead
//    silently collapses into "toggle twice to the same side."
// 2. Worse: each invocation ends with its own
//    `await session.replaceOutgoingVideoTrack(newTrack)` -- a second,
//    independent async step with no ordering guarantee relative to the
//    other invocation's own replaceTrack call. If the FIRST invocation's
//    replaceTrack happens to resolve AFTER the second's (a genuine race
//    between two independent RTCRtpSender.replaceTrack calls), the peer
//    ends up receiving the first invocation's track as final -- which by
//    then has already been .stop()'d locally by the second invocation's
//    own cleanup. The peer would see a black/frozen remote video while
//    the local preview and currentFacingMode both correctly show the
//    intended camera.
// Fix: a simple in-flight guard, same shape as the disable-during-action
// pattern used for every other double-submit/re-entrancy fix this
// session (dialForm, idForm, access-requests.js) -- a second click while
// one switch is already in progress is now just a no-op instead of a
// second overlapping attempt.
let switchInFlight = false;
async function switchCamera(media) {
  if (media.kind !== 'media' || !cameraSwitchAvailable || switchInFlight) return;
  switchInFlight = true;
  try {
    const nextFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: nextFacingMode } });
    const newTrack = newStream.getVideoTracks()[0];
    const oldTrack = media.stream.getVideoTracks()[0];
    if (oldTrack) {
      media.stream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    media.stream.addTrack(newTrack);
    currentFacingMode = nextFacingMode;
    const session = getActiveSession();
    if (session) await session.replaceOutgoingVideoTrack(newTrack);
  } catch (e) {
    log(`camera switch failed: ${e.message || e}`);
  } finally {
    switchInFlight = false;
  }
}

export {
  currentFacingMode,
  cameraSwitchAvailable,
  getLocalMedia,
  switchCamera,
};
