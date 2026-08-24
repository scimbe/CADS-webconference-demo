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
// Live-requested: generic crown shape (a jagged band + round jewels), not
// modeled on any specific franchise's design -- same "geometric shape, not
// a raster likeness" approach as drawEar/drawSparkle above.
function drawCrown(ctx, x, y, w, h, fillColor, jewelColor) {
  ctx.save();
  ctx.translate(x - w / 2, y - h);
  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, h * 0.35);
  ctx.lineTo(w * 0.17, h * 0.7);
  ctx.lineTo(w * 0.33, h * 0.1);
  ctx.lineTo(w * 0.5, h * 0.55);
  ctx.lineTo(w * 0.67, h * 0.1);
  ctx.lineTo(w * 0.83, h * 0.7);
  ctx.lineTo(w, h * 0.35);
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = jewelColor;
  for (const fx of [0.17, 0.5, 0.83]) {
    ctx.beginPath();
    ctx.arc(w * fx, h * 0.62, w * 0.045, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
// Six-armed ice-crystal shape -- deliberately not a snowflake emoji glyph or
// any specific character's iconography, just a generic winter/ice motif.
function drawSnowflake(ctx, x, y, r) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(210, 240, 255, 0.95)';
  ctx.lineWidth = Math.max(1.5, r * 0.12);
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.rotate((i * Math.PI) / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -r);
    ctx.moveTo(0, -r * 0.55);
    ctx.lineTo(-r * 0.22, -r * 0.75);
    ctx.moveTo(0, -r * 0.55);
    ctx.lineTo(r * 0.22, -r * 0.75);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}
// A single braided plait draped over one shoulder -- alternating offset
// segments (a common procedural-braid technique: tapering ellipses that
// zig-zag left/right, each with a faint diagonal cross-line to read as
// "woven" rather than a solid rope) plus a tie band near the top and a
// small tuft at the tip. Live-requested (2026-08-16, reference: a generic
// long-braid hairstyle photo) -- same "geometric shape anchored to real
// landmarks, not a raster likeness of any specific character" approach as
// drawCrown/drawSnowflake above; hair/tie colors are plain generic tones,
// not modeled on any particular franchise's palette.
function drawBraid(ctx, x, y, length, width, tiltDeg, hairColor, tieColor) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((tiltDeg * Math.PI) / 180);
  const segments = 9;
  const segH = length / segments;
  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const segY = i * segH;
    const segW = width * (1 - t * 0.6); // taper toward the tip
    const offsetX = (i % 2 === 0 ? -1 : 1) * segW * 0.22; // alternating weave
    ctx.fillStyle = hairColor;
    ctx.beginPath();
    ctx.ellipse(offsetX, segY + segH / 2, segW / 2, segH * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.14)';
    ctx.lineWidth = Math.max(1, segW * 0.08);
    ctx.beginPath();
    ctx.moveTo(offsetX - segW * 0.38, segY + segH * 0.18);
    ctx.lineTo(offsetX + segW * 0.38, segY + segH * 0.82);
    ctx.stroke();
  }
  ctx.fillStyle = tieColor;
  ctx.beginPath();
  ctx.ellipse(0, width * 0.18, width * 0.4, width * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = hairColor;
  ctx.beginPath();
  ctx.ellipse(0, length, width * 0.16, width * 0.26, 0, 0, Math.PI * 2);
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
  } else if (style === 'princess') {
    const crownWidth = eyeSpan * 1.8;
    const crownHeight = box.height * 0.32;
    drawCrown(ctx, box.x + box.width / 2, box.top + crownHeight * 0.15, crownWidth, crownHeight, '#f6c453', '#ff6fa5');
  } else if (style === 'ice-princess') {
    // Generalized winter/ice theme -- icy palette + snowflake motif, not
    // any specific character's braid, dress, or color design.
    const crownWidth = eyeSpan * 1.7;
    const crownHeight = box.height * 0.3;
    drawCrown(ctx, box.x + box.width / 2, box.top + crownHeight * 0.15, crownWidth, crownHeight, '#cdeeff', '#8fd8ff');
    drawSnowflake(ctx, box.x - box.width * 0.08, box.y + box.height * 0.15, eyeSpan * 0.28);
    drawSnowflake(ctx, box.x + box.width * 1.08, box.y + box.height * 0.25, eyeSpan * 0.22);
  } else if (style === 'snowman') {
    // Generic snowman face: coal eyes + a carrot nose + a simple hat brim --
    // not modeled on any specific character's proportions or body.
    ctx.fillStyle = '#1c2733';
    ctx.beginPath();
    ctx.arc(leftEye.x, leftEye.y, eyeSpan * 0.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rightEye.x, rightEye.y, eyeSpan * 0.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff8a3d';
    ctx.beginPath();
    ctx.moveTo(noseTip.x, noseTip.y - eyeSpan * 0.06);
    ctx.lineTo(noseTip.x + eyeSpan * 0.32, noseTip.y);
    ctx.lineTo(noseTip.x, noseTip.y + eyeSpan * 0.06);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#22262b';
    ctx.beginPath();
    ctx.ellipse(box.x + box.width / 2, box.top - box.height * 0.02, box.width * 0.42, box.height * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(box.x + box.width * 0.28, box.top - box.height * 0.24, box.width * 0.44, box.height * 0.24);
  } else if (style === 'mouse-ears') {
    // A generic small animal's round ears (gray fur, pink inner ear) --
    // same construction as the existing bunny filter's own ears, deliberately
    // NOT a solid-black silhouette or any specific character's bow/color.
    const earR = eyeSpan * 0.42;
    const earY = box.top - box.height * 0.12;
    for (const side of [-1, 1]) {
      const ex = box.x + box.width / 2 + side * eyeSpan * 0.7;
      ctx.fillStyle = '#8c92a6';
      ctx.beginPath();
      ctx.arc(ex, earY, earR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f3b8c9';
      ctx.beginPath();
      ctx.arc(ex, earY, earR * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#6b7182';
    ctx.beginPath();
    ctx.ellipse(noseTip.x, noseTip.y, eyeSpan * 0.06, eyeSpan * 0.045, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (style === 'pup') {
    const earWidth = eyeSpan * 0.5;
    const earHeight = box.height * 0.55;
    const earY = box.top + earHeight * 0.15;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(box.x + box.width / 2 + side * eyeSpan * 0.85, earY);
      ctx.rotate((side * 18 * Math.PI) / 180);
      ctx.fillStyle = '#a9754f';
      ctx.beginPath();
      ctx.ellipse(0, 0, earWidth / 2, earHeight / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7a5439';
      ctx.beginPath();
      ctx.ellipse(0, earHeight * 0.08, earWidth * 0.32, earHeight * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#2b2420';
    ctx.beginPath();
    ctx.ellipse(noseTip.x, noseTip.y, eyeSpan * 0.11, eyeSpan * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2b2420';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(noseTip.x, noseTip.y + eyeSpan * 0.06);
    ctx.lineTo(noseTip.x, noseTip.y + eyeSpan * 0.18);
    ctx.stroke();
    ctx.fillStyle = '#ff8fa3';
    ctx.beginPath();
    ctx.ellipse(noseTip.x, noseTip.y + eyeSpan * 0.32, eyeSpan * 0.09, eyeSpan * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (style === 'braid') {
    // Generic single braid draped over one shoulder -- see drawBraid's own
    // header comment for the "not any specific character's design" note.
    const braidWidth = eyeSpan * 0.5;
    const braidLength = box.height * 1.5;
    const anchorX = box.x + box.width * 0.78;
    const anchorY = box.top + box.height * 0.72;
    drawBraid(ctx, anchorX, anchorY, braidLength, braidWidth, 6, '#f2d98a', '#e8a6c1');
  } else if (style === 'ladybug') {
    // Generic "ladybug" costume face paint: a red domino mask across the
    // eyes, black polka dots on both cheeks, and a pair of small bobbing
    // antennae -- a widely-recognized generic costume motif (red + black
    // spots + antennae), not modeled on any specific character's face
    // paint, hairstyle, or color design.
    const maskW = eyeSpan * 1.9;
    const maskH = box.height * 0.24;
    ctx.fillStyle = 'rgba(196, 30, 40, 0.88)';
    ctx.beginPath();
    ctx.ellipse((leftEye.x + rightEye.x) / 2, (leftEye.y + rightEye.y) / 2, maskW / 2, maskH / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = Math.max(2, eyeSpan * 0.05);
    ctx.stroke();
    const dotR = eyeSpan * 0.09;
    ctx.fillStyle = '#1a1a1a';
    const cheekDots = [
      { x: box.x + box.width * 0.14, y: box.y + box.height * 0.62 },
      { x: box.x + box.width * 0.22, y: box.y + box.height * 0.78 },
      { x: box.x + box.width * 0.86, y: box.y + box.height * 0.62 },
      { x: box.x + box.width * 0.78, y: box.y + box.height * 0.78 },
    ];
    for (const d of cheekDots) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = Math.max(2, eyeSpan * 0.06);
    ctx.lineCap = 'round';
    const antBaseY = box.top + box.height * 0.08;
    for (const side of [-1, 1]) {
      const bx = box.x + box.width / 2 + side * eyeSpan * 0.35;
      const tipX = bx + side * eyeSpan * 0.22;
      const tipY = antBaseY - box.height * 0.32;
      ctx.beginPath();
      ctx.moveTo(bx, antBaseY);
      ctx.quadraticCurveTo(bx + side * eyeSpan * 0.15, antBaseY - box.height * 0.18, tipX, tipY);
      ctx.stroke();
      ctx.fillStyle = 'rgba(196, 30, 40, 0.95)';
      ctx.beginPath();
      ctx.arc(tipX, tipY, eyeSpan * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
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
  //
  // Live-reported: enabling a filter froze the video, and with it the whole
  // page, for a real, user-perceptible stretch. Root cause: this callback
  // had no re-entrancy guard -- faceapi.detectSingleFace/withFaceLandmarks
  // (TensorFlow.js underneath) can easily take longer than 150ms, especially
  // on the CPU backend or before WebGL shaders have warmed up. setInterval
  // doesn't wait for an async callback to finish before firing the next
  // tick, so a slow pass let a SECOND detection start on top of the first,
  // then a third on top of that -- each one itself expensive CPU/GPU work,
  // piling up faster than any of them could finish and starving the main
  // thread (and therefore the rAF-driven draw loop AND page interactivity)
  // for however long it took the backlog to drain. `detecting` bounds this
  // to at most one in-flight detection pass at a time -- a tick landing
  // while one is still running is simply skipped, same shape as every other
  // "don't start a second overlapping async attempt" guard in this file
  // (selectFilterStyle's own startingCompositor) and elsewhere this session.
  let detecting = false;
  state.detectTimer = setInterval(async () => {
    if (state.stopped || sourceVideo.readyState < 2 || detecting) return;
    detecting = true;
    try {
      state.latestDetection = (await faceapi.detectSingleFace(sourceVideo, detectorOptions).withFaceLandmarks(true)) || null;
    } catch (_) {
      // one bad detection pass isn't fatal -- keep drawing the last known position
    } finally {
      detecting = false;
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

let startingCompositor = false; // guards the first-activation branch inside selectFilterStyle, below

// Applies an explicit style (null | 'bunny' | 'sparkle' | 'princess' |
// 'ice-princess' | 'snowman' | 'mouse-ears' | 'pup' | 'braid' | 'ladybug')
// directly -- the
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
    // Robustness audit finding (round 2 re-read, not yet live-reproduced --
    // needs a rapid re-pick landing inside a real first-ever loadFaceApi()
    // network/model-load window): this branch had no re-entrancy guard,
    // unlike every other "await spans a user-repeatable action" case fixed
    // this session (camera.js's switchInFlight, access-requests.js's
    // inFlightRequestActions, dialForm/idForm's disabled-button guards).
    // videoFilterState is only ever set at the very end of this branch (by
    // startVideoFilterCompositor), so a second filter pick landing here
    // before the first one's own await chain resolved would sail straight
    // through this same null check a second time and call
    // startVideoFilterCompositor() independently -- leaking the FIRST
    // invocation's rAF loop and 150ms detectTimer forever (until the next
    // full page reload) once the second call's state clobbers the shared
    // module-scope videoFilterState. Same fix shape as those precedents: a
    // second pick while one activation is already in flight is now just a
    // no-op instead of a second overlapping compositor.
    if (startingCompositor) return;
    startingCompositor = true;
    // Live-reported 2026-08-24: filters did nothing at all in practice mode
    // (practice-mode.js) -- captured here, BEFORE the loadFaceApi() await
    // below, because the "call ended while loading" guard further down reads
    // getActiveSession() again AFTER that await and needs to tell "a call
    // was live and then ended" apart from "there was never a call in the
    // first place" (practice mode's permanent, legitimate baseline -- see
    // that file's own header comment: it deliberately never touches
    // call-transport code, so getActiveSession() is always null there).
    const hadSessionBeforeLoad = !!getActiveSession();
    try {
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
      // scheduled reload eventually tears down the whole page. Only bail
      // here if a session WAS live before this await and is gone now (a
      // real hangup-during-load) -- not merely because there's no session
      // at all, which is practice mode's normal, permanent state and isn't
      // "the call ended", there never was one to end.
      if (hadSessionBeforeLoad && !getActiveSession()) {
        btnVideoFilters.disabled = false;
        return;
      }
      btnVideoFilters.disabled = false;
      startVideoFilterCompositor(media);
    } finally {
      startingCompositor = false;
    }
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
