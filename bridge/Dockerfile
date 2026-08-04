# webconference-demo-bridge: plain Node (native fetch, Node 20+), zero deps.
# Needs the already-built ct-video-call-grant binary (this repo's own
# video-call-grant/ crate) to mint grants -- copied in via a build context
# rather than rebuilt here, since it's already compiled and pinned to this
# repo's ct-common tag.
FROM node:20-bookworm-slim
WORKDIR /srv
COPY server.js ./
COPY --from=grant-bin ct-video-call-grant /usr/local/bin/ct-video-call-grant
RUN chmod +x /usr/local/bin/ct-video-call-grant
EXPOSE 8791
CMD ["node", "server.js"]
