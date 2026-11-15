// node --test test/*.test.mjs -- CADS-webconference-demo#172: /api/attest,
// /api/cancel, /api/decline, and /api/call-status are now bound to the
// verified participant. Self-contained (own inline withBridge and stub grant
// binary, not test/helpers/* from #175) so this proves the fix on its own
// regardless of merge order.
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

async function postJson(base, pathname, body, headers) {
  const resp = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

test('call-control routes are bound to the verified caller/callee', async () => {
  await withBridge({}, async (base) => {
    await postJson(base, '/api/register', { email: 'caller@x.com', holderPub: HEX64, noisePub: HEX64 });
    await postJson(base, '/api/register', { email: 'callee@x.com', holderPub: HEX64_B, noisePub: HEX64_B });
    const call = await postJson(base, '/api/call', { fromEmail: 'caller@x.com', toEmail: 'callee@x.com' });
    assert.equal(call.status, 200);
    assert.equal(call.body.status, 'ringing');
    const channel = call.body.channel;

    // Only the caller may cancel; a stranger or the callee may not.
    const calleeTriesCancel = await postJson(base, '/api/cancel', { channel }, { 'X-Gate-Email': 'callee@x.com' });
    assert.equal(calleeTriesCancel.status, 403);
    const strangerTriesCancel = await postJson(base, '/api/cancel', { channel }, { 'X-Gate-Email': 'eve@x.com' });
    assert.equal(strangerTriesCancel.status, 403);

    // Status: a stranger can't read it; either real participant can.
    const strangerStatus = await (await fetch(`${base}/api/call-status?channel=${channel}`, { headers: { 'X-Gate-Email': 'eve@x.com' } })).json();
    assert.equal(strangerStatus.error, 'not a participant on this call');
    const callerStatus = await (await fetch(`${base}/api/call-status?channel=${channel}`, { headers: { 'X-Gate-Email': 'Caller@X.com' } })).json();
    assert.equal(callerStatus.status.state, 'ringing');

    // Attesting under the WRONG role for your own verified identity is refused.
    const wrongRoleAttest = await postJson(base, '/api/attest', { channel, role: 'callee', holderPub: HEX64, noisePub: HEX64, attestation: 'a'.repeat(128) }, { 'X-Gate-Email': 'caller@x.com' });
    assert.equal(wrongRoleAttest.status, 403);
    // The right role for your own identity is accepted.
    const rightRoleAttest = await postJson(base, '/api/attest', { channel, role: 'caller', holderPub: HEX64, noisePub: HEX64, attestation: 'a'.repeat(128) }, { 'X-Gate-Email': 'caller@x.com' });
    assert.equal(rightRoleAttest.status, 200);

    // Only the callee may decline; the caller may not.
    const callerTriesDecline = await postJson(base, '/api/decline', { channel }, { 'X-Gate-Email': 'caller@x.com' });
    assert.equal(callerTriesDecline.status, 403);
    const calleeDeclines = await postJson(base, '/api/decline', { channel }, { 'X-Gate-Email': 'callee@x.com' });
    assert.equal(calleeDeclines.status, 200);
  });
});

test('an ungated deployment (no X-Gate-Email at all) is unaffected', async () => {
  await withBridge({}, async (base) => {
    await postJson(base, '/api/register', { email: 'caller@x.com', holderPub: HEX64, noisePub: HEX64 });
    await postJson(base, '/api/register', { email: 'callee@x.com', holderPub: HEX64_B, noisePub: HEX64_B });
    const call = await postJson(base, '/api/call', { fromEmail: 'caller@x.com', toEmail: 'callee@x.com' });
    const channel = call.body.channel;
    const cancel = await postJson(base, '/api/cancel', { channel }); // no gate header -- fails open
    assert.equal(cancel.status, 200);
  });
});
