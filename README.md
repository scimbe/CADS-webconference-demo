# CADS-webconference-demo — real WASM-in-browser Agent-Fabric video calling

`https://webconference.bunsenbrenner.org` (once deployed) is two browser tabs
joining a real [CADS-Tunnel](https://github.com/scimbe/CADS-Tunnel) Agent-Fabric
channel entirely in-browser: `ct-agent-wasm` ([scimbe/ct-agent](https://github.com/scimbe/ct-agent)'s
browser build — channel-join/Noise_IK-handshake/WebRTC-signaling primitives
against CADS-Tunnel's `ct-common` core, compiled to WASM) drives a real WebSocket
connection to the edge's `ws_channel.rs` listener, runs a real Noise_IK handshake,
and exchanges real encrypted WebRTC signaling messages to establish a real
`RTCPeerConnection` — genuine browser-native audio/video, not a reimplementation.

It has grown well past a bare call demo: a persistent encrypted messenger (chat,
file attachments, contacts) is layered on top of the same identity and channel
primitives, plus a handful of on-call video filters.

## What's real, what's simulated

- **Real**: every cryptographic and protocol step. `holderSign`/
  `buildChannelJoinRequest` (channel admission), the Noise_IK handshake, the
  encrypted offer/answer/ICE-candidate/bye signaling messages, and the resulting
  `RTCPeerConnection` are all the genuine article — the same primitives CADS-Tunnel
  verifies end-to-end against its own edge binary, and, separately, this demo's own
  live verification: two real Chromium tabs (via Playwright,
  `--use-fake-device-for-media-stream` for a reproducible capture device) joined a
  channel registered through a real Keycloak/OIDC login, over the real production
  edge, and reached `RTCPeerConnection` state `connected` on both sides.
- **Simulated**: nothing in the call path. The only thing "faked" for automated
  testing is the camera/microphone hardware itself (Chromium's synthetic test
  pattern) — the capture, encoding, and peer connection around it are real. A human
  visiting with a real camera/microphone gets the genuine thing.
- **Messenger features are real too, not a mockup**: persistent chat backed by
  `chatStore.js` (message bodies encrypted at rest, one key per conversation),
  encrypted file attachments (chunked so large files don't blow past a single
  sync-push request), a contacts/blocked list, and cross-tab live updates via
  `BroadcastChannel` so a second open tab sees new messages without a reload.
- **Video filters** (`video-filters.js`): seven on-call overlay styles — `bunny`,
  `sparkle`, `princess`, `ice-princess`, `snowman`, `mouse-ears`, `pup` — a live
  face-tracking compositor layered on the local video element. Not available on
  the direct-channel transport (switching filters there would freeze the video;
  the UI disables the filter menu and says so).

## Known limitations — verified, not assumed

These are current, not historical — each one was independently reproduced against
the live production site, not inferred from reading the code.

- **The automatic WebRTC→direct-channel fallback is currently broken on a
  UDP-blocked network** ([#129](https://github.com/scimbe/CADS-webconference-demo/issues/129),
  open, reproduced 3/3 under real `tc netem`/`iptables` emulation, not just CDP
  throttling). On a network where UDP is blocked (STUN/ICE can never complete —
  the classic locked-down corporate egress policy), the default WebRTC transport
  never connects, the fallback to the direct-channel transport *does* fire, but it
  hands off a signaling WebSocket that has already gone stale — the call is
  silently abandoned roughly 2 seconds later and both users land back on the
  contact list with **no error shown**. There's also ~14 seconds of complete
  silence (no banner, no feedback) between the call screen appearing and the first
  "Reconnecting…" indicator, on every network path, regardless of whether the
  fallback ultimately works.
- **The workaround that does work**: manually enable **"Use direct-channel media
  (experimental)"** in the menu *before* dialing, rather than relying on the
  automatic fallback. On the identical UDP-blocked network — and even under a much
  harsher firewall that drops everything except TCP/80, TCP/443, and UDP/53 (a
  silent black hole, no ICMP rejection) — a call placed with this toggle
  pre-enabled connects cleanly, chat stays enabled the whole time, and hangup is
  clean. The transport itself is solid; only the automatic handoff into it is
  broken. The toggle isn't persisted across sessions (read fresh from the checkbox
  at dial time), so this has to be re-selected each time on a network you already
  know needs it.
- **No TURN relay** ([#18](https://github.com/scimbe/CADS-webconference-demo/issues/18),
  closed — the STUN-addition scope of it, not the full gap). `RTCPeerConnection`
  now uses a public STUN server (`iceServers` used to be empty), which resolves
  ordinary NAT — each side discovers its own reflexive address — but STUN alone
  can't traverse symmetric NAT or a locked-down corporate network. That needs a
  real TURN relay, which this demo has no infrastructure/credentials to offer.
  The direct-channel transport (manually enabled, see above) is the actual
  fallback for those networks today, not the automatic one.
- **Identity keys live in browser storage in the clear until you explicitly
  remove them** ([#42](https://github.com/scimbe/CADS-webconference-demo/issues/42),
  closed). Each identity's holder/Noise private keys persist in `localStorage`
  across reloads and tab closes by design (that's what lets a reload keep an
  in-progress call alive), cleared only via "Forget this identity" (or "Log out,"
  which forgets it too) — independently re-verified live: the action removes
  exactly that identity's keys, not a blanket wipe of other identities/contacts in
  the same browser. Contacts, blocked list, and message *metadata* (who/when/
  direction, not body content — chatStore only encrypts bodies,
  [#22](https://github.com/scimbe/CADS-webconference-demo/issues/22)) are
  similarly unencrypted at rest. Anyone who can read this browser profile's
  storage for this origin has the private keys themselves — don't use this demo
  on a shared/kiosk machine and walk away without forgetting your identity first.
- **Bridge trust model** ([#9](https://github.com/scimbe/CADS-webconference-demo/issues/9),
  closed): every mutating bridge endpoint now checks the caller's identity against
  the gate-verified header rather than trusting a client-supplied email field.
  Real secrets (the channel operator key, OIDC client credentials) still live in
  the bridge process's environment for its entire lifetime — treat this demo as
  "a small, curated set of participants who trust each other and the operator,"
  not a hardened multi-tenant service.

## Architecture

- `index.html` / `app.js` — the demo page. The original call screen is
  configured via URL query params (`ws`, `grant`, `holderPriv`, `noisePriv`,
  `role`); a full messenger-style shell (contacts, persistent encrypted chat,
  an admin panel) was layered on top afterward, backed by `chatStore.js` and
  `bridge/server.js` below — see those files' own header comments for detail
  this README doesn't duplicate. Still no build step, no bundler.
- `call-webrtc.js` / `call-channel.js` / `call-protocol.js` /
  `call-transport-shared.js` — the two call transports (WebRTC and the
  Agent-Fabric direct channel) and the fallback handoff between them.
- `chatStore.js` / `messenger-ui.js` / `contacts.js` / `video-filters.js` — the
  persistent encrypted messenger and on-call video filters layered on top of the
  original two-tab call demo.
- `pkg/` — `ct-agent-wasm` compiled for the browser (`wasm-bindgen --target web`),
  built by `./build-wasm.sh` from a pinned `scimbe/ct-agent` commit (see
  `Agent.Dockerfile`'s `CT_AGENT_REF` for the exact pin — `ct-agent-wasm` IS
  `ct-agent` for the browser, sharing one `ct-common` version with the native
  binary; not specific to this demo, so it stays in that repo's `wasm/` workspace
  member). This repo only ever builds against that pin, never vendors its source.
- `video-call-grant/` — `ct-video-call-grant`, the operator-side CLI that mints the
  `SignedChannelGrant`s two peers need for a manual (non-bridge-mediated) call — a
  browser peer can't mint its own grant, that needs the channel operator's private
  key. Pure local signing, no network call.
- Caddy origin + Browser-Plane agent (`Caddyfile`, `Caddy.Dockerfile`,
  `Agent.Dockerfile`, `compose.webconference-demo.yml`): Caddy serves the static
  page and reverse-proxies `/ws/channel` to the edge's dedicated
  `CT_EDGE_WS_CHANNEL_LISTEN` port; a Browser-Plane `ct-agent` tunnels
  `webconference.bunsenbrenner.org` traffic to that Caddy, terminating TLS with a
  cert issued CORE-side via deSEC DNS-01.
  `compose.webconference-demo.selfservice.yml` is a variant for deploying on a
  free-tier tunnel account instead of the operator-issued hostname — see that
  file's own header comment for exactly what differs (plain-HTTP origin behind
  a shared-cert tunnel, no external plane network).
- `bridge/server.js` — a directory + presence + call-signaling service so two
  browser tabs can find each other by email and place a call without a manual
  `ct-video-call-grant` step: holds the channel operator's private key, mints
  `SignedChannelGrant`s on demand (shelling out to `video-call-grant/`), proxies
  control-plane channel registration, and backs the full messenger UI (persistent
  encrypted chat, contacts, an admin-gated login-allowlist, background message
  delivery).

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
   free `yourname.dedyn.io` name if you don't have one). Set `DESEC_TOKEN` and
   `PORTAL_PUBLIC_HOST` to **your own** domain, not the operator's.
   - The video-conferencing WebSocket listener (`ws_channel.rs`,
     `CT_EDGE_WS_CHANNEL_LISTEN`) is already wired into the **base**
     `compose.selfhost.yml` and comes up automatically once
     `CT_EDGE_ADMIN_TOKEN` is set — no extra step for that specifically.
   - You have two options for the video-call WebSocket traffic itself: (a) let
     this demo's own Caddy reverse-proxy it (the shape documented below), or
     (b) set `CT_EDGE_WS_CHANNEL_CERT`/`CT_EDGE_WS_CHANNEL_KEY` on your edge so
     it terminates `wss://` natively and skip proxying that path through Caddy
     at all.

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
   (see the script's own header comment for the full var list).

   **Set `WEBCONFERENCE_ADMIN_EMAILS`** (comma-separated, on the bridge service)
   **to your own email** once your instance is gated. Left unset, the admin-only
   endpoints that *grant* tunnel access (`/api/access-requests/approve`,
   `/api/allowlist/add`) refuse to run at all (`503`) rather than silently
   trusting every gate-admitted caller.

4. **Verify it's real**, the same way the operator's instance was verified: mint
   two grants (`video-call-grant/`), open the page as two browser tabs, and
   confirm both reach `RTCPeerConnection` state `connected` — not just that the
   page loads. If you're on a restrictive network, also check the "Known
   limitations" section above before assuming the automatic fallback will save
   you — it currently won't; enable direct-channel media manually instead.

Once this is confirmed stable and working end-to-end on your own infrastructure,
the operator's own copy of this demo can be taken down — this repo, your plane,
and your subdomain are the durable home for it going forward.

## Provenance

Extracted from [scimbe/CADS-Tunnel](https://github.com/scimbe/CADS-Tunnel) — the
demo page, grant-minting CLI, and deployment scaffolding lived at
`examples/video-call-demo/` and `crates/agent-tools/src/bin/video_call_grant.rs`
there during development; moved here once the underlying protocol was proven. The
core primitives this demo depends on — the edge's `ws_channel.rs` browser channel
listener and cross-transport pairing with the `:443`/QUIC channel brokers —
remain in CADS-Tunnel itself. `ct-agent-wasm` itself moved a step further, from
CADS-Tunnel into [scimbe/ct-agent](https://github.com/scimbe/ct-agent)'s own
`wasm/` workspace member (it's `ct-agent` for the browser, not CADS-Tunnel
platform code).

## Related: a native Android client is in progress

[`CADS-webconference-android`](https://github.com/scimbe/CADS-webconference-android)
is a separate, in-progress effort to build a native counterpart to this demo — a
real Agent-Fabric channel-join + Noise_IK handshake + WebRTC client matching this
repo's own protocol behavior, but as a Kotlin/Android app rather than
`ct-agent-wasm` in a browser tab.
