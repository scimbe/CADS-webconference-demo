// Camera acquisition and front/back switching. Split out of app.js as part
// of the client-code consolidation (CADS-webconference-demo#91); every
// function/const here is a verbatim move, comments included, with no
// behavior change.
//
// CADS-webconference-demo#91 (temporary, per the consolidation plan):
// switchCamera reaches into activeWebrtcPc, which is still declared and
// owned by app.js (the inline WebRTC call setup hasn't been extracted into
// its own call-webrtc.js module yet -- that's a later cycle). Imported back
// from app.js as a circular-import stopgap, same pattern pairing.js
// originally used for `api` before contacts.js existed -- read-only here
// (camera.js never reassigns it, only app.js's own not-yet-extracted call
// code does), so the live-binding import is safe. To be repointed to
// call-webrtc.js once that module exists.

import { btnSwitchCamera, log } from './ui-dom.js';
import { activeWebrtcPc } from './app.js';

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
    if (activeWebrtcPc) {
      const sender = activeWebrtcPc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }
  } catch (e) {
    log(`camera switch failed: ${e.message || e}`);
  }
}

export {
  currentFacingMode,
  cameraSwitchAvailable,
  getLocalMedia,
  switchCamera,
};
