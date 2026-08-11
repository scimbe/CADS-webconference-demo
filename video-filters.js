// Video filters: face-api.js lazy-loading, the canvas compositor that draws
// detected-face-anchored stickers onto a replacement video track, and the
// filter-picker menu wiring. Split out of app.js as part of the client-code
// consolidation (CADS-webconference-demo#91); the compositor functions are
// a verbatim move from that cycle. The selection UI itself was reworked in
// CADS-webconference-demo#95 (live-requested): a context menu listing every
// style directly (including "None"), replacing the original click-to-cycle
// button -- see toggleFilterMenu/selectFilterStyle below.
//
// CADS-webconference-demo#91 (cycle 17): same getActiveSession() call
// camera.js's switchCamera uses -- see camera.js's own header comment.

import { btnVideoFilters, filterMenu, filterMenuNote, filterMenuItems, log, addChatMessage } from './ui-dom.js';
import { getActiveSession } from './call-session.js';

// Live-requested: video filters, especially for kids. Vendored (not CDN --
// this app's CSP is script-src 'self', see vendor/face-api/README.md) tiny
// face-api.js models, lazy-loaded only the first time a user actually
// picks a style from the menu -- never part of the normal page/call weight.
// Off is the default, matching every other opt-in control in this call screen.
//
// Same "only the local preview is guaranteed, the channel-fallback peer
// isn't" caveat switchCamera's own comment documents: this replaces the
// outgoing video track via RTCRtpSender.replaceTrack for the webrtc
// transport (picked up mid-call, no renegotiation), but a MediaRecorder
// already handed a fixed stream (the channel-fallback transport) won't
// pick up a track swap mid-call -- same accepted limitation, not a new one.
const FACE_API_BASE = '/vendor/face-api';
let faceApiLoadPromise = null;
function loadFaceApi() {
  if (faceApiLoadPromise) return faceApiLoadPromise;
  faceApiLoadPromise = (async () => {
    if (!window.faceapi) {
      await new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = `${FACE_API_BASE}/face-api.min.js`;
        el.onload = resolve;
        el.onerror = () => reject(new Error('failed to load face-api.min.js'));
        document.head.appendChild(el);
      });
    }
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(`${FACE_API_BASE}/models`),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(`${FACE_API_BASE}/models`),
    ]);
  })().catch((e) => {
    faceApiLoadPromise = null; // a transient failure (offline, slow network) shouldn't permanently block a later retry
    throw e;
  });
  return faceApiLoadPromise;
}

function avgPoint(points) {
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}
function drawEar(ctx, x, y, w, h, tiltDeg) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((tiltDeg * Math.PI) / 180);
  ctx.fillStyle = '#f4d7e3';
  ctx.beginPath();
  ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffb6cf';
  ctx.beginPath();
  ctx.ellipse(0, h * 0.05, w * 0.28, h * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
function drawSparkle(ctx, x, y, r) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(255, 221, 100, 0.9)';
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    ctx.rotate(Math.PI / 2);
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(r * 0.15, -r * 0.15, r, 0);
    ctx.quadraticCurveTo(r * 0.15, r * 0.15, 0, r);
    ctx.quadraticCurveTo(-r * 0.15, r * 0.15, -r, 0);
    ctx.quadraticCurveTo(-r * 0.15, -r * 0.15, 0, -r);
  }
  ctx.fill();
  ctx.restore();
}
// Kept deliberately simple -- geometric shapes anchored to real detected
// landmark points, not raster sticker images (no extra asset files, and
// nothing that could be mistaken for a real photo of anyone). Not a claim
// of production-grade AR quality, just a real, working, live-camera-driven
// overlay rather than a static filter.
function drawKidStickers(ctx, detection, style) {
  if (!detection || !detection.landmarks) return;
  const box = detection.detection.box;
  const landmarks = detection.landmarks;
  const leftEye = avgPoint(landmarks.getLeftEye());
  const rightEye = avgPoint(landmarks.getRightEye());
  const nosePoints = landmarks.getNose();
  const noseTip = nosePoints[Math.floor(nosePoints.length / 2)] || avgPoint(nosePoints);
  const eyeSpan = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) || box.width * 0.3;
  if (style === 'bunny') {
    const earWidth = eyeSpan * 0.55;
    const earHeight = box.height * 0.85;
    const earY = box.top - earHeight * 0.6;
    drawEar(ctx, leftEye.x - eyeSpan * 0.35, earY, earWidth, earHeight, -12);
    drawEar(ctx, rightEye.x + eyeSpan * 0.35, earY, earWidth, earHeight, 12);
    ctx.fillStyle = '#ff8fb3';
    ctx.beginPath();
    ctx.ellipse(noseTip.x, noseTip.y, eyeSpan * 0.12, eyeSpan * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    for (const side of [-1, 1]) {
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(noseTip.x + side * eyeSpan * 0.15, noseTip.y + i * 6);
        ctx.lineTo(noseTip.x + side * eyeSpan * 0.65, noseTip.y + i * 11);
        ctx.stroke();
      }
    }
  } else if (style === 'sparkle') {
    ctx.strokeStyle = 'rgba(255, 210, 80, 0.85)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width * 0.62, box.height * 0.7, 0, 0, Math.PI * 2);
    ctx.stroke();
    const spots = [
      { x: box.x - box.width * 0.15, y: box.y + box.height * 0.1 },
      { x: box.x + box.width * 1.1, y: box.y + box.height * 0.2 },
      { x: box.x + box.width * 0.18, y: box.y - box.height * 0.18 },
      { x: box.x + box.width * 0.82, y: box.y - box.height * 0.12 },
    ];
    for (const s of spots) drawSparkle(ctx, s.x, s.y, eyeSpan * 0.2);
  }
}

