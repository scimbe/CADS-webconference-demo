// E2E: automatic WebRTC -> direct-channel fallback.
//   npx playwright test            (needs ./build-wasm.sh and the grant CLI, see README)
// Each test runs a REAL two-party call (two browser contexts, real ct-agent-wasm
// Noise_IK, real RTCPeerConnection) through test/e2e/harness.mjs. "Arrives" is
// checked on content, not on status: the receiver must see the sender's colour
// sequence on the remote <video>, hear the sender's tone, and show the exact
// chat text the sender typed.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness } from './harness.mjs';
import { probe } from './page-probe.mjs';

const TONE = { caller: 440, callee: 880 };
let h;
const metrics = {};

test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => {
  await h?.close();
  const out = process.env.E2E_METRICS_FILE || path.join('test-results', 'fallback-metrics.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(metrics, null, 2));
});

async function openPeer(browser, url, role, blockIce) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (process.env.E2E_VERBOSE) console.log(`[${role}] ${m.text()}`); });
  await page.addInitScript(probe, { tone: TONE[role], blockIce });
  await page.addInitScript(() => {
    // timestamps for the transport badge and every chat line, set up as soon as the DOM exists
    document.addEventListener('DOMContentLoaded', () => {
      const e2e = window.__e2e;
      e2e.badge = [];
      e2e.chat = [];
      const badge = document.getElementById('transport-badge');
      new MutationObserver(() => e2e.badge.push({ text: badge.textContent, t: Date.now() })).observe(badge, { childList: true, characterData: true, subtree: true });
      const log = document.getElementById('chat-log');
      new MutationObserver(() => {
        const last = log.lastElementChild;
        if (last) e2e.chat.push({ cls: last.className, text: last.textContent, t: Date.now() });
      }).observe(log, { childList: true });
    });
  });
  const t0 = Date.now();
  await page.goto(url);
  await page.evaluate(() => window.__e2e.startSampling());
  return { ctx, page, t0 };
}

async function call(browser, { blockIce }) {
  const links = await h.newCall();
  const [callee, caller] = await Promise.all([
    openPeer(browser, links.callee, 'callee', blockIce),
    openPeer(browser, links.caller, 'caller', blockIce),
  ]);
  return { caller, callee, t0: Math.min(caller.t0, callee.t0) };
}

const e2eOf = (p) => p.page.evaluate(() => {
  const { sent, seen, peaks, ice, conn, badge, chat, t0 } = window.__e2e;
  return { sent, seen, peaks, ice, conn, badge, chat, t0 };
});

// per colour switch the receiver saw: time since the SENDER produced that colour
function videoLatencies(sender, receiver) {
  const out = [];
  for (const s of (receiver.seen || []).slice(1)) { // [0] is whatever frame showed first, not a switch
    const src = sender.sent.filter((x) => x.idx === s.idx && x.t <= s.t).pop();
    if (src) out.push(s.t - src.t);
  }
  return out;
}
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

async function expectMediaAndChat({ caller, callee }, label) {
  // video: both directions show >= 4 colour switches of the other side's palette sequence
  await expect.poll(async () => videoLatencies(await e2eOf(caller), await e2eOf(callee)).length, { timeout: 30000 }).toBeGreaterThanOrEqual(4);
  await expect.poll(async () => videoLatencies(await e2eOf(callee), await e2eOf(caller)).length, { timeout: 30000 }).toBeGreaterThanOrEqual(4);
  // audio: the dominant remote frequency is the OTHER side's tone (bin width ~11.7 Hz at 48 kHz/4096)
  const tone = async (p) => median((await e2eOf(p)).peaks.slice(-6).map((x) => x.hz));
  await expect.poll(() => tone(callee), { timeout: 20000 }).toBeGreaterThan(TONE.caller - 25);
  expect(await tone(callee)).toBeLessThan(TONE.caller + 25);
  await expect.poll(() => tone(caller), { timeout: 20000 }).toBeGreaterThan(TONE.callee - 25);
  expect(await tone(caller)).toBeLessThan(TONE.callee + 25);
  // chat, both directions, exact text
  const chatLat = [];
  for (const [from, to, name] of [[caller, callee, 'caller'], [callee, caller, 'callee']]) {
    const text = `${label} hallo von ${name} ${Math.random().toString(36).slice(2, 8)}`;
    await expect(from.page.locator('#chat-send')).toBeEnabled({ timeout: 20000 });
    await from.page.fill('#chat-input', text);
    const sentAt = await from.page.evaluate(() => Date.now());
    await from.page.press('#chat-input', 'Enter');
    await expect(to.page.locator('.chat-msg.peer', { hasText: text })).toHaveCount(1, { timeout: 15000 });
    const got = (await e2eOf(to)).chat.find((c) => c.text.includes(text));
    chatLat.push(got.t - sentAt);
  }
  const ce = await e2eOf(caller), cl = await e2eOf(callee);
  const lat = [...videoLatencies(ce, cl), ...videoLatencies(cl, ce)];
  return {
    firstRemoteVideoMs: Math.max(cl.seen[0].t - cl.t0, ce.seen[0].t - ce.t0),
    videoLatencyMedianMs: median(lat),
    videoLatencyMaxMs: Math.max(...lat),
    videoSamples: lat.length,
    chatLatencyMs: chatLat,
    toneCallerHearsHz: await tone(caller),
    toneCalleeHearsHz: await tone(callee),
  };
}

