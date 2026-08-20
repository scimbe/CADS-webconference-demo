// Live-requested: a local-only screen for kids to try out the video filters
// before a real call -- no dialing, no peer, no signaling of any kind.
//
// Research-confirmed before building this (see the plan this shipped from):
// a real "call yourself" loopback would need the FULL signaling pipeline
// (two separate registered sessions, a real Noise_IK handshake, grant
// minting) before the camera is ever touched -- heavyweight and fragile for
// what's meant to be a quick, always-available practice screen. Instead,
// this reuses getLocalMedia() (camera.js) and startVideoFilterCompositor/
// selectFilterStyle (video-filters.js) exactly as they already are: both
// already operate on a bare {kind, stream} media object and explicitly
// tolerate getActiveSession() === null throughout (every peer-push site is
// `if (session) ...`) -- zero changes needed to those files, zero call-
// transport code involved.
//
// Deliberately does NOT reuse the real call screen's #filter-menu popup --
// that element lives inside #call-screen and would be display:none via its
// hidden ancestor while practice mode (a different top-level screen) is
// showing (same class of bug #offline-banner had before this session's own
// robustness pass moved its listener registration out of setupControls).
// Simpler and equally correct: this screen's own inline filter-button row
// (index.html) calls selectFilterStyle directly, no popup needed.

import { getLocalMedia } from './camera.js';
import { selectFilterStyle, stopVideoFilterCompositor } from './video-filters.js';
import {
  practiceScreen, practiceVideo, practiceFilterRow, practiceDoneBtn, practiceEmpty,
  showPracticeScreen, log,
} from './ui-dom.js';

let practiceMedia = null;
let onExit = null; // set by enterPracticeMode -- returns to whichever screen opened this one

async function enterPracticeMode(exitCallback) {
  onExit = exitCallback;
  showPracticeScreen();
  practiceEmpty.hidden = true;
  practiceFilterRow.hidden = false;
  practiceMedia = await getLocalMedia();
  if (practiceMedia.kind !== 'media') {
    // No camera/mic (denied, in use elsewhere, no hardware) -- getLocalMedia
    // already logged why; tell the kid plainly instead of showing a dead
    // black video box with filter buttons that would silently do nothing.
    practiceEmpty.hidden = false;
    practiceFilterRow.hidden = true;
    return;
  }
  practiceVideo.srcObject = practiceMedia.stream;
  practiceFilterRow.onclick = (ev) => {
    const item = ev.target.closest('[data-style]');
    if (!item) return;
    selectFilterStyle(practiceMedia, item.dataset.style || null).catch((e) => {
      log(`practice mode: filter selection failed: ${e.message || e}`);
    });
  };
}

function exitPracticeMode() {
  stopVideoFilterCompositor();
  if (practiceMedia?.stream) {
    for (const t of practiceMedia.stream.getTracks()) t.stop();
  }
  practiceMedia = null;
  practiceVideo.srcObject = null;
  practiceScreen.hidden = true;
  onExit?.();
  onExit = null;
}

practiceDoneBtn.onclick = exitPracticeMode;

export { enterPracticeMode, exitPracticeMode };
