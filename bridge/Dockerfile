# webconference-demo-bridge: plain Node (native fetch, Node 20+), zero deps.
# Needs the already-built ct-video-call-grant binary (this repo's own
# video-call-grant/ crate) to mint grants -- copied in via a build context
# rather than rebuilt here, since it's already compiled and pinned to this
# repo's ct-common tag.
FROM node:20-bookworm-slim
WORKDIR /srv
COPY server.js ./
COPY media-fallback.js ./
COPY --from=grant-bin ct-video-call-grant /usr/local/bin/ct-video-call-grant
RUN chmod +x /usr/local/bin/ct-video-call-grant
# CADS-webconference-demo#177: this held the channel operator private key and
# the control-plane credentials (see server.js's own header comment) and ran
# as root by default -- more than either needs. node:*-slim images already
# ship a non-root `node` user for exactly this. /srv/data is where both
# compose files point WEBCONFERENCE_ACCESS_REQUESTS_FILE/
# WEBCONFERENCE_SYNC_STORE_FILE (a mounted named volume in both) -- created
# and chowned here so Docker initializes that volume with the right
# ownership the first time it's mounted over this directory.
RUN mkdir -p /srv/data && chown -R node:node /srv/data
USER node
EXPOSE 8791
CMD ["node", "server.js"]