test('baseline: WebRTC connects, media and chat arrive (no fallback)', async ({ browser }) => {
  test.setTimeout(90000);
  h.config.fallback = { enabled: true, timeoutMs: 10000 };
  // direct host candidates allowed; STUN/TURN still unreachable, which is fine on one host
  const c = await call(browser, { blockIce: false });
  await expect.poll(async () => (await e2eOf(c.caller)).conn.some((x) => x.s === 'connected'), { timeout: 20000 }).toBe(true);
  const ce = await e2eOf(c.caller);
  const m = await expectMediaAndChat(c, 'webrtc');
  await expect(c.caller.page.locator('#transport-badge')).toHaveText('webrtc');
  await expect(c.callee.page.locator('#transport-badge')).toHaveText('webrtc');
  metrics.baselineWebrtc = { iceConnectedMs: ce.conn.find((x) => x.s === 'connected').t - c.t0, ...m };
  await c.caller.ctx.close(); await c.callee.ctx.close();
});

for (const timeoutMs of [10000, 4000]) {
  test(`ICE blocked, signed-in account: switches to direct-channel after ${timeoutMs} ms, media and chat arrive`, async ({ browser }) => {
    test.setTimeout(120000);
    h.config.fallback = { enabled: true, timeoutMs };
    const c = await call(browser, { blockIce: true });
    await expect(c.caller.page.locator('#transport-badge')).toContainText('direct-channel', { timeout: timeoutMs + 15000 });
    await expect(c.callee.page.locator('#transport-badge')).toContainText('direct-channel', { timeout: 10000 });
    const ce = await e2eOf(c.caller), cl = await e2eOf(c.callee);
    // never a nominated pair: ICE never reached connected/completed on either side
    for (const p of [ce, cl]) expect(p.ice.some((x) => x.s === 'connected' || x.s === 'completed')).toBe(false);
    const switchAt = Math.min(...[ce, cl].map((p) => p.badge.find((b) => b.text.includes('direct-channel')).t));
    const iceStart = Math.min(...[ce, cl].map((p) => (p.ice[0] || p.conn[0] || { t: p.t0 }).t));
    const sinceIce = switchAt - iceStart;
    // fires after the configured limit, not before, and not much later
    expect(sinceIce).toBeGreaterThanOrEqual(timeoutMs - 1000);
    expect(sinceIce).toBeLessThan(timeoutMs + 5000);
    // the switch is visible: badge + a short system line in the chat
    await expect(c.caller.page.locator('.chat-msg.system', { hasText: /direct channel/i }).first()).toBeVisible();
    const m = await expectMediaAndChat(c, `fallback${timeoutMs}`);
    metrics[`fallback${timeoutMs}`] = { switchAfterIceStartMs: sinceIce, switchAfterPageLoadMs: switchAt - c.t0, ...m };
    await c.caller.ctx.close(); await c.callee.ctx.close();
  });
}

test('ICE blocked, long limit: ICE "failed" itself triggers the switch, without an ICE restart first', async ({ browser }) => {
  test.setTimeout(120000);
  h.config.fallback = { enabled: true, timeoutMs: 60000 };
  const c = await call(browser, { blockIce: true });
  await expect(c.caller.page.locator('#transport-badge')).toContainText('direct-channel', { timeout: 50000 });
  const ce = await e2eOf(c.caller), cl = await e2eOf(c.callee);
  // Chrome reports the failure on connectionState ('failed') while iceConnectionState reads 'disconnected'
  const failedAt = Math.min(...[ce, cl].map((p) => ([...p.ice, ...p.conn].find((x) => x.s === 'failed') || { t: Infinity }).t));
  const switchAt = Math.min(...[ce, cl].map((p) => p.badge.find((b) => b.text.includes('direct-channel')).t));
  expect(Number.isFinite(failedAt)).toBe(true);
  // right after 'failed' -- well before the 60 s limit, and no 20 s restart grace in between
  expect(switchAt - failedAt).toBeLessThan(2000);
  const m = await expectMediaAndChat(c, 'failed');
  const iceStart = Math.min(...[ce, cl].map((p) => (p.ice[0] || { t: p.t0 }).t));
  metrics.fallbackOnIceFailed = { iceFailedAfterIceStartMs: failedAt - iceStart, switchAfterIceStartMs: switchAt - iceStart, ...m };
  await c.caller.ctx.close(); await c.callee.ctx.close();
});

test('ICE blocked, no account: no automatic switch', async ({ browser }) => {
  test.setTimeout(60000);
  h.config.fallback = { enabled: false, timeoutMs: 4000 };
  const c = await call(browser, { blockIce: true });
  await c.caller.page.waitForTimeout(4000 + 6000);
  await expect(c.caller.page.locator('#transport-badge')).toHaveText('webrtc');
  await expect(c.callee.page.locator('#transport-badge')).toHaveText('webrtc');
  await c.caller.ctx.close(); await c.callee.ctx.close();
});
