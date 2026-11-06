// node --test test/  -- ice-watchdog.js decision logic, no browser needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIceWatchdog, resolveFallbackConfig, DEFAULT_TIMEOUT_MS, LOCAL_OVERRIDE_KEY } from '../ice-watchdog.js';

function fakePc(state = 'new', pairs = []) {
  return {
    iceConnectionState: state,
    pairs,
    async getStats() { return new Map(this.pairs.map((p, i) => [`p${i}`, { type: 'candidate-pair', ...p }])); },
  };
}
function clock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    advance(ms) { t += ms; for (const h of [...timers]) if (h.at <= t) { timers.splice(timers.indexOf(h), 1); h.fn(); } },
  };
}
const flush = () => new Promise((r) => setImmediate(r));

test('fires on timeout while ICE is still checking and nothing is nominated', async () => {
  const c = clock(); const pc = fakePc('checking'); const fired = [];
  const w = createIceWatchdog(pc, { timeoutMs: 10000, onTrigger: (x) => fired.push(x), ...c });
  w.start();
  c.advance(9999); await flush();
  assert.equal(fired.length, 0, 'not before the limit');
  c.advance(1); await flush();
  assert.deepEqual(fired, [{ cause: 'timeout', elapsedMs: 10000, iceState: 'checking' }]);
  assert.equal(w.active, false);
});

test('fires early on failed (no nominated pair), and only once', async () => {
  const c = clock(); const pc = fakePc('checking'); const fired = [];
  const w = createIceWatchdog(pc, { timeoutMs: 10000, onTrigger: (x) => fired.push(x), ...c });
  w.start();
  c.advance(3000);
  pc.iceConnectionState = 'failed';
  w.notify(); w.notify(); await flush();
  c.advance(20000); await flush();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].cause, 'failed');
  assert.equal(fired[0].elapsedMs, 3000);
});

test('fires on connectionState failed even while iceConnectionState reads disconnected (Chrome)', async () => {
  const c = clock(); const pc = fakePc('checking'); const fired = [];
  const w = createIceWatchdog(pc, { timeoutMs: 60000, onTrigger: (x) => fired.push(x), ...c });
  w.start();
  c.advance(16500);
  pc.iceConnectionState = 'disconnected';
  pc.connectionState = 'failed';
  w.notify(); await flush();
  assert.deepEqual(fired, [{ cause: 'failed', elapsedMs: 16500, iceState: 'disconnected' }]);
});

test('disconnected alone (no failure yet) waits for the time limit', async () => {
  const c = clock(); const pc = fakePc('disconnected'); const fired = [];
  const w = createIceWatchdog(pc, { timeoutMs: 10000, onTrigger: (x) => fired.push(x), ...c });
  w.start(); w.notify(); await flush();
  assert.equal(fired.length, 0);
  c.advance(10000); await flush();
  assert.equal(fired[0].cause, 'timeout');
});

test('does not fire once connected', async () => {
  const c = clock(); const pc = fakePc('checking'); const fired = [];
  const w = createIceWatchdog(pc, { timeoutMs: 10000, onTrigger: (x) => fired.push(x), ...c });
  w.start();
  pc.iceConnectionState = 'connected';
  w.notify();
  c.advance(30000); await flush();
  assert.equal(fired.length, 0);
  assert.equal(w.active, false);
});

test('a nominated, succeeded pair at the deadline prevents the switch', async () => {
  const c = clock(); const pc = fakePc('checking', [{ state: 'succeeded', nominated: true }]); const fired = [];
  const w = createIceWatchdog(pc, { timeoutMs: 10000, onTrigger: (x) => fired.push(x), ...c });
  w.start();
  c.advance(10000); await flush();
  assert.equal(fired.length, 0);
});

test('pairs that are not nominated/succeeded do not count', async () => {
  const c = clock();
  const pc = fakePc('checking', [{ state: 'in-progress', nominated: true }, { state: 'succeeded', nominated: false }, { state: 'failed' }]);
  const fired = [];
  createIceWatchdog(pc, { timeoutMs: 5000, onTrigger: (x) => fired.push(x), ...c }).start();
  c.advance(5000); await flush();
  assert.equal(fired.length, 1);
});

test('nothing happens before start() (ICE not begun)', async () => {
  const c = clock(); const pc = fakePc('failed'); const fired = [];
  const w = createIceWatchdog(pc, { timeoutMs: 5000, onTrigger: (x) => fired.push(x), ...c });
  w.notify(); c.advance(60000); await flush();
  assert.equal(fired.length, 0);
});

test('stop() cancels', async () => {
  const c = clock(); const pc = fakePc('checking'); const fired = [];
  const w = createIceWatchdog(pc, { timeoutMs: 5000, onTrigger: (x) => fired.push(x), ...c });
  w.start(); w.stop(); c.advance(60000); await flush();
  assert.equal(fired.length, 0);
});

const store = (v) => ({ getItem: (k) => (k === LOCAL_OVERRIDE_KEY ? v : null) });

test('config: enabled only from the server answer (account check)', () => {
  assert.deepEqual(resolveFallbackConfig({ enabled: true, timeoutMs: 8000, reason: 'account' }, store(null)), { enabled: true, timeoutMs: 8000, reason: 'account' });
  assert.equal(resolveFallbackConfig({ enabled: false, timeoutMs: 8000, reason: 'no_account' }, store(null)).enabled, false);
  assert.equal(resolveFallbackConfig(null, store('5000')).enabled, false, 'endpoint unreachable -> off');
  assert.equal(resolveFallbackConfig({ enabled: 'yes' }, null).enabled, false, 'only literal true');
});

test('config: timeout default, server value, local override, clamping', () => {
  assert.equal(resolveFallbackConfig({ enabled: true }, null).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_MS, 10000);
  assert.equal(resolveFallbackConfig({ enabled: true, timeoutMs: 15000 }, store(null)).timeoutMs, 15000);
  assert.equal(resolveFallbackConfig({ enabled: true, timeoutMs: 15000 }, store('6000')).timeoutMs, 6000);
  assert.equal(resolveFallbackConfig({ enabled: true, timeoutMs: 500 }, null).timeoutMs, 3000);
  assert.equal(resolveFallbackConfig({ enabled: true, timeoutMs: 10 ** 7 }, null).timeoutMs, 60000);
  assert.equal(resolveFallbackConfig({ enabled: true, timeoutMs: 'x' }, store('garbage')).timeoutMs, DEFAULT_TIMEOUT_MS);
  const throwing = { getItem() { throw new Error('denied'); } };
  assert.equal(resolveFallbackConfig({ enabled: true, timeoutMs: 7000 }, throwing).timeoutMs, 7000);
});

test('every client module reachable from app.js is copied into the Caddy image', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const docker = fs.readFileSync(path.join(root, 'Caddy.Dockerfile'), 'utf8');
  const seen = new Set();
  const visit = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^'"]*['"]\.\/([\w.-]+\.js)['"]/gm)) visit(m[1]);
  };
  visit('app.js');
  assert.ok(seen.has('ice-watchdog.js'));
  for (const f of seen) assert.match(docker, new RegExp(`^COPY ${f.replace('.', '\\.')} /srv/${f.replace('.', '\\.')}$`, 'm'), `${f} missing from Caddy.Dockerfile`);
});
