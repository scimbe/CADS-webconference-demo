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
# automates checking for a newer one). No tag newer than v0.3.0 exists yet; pinned
# past the workspace restructure that added wasm/ (ct-agent-wasm, this demo's
# browser build -- see build-wasm.sh) as a sibling of this native binary.
# CADS-webconference-demo#29 -- must match build-wasm.sh's own default and
# both compose files' CT_AGENT_REF (they'd drifted); see build-wasm.sh's
# comment for why b03f2efd is the one aligned to here.
ARG CT_AGENT_REF=b03f2efd1ab5ec34d745a98336593fa6d9791ff1
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
