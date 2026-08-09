Vendored (not built) third-party assets for CADS-webconference-demo's optional
video-filter feature (live-requested: "video filter, gerade fuer Kinder" +
"aufwaendigere Gesichtserkennung/Overlay-Sticker").

- Source: https://github.com/justadudewhohacks/face-api.js
- Pinned ref: `0.22.2` (tag, no `v` prefix in this repo's own tag naming)
- License: MIT (see that repo's own LICENSE file)
- Files here are exactly what that tag ships under `dist/face-api.min.js` and
  `weights/tiny_face_detector_model-*` / `weights/face_landmark_68_tiny_model-*`
  -- unmodified, byte-for-byte.

Why vendored instead of loaded from a CDN: this app's CSP is
`script-src 'self'` (no external script hosts at all, see Caddyfile*'s own
CSP header) -- any face-detection library has to be served from this app's
own origin or it can't run here. Only the two "tiny" models are vendored
(~270KB total) -- deliberately not the larger, more accurate detector/
recognition models, which would add several more MB for a feature that's
opt-in and only needs face BOUNDING BOXES + basic landmark points to
position overlay stickers, not real face recognition/identification.

Loaded lazily (only once a user actually enables the filter toggle in
app.js) -- never part of the page's normal initial load.
