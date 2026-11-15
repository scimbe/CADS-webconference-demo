// node --test test/*.test.mjs -- CADS-webconference-demo#171: /api/register and
// /api/attest now validate key material the same way the play routes already
// did. Self-contained (own inline withBridge and stub grant binary, not
// test/helpers/* from #175) so this proves the fix on its own regardless of
// merge order.
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

// Mimics only the `key=value` output shape bridge/server.js's mintGrants()
// parses -- not real cryptography, never use this for anything but a local
// test process. The real ct-video-call-grant binary is a separately
// compiled Rust crate this repo doesn't build in CI.
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

test('/api/register rejects malformed key material', async () => {
  await withBridge({}, async (base) => {
    const badHolder = await postJson(base, '/api/register', { email: 'me@x.com', holderPub: 'not-hex', noisePub: HEX64 });
    assert.equal(badHolder.status, 400);
    const badNoise = await postJson(base, '/api/register', { email: 'me@x.com', holderPub: HEX64, noisePub: 'short' });
    assert.equal(badNoise.status, 400);
    const ok = await postJson(base, '/api/register', { email: 'me@x.com', holderPub: HEX64, noisePub: HEX64 });
    assert.equal(ok.status, 200);
  });
});

test('/api/attest rejects malformed key material on a real pending call', async () => {
  await withBridge({}, async (base) => {
    await postJson(base, '/api/register', { email: 'caller@x.com', holderPub: HEX64, noisePub: HEX64 });
    await postJson(base, '/api/register', { email: 'callee@x.com', holderPub: HEX64_B, noisePub: HEX64_B });
    const call = await postJson(base, '/api/call', { fromEmail: 'caller@x.com', toEmail: 'callee@x.com' });
    assert.equal(call.status, 200);
    const channel = call.body.channel;

    const badHolder = await postJson(base, '/api/attest', { channel, role: 'caller', holderPub: 'zz', noisePub: HEX64, attestation: 'a'.repeat(128) });
    assert.equal(badHolder.status, 400);
    const shortAttestation = await postJson(base, '/api/attest', { channel, role: 'caller', holderPub: HEX64, noisePub: HEX64, attestation: 'too-short' });
    assert.equal(shortAttestation.status, 400);

    const ok = await postJson(base, '/api/attest', { channel, role: 'caller', holderPub: HEX64, noisePub: HEX64, attestation: 'a'.repeat(128) });
    assert.equal(ok.status, 200);
  });
});
