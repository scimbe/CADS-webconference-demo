// node --test test/*.test.mjs -- the file tool's relay ("Datei rueber", purpose "file") only with a grant from the wrapper.
// Unit tests for bridge/relay-grant.js, then the real bridge process with a fake grant binary and a fake control plane:
// file channels get TURN only with a valid grant (bound to the channel), game channels stay as they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { signRelayGrant, verifyRelayGrant, MAX_TTL_S } = createRequire(import.meta.url)('../bridge/relay-grant.js');
// throwaway test values, generated per run: never a real secret
const SECRET = crypto.randomBytes(32).toString('hex');
const CH = 'ab'.repeat(32);

test('grant: sign/verify round trip, bound to channel and purpose', () => {
  const now = Date.now();
  const g = signRelayGrant({ sub: 'acct1', ch: CH, now }, SECRET);
  assert.deepEqual(verifyRelayGrant(g, SECRET, { channel: CH, now }), { ok: true, sub: 'acct1' });
  assert.deepEqual(verifyRelayGrant(g, SECRET, { channel: CH.toUpperCase(), now }), { ok: true, sub: 'acct1' });
  assert.equal(verifyRelayGrant(g, SECRET, { channel: 'cd'.repeat(32), now }).why, 'channel');
  assert.equal(verifyRelayGrant(g, SECRET, { channel: CH, now, purpose: 'game' }).why, 'purpose');
  assert.equal(verifyRelayGrant(signRelayGrant({ sub: 'a', ch: CH, purpose: 'game', now }, SECRET), SECRET, { channel: CH, now }).why, 'purpose');
});

test('grant: fails closed on expiry, long life, tampering, wrong or short secret', () => {
  const now = Date.now();
  const g = signRelayGrant({ sub: 'a', ch: CH, now, ttlS: 60 }, SECRET);
  assert.equal(verifyRelayGrant(g, SECRET, { channel: CH, now: now + 61_000 }).why, 'time');
  assert.equal(verifyRelayGrant(signRelayGrant({ sub: 'a', ch: CH, now, ttlS: MAX_TTL_S + 1 }, SECRET), SECRET, { channel: CH, now }).why, 'time');
  assert.equal(verifyRelayGrant(signRelayGrant({ sub: 'a', ch: CH, now: now + 120_000 }, SECRET), SECRET, { channel: CH, now }).why, 'time');
  const [p, body, sig] = g.split('.');
  const forged = JSON.parse(Buffer.from(body, 'base64url')); forged.ch = 'cd'.repeat(32);
  assert.equal(verifyRelayGrant(`${p}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`, SECRET, { channel: 'cd'.repeat(32), now }).why, 'sig');
  assert.equal(verifyRelayGrant(g.slice(0, -2) + (g.endsWith('AA') ? 'BB' : 'AA'), SECRET, { channel: CH, now }).why, 'sig');
  assert.equal(verifyRelayGrant(g, crypto.randomBytes(32).toString('hex'), { channel: CH, now }).why, 'sig');
  assert.equal(verifyRelayGrant(g, 'short', { channel: CH, now }).why, 'off');
  assert.equal(verifyRelayGrant(g, undefined, { channel: CH, now }).why, 'off');
  for (const bad of [undefined, '', 'x', 'rg1.a', 'rg1.a.b.c', 'rg1.%%.x', 'rg2.' + g.slice(4), 'rg1.' + 'A'.repeat(2000) + '.x']) {
    assert.equal(verifyRelayGrant(bad, SECRET, { channel: CH, now }).ok, false, String(bad).slice(0, 20));
  }
});

test('grant: fixed vector shared with CADS-DEMO-wrapper lib/relay-grant.mjs', () => {
  const secret = 'test-only-vector-secret-0123456789abcdef';
  const g = signRelayGrant({ sub: 'a0123456789abcdef', ch: CH, now: 1_800_000_000_000, ttlS: 900 }, secret);
  assert.equal(g, VECTOR);
  assert.deepEqual(verifyRelayGrant(VECTOR, secret, { channel: CH, now: 1_800_000_100_000 }), { ok: true, sub: 'a0123456789abcdef' });
});
const VECTOR = 'rg1.eyJzdWIiOiJhMDEyMzQ1Njc4OWFiY2RlZiIsInB1cnBvc2UiOiJmaWxlIiwiY2giOiJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDA5MDB9.AQ5R0JlIOF1xOWshwutwkQ4KvzutAnmnOZP0sHB8qVw';

