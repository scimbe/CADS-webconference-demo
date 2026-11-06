// E2E harness for the WebRTC -> direct-channel fallback (no real plane needed).
//
// - serves this repo's static client (index.html, *.js, pkg/) over HTTPS
//   (self-signed, generated per run -- app.js always dials wss://<host>/ws/channel),
// - answers the few /api/* calls a call page makes (ice-config, media-fallback,
//   ice-outcome, whoami) from a mutable `config`,
// - stands in for ct-edge's /ws/channel (CADS-Tunnel crates/edge/src/ws_channel.rs):
//   framed join request -> 32-byte challenge -> 64-byte holder signature ->
//   "OK relay-only <peer-noise-hex> r=127.0.0.1 sp=0\n" -> opaque byte relay
//   between the two members of a channel. It never sees plaintext: everything
//   after the ack is Noise_IK ciphertext produced by the real ct-agent-wasm build.
//
// Grants are minted with this repo's own ct-video-call-grant CLI (GRANT_CMD).
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-e2e-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const hexToBuf = (hex) => Buffer.from(hex, 'hex');

let wasmMod = null;
async function wasm() {
  if (!wasmMod) {
    // pkg/*.js is an ES module without a "type": "module" package.json around
    // it -- import a .mjs copy so Node (and Playwright's loader) treat it as ESM.
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-wasm-')), 'ct_agent_wasm.mjs');
    fs.copyFileSync(path.join(ROOT, 'pkg', 'ct_agent_wasm.js'), copy);
    wasmMod = await import(copy);
    wasmMod.initSync({ module: fs.readFileSync(path.join(ROOT, 'pkg', 'ct_agent_wasm_bg.wasm')) });
  }
  return wasmMod;
}

// GRANT_CMD: the ct-video-call-grant binary, or a wrapper command (split on spaces),
// e.g. "docker run --rm -v <dir>:/b rust:1-slim /b/ct-video-call-grant" on macOS.
function mintGrants(holderA, holderB) {
  const cmd = (process.env.GRANT_CMD || path.join(ROOT, 'video-call-grant', 'target', 'release', 'ct-video-call-grant')).split(' ');
  const out = execFileSync(cmd[0], [...cmd.slice(1), holderA, holderB], { encoding: 'utf8' });
  const kv = Object.fromEntries(out.trim().split('\n').map((l) => l.split('=')));
  return { channel: kv.channel_id_hex, grantA: kv.grant_a_hex, grantB: kv.grant_b_hex };
}

export async function startHarness() {
  const config = {
    whoamiEmail: 'tester@example.org',
    fallback: { enabled: true, timeoutMs: 10000 },
    // "blocked" STUN/TURN: TEST-NET-1 (RFC 5737), never routed.
    iceServers: [
      { urls: 'stun:192.0.2.1:3478' },
      { urls: ['turn:192.0.2.1:3478?transport=udp', 'turn:192.0.2.1:3478?transport=tcp'], username: 'x', credential: 'y' },
    ],
  };
  const members = new Map(); // grantHex -> { channel, noisePub }
  const waiting = new Map(); // channel -> Member parked until its peer joins
  const stats = { joins: 0, bytesRelayed: 0 };

  const server = https.createServer(selfSignedCert(), (req, res) => {
    const url = new URL(req.url, 'https://localhost');
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/api/whoami') return json(200, { email: config.whoamiEmail });
    if (url.pathname === '/api/ice-config') return json(200, { iceServers: config.iceServers, ttl: 600 });
    if (url.pathname === '/api/media-fallback') {
      return json(200, { enabled: config.fallback.enabled, timeoutMs: config.fallback.timeoutMs,
        reason: config.fallback.enabled ? 'account' : 'no_account' });
    }
    if (url.pathname === '/api/ice-outcome') { res.writeHead(204); return res.end(); }
    if (url.pathname.startsWith('/api/')) return json(404, { error: 'not mocked' });
    const file = url.pathname === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  class Member {
    constructor(ws) {
      this.ws = ws;
      this.buf = Buffer.alloc(0);
      this.stage = 'join';
      this.peer = null;
      this.pending = [];
      ws.on('message', (d) => this.onData(Buffer.from(d)));
      ws.on('close', () => {
        if (waiting.get(this.channel) === this) waiting.delete(this.channel);
        if (this.peer && this.peer.ws.readyState === 1) this.peer.ws.close();
      });
    }
    onData(d) {
      this.buf = Buffer.concat([this.buf, d]);
      if (this.stage === 'join') {
        if (this.buf.length < 2) return;
        const len = this.buf.readUInt16BE(0);
        if (this.buf.length < 2 + len) return;
        const frame = this.buf.subarray(2, 2 + len);
        this.buf = this.buf.subarray(2 + len);
        const hit = [...members.entries()].find(([g]) => frame.indexOf(hexToBuf(g)) !== -1);
        if (!hit) { this.ws.send(Buffer.from('NO')); this.ws.close(); return; }
        this.channel = hit[1].channel;
        this.noisePub = hit[1].noisePub;
        stats.joins++;
        this.ws.send(crypto.randomBytes(32));
        this.stage = 'sig';
      }
      if (this.stage === 'sig') {
        if (this.buf.length < 64) return;
        this.buf = this.buf.subarray(64);
        this.stage = 'wait';
        const other = waiting.get(this.channel);
        if (other && other !== this && other.ws.readyState === 1) {
          waiting.delete(this.channel);
          this.pair(other);
          other.pair(this);
        } else {
          waiting.set(this.channel, this);
        }
      }
      if (this.stage === 'relay' || this.stage === 'wait') {
        if (this.buf.length) this.forward(this.buf);
        this.buf = Buffer.alloc(0);
      }
    }
    forward(b) {
      stats.bytesRelayed += b.length;
      if (this.peer && this.peer.ws.readyState === 1) this.peer.ws.send(b); else this.pending.push(b);
    }
    pair(other) {
      this.peer = other;
      this.stage = 'relay';
      this.ws.send(Buffer.from(`OK relay-only ${other.noisePub} r=127.0.0.1 sp=0\n`));
      for (const b of this.pending) other.ws.send(b);
      this.pending = [];
    }
  }

  const wss = new WebSocketServer({ server, path: '/ws/channel' });
  wss.on('connection', (ws) => new Member(ws));

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // One call = two fresh browser identities + a freshly minted grant pair.
  async function newCall() {
    const w = await wasm();
    const ids = [0, 1].map(() => {
      const h = w.generate_holder_identity();
      const n = w.generate_noise_identity();
      return { holderPub: h.public_hex, holderPriv: h.private_hex, noisePub: n.public_hex, noisePriv: n.private_hex };
    });
    const g = mintGrants(ids[0].holderPub, ids[1].holderPub);
    members.set(g.grantA, { channel: g.channel, noisePub: ids[0].noisePub });
    members.set(g.grantB, { channel: g.channel, noisePub: ids[1].noisePub });
    const link = (id, grant, role) => `https://localhost:${port}/?ws=1&grant=${grant}&holderPriv=${id.holderPriv}&noisePriv=${id.noisePriv}&role=${role}&transport=webrtc`;
    return { caller: link(ids[0], g.grantA, 'caller'), callee: link(ids[1], g.grantB, 'callee') };
  }

  return { port, config, stats, newCall, close: () => new Promise((r) => { wss.close(); server.close(r); }) };
}
