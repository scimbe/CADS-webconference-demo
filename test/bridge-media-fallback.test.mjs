// node --test test/*.test.mjs  -- GET /api/media-fallback on the real bridge process:
// the automatic direct-channel switch is on only for a gate-verified account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { withBridge, ROOT } from './helpers/with-bridge.mjs';

test('media-fallback: off without a gate identity, on with one; limit from env', async () => {
  await withBridge({ WEBCONFERENCE_ICE_FALLBACK_TIMEOUT_MS: '12000' }, async (base) => {
    const anon = await (await fetch(`${base}/api/media-fallback`)).json();
    assert.deepEqual(anon, { enabled: false, timeoutMs: 12000, reason: 'no_account' });
    const signedIn = await (await fetch(`${base}/api/media-fallback`, { headers: { 'X-Gate-Email': 'Tester@Example.org' } })).json();
    assert.deepEqual(signedIn, { enabled: true, timeoutMs: 12000, reason: 'account' });
  });
});

test('media-fallback: default limit is 10 s', async () => {
  await withBridge({ WEBCONFERENCE_ICE_FALLBACK_TIMEOUT_MS: '' }, async (base) => {
    const r = await (await fetch(`${base}/api/media-fallback`, { headers: { 'X-Gate-Email': 'a@b.c' } })).json();
    assert.equal(r.timeoutMs, 10000);
  });
});

test('decision: a later plan value may only shorten the limit, never enable or lengthen', () => {
  const { mediaFallbackDecision: d } = createRequire(import.meta.url)('../bridge/media-fallback.js');
  assert.deepEqual(d({ verifiedEmail: null, defaultTimeoutMs: 10000, planTimeoutMs: 5000 }), { enabled: false, timeoutMs: 10000, reason: 'no_account' });
  assert.deepEqual(d({ verifiedEmail: 'a@b.c', defaultTimeoutMs: 10000 }), { enabled: true, timeoutMs: 10000, reason: 'account' });
  assert.deepEqual(d({ verifiedEmail: 'a@b.c', defaultTimeoutMs: 10000, planTimeoutMs: 6000 }), { enabled: true, timeoutMs: 6000, reason: 'plan' });
  assert.equal(d({ verifiedEmail: 'a@b.c', defaultTimeoutMs: 10000, planTimeoutMs: 20000 }).timeoutMs, 10000);
  assert.equal(d({ verifiedEmail: 'a@b.c', defaultTimeoutMs: 10000, planTimeoutMs: 500 }).timeoutMs, 3000);
  assert.equal(d({ verifiedEmail: 'a@b.c', defaultTimeoutMs: 10000, planTimeoutMs: 'x' }).reason, 'account');
});

test('bridge image ships media-fallback.js', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'bridge', 'Dockerfile'), 'utf8'), /^COPY media-fallback\.js \.\/$/m);
});
