// node --test test/*.test.mjs -- CADS-webconference-demo#160: the sync store's
// chunk-upload validation and persistence. Self-contained (own inline
// withBridge, not test/helpers/with-bridge.mjs from #175) so this proves the
// fix on its own regardless of merge order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withBridge(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bridge-'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: {
      ...process.env,
      CT_CHANNEL_OPERATOR_KEY: crypto.randomBytes(32).toString('hex'),
      CT_AGENT_HOSTNAME: 'localhost',
      CT_AGENT_CP_URL: 'http://127.0.0.1:1',
      WEBCONFERENCE_BRIDGE_LISTEN: `127.0.0.1:${port}`,
      WEBCONFERENCE_ACCESS_REQUESTS_FILE: path.join(dir, 'access-requests.json'),
      WEBCONFERENCE_SYNC_STORE_FILE: path.join(dir, 'sync-store.json'),
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
    await fn(`http://127.0.0.1:${port}`, dir);
  } finally {
    child.kill();
  }
}

async function postJson(base, pathname, body) {
  const resp = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

test('sync push/pull round-trips a row, and reassembles a chunked row', async () => {
  await withBridge({}, async (base) => {
    await postJson(base, '/api/sync/push', {
      email: 'me@x.com',
      messages: [{ conversation: 'me@x.com->you@x.com', seq: 1, from: 'me', ts: 1, kind: 'text', iv: [1, 2, 3], ciphertext: [4, 5, 6] }],
    });
    await postJson(base, '/api/sync/push', {
      email: 'me@x.com',
      messages: [{ conversation: 'me@x.com->you@x.com', seq: 2, from: 'me', ts: 2, kind: 'text', iv: [1], chunkIndex: 0, chunkCount: 2, ciphertextChunk: [10, 11] }],
    });
    await postJson(base, '/api/sync/push', {
      email: 'me@x.com',
      messages: [{ conversation: 'me@x.com->you@x.com', seq: 2, from: 'me', ts: 2, kind: 'text', iv: [1], chunkIndex: 1, chunkCount: 2, ciphertextChunk: [12, 13] }],
    });
    const pull = await (await fetch(`${base}/api/sync/pull?email=me@x.com&since=0`)).json();
    assert.equal(pull.messages.length, 2);
    const reassembled = pull.messages.find((m) => m.seq === 2);
    assert.deepEqual(reassembled.ciphertext, [10, 11, 12, 13]);
  });
});

test('an out-of-bounds or non-integer chunkCount/chunkIndex is dropped, not crashed on', async () => {
  await withBridge({}, async (base) => {
    // Infinity used to pass the old `typeof row.chunkCount === 'number' &&
    // row.chunkCount > 0` check outright and reach `new Array(Infinity)`, a
    // RangeError thrown inside the request handler.
    const r1 = await postJson(base, '/api/sync/push', {
      email: 'me@x.com',
      messages: [{ conversation: 'me@x.com->you@x.com', seq: 1, from: 'me', ts: 1, kind: 'text', iv: [1], chunkIndex: 0, chunkCount: Infinity, ciphertextChunk: [1] }],
    });
    assert.equal(r1.status, 200); // the push itself still succeeds -- the one bad row is just dropped

    const r2 = await postJson(base, '/api/sync/push', {
      email: 'me@x.com',
      messages: [{ conversation: 'me@x.com->you@x.com', seq: 2, from: 'me', ts: 2, kind: 'text', iv: [1], chunkIndex: -1, chunkCount: 5, ciphertextChunk: [1] }],
    });
    assert.equal(r2.status, 200);

    const r3 = await postJson(base, '/api/sync/push', {
      email: 'me@x.com',
      messages: [{ conversation: 'me@x.com->you@x.com', seq: 3, from: 'me', ts: 3, kind: 'text', iv: [1], chunkIndex: 0, chunkCount: 50_000, ciphertextChunk: [1] }],
    });
    assert.equal(r3.status, 200);

    const pull = await (await fetch(`${base}/api/sync/pull?email=me@x.com&since=0`)).json();
    assert.equal(pull.messages.length, 0); // none of the three malformed rows ever landed
  });
});

test('the sync store is still persisted to disk (debounced, flushed on SIGTERM)', async () => {
  await withBridge({}, async (base, dir) => {
    await postJson(base, '/api/sync/push', {
      email: 'me@x.com',
      messages: [{ conversation: 'me@x.com->you@x.com', seq: 1, from: 'me', ts: 1, kind: 'text', iv: [1], ciphertext: [1] }],
    });
    await new Promise((r) => setTimeout(r, 3000)); // past SYNC_STORE_PERSIST_DEBOUNCE_MS
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sync-store.json'), 'utf8'));
    assert.equal(saved['me@x.com'].messages.length, 1);
  });
});
