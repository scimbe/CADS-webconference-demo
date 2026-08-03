#!/usr/bin/env bash
# Builds ct-agent-wasm (the browser Agent-Fabric channel primitives -- channel-join,
# Noise_IK handshake, WebRTC signaling protocol) for the browser
# (wasm-bindgen --target web) into ./pkg -- generated build output (gitignored),
# not source. ct-agent-wasm lives in CADS-Tunnel itself (it's core platform code,
# not part of this demo); this clones the pinned release tag and builds straight
# from that checkout, so this demo repo carries no CADS-Tunnel source of its own.
# Hermetic: runs entirely inside a throwaway container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADS_TUNNEL_TAG="${CADS_TUNNEL_TAG:-v0.4.12}"
OUT_DIR="$REPO_ROOT/pkg"

docker run --rm -m 2g --cpus 2 \
  -v "$REPO_ROOT":/work -w /work \
  -v ct-webconference-tunnel-src:/tunnel-src \
  -v ct-webconference-target:/cargo-target \
  -v ct-webconference-cargo-registry:/usr/local/cargo/registry \
  -v ct-webconference-rustup:/usr/local/rustup \
  -v ct-webconference-wasm-bindgen-cli:/usr/local/cargo/bin-wbg \
  rust:1-slim bash -c '
set -euo pipefail
export PATH=/usr/local/cargo/bin-wbg/bin:$PATH
export CARGO_TARGET_DIR=/cargo-target
apt-get update -qq >/dev/null && apt-get install -y -qq git >/dev/null

if [ -d /tunnel-src/.git ]; then
  git -C /tunnel-src fetch --depth 1 origin "tag:${CADS_TUNNEL_TAG}"
  git -C /tunnel-src checkout "'"$CADS_TUNNEL_TAG"'"
else
  git clone --depth 1 --branch "'"$CADS_TUNNEL_TAG"'" https://github.com/scimbe/CADS-Tunnel /tunnel-src
fi

cd /tunnel-src
rustup target add wasm32-unknown-unknown >/dev/null 2>&1
cargo build -p ct-agent-wasm --release --target wasm32-unknown-unknown
if ! command -v wasm-bindgen >/dev/null; then
  cargo install wasm-bindgen-cli --version 0.2.126 --root /usr/local/cargo/bin-wbg
fi
mkdir -p /work/pkg
wasm-bindgen --target web --out-dir /work/pkg \
  /cargo-target/wasm32-unknown-unknown/release/ct_agent_wasm.wasm
'

echo "built: $OUT_DIR (from CADS-Tunnel@$CADS_TUNNEL_TAG)"
