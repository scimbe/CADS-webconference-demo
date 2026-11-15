// CADS-webconference-demo#175: moved out of bridge-media-fallback.test.mjs
// (its original, only caller) so other test files that also need a real,
// throwaway bridge process can share it instead of each re-implementing
// their own spawn/wait-for-"listening"/kill loop.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function withBridge(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-bridge-'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.js')], {
    env: {
      ...process.env,
      // throwaway values for a local process -- no real operator key, no real plane
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
