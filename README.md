# CADS-webconference-demo — real WASM-in-browser Agent-Fabric video calling

`https://webconference.bunsenbrenner.org` (once deployed) is two browser tabs
joining a real [CADS-Tunnel](https://github.com/scimbe/CADS-Tunnel) Agent-Fabric
channel entirely in-browser: `ct-agent-wasm` (CADS-Tunnel's channel-join/Noise_IK
handshake/WebRTC-signaling primitives, compiled to WASM) drives a real WebSocket
connection to the edge's `ws_channel.rs` listener, runs a real Noise_IK handshake,
and exchanges real encrypted WebRTC signaling messages to establish a real
`RTCPeerConnection` — genuine browser-native audio/video, not a reimplementation.

## What's real, what's simulated

- **Real**: every cryptographic and protocol step. `holderSign`/
  `buildChannelJoinRequest` (channel admission), the Noise_IK handshake, the
  encrypted offer/answer/ICE-candidate/bye signaling messages, and the resulting
  `RTCPeerConnection` are all the genuine article — the SAME primitives CADS-Tunnel
  verifies end-to-end against its own edge binary (see
  `scripts/e2e-video-call` in the CADS-Tunnel repo) and, separately, this demo's own
  live verification: two real Chromium tabs (via Playwright, `--use-fake-device-for-media-stream`
  for a reproducible capture device) joined a channel registered through a real
  Keycloak/OIDC login, over the real production edge, and reached `RTCPeerConnection`
  state `connected` on both sides.
- **Simulated**: nothing in the call path. The only thing "faked" for automated
  testing is the camera/microphone hardware itself (Chromium's synthetic test
  pattern) — the capture, encoding, and peer connection around it are real. A human
  visiting with a real camera/microphone gets the genuine thing.

## Architecture

- `index.html` / `app.js` — the demo page. Configured entirely via URL query
  params (`ws`, `grant`, `holderPriv`, `noisePriv`, `role`) — no build step, no
  bundler.
- `pkg/` — `ct-agent-wasm` compiled for the browser (`wasm-bindgen --target web`),
  built by `./build-wasm.sh` from a pinned CADS-Tunnel release tag. `ct-agent-wasm`
  is core CADS-Tunnel platform code (the browser port of its Agent-Fabric channel
  primitives) — genuinely useful to any browser-based Agent-Fabric application, not
  specific to this demo — so it stays in that repo; this one only ever builds
  against a tagged release, never vendors its source.
- `video-call-grant/` — `ct-video-call-grant`, the operator-side CLI that mints the
  `SignedChannelGrant`s this demo's two peers need (a browser peer can't mint its
  own grant — that needs the channel operator's private key). Pure local signing,
  no network call, depending on CADS-Tunnel's `ct-common` via the same pinned
  release tag (matches `CADS-auction-demo`'s own dependency convention).
- Caddy origin + Browser-Plane agent (`Caddyfile`, `Caddy.Dockerfile`,
  `Agent.Dockerfile`, `compose.webconference-demo.yml`) — same shape as
  `CADS-auction-demo`/`CADS-a2a-demo`: Caddy serves the static page and
  reverse-proxies `/ws/channel` to the edge's dedicated
  `CT_EDGE_WS_CHANNEL_LISTEN` port; a Browser-Plane `ct-agent` tunnels
  `webconference.bunsenbrenner.org` traffic to that Caddy, terminating TLS with a
  cert issued CORE-side via deSEC DNS-01.

## Running it

```bash
./build-wasm.sh                          # build pkg/
# mint two grants for a real test call (see video-call-grant/src/main.rs's own
# doc comment for the full join sequence each peer follows):
cd video-call-grant && cargo run -- <holder_a_hex> <holder_b_hex>
```

Deploying live: `./run-demo.sh up` (needs a running CADS-Tunnel plane reachable
from this host, `WEBCONFERENCE_CERT_DIR` with a real cert, and
`WEBCONFERENCE_EDGE_WS=<plane host>:<CT_EDGE_WS_CHANNEL_LISTEN port>` — see that
script's own header comment for every env var). The TLS certificate is issued
**CORE-side** (deSEC DNS-01 with the operator's zone-wide token) — this repo never
holds that credential; see CADS-Tunnel's `docs/dns01-desec.md` for the full
cert-issuance walkthrough.

## Provenance

Extracted from [scimbe/CADS-Tunnel](https://github.com/scimbe/CADS-Tunnel) — the
demo page, grant-minting CLI, and deployment scaffolding lived at
`examples/video-call-demo/` and `crates/agent-tools/src/bin/video_call_grant.rs`
there during development; moved here once the underlying protocol was proven (this
repo is a demo, not core platform code, matching `CADS-auction-demo`/
`CADS-a2a-demo`'s own separate-repo convention). The core primitives this demo
depends on — `ct-agent-wasm`, the edge's `ws_channel.rs` browser channel listener,
and cross-transport pairing with the `:443`/QUIC channel brokers — remain in
CADS-Tunnel itself.
