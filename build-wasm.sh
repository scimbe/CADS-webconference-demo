#!/usr/bin/env bash
# Builds ct-agent-wasm (the browser Agent-Fabric channel primitives -- channel-join,
# Noise_IK handshake, WebRTC signaling protocol) for the browser
# (wasm-bindgen --target web) into ./pkg -- generated build output (gitignored),
# not source. ct-agent-wasm is "ct-agent for the browser" -- it lives in
# scimbe/ct-agent's own `wasm/` workspace member (moved there from CADS-Tunnel so
# native ct-agent and the browser build share one ct-common pin); this clones the
# pinned commit and builds straight from that checkout, so this demo repo carries
# no ct-agent source of its own. Hermetic: runs entirely inside a throwaway
# container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scimbe/ct-agent has no tagged release newer than v0.3.0 yet (see that repo's own
# Agent.Dockerfile comment) and its wasm/ member didn't exist before the workspace
# restructure commit -- pinned by commit SHA until a release tag covers it. Bump
# deliberately (bump-ct-agent.yml automates checking for a newer commit).
#
# CADS-webconference-demo#29: this pin MUST match Agent.Dockerfile's own
# CT_AGENT_REF default and both compose files' -- the WASM build here is
# the browser half of the same wire protocol the NATIVE ct-agent (built
# from Agent.Dockerfile, run as webconference-demo-agent) speaks. All four
# had drifted once before with no CI check catching it -- bump all four
# together from now on.
# Bumped 2026-08-13 (v0.4.8): the actual root cause of the CADS-flappy-demo
# admission-stall saga -- the edge parks a lone pairing member for a 30s
# TTL, but the client's own ADMISSION_EXCHANGE_TIMEOUT was only 15s. v0.4.8
# raises it to 45s. See Agent.Dockerfile's comment for the full story.
CT_AGENT_REF="${CT_AGENT_REF:-dc13b5a0ebe9715f5b3a58318b68a9ac1ce7d5bd}"
OUT_DIR="$REPO_ROOT/pkg"

docker run --rm -m 2g --cpus 2 \
  -v "$REPO_ROOT":/work -w /work \
  -v ct-webconference-agent-src:/agent-src \
  -v ct-webconference-target:/cargo-target \
  -v ct-webconference-cargo-registry:/usr/local/cargo/registry \
  -v ct-webconference-rustup:/usr/local/rustup \
  -v ct-webconference-wasm-bindgen-cli:/usr/local/cargo/bin-wbg \
  rust:1-slim bash -c '
set -euo pipefail
export PATH=/usr/local/cargo/bin-wbg/bin:$PATH
export CARGO_TARGET_DIR=/cargo-target
apt-get update -qq >/dev/null && apt-get install -y -qq git >/dev/null

if [ ! -d /agent-src/.git ]; then
  git clone https://github.com/scimbe/ct-agent /agent-src
fi
git -C /agent-src fetch origin
git -C /agent-src checkout "'"$CT_AGENT_REF"'"

cd /agent-src
rustup target add wasm32-unknown-unknown >/dev/null 2>&1
cargo build -p ct-agent-wasm --release --target wasm32-unknown-unknown
if ! command -v wasm-bindgen >/dev/null; then
  cargo install wasm-bindgen-cli --version 0.2.126 --root /usr/local/cargo/bin-wbg
fi
mkdir -p /work/pkg
wasm-bindgen --target web --out-dir /work/pkg \
  /cargo-target/wasm32-unknown-unknown/release/ct_agent_wasm.wasm
'

echo "built: $OUT_DIR (from ct-agent@$CT_AGENT_REF)"
