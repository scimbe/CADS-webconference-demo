# The Browser-Plane agent for this demo, built from the standalone scimbe/ct-agent
# repo (not vendored) -- same shape as examples/help-site/Agent.Dockerfile and
# examples/flappy-demo's agent build in the CADS-Tunnel repo. This is deliberately
# closer to how a real customer installs ct-agent: build (or, once a tagged release
# exists for the pinned ref, download a prebuilt binary) from that repo directly.

FROM rust:1-slim-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
# Which ct-agent commit/tag to build -- bump deliberately (bump-ct-agent.yml
# automates checking for a newer one). Must match build-wasm.sh's own default
# and both compose files' CT_AGENT_REF (CADS-webconference-demo#29 -- they'd
# drifted once before).
# Bumped 2026-08-13 (v0.4.8): the actual root cause of the CADS-flappy-demo
# admission-stall saga, pinned by the operator via live edge logs -- the
# edge parks a lone pairing member for a 30s TTL, but the client's own
# ADMISSION_EXCHANGE_TIMEOUT was only 15s, so any pairing whose second side
# took 15-30s to arrive failed deterministically. v0.4.8 raises it to 45s.
# Keep in sync with build-wasm.sh's own default and both compose files'
# CT_AGENT_REF.
ARG CT_AGENT_REF=a3d33f8b68aeafc3b53646a7ccd183c4ba807585
RUN git clone https://github.com/scimbe/ct-agent.git /build && cd /build && git checkout "${CT_AGENT_REF}"
WORKDIR /build
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked -p ct-agent \
    && cp target/release/ct-agent /tmp/ct-agent

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /tmp/ct-agent /usr/local/bin/ct-agent
CMD ["ct-agent"]
