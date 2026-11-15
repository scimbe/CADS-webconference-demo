// Shared call-control plumbing used by both transports (call-channel.js,
// call-webrtc.js) and by app.js itself: the hangup/mic/cam/filter button
// wiring, the single termination choke point every transport funnels
// through, and the activeCallBye state that lets a pagehide send a 'bye' for
// whichever transport is actually live.
//
// CADS-webconference-demo#176: split out of app.js, which both transport
// modules already imported this from -- app.js itself imports
// runChannelMediaCall/runWebrtcMediaCall from those same two modules, so that
// was a real circular import (ES modules tolerate it here only because
// every one of these bindings is a function/setter only ever CALLED at
// runtime, well after all three modules have finished evaluating -- never
// read at module-evaluation time). A verbatim move: every function/const
// here, comments included, is unchanged from app.js's own copy; only the
// import list changed to match what actually lives here now.

import {
  btnHangup, btnMic, btnCam, btnSwitchCamera, btnVideoFilters, filterMenu,
  callScreen, offlineBanner, setCtlLabel, setStatus,
} from './ui-dom.js';
import { switchCamera } from './camera.js';
import { selectFilterStyle, toggleFilterMenu, closeFilterMenu, stopVideoFilterCompositor } from './video-filters.js';

// Set when either transport's call setup completes, cleared at the single
// choke point every termination path already funnels through
// (returnToDialerAfterHangup) so a later pagehide never fires a stale bye
// against an already-torn-down connection.
// CADS-webconference-demo#91: exported with a setter -- both this module's
// own webrtc call setup AND call-channel.js's runChannelMediaCall assign
// this (see the cycle 9 lesson: a variable reassigned from code that isn't
// moving with it needs a setter, not a plain live-binding import, since an
// imported binding is read-only from the importing module's side).
let activeCallBye = null;
function setActiveCallBye(v) { activeCallBye = v; }
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