let videoFilterState = null; // {sourceVideo, canvas, ctx, rawTrack, style, latestDetection, rafHandle, detectTimer, stopped}

function startVideoFilterCompositor(media) {
  const rawTrack = media.stream.getVideoTracks()[0];
  if (!rawTrack) return;
  const sourceVideo = document.createElement('video');
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.srcObject = new MediaStream([rawTrack]);
  sourceVideo.play().catch(() => {});
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const state = { sourceVideo, canvas, ctx, rawTrack, style: null, latestDetection: null, rafHandle: null, detectTimer: null, stopped: false };
  videoFilterState = state;

  const detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
  // Deliberately far below the ~30fps draw loop below -- a full detection
  // pass every frame would burn far more CPU than a demo call should cost;
  // stickers tracking a slightly-stale (up to 150ms old) position reads
  // fine for this, not a real AR product's accuracy bar.
  state.detectTimer = setInterval(async () => {
    if (state.stopped || sourceVideo.readyState < 2) return;
    try {
      state.latestDetection = (await faceapi.detectSingleFace(sourceVideo, detectorOptions).withFaceLandmarks(true)) || null;
    } catch (_) {
      // one bad detection pass isn't fatal -- keep drawing the last known position
    }
  }, 150);

  function drawFrame() {
    if (state.stopped) return;
    if (sourceVideo.videoWidth && (canvas.width !== sourceVideo.videoWidth || canvas.height !== sourceVideo.videoHeight)) {
      canvas.width = sourceVideo.videoWidth;
      canvas.height = sourceVideo.videoHeight;
    }
    if (canvas.width && canvas.height) {
      ctx.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
      if (state.style) {
        try { drawKidStickers(ctx, state.latestDetection, state.style); } catch (_) {}
      }
    }
    state.rafHandle = requestAnimationFrame(drawFrame);
  }
  drawFrame();

  const filteredTrack = canvas.captureStream(30).getVideoTracks()[0];
  media.stream.removeTrack(rawTrack);
  media.stream.addTrack(filteredTrack);
  const session = getActiveSession();
  if (session) session.replaceOutgoingVideoTrack(filteredTrack).catch((e) => log(`filter track swap failed: ${e.message || e}`));
}

function disableVideoFilterAndRestoreCamera(media) {
  const state = videoFilterState;
  if (!state) return;
  state.stopped = true;
  if (state.rafHandle) cancelAnimationFrame(state.rafHandle);
  clearInterval(state.detectTimer);
  state.sourceVideo.srcObject = null;
  const filteredTrack = media.stream.getVideoTracks()[0];
  if (filteredTrack && filteredTrack !== state.rawTrack) {
    media.stream.removeTrack(filteredTrack);
    filteredTrack.stop();
  }
  if (state.rawTrack.readyState !== 'ended') media.stream.addTrack(state.rawTrack);
  const session = getActiveSession();
  if (session) session.replaceOutgoingVideoTrack(state.rawTrack).catch((e) => log(`filter track restore failed: ${e.message || e}`));
  videoFilterState = null;
}

// Called from returnToDialerAfterHangup (the file's own established single
// choke point every call-termination path funnels through) -- stops the
// rAF/detection loops immediately and stops the DETACHED raw camera track
// (it was swapped out of media.stream while filters were active, so
// nothing else -- including btnHangup's own media.stream.getTracks().stop()
// -- still holds/stops it; without this the camera stays lit after hangup).
function stopVideoFilterCompositor() {
  const state = videoFilterState;
  if (!state) return;
  state.stopped = true;
  if (state.rafHandle) cancelAnimationFrame(state.rafHandle);
  clearInterval(state.detectTimer);
  state.sourceVideo.srcObject = null;
  try { state.rawTrack.stop(); } catch (_) {}
  videoFilterState = null;
}

