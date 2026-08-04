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
CT_AGENT_REF="${CT_AGENT_REF:-86ab198ffc70d6dcb9ee1bb55efa2191dbd8d408}"
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
