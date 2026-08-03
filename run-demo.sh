#!/usr/bin/env bash
# Enable/disable the webconference.bunsenbrenner.org demo -- same publishing shape as
# CADS-Tunnel's examples/help-site/run-demo.sh and CADS-auction-demo/CADS-a2a-demo's
# own run-demo.sh.
#
#   ./build-wasm.sh    # build pkg/ first (Caddy.Dockerfile COPYs it in)
#   ./run-demo.sh up      # enable  (default) -- mint token, deploy, wait for HTTPS
#   ./run-demo.sh down    # disable -- take the demo offline
#   ./run-demo.sh status  # show container status
#
# `up` assumes a RUNNING CADS-Tunnel plane reachable from this host: ct-edge (with
# CT_EDGE_BROWSER_LISTEN=:443 for this demo's own Browser-Plane tunnel, AND
# CT_EDGE_WS_CHANNEL_LISTEN published for the video-call WebSocket traffic itself --
# see CADS-Tunnel's docker/deploy/compose.selfhost.yml) and ct-control-plane. It
# mints a join token, brings up the Caddy origin (real LE cert via deSEC DNS-01,
# issued CORE-side and relayed in) + a Browser-Plane agent bound to the hostname,
# then polls until the page is served over HTTPS.
#
# Standalone (not nested inside a CADS-Tunnel checkout) -- set ENV_FILE to wherever
# the plane's admin-token env actually lives (e.g. /path/to/CADS-Tunnel/docker/deploy/.env)
# if you need it.
set -euo pipefail
cd "$(dirname "$0")"

CMD="${1:-up}"
COMPOSE="docker compose -f compose.webconference-demo.yml"
ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a || true

HOSTNAME_FQDN="${HOSTNAME_FQDN:-webconference.bunsenbrenner.org}"
CP_URL="${CP_URL:-${WEBCONFERENCE_AGENT_CP_URL:-http://127.0.0.1:8090}}"
EDGE="${EDGE:-${WEBCONFERENCE_AGENT_EDGE:-127.0.0.1:4433}}"
# CP_URL/EDGE above are this SCRIPT's own host-side reachability checks; the
# CONTAINERIZED agent needs the plane's compose-network service names instead when
# co-located (e.g. control-plane:8090 / edge:4433) -- override if not co-located.
CONTAINER_CP_URL="${CONTAINER_CP_URL:-$CP_URL}"
CONTAINER_EDGE="${CONTAINER_EDGE:-$EDGE}"
TENANT="${TENANT:-webconference-demo}"
EDGE_ADMIN_URL="${CT_CP_EDGE_ADMIN_URL:-}"
EDGE_ADMIN_TOKEN="${CT_CP_EDGE_ADMIN_TOKEN:-}"

