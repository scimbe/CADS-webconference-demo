# The Browser-Plane agent for this demo, built from the standalone scimbe/ct-agent
# repo (not vendored) -- same shape as examples/help-site/Agent.Dockerfile and
# examples/flappy-demo's agent build in the CADS-Tunnel repo. This is deliberately
# closer to how a real customer installs ct-agent: build (or, once a tagged release
# exists for the pinned ref, download a prebuilt binary) from that repo directly.

# Since v0.8.0 the pinned ref is a tagged release with prebuilt, checksummed binaries, so this image
# downloads that binary instead of compiling: no Rust toolchain, no cargo build on the 2-vCPU demo host,
# and the browser half (build-wasm.sh, built from the same commit) speaks the same wire protocol.
# Bumped 2026-11-02 to v0.8.0 (commit 09ac2ee). The running agent had drifted to 0.7.24 and the served
# WASM to an August build while all four pins still said c27e9ae; this brings both halves back together.
# Keep CT_AGENT_REF equal to the commit the tag points to, and in sync with build-wasm.sh and both compose files.
FROM debian:bookworm-slim AS fetch
ARG CT_AGENT_VERSION=v0.8.0
ARG CT_AGENT_REF=09ac2eefb9500ee0122d7afb7ff7321bd8b4c3a6
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; base="https://github.com/scimbe/ct-agent/releases/download/${CT_AGENT_VERSION}"; cd /tmp \
    && curl -fsSL -o ct-agent-linux-x86_64 "$base/ct-agent-linux-x86_64" \
    && curl -fsSL -o ct-agent-linux-x86_64.sha256 "$base/ct-agent-linux-x86_64.sha256" \
    && sha256sum -c ct-agent-linux-x86_64.sha256 \
    && install -m 0755 ct-agent-linux-x86_64 /tmp/ct-agent

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /tmp/ct-agent /usr/local/bin/ct-agent
CMD ["ct-agent"]