// Applies an explicit style (null | 'bunny' | 'sparkle') directly -- the
// menu passes exactly which item was clicked, no cycling/index-tracking
// needed. Current selection is read back from videoFilterState?.style
// (null when off) rather than a separate tracked index.
async function selectFilterStyle(media, style) {
  if (media.kind !== 'media') return;
  // CADS-webconference-demo (live-reported): toggling a filter on the
  // direct-channel transport froze the video image outright -- see
  // call-session.js's own comment on the `kind` field for the root cause
  // (an already-running MediaRecorder doesn't pick up a live track swap
  // the way RTCRtpSender.replaceTrack does). Refuse the swap up front on
  // that transport instead of attempting it and freezing the call. The
  // menu items are also disabled in this case (see syncFilterMenu) -- this
  // check stays as defense in depth against reaching this function any
  // other way.
  if (getActiveSession()?.kind === 'channel') {
    addChatMessage('video filters aren\'t available on the direct-channel connection yet -- switching filters here would freeze the video', 'system');
    return;
  }
  // Live-reported: the button's own visible label used to change to
  // "Video filters: off"/"Video filters: bunny"/etc. on every selection --
  // the button's job is just to open the menu (it always reads "Filters"),
  // the CURRENT selection is what the menu itself already shows via
  // aria-checked on the matching item (syncFilterMenu, below). Only the
  // aria-label (screen-reader-only, never rendered) still tracks state for
  // accessibility -- the visible .ctl-icon/.ctl-label span are never
  // touched here anymore.
  if (style === null) {
    disableVideoFilterAndRestoreCamera(media);
    btnVideoFilters.setAttribute('aria-label', 'Video filters: off');
    return;
  }
  if (!videoFilterState) {
    btnVideoFilters.disabled = true;
    btnVideoFilters.setAttribute('aria-label', 'Loading filters…');
    try {
      await loadFaceApi();
    } catch (e) {
      log(`video filters unavailable: ${e.message || e}`);
      addChatMessage('video filters failed to load -- continuing without them', 'system');
      btnVideoFilters.disabled = false;
      btnVideoFilters.setAttribute('aria-label', 'Video filters: off');
      return;
    }
    // Robustness audit finding (proactive review, not yet live-reproduced
    // -- needs a real hangup landing inside the real network-fetch window
    // of a first-ever loadFaceApi() call, timing-dependent): hangup
    // (returnToDialerAfterHangup) calls stopVideoFilterCompositor() as its
    // single choke-point cleanup, then reloads the page ~1.2s later. If
    // that hangup happened WHILE this function's own await above was
    // still in flight, videoFilterState was still null at cleanup time --
    // stopVideoFilterCompositor() no-ops on a null state, correctly, since
    // there was nothing to stop yet. But this continuation, resuming
    // AFTER that cleanup already ran, would then go ahead and call
    // startVideoFilterCompositor() anyway -- starting a brand-new rAF
    // draw loop and 150ms detection setInterval that the choke point
    // never got a chance to know about, left running until the already-
    // scheduled reload eventually tears down the whole page. Re-checking
    // getActiveSession() here (the same "is a call still live" signal
    // this function already trusts for the channel-transport check at its
    // own top) catches "the call ended while we were loading" and skips
    // starting a compositor for a call that's already gone, instead of
    // relying on the reload's timing to paper over it.
    if (!getActiveSession()) {
      btnVideoFilters.disabled = false;
      return;
    }
    btnVideoFilters.disabled = false;
    startVideoFilterCompositor(media);
  }
  videoFilterState.style = style;
  btnVideoFilters.setAttribute('aria-label', `Video filters: ${style}`);
}

// CADS-webconference-demo#95: reflects the current selection (checked item)
// and, on a channel-transport call, disables every item with an inline
// note instead of letting the user pick something that would freeze the
// video (same underlying restriction selectFilterStyle enforces, surfaced
// up front here instead of only after a click).
function syncFilterMenu() {
  const currentStyle = videoFilterState?.style ?? null;
  const disabled = getActiveSession()?.kind === 'channel';
  filterMenuNote.hidden = !disabled;
  for (const item of filterMenuItems) {
    item.disabled = disabled;
    const itemStyle = item.dataset.style || null;
    item.setAttribute('aria-checked', String(itemStyle === currentStyle));
  }
}

function closeFilterMenu() {
  filterMenu.hidden = true;
  btnVideoFilters.setAttribute('aria-expanded', 'false');
}

function toggleFilterMenu(media) {
  if (media.kind !== 'media') return;
  if (!filterMenu.hidden) {
    closeFilterMenu();
    return;
  }
  syncFilterMenu();
  filterMenu.hidden = false;
  btnVideoFilters.setAttribute('aria-expanded', 'true');
}

export {
  selectFilterStyle,
  toggleFilterMenu,
  closeFilterMenu,
  stopVideoFilterCompositor,
};