say() { printf '\033[36m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

if [ "$CMD" = "down" ] || [ "$CMD" = "disable" ] || [ "$CMD" = "off" ]; then
  say "Taking webconference-demo offline (stopping origin + agent)"
  $COMPOSE down
  printf '\033[32m✓ webconference-demo is OFFLINE.\033[0m\n'
  exit 0
fi
if [ "$CMD" = "status" ]; then
  $COMPOSE ps
  exit 0
fi
[ "$CMD" = "up" ] || [ "$CMD" = "enable" ] || [ "$CMD" = "on" ] || die "unknown command '$CMD' (use: up | down | status)"

say "Checking prerequisites"
[ -d pkg ] || die "pkg/ missing -- run ./build-wasm.sh first"
WEBCONFERENCE_CERT_DIR="${WEBCONFERENCE_CERT_DIR:?set WEBCONFERENCE_CERT_DIR=<dir with fullchain.pem+privkey.pem from the operator>}"
[ -f "$WEBCONFERENCE_CERT_DIR/fullchain.pem" ] && [ -f "$WEBCONFERENCE_CERT_DIR/privkey.pem" ] \
  || die "no fullchain.pem/privkey.pem in WEBCONFERENCE_CERT_DIR=$WEBCONFERENCE_CERT_DIR — ask the operator to authorize $HOSTNAME_FQDN and relay the cert files"
WEBCONFERENCE_EDGE_WS="${WEBCONFERENCE_EDGE_WS:?set WEBCONFERENCE_EDGE_WS=<plane host>:<CT_EDGE_WS_CHANNEL_LISTEN port, e.g. 4437>}"
command -v docker >/dev/null || die "docker not found."
curl -fsS "$CP_URL/healthz" >/dev/null 2>&1 || curl -fsS "$CP_URL/status" >/dev/null 2>&1 \
  || die "control-plane not reachable at $CP_URL (is the plane running?). Set CP_URL."

RESOLVED="$(getent hosts "$HOSTNAME_FQDN" 2>/dev/null | awk '{print $1; exit}')" || true
[ -n "$RESOLVED" ] && echo "   $HOSTNAME_FQDN -> $RESOLVED" \
  || echo "   ! $HOSTNAME_FQDN does not resolve yet (deSEC NS may still be propagating)."

# A caller without the admin token (e.g. a routine-lifecycle maintainer handed
# a batch of pre-minted single-use tokens instead of the admin token itself,
# #214) can skip minting entirely by pre-setting WEBCONFERENCE_JOIN_TOKEN --
# consumes one of the batch instead of calling the admin-gated /enroll/issue.
if [ -n "${WEBCONFERENCE_JOIN_TOKEN:-}" ]; then
  say "Using pre-minted WEBCONFERENCE_JOIN_TOKEN (skipping /enroll/issue -- no admin token needed)"
  TOKEN="$WEBCONFERENCE_JOIN_TOKEN"
else
  say "Minting a join token at $CP_URL/enroll/issue"
  if [ -n "$EDGE_ADMIN_TOKEN" ]; then
    TOKEN="$(curl -fsS -X POST "$CP_URL/enroll/issue" -H 'content-type: application/json' \
              -H "x-ct-admin-token: $EDGE_ADMIN_TOKEN" -d "{\"tenant\":\"$TENANT\"}" \
              | sed -n 's/.*"token":"\([0-9a-f]\{64\}\)".*/\1/p')"
  else
    TOKEN="$(curl -fsS -X POST "$CP_URL/enroll/issue" -H 'content-type: application/json' \
              -d "{\"tenant\":\"$TENANT\"}" | sed -n 's/.*"token":"\([0-9a-f]\{64\}\)".*/\1/p')"
  fi
  [ -n "$TOKEN" ] || die "could not mint a join token (if the CP gates /enroll/issue, set CT_CP_EDGE_ADMIN_TOKEN in $ENV_FILE, or set WEBCONFERENCE_JOIN_TOKEN to a pre-minted one)"
  echo "   token minted (single-use; not printed)"
fi

WEBCONFERENCE_AGENT_TOKEN=""
if [ -n "$EDGE_ADMIN_URL" ] && [ -n "$EDGE_ADMIN_TOKEN" ]; then
  command -v openssl >/dev/null || die "openssl needed to mint a routing token (or unset CT_CP_EDGE_ADMIN_URL to use BP4a)."
  WEBCONFERENCE_AGENT_TOKEN="$(openssl rand -hex 32)"
  say "Authorizing $HOSTNAME_FQDN at the edge (hostname-ownership, BP4b)"
  curl -fsS -X POST "${EDGE_ADMIN_URL%/}/admin/authorize-host/$WEBCONFERENCE_AGENT_TOKEN/$HOSTNAME_FQDN" \
       -H "x-ct-admin-token: $EDGE_ADMIN_TOKEN" >/dev/null \
    || die "edge authorize-host failed (check CT_CP_EDGE_ADMIN_URL / token / edge admin listener)."
  echo "   authorized — agent registers under this routing token."
else
  echo "   ! edge host-auth not configured — relying on BP4a (fine for one hostname)."
fi

say "Starting the Caddy origin + Browser-Plane agent"
WEBCONFERENCE_JOIN_TOKEN="$TOKEN" \
WEBCONFERENCE_AGENT_TOKEN="$WEBCONFERENCE_AGENT_TOKEN" \
WEBCONFERENCE_AGENT_EDGE="$CONTAINER_EDGE" \
WEBCONFERENCE_AGENT_CP_URL="$CONTAINER_CP_URL" \
WEBCONFERENCE_AGENT_EDGE_CERT_URL="${WEBCONFERENCE_AGENT_EDGE_CERT_URL:-$CONTAINER_CP_URL}" \
WEBCONFERENCE_CERT_DIR="$WEBCONFERENCE_CERT_DIR" \
WEBCONFERENCE_EDGE_WS="$WEBCONFERENCE_EDGE_WS" \
  $COMPOSE up --build -d

say "Waiting for https://$HOSTNAME_FQDN/ (Caddy completes the deSEC DNS-01 challenge first) …"
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$HOSTNAME_FQDN/" >/dev/null 2>&1; then
    printf '\033[32m✓ LIVE — https://%s/ serves the live video-call demo.\033[0m\n' "$HOSTNAME_FQDN"
    exit 0
  fi
  sleep 5
done
echo "   Not reachable yet. Check:"
echo "     - DNS:     dig +short A $HOSTNAME_FQDN @1.1.1.1   (must be this host)"
echo "     - cert:    $COMPOSE logs webconference-demo-origin   (deSEC DNS-01 progress)"
echo "     - agent:   $COMPOSE logs webconference-demo-agent     (onboard + hostname bind)"
echo "     - edge:    CT_EDGE_BROWSER_LISTEN=:443 and CT_EDGE_WS_CHANNEL_LISTEN both set and reachable?"
die "demo not live within the timeout (see hints above)."
