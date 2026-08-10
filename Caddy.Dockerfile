# Plain Caddy -- no custom build, no ACME DNS plugin. The origin's cert is issued
# CORE-side (CADS-Tunnel's scripts/authorize-pipeline.sh, deSEC DNS-01) and mounted
# in as static files; Caddy here only ever reads fullchain.pem/privkey.pem -- it
# never holds the deSEC zone-wide token. Same convention as the other CADS-Tunnel
# demos (help-site, flappy-demo, cookbook-demo, CADS-auction-demo, CADS-a2a-demo).
#
# Serves the static demo page (index.html/app.js/pkg -- built by build-wasm.sh
# BEFORE this image is built) and reverse-proxies /ws/channel to the edge's
# dedicated browser channel listener (ws_channel.rs) -- no backend bridge process
# of its own, unlike the other demos: this one has nothing to compute server-side.
FROM caddy:2
COPY index.html /srv/index.html
COPY app.js /srv/app.js
COPY call-protocol.js /srv/call-protocol.js
COPY ui-dom.js /srv/ui-dom.js
COPY identity.js /srv/identity.js
COPY pairing.js /srv/pairing.js
COPY call-transport-shared.js /srv/call-transport-shared.js
COPY chatStore.js /srv/chatStore.js
COPY request-access.html /srv/request-access.html
COPY request-access.js /srv/request-access.js
COPY pkg /srv/pkg
# Vendored (not built) -- see vendor/face-api/README.md for provenance/license/
# pin. Optional video-filter feature, lazy-loaded by app.js only when a user
# enables it.
COPY vendor /srv/vendor
