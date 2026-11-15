// CADS-webconference-demo#175: the real-process bridge tests covered only
// /api/media-fallback. Identity checks, admin fail-closed/fail-open routes,
// sync push/pull with chunk reassembly, and the call lifecycle's participant
// binding had no automated coverage at all, despite several of them having
// been hand-fixed (and only manually re-verified) across past issues.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withBridge, ROOT } from './helpers/with-bridge.mjs';

const STUB_GRANT_BIN = path.join(ROOT, 'test', 'helpers', 'stub-grant-bin.js');
const HEX64 = () => 'a'.repeat(64);
const HEX64_B = () => 'b'.repeat(64);

async function postJson(base, pathname, body, headers) {
  const resp = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

test('identity checks: a gate-verified caller cannot claim a different email', async () => {
  await withBridge({}, async (base) => {
    const mismatched = await postJson(base, '/api/register', { email: 'victim@x.com', holderPub: HEX64(), noisePub: HEX64() }, { 'X-Gate-Email': 'attacker@x.com' });
    assert.equal(mismatched.status, 403);
    assert.equal(mismatched.body.code, 'identity_mismatch');

    const matched = await postJson(base, '/api/register', { email: 'me@x.com', holderPub: HEX64(), noisePub: HEX64() }, { 'X-Gate-Email': 'Me@X.com' });
    assert.equal(matched.status, 200);

    const ungated = await postJson(base, '/api/register', { email: 'anyone@x.com', holderPub: HEX64(), noisePub: HEX64() });
    assert.equal(ungated.status, 200); // no gate header at all -- fails open, same as identityAllowed's documented default
  });
});

test('admin routes: grant fails closed when unconfigured, revoke stays permissive', async () => {
  await withBridge({ WEBCONFERENCE_TUNNEL_ID: 't1' }, async (base) => {
    const add = await postJson(base, '/api/allowlist/add', { email: 'x@y.com' });
    assert.equal(add.status, 503); // WEBCONFERENCE_ADMIN_EMAILS unset -- grant-capability route fails closed, never even reaches the control plane

    // Revoke stays permissive-when-unconfigured (demo-ergonomics default) --
    // it gets PAST the admin gate instead of 403ing, and only then fails
    // with 502 because this test has no real CT_PORTAL_SESSION_COOKIE/control
    // plane configured. A regression here (the exact bug this fix caught --
    // requireAdmin's permissive path returning a falsy '' instead of a
    // truthy sentinel) would hang the request instead of ever responding.
    const remove = await postJson(base, '/api/allowlist/remove', { email: 'x@y.com' });
    assert.equal(remove.status, 502);
  });
});

test('admin routes: configured admin can act, non-admin cannot', async () => {
  await withBridge({ WEBCONFERENCE_TUNNEL_ID: 't1', WEBCONFERENCE_ADMIN_EMAILS: 'admin@x.com' }, async (base) => {
    const asNonAdmin = await fetch(`${base}/api/access-requests`, { headers: { 'X-Gate-Email': 'nobody@x.com' } });
    assert.equal(asNonAdmin.status, 403);
    const asAdmin = await fetch(`${base}/api/access-requests`, { headers: { 'X-Gate-Email': 'Admin@X.com' } });
    assert.equal(asAdmin.status, 200);
    const addAsNonAdmin = await postJson(base, '/api/allowlist/add', { email: 'x@y.com' }, { 'X-Gate-Email': 'nobody@x.com' });
    assert.equal(addAsNonAdmin.status, 403);
  });
});

test('sync push/pull round-trips a row, and reassembles a chunked row', async () => {
  await withBridge({}, async (base) => {
    const push1 = await postJson(base, '/api/sync/push', {
      email: 'me@x.com',
      messages: [{ conversation: 'me@x.com->you@x.com', seq: 1, from: 'me', ts: 1, kind: 'text', iv: [1, 2, 3], ciphertext: [4, 5, 6] }],
    });
    assert.equal(push1.status, 200);
    assert.equal(push1.body.revision, 1);

    // Two chunks of one oversized row -- same shape sync.js's own
    // pushChunkedRow sends, one /sync/push call per chunk.
    await postJson(base, '/api/sync/push', {
      email: 'me@x.com',
      messages: [{ conversation: 'me@x.com->you@x.com', seq: 2, from: 'me', ts: 2, kind: 'text', iv: [1], chunkIndex: 0, chunkCount: 2, ciphertextChunk: [10, 11] }],
    });
    const push2 = await postJson(base, '/api/sync/push', {
      email: 'me@x.com',
      messages: [{ conversation: 'me@x.com->you@x.com', seq: 2, from: 'me', ts: 2, kind: 'text', iv: [1], chunkIndex: 1, chunkCount: 2, ciphertextChunk: [12, 13] }],
    });
    assert.equal(push2.status, 200);
    assert.equal(push2.body.revision, 2);

    const pull = await (await fetch(`${base}/api/sync/pull?email=me@x.com&since=0`)).json();
    assert.equal(pull.messages.length, 2);
    const reassembled = pull.messages.find((m) => m.seq === 2);
    assert.deepEqual(reassembled.ciphertext, [10, 11, 12, 13]);
  });
});

test('play: a malformed status token is rejected before it ever reaches the rate limiter', async () => {
  await withBridge({ PLAY_OIDC_CLIENT_ID: 'c', PLAY_OIDC_CLIENT_SECRET: 's', PLAY_OPERATOR_KEY: HEX64() }, async (base) => {
    const resp = await fetch(`${base}/api/play/status?token=${encodeURIComponent('not a real token!')}`);
    assert.equal(resp.status, 404);
    assert.equal((await resp.json()).code, 'gone');
  });
});

test('play: open/join lifecycle mints symmetric grants via the stub binary', async () => {
  await withBridge({ PLAY_OIDC_CLIENT_ID: 'c', PLAY_OIDC_CLIENT_SECRET: 's', PLAY_OPERATOR_KEY: HEX64(), CT_VIDEO_CALL_GRANT_BIN: STUB_GRANT_BIN }, async (base) => {
    const opened = await postJson(base, '/api/play/open', { holderPub: HEX64(), noisePub: HEX64() });
    assert.equal(opened.status, 200);
    const joined = await postJson(base, '/api/play/join', { token: opened.body.token, holderPub: HEX64_B(), noisePub: HEX64_B() });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.role, 'callee');
    const status = await (await fetch(`${base}/api/play/status?token=${opened.body.token}`)).json();
    assert.equal(status.state, 'joined');
    assert.equal(status.channel, joined.body.channel);
  });
});