// Live-reported: going offline yourself outside a call had no fast, clear
// feedback at all -- only the dialer/messenger shell's existing
// #conn-trouble-banner (contacts.js's noteApiResult), which only shows after
// 3 CONSECUTIVE failed background polls, however long that takes to
// accumulate. #96's own window.onoffline/ononline fix (below, previously
// registered only inside setupControls -- i.e. only once an actual call had
// started) already solved this instantly for the in-call #offline-banner;
// this is that exact same instant signal, registered unconditionally at
// module scope (this script re-runs top-to-bottom on every screen, since
// every screen transition in this app is a real page load/reload -- see
// run()'s own URL-param dispatch -- so "always active" just means
// "registered here instead of only inside setupControls", not a new
// persistent-SPA listener lifetime to manage) so it covers the dialer/
// messenger screens too. Reuses the existing #conn-trouble-banner element
// exactly as contacts.js already drives it -- no new banner, no DOM change.
// Deliberately does NOT touch #presence-lost-banner (a distinct, narrower
// signal for the presence WS specifically, with its own manual-reconnect
// button) or any of the reload-based recovery panels (identity-mismatch,
// startup/WASM-init failure) -- those handle genuinely different failure
// classes and are already correctly engineered for them, per this file's
// own existing comments; scope here is strictly "the browser itself just
// told us we have no network," recoverable in place, no state teardown.
function updateOfflineIndicator() {
  const offline = !navigator.onLine;
  if (!callScreen.hidden) {
    offlineBanner.hidden = !offline;
    return;
  }
  // Outside a call: don't fight noteApiResult's own identity-mismatch-sticky
  // guard or stomp #presence-lost-banner -- just reuse #conn-trouble-banner,
  // the same element the poll-failure path already owns, so there's exactly
  // one "connection trouble" banner per screen, not two disagreeing ones.
  const connBanner = document.getElementById('conn-trouble-banner');
  if (connBanner) connBanner.hidden = !offline;
}
window.addEventListener('offline', updateOfflineIndicator);
window.addEventListener('online', updateOfflineIndicator);
updateOfflineIndicator(); // covers already being offline at the moment this script runs

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
  //
  // Robustness audit finding (call-webrtc.js's attemptChannelFallback own
  // comment has the full detail): that property-assignment fix prevented a
  // second onHangup registration from stacking on top of the first, but
  // left a real gap open in the OTHER direction -- the window between
  // attemptChannelFallback starting the handoff and THIS function's own
  // (re-)registration below, during which the old transport's now-unsafe
  // onHangup was still the only one wired up. attemptChannelFallback now
  // disables btnHangup for exactly that window; re-enabling it here is a
  // harmless no-op for the normal single-call path (never disabled to
  // begin with) and the actual fix for the fallback path.
  btnHangup.disabled = false;
  btnMic.onclick = () => {
    if (media.kind !== 'media') return;
    micOn = !micOn;
    for (const t of media.stream.getAudioTracks()) t.enabled = micOn;
    setCtlLabel(btnMic, micOn ? '🎤' : '🔇', micOn ? 'Mute' : 'Unmute');
    btnMic.dataset.off = micOn ? '0' : '1';
    // CADS-webconference-demo#97 (live-reported, GUI-coverage test): the
    // label text/icon already changed on click, but nothing exposed the
    // toggle state to assistive tech -- aria-pressed mirrors dataset.off
    // (true once the mic is muted, the button's "engaged" state).
    btnMic.setAttribute('aria-pressed', String(!micOn));
  };
  btnCam.onclick = () => {
    if (media.kind !== 'media') return;
    camOn = !camOn;
    for (const t of media.stream.getVideoTracks()) t.enabled = camOn;
    setCtlLabel(btnCam, '📷', camOn ? 'Camera off' : 'Camera on');
    btnCam.dataset.off = camOn ? '0' : '1';
    // CADS-webconference-demo#98: same fix as #97 above, mirrored for the
    // camera toggle -- aria-pressed true once the camera is switched off.
    btnCam.setAttribute('aria-pressed', String(!camOn));
  };
  btnSwitchCamera.onclick = () => switchCamera(media);
  // CADS-webconference-demo#95: opens the filter-picker menu instead of
  // cycling styles directly -- filterMenu.onclick (item selection) and
  // document.onclick (outside-click-to-close) are both property
  // assignments too, same "setupControls may run twice" reasoning as
  // every other handler here.
  btnVideoFilters.onclick = () => toggleFilterMenu(media);
  filterMenu.onclick = (ev) => {
    const item = ev.target.closest('.filter-menu-item');
    if (!item || item.disabled) return;
    selectFilterStyle(media, item.dataset.style || null);
    closeFilterMenu();
  };
  document.onclick = (ev) => {
    if (!filterMenu.hidden && !filterMenu.contains(ev.target) && !btnVideoFilters.contains(ev.target)) {
      closeFilterMenu();
    }
  };
  btnHangup.onclick = () => {
    try { onHangup(); } catch {}
    setStatus('you-hung-up');
    for (const t of (media.kind === 'media' ? media.stream.getTracks() : [])) t.stop();
    closeFilterMenu();
    returnToDialerAfterHangup();
  };
  // CADS-webconference-demo#96's offline/online handling moved to module
  // scope (updateOfflineIndicator, registered once near this file's top) so
  // it also covers the dialer/messenger screens, not just an active call --
  // see that function's own comment for the full reasoning. Re-check here
  // anyway: setupControls can run twice per page load (the webrtc->channel
  // fallback handoff), and the module-level registration's own "covers
  // already offline" call happened once at script-load time, before this
  // specific call (or fallback) existed.
  updateOfflineIndicator();
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
  // Video filters (if ever enabled this call) hold a live rAF loop, a
  // detection setInterval, AND the original raw camera track detached from
  // media.stream (swapped out in favor of the canvas-capture track) -- none
  // of which the reload below implicitly cleans up fast enough to stop the
  // camera's in-use indicator right away. Same choke-point reasoning as
  // activeCallBye just above: every termination path funnels through here.
  stopVideoFilterCompositor();
  setTimeout(() => {
    location.href = location.pathname;
  }, delayMs);
}

export { setupControls, returnToDialerAfterHangup, setActiveCallBye };