// ---------- the real bridge process ----------

async function fakePlane() {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'fake', expires_in: 300 }));
      res.end('{}');   // POST /me/channels, .../members, DELETE: all 200
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return srv;
}

async function withBridge(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-relay-'));
  const bin = path.join(dir, 'fake-grant');
  // stands in for ct-video-call-grant: a fresh channel id and dummy grants
  fs.writeFileSync(bin, `#!${process.execPath}\nconst r = () => require('crypto').randomBytes(32).toString('hex');\nconsole.log('channel_id_hex=' + r() + '\\ngrant_a_hex=' + r() + '\\ngrant_b_hex=' + r() + '\\noperator_public_hex=' + r());\n`, { mode: 0o700 });
  const plane = await fakePlane();
  const cp = `http://127.0.0.1:${plane.address().port}`;
  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: {
      ...process.env,
      CT_CHANNEL_OPERATOR_KEY: crypto.randomBytes(32).toString('hex'),
      CT_AGENT_HOSTNAME: 'localhost',
      CT_AGENT_CP_URL: cp,
      CT_OIDC_TOKEN_URL: cp + '/token',
      CT_VIDEO_CALL_GRANT_BIN: bin,
      WEBCONFERENCE_BRIDGE_LISTEN: `127.0.0.1:${port}`,
      WEBCONFERENCE_ACCESS_REQUESTS_FILE: path.join(dir, 'access-requests.json'),
      PLAY_OIDC_CLIENT_ID: 'play-test',
      PLAY_OIDC_CLIENT_SECRET: crypto.randomBytes(16).toString('hex'),
      PLAY_OPERATOR_KEY: crypto.randomBytes(32).toString('hex'),
      TURN_SHARED_SECRET: crypto.randomBytes(16).toString('hex'),
      DUELL_RELAY_GRANT_SECRET: SECRET,
      PLAY_FILE_RELAY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bridge did not start')), 10000);
      child.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
      child.on('exit', (c) => reject(new Error(`bridge exited ${c}`)));
    });
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    plane.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const hex = () => crypto.randomBytes(32).toString('hex');
async function post(base, p, body) {
  const r = await fetch(base + '/api/play' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
/** open + join + both attest: a registered channel of the given purpose (undefined: what an older client sends). */
async function pair(base, purpose, joinPurpose = purpose) {
  const a = { holderPub: hex(), noisePub: hex() }, b = { holderPub: hex(), noisePub: hex() };
  const o = await post(base, '/open', { ...a, ...(purpose ? { purpose } : {}) });
  assert.equal(o.status, 200);
  const j = await post(base, '/join', { token: o.json.token, ...b, ...(joinPurpose ? { purpose: joinPurpose } : {}) });
  if (j.status !== 200) return { join: j };
  const channel = j.json.channel, token = o.json.token;
  for (const [role, k] of [['caller', a], ['callee', b]]) {
    const at = await post(base, '/attest', { channel, role, token, ...k, attestation: crypto.randomBytes(64).toString('hex') });
    assert.equal(at.status, 200);
  }
  return { channel, token };
}
async function ice(base, { channel, token }, role, grant) {
  const r = await fetch(`${base}/api/play/ice?channel=${channel}&role=${role}&token=${encodeURIComponent(token)}`, { headers: grant ? { 'x-relay-grant': grant } : {} });
  return { status: r.status, json: await r.json() };
}
const turn = (j) => j.iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));

