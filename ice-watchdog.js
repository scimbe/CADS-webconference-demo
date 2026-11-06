// Automatic WebRTC -> direct-channel switch for calls whose ICE never comes up.
//
// Before this, call-webrtc.js only fell back after ICE had reached 'failed'
// AND an ICE restart had failed again within ICE_RESTART_GRACE_MS (20s) --
// i.e. ~30s (Chrome's own check timeout) + 20s on a network that blocks UDP,
// and never at all while ICE just sat in 'checking'. This watchdog covers the
// INITIAL connection only (an established call that later drops still goes
// through the existing restart path): if no candidate pair has been nominated
// within `timeoutMs`, or ICE reports 'failed' before that, it hands over to the
// direct-channel transport.
//
// Trigger = (ICE has failed -- iceConnectionState OR connectionState 'failed';
// Chrome reports connectionState 'failed' while iceConnectionState still reads
// 'disconnected', seen in the E2E -- OR it is still 'new'/'checking' when the
// time limit expires) AND getStats() shows no nominated, succeeded candidate
// pair. Both conditions, so a slow-but-working path that just got
// its pair nominated is never thrown away.
//
// No DOM access -- unit-tested in test/ice-watchdog.test.mjs.

// Why 10s: on a reachable path ICE completes far below that -- host/srflx
// pairs within ~0.1-2s, a TURN relay (allocation + permission + checks over a
// high-RTT mobile link) within ~2-5s. Chrome itself only declares 'failed'
// after ~30s of unanswered checks, which is what made the old path so slow.
// 10s leaves 2x headroom over the slowest working relay setup we expect,
// while a user behind a blocking firewall gets media after ~10s plus the
// direct-channel setup, not after ~50s or never.
const DEFAULT_TIMEOUT_MS = 10000;
const MIN_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 60000;
const LOCAL_OVERRIDE_KEY = 'ct-webconference-ice-fallback-ms';

function clampTimeout(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

// server: the /api/media-fallback answer ({enabled, timeoutMs, reason}) or null
// when it could not be fetched. `enabled` comes ONLY from the server (it is the
// account check -- see bridge/server.js); a local override may change the time
// limit, never switch the feature on.
function resolveFallbackConfig(server, storage) {
  let override = null;
  try { override = clampTimeout(storage?.getItem(LOCAL_OVERRIDE_KEY)); } catch (_) {}
  const timeoutMs = override ?? clampTimeout(server?.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const enabled = server?.enabled === true;
  return { enabled, timeoutMs, reason: enabled ? (server.reason || 'account') : (server?.reason || 'unavailable') };
}

// One retry: a transient 5xx/network blip must not silently turn the switch
// off for a signed-in account for the whole call. Still fails closed (off).
async function fetchFallbackConfig(fetchFn, storage, { retryDelayMs = 500 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, retryDelayMs));
    try {
      const r = await fetchFn('/api/media-fallback', { credentials: 'same-origin' });
      if (r.ok) return resolveFallbackConfig(await r.json(), storage);
      if (r.status < 500) break; // a definite answer (e.g. 401/404): no retry
    } catch (_) {
      // network error: retry once
    }
  }
  return resolveFallbackConfig(null, storage);
}

const CONNECTED = new Set(['connected', 'completed']);
const NOT_YET = new Set(['new', 'checking', 'failed', 'disconnected']);
const hasFailed = (pc) => pc.iceConnectionState === 'failed' || pc.connectionState === 'failed';

async function hasNominatedPair(pc) {
  try {
    const stats = await pc.getStats();
    for (const s of stats.values()) {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) return true;
    }
  } catch (_) {
    // stats unavailable (pc closed): nothing nominated as far as we can tell
  }
  return false;
}

// pc: an RTCPeerConnection (or anything with iceConnectionState,
// connectionState and getStats).
// onTrigger({ cause: 'failed' | 'timeout', elapsedMs, iceState }) is called at
// most once. Call start() when ICE begins, notify() from the pc's state-change
// handlers, stop() when the call ends or switches anyway.
function createIceWatchdog(pc, { timeoutMs, onTrigger, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let startedAt = null;
  let timer = null;
  let done = false;
  let evaluating = false;

  function stop() {
    done = true;
    if (timer) { clearTimer(timer); timer = null; }
  }

  async function evaluate(cause) {
    if (done || evaluating) return;
    const state = pc.iceConnectionState;
    if (CONNECTED.has(state)) { stop(); return; }
    if (cause === 'failed' ? !hasFailed(pc) : !NOT_YET.has(state)) return;
    evaluating = true;
    const nominated = await hasNominatedPair(pc);
    evaluating = false;
    if (done) return;
    stop();
    if (nominated) return;
    onTrigger({ cause, elapsedMs: now() - startedAt, iceState: pc.iceConnectionState });
  }

  return {
    start() {
      if (startedAt !== null || done) return;
      startedAt = now();
      timer = setTimer(() => { timer = null; evaluate('timeout'); }, timeoutMs);
    },
    notify() {
      if (done || startedAt === null) return;
      const state = pc.iceConnectionState;
      if (CONNECTED.has(state)) stop();
      else if (hasFailed(pc)) evaluate('failed');
    },
    stop,
    // true while the watchdog still owns the initial-connection decision --
    // call-webrtc.js skips its own restart path for 'failed' in that window
    get active() { return startedAt !== null && !done; },
  };
}

export {
  createIceWatchdog,
  resolveFallbackConfig,
  fetchFallbackConfig,
  hasNominatedPair,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  LOCAL_OVERRIDE_KEY,
};
