// node --test test/*.test.mjs -- CADS-webconference-demo#158: a chat-delivery
// call can no longer clobber a live real call sharing the same (deterministic
// per holder-pubkey pair) channel. Self-contained (own inline withBridge and
// stub grant binary, not test/helpers/* from #175) so this proves the fix on
// its own regardless of merge order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);

// Deliberately deterministic per (holderA, holderB) PAIR regardless of
// argument order -- mirrors the real ct-video-call-grant's documented
// channel_id_for_link behavior, which is the whole reason #158 exists: a
// real call and a chat-delivery session between the same two people land on
// the same channel.
const STUB_GRANT_SRC = `#!/usr/bin/env node
const crypto = require('crypto');
const [a, b] = process.argv.slice(2);
const key = [a, b].sort().join(':');
const h = (l) => crypto.createHash('sha256').update(l + ':' + key).digest('hex');
console.log('channel_id_hex=' + h('c'));
console.log('grant_a_hex=' + h('a'));
console.log('grant_b_hex=' + h('b'));
console.log('operator_public_hex=' + h('o'));
`;

async function withBridge(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bridge-'));
  const stubBin = path.join(dir, 'stub-grant-bin.js');
  fs.writeFileSync(stubBin, STUB_GRANT_SRC, { mode: 0o755 });
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: {
      ...process.env,
      CT_CHANNEL_OPERATOR_KEY: crypto.randomBytes(32).toString('hex'),
      CT_AGENT_HOSTNAME: 'localhost',
      CT_AGENT_CP_URL: 'http://127.0.0.1:1',
      WEBCONFERENCE_BRIDGE_LISTEN: `127.0.0.1:${port}`,
      WEBCONFERENCE_ACCESS_REQUESTS_FILE: path.join(dir, 'access-requests.json'),
      CT_VIDEO_CALL_GRANT_BIN: stubBin,
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
  }
}

async function postJson(base, pathname, body) {
  const resp = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

test('a chat-delivery call refuses to clobber a live real call on the same channel', async () => {
  await withBridge({}, async (base) => {
    await postJson(base, '/api/register', { email: 'caller@x.com', holderPub: HEX64, noisePub: HEX64 });
    await postJson(base, '/api/register', { email: 'callee@x.com', holderPub: HEX64_B, noisePub: HEX64_B });

    const realCall = await postJson(base, '/api/call', { fromEmail: 'caller@x.com', toEmail: 'callee@x.com' });
    assert.equal(realCall.body.status, 'ringing');
    const channel = realCall.body.channel;

    // Same two holders -> the stub (like the real binary) derives the SAME
    // channel id. Before this fix, this second /api/call would silently
    // overwrite the still-ringing real call's pendingCalls entry.
    const chatDelivery = await postJson(base, '/api/call', { fromEmail: 'caller@x.com', toEmail: 'callee@x.com', kind: 'chat-delivery' });
    assert.equal(chatDelivery.body.status, 'busy');
    assert.equal(chatDelivery.body.channel, undefined); // no channel/grant handed out for a refused request

    const status = await (await fetch(`${base}/api/call-status?channel=${channel}`)).json();
    assert.equal(status.status.state, 'ringing'); // the real call's entry is untouched
  });
});

test('a chat-delivery call is still allowed when nothing else occupies the channel', async () => {
  await withBridge({}, async (base) => {
    await postJson(base, '/api/register', { email: 'caller@x.com', holderPub: HEX64, noisePub: HEX64 });
    await postJson(base, '/api/register', { email: 'callee@x.com', holderPub: HEX64_B, noisePub: HEX64_B });
    const chatDelivery = await postJson(base, '/api/call', { fromEmail: 'caller@x.com', toEmail: 'callee@x.com', kind: 'chat-delivery' });
    assert.equal(chatDelivery.status, 200);
    assert.equal(chatDelivery.body.status, 'ringing');
  });
});
