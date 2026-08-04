# CADS-webconference-demo — real WASM-in-browser Agent-Fabric video calling

`https://webconference.bunsenbrenner.org` (once deployed) is two browser tabs
joining a real [CADS-Tunnel](https://github.com/scimbe/CADS-Tunnel) Agent-Fabric
channel entirely in-browser: `ct-agent-wasm` ([scimbe/ct-agent](https://github.com/scimbe/ct-agent)'s
browser build -- channel-join/Noise_IK-handshake/WebRTC-signaling primitives
against CADS-Tunnel's `ct-common` core, compiled to WASM) drives a real WebSocket
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
  built by `./build-wasm.sh` from a pinned `scimbe/ct-agent` commit (see that repo's
  `wasm/` workspace member — `ct-agent-wasm` IS `ct-agent` for the browser,
  sharing one `ct-common` version with the native binary; not specific to this
  demo, so it stays there) — this repo only ever builds against that pin, never
  vendors its source.
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

## Self-hosting: running your own instance (not on the operator's host)

This demo needs a **CADS-Tunnel plane you control** (an edge + control-plane you
can reach and admin) — it isn't a standalone service. If you don't already run
one, that's the actual first step, not something specific to this repo:

1. **Stand up your own CADS-Tunnel plane.** In a `CADS-Tunnel` checkout:
   `./scripts/deploy-selfhost.sh --frontdoor` (see CADS-Tunnel's
   [`docs/ops/runbook.md`](https://github.com/scimbe/CADS-Tunnel/blob/main/docs/ops/runbook.md)).
   This is generic, not tied to any specific operator's domain or account — it
   issues a real Let's Encrypt cert via **deSEC DNS-01**
   ([`docs/dns01-desec.md`](https://github.com/scimbe/CADS-Tunnel/blob/main/docs/dns01-desec.md)),
   a free DNS host anyone can sign up for with **their own domain** (or even a
   free `yourname.dedyn.io` name if you don't have one — no registrar changes
   needed for that path). Set `DESEC_TOKEN` and `PORTAL_PUBLIC_HOST` to
   **your own** domain, not the operator's.
   - The video-conferencing WebSocket listener (`ws_channel.rs`,
     `CT_EDGE_WS_CHANNEL_LISTEN`) is already wired into the **base**
     `compose.selfhost.yml` and comes up automatically once
     `CT_EDGE_ADMIN_TOKEN` is set (a base-stack requirement regardless of this
     demo) — no extra step for that specifically.
   - As of CADS-Tunnel's `ws_channel.rs` native-TLS increment, you have two
     options for the video-call WebSocket traffic itself: (a) let this demo's
     own Caddy reverse-proxy it (the shape below, and what the operator's
     instance does), or (b) set `CT_EDGE_WS_CHANNEL_CERT`/`CT_EDGE_WS_CHANNEL_KEY`
     on your edge so it terminates `wss://` natively and skip proxying that path
     through Caddy at all. Either is a real, tested option — (a) is what's
     documented below since it matches this repo's existing `Caddyfile`/
     `run-demo.sh` shape.

2. **DNS + a cert for YOUR subdomain** (e.g. `webconference.yourdomain.tld`):
   point an `A` record at your plane's host, then get a cert the same way the
   front door got its own (deSEC DNS-01, or any ACME method you prefer) into a
   local directory with `fullchain.pem` + `privkey.pem`.

3. **Build and run this demo against your plane:**

   ```bash
   ./build-wasm.sh   # builds pkg/ from the pinned scimbe/ct-agent commit

   HOSTNAME_FQDN=webconference.yourdomain.tld \
   WEBCONFERENCE_CERT_DIR=/path/to/your/cert-dir \
   WEBCONFERENCE_EDGE_WS=<your-plane-host>:<CT_EDGE_WS_CHANNEL_LISTEN port, default 4437> \
   CP_URL=http://<your-plane-host>:8090 \
   EDGE=<your-plane-host>:4433 \
   ./run-demo.sh up
   ```

   `run-demo.sh` mints a join token from your own control-plane, brings up the
   Caddy origin + a Browser-Plane `ct-agent` bound to your hostname, and polls
   until the page serves over real HTTPS. If your plane's edge gates
   host-authorization, also set `CT_CP_EDGE_ADMIN_URL`/`CT_CP_EDGE_ADMIN_TOKEN`
   (see the script's own header comment for the full var list — every one is
   documented there, not just the ones above).

4. **Verify it's real**, the same way the operator's instance was verified: mint
   two grants (`video-call-grant/`), open the page as two browser tabs, and
   confirm both reach `RTCPeerConnection` state `connected` — not just that the
   page loads.

Once this is confirmed stable and working end-to-end on your own infrastructure,
the operator's own copy of this demo can be taken down — this repo, your plane,
and your subdomain are the durable home for it going forward.

## Provenance

Extracted from [scimbe/CADS-Tunnel](https://github.com/scimbe/CADS-Tunnel) — the
demo page, grant-minting CLI, and deployment scaffolding lived at
`examples/video-call-demo/` and `crates/agent-tools/src/bin/video_call_grant.rs`
there during development; moved here once the underlying protocol was proven (this
repo is a demo, not core platform code, matching `CADS-auction-demo`/
`CADS-a2a-demo`'s own separate-repo convention). The core primitives this demo
depends on — the edge's `ws_channel.rs` browser channel listener and cross-transport
pairing with the `:443`/QUIC channel brokers — remain in CADS-Tunnel itself.
`ct-agent-wasm` itself moved a step further, from CADS-Tunnel into
[scimbe/ct-agent](https://github.com/scimbe/ct-agent)'s own `wasm/` workspace
member (it's `ct-agent` for the browser, not CADS-Tunnel platform code).

## Related: a native Android client is in progress

[`CADS-webconference-android`](https://github.com/scimbe/CADS-webconference-android)
is a separate, in-progress effort to build a native counterpart to this demo — a
real Agent-Fabric channel-join + Noise_IK handshake + WebRTC client matching this
repo's own protocol behavior, but as a Kotlin/Android app rather than
`ct-agent-wasm` in a browser tab. It's also the flagship proof for
[The Development System](https://github.com/scimbe/CADS-devsystem)
([CADS-Tunnel#382](https://github.com/scimbe/CADS-Tunnel/issues/382)), a
self-optimizing, agent-driven development pipeline being built alongside it.

As of this writing: real Gradle scaffold, hermetically-verified signed debug APK,
a real unit test, CI, and a full toolchain modernization pass are done —
`MainActivity` is still a placeholder, not a working client. The actual bridge to
this protocol needs a Rust→Android JNI layer (CADS-Tunnel's Noise_IK/Agent-Fabric
code, same as `ct-agent-wasm` depends on here, has no existing Android path) —
an architecture decision currently open on CADS-Tunnel#382, not yet started.
