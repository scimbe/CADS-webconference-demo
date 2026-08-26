#!/usr/bin/env bash
# start-webconference-on-boot.sh — bring webconference-demo's 3 containers (origin,
# bridge, agent) back up cleanly after a host reboot.
#
# Added 2026-08-26: this repo had NO boot-recovery mechanism at all before this --
# only each container's own `restart: unless-stopped` policy, which the docker
# daemon honors when it starts back up. That's usually enough for a stateless
# container, but CADS-flappy-demo's own history (start-crew-on-boot.sh's header
# comment: a 2026-08-10 reboot left its role-serve containers not actually back up
# despite similar assumptions) is a concrete, live precedent for why "the restart
# policy alone should cover it" isn't something to just assume here too --
# especially for webconference-demo-agent, which does a real onboarding/registration
# handshake with the control-plane and edge on every startup (confirmed live via its
# own logs: "ct-agent: onboarded agent=... via https://bunsenbrenner.org" / "fetched
# edge cert" / "registered with edge ... (serving)"), not just a stateless process
# restart. A force-recreate on every boot guarantees a genuinely fresh container
# (fresh /tmp, fresh capability file, no leftover state from before the reboot)
# instead of trusting the daemon's own restart of a container that may still be
# holding pre-reboot state in its writable layer.
#
# Idempotent: safe to re-run manually too -- --force-recreate never leaves two
# overlapping instances of anything running.
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '[%s] start-webconference-on-boot: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Docker itself may still be starting up right after boot -- wait for it rather
# than failing once and never being retried (this script only runs once at boot).
for i in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  log "waiting for docker (attempt $i/30)..."
  sleep 2
done
docker info >/dev/null 2>&1 || { log "docker never became ready -- giving up"; exit 1; }

COMPOSE_FILE="compose.webconference-demo.selfservice.yml"
ENV_FILE=".env.selfservice"
[ -f "$COMPOSE_FILE" ] || { log "FATAL: $COMPOSE_FILE not found in $(pwd)"; exit 1; }
[ -f "$ENV_FILE" ] || { log "FATAL: $ENV_FILE not found in $(pwd)"; exit 1; }

log "force-recreating webconference-demo-origin, -bridge, -agent (images already built -- this does not rebuild)"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --force-recreate \
  webconference-demo-origin webconference-demo-bridge webconference-demo-agent \
  || { log "docker compose up failed -- check 'docker ps -a | grep webconference' and 'docker compose -f $COMPOSE_FILE logs'"; exit 1; }

log "done"