test('bridge: a file channel without a grant gets STUN only, on both sides', async () => {
  await withBridge({}, async (base) => {
    const g = await pair(base, 'file');
    for (const role of ['caller', 'callee']) {
      const r = await ice(base, g, role);
      assert.equal(r.status, 200);
      assert.equal(turn(r.json), false, role);
      assert.equal(r.json.relay, false);
      assert.deepEqual(r.json.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
    }
  });
});

test('bridge: mixed pair -- the paying side gets TURN with its grant, the free side STUN only', async () => {
  await withBridge({}, async (base) => {
    const g = await pair(base, 'file');
    const paid = await ice(base, g, 'caller', signRelayGrant({ sub: 'apaid', ch: g.channel }, SECRET));
    assert.equal(turn(paid.json), true);
    assert.equal(paid.json.relay, true);
    const t = paid.json.iceServers.find((s) => s.username);
    assert.match(t.username, /^\d+:file-[0-9a-f]{16}$/);
    assert.ok(t.credential);
    const free = await ice(base, g, 'callee');
    assert.equal(turn(free.json), false);
  });
});

test('bridge: a grant for another channel, expired, of another purpose or forged gives no relay', async () => {
  await withBridge({}, async (base) => {
    const bad = [
      (ch) => signRelayGrant({ sub: 'a', ch: 'cd'.repeat(32) }, SECRET),
      (ch) => signRelayGrant({ sub: 'a', ch, now: Date.now() - 20 * 60_000 }, SECRET),
      (ch) => signRelayGrant({ sub: 'a', ch, purpose: 'game' }, SECRET),
      (ch) => signRelayGrant({ sub: 'a', ch }, crypto.randomBytes(32).toString('hex')),
    ];
    for (const make of bad) {
      const g = await pair(base, 'file');
      const r = await ice(base, g, 'caller', make(g.channel));
      assert.equal(r.status, 200);
      assert.equal(turn(r.json), false);
    }
  });
});

test('bridge: game channels are unchanged -- TURN without any grant, no relay field', async () => {
  await withBridge({}, async (base) => {
    for (const purpose of [undefined, 'game']) {
      const g = await pair(base, purpose);
      const r = await ice(base, g, 'caller');
      assert.equal(turn(r.json), true);
      assert.equal('relay' in r.json, false);
      assert.match(r.json.iceServers[1].username, /^\d+:play-[0-9a-f]{16}$/);
      assert.equal((await ice(base, g, 'caller')).status, 429);   // still once per seat
    }
  });
});

test('bridge: without the shared secret a file channel never gets the relay', async () => {
  await withBridge({ DUELL_RELAY_GRANT_SECRET: '' }, async (base) => {
    const g = await pair(base, 'file');
    assert.equal(turn((await ice(base, g, 'caller', signRelayGrant({ sub: 'a', ch: g.channel }, SECRET))).json), false);
    const game = await pair(base, 'game');
    assert.equal(turn((await ice(base, game, 'caller')).json), true);
  });
});

test('bridge: PLAY_FILE_RELAY=open gives file channels the relay without a grant, off never', async () => {
  await withBridge({ PLAY_FILE_RELAY: 'open' }, async (base) => {
    assert.equal(turn((await ice(base, await pair(base, 'file'), 'callee')).json), true);
  });
  await withBridge({ PLAY_FILE_RELAY: 'off' }, async (base) => {
    const g = await pair(base, 'file');
    assert.equal(turn((await ice(base, g, 'caller', signRelayGrant({ sub: 'a', ch: g.channel }, SECRET))).json), false);
  });
});

test('bridge: per grant subject the relay is limited per hour', async () => {
  await withBridge({ PLAY_FILE_TURN_PER_HOUR: '1' }, async (base) => {
    const g1 = await pair(base, 'file'), g2 = await pair(base, 'file');
    assert.equal(turn((await ice(base, g1, 'caller', signRelayGrant({ sub: 'same', ch: g1.channel }, SECRET))).json), true);
    assert.equal(turn((await ice(base, g2, 'caller', signRelayGrant({ sub: 'same', ch: g2.channel }, SECRET))).json), false);
    assert.equal(turn((await ice(base, g2, 'callee', signRelayGrant({ sub: 'other', ch: g2.channel }, SECRET))).json), true);
  });
});

test('bridge: purpose is checked on open and join; CORS lets the grant header through', async () => {
  await withBridge({ PLAY_ALLOWED_ORIGINS: 'https://app.example' }, async (base) => {
    assert.equal((await post(base, '/open', { holderPub: hex(), noisePub: hex(), purpose: 'video' })).status, 400);
    const r = await pair(base, 'file', 'game');
    assert.equal(r.join.status, 409);
    assert.equal(r.join.json.code, 'purpose');
    const pre = await fetch(base + '/api/play/ice', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-headers': 'x-relay-grant' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /x-relay-grant/);
  });
});
