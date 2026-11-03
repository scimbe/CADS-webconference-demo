// node --test test/  -- the optional My Daily Idea look (theme.js), no browser needed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../theme.js');

function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}
function fakeDoc() {
  const props = {}, attrs = {};
  return { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, style: { setProperty: (k, v) => { props[k] = v; } } }, props, attrs };
}

test('parseLook: only look=daily with strict hex colours', () => {
  assert.deepEqual(T.parseLook('?look=daily&a=2B59FF&b=ffd400'), { look: 'daily', a: '#2b59ff', b: '#ffd400' });
  assert.equal(T.parseLook(''), null);
  assert.equal(T.parseLook('?look=dark'), null);
  assert.deepEqual(T.parseLook('?look=off'), { off: true });
  // anything that is not exactly six hex digits falls back to the app's defaults
  for (const bad of ['red', '#ffd400', 'ffd40', 'ffd4000', 'ffd400;background:url(x)', 'zzzzzz']) {
    assert.deepEqual(T.parseLook('?look=daily&a=' + encodeURIComponent(bad)), { look: 'daily', a: '#ffd400', b: '#ff3b1d' }, bad);
  }
});

test('apply: sets data-look and colours, remembers them for the login round trip', () => {
  const store = memStore(), d1 = fakeDoc();
  assert.ok(T.apply(d1, store, '?look=daily&a=2b59ff&b=ffd400'));
  assert.equal(d1.attrs['data-look'], 'daily');
  assert.equal(d1.props['--d-a'], '#2b59ff');
  assert.equal(d1.props['--d-on'], '#fffaf0', 'light text on a dark blue');
  assert.equal(d1.props['--d-onb'], '#111111', 'dark text on yellow');
  assert.equal(d1.props['--d-btn'], '#fffaf0', 'dark first colour -> paper button text');
  // back from gate/start: return= carries only the path, the look comes from sessionStorage
  const d2 = fakeDoc();
  assert.ok(T.apply(d2, store, ''));
  assert.equal(d2.props['--d-b'], '#ffd400');
  // ?look=off forgets it
  assert.equal(T.apply(fakeDoc(), store, '?look=off'), null);
  assert.equal(T.apply(fakeDoc(), store, ''), null);
});

test('apply: tampered or broken storage never injects CSS and never throws', () => {
  for (const raw of ['{', '"x"', JSON.stringify({ look: 'daily', a: 'red;x:y', b: '#ffd400' }), JSON.stringify({ look: 'evil' })]) {
    const d = fakeDoc(), got = T.apply(d, memStore({ [T.KEY]: raw }), '');
    if (got) assert.match(d.props['--d-a'], /^#[0-9a-f]{6}$/);
  }
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  assert.ok(T.apply(fakeDoc(), throwing, '?look=daily'));
  assert.equal(T.apply(fakeDoc(), throwing, ''), null);
});

test('back link is a constant, not taken from the URL', () => {
  assert.equal(T.BACK, 'https://demos-34a13a96.bunsenbrenner.org/duell');
  assert.equal(T.parseLook('?look=daily&back=https://evil.example').back, undefined);
});

test('page and image ship the look; gate, CSP and gated paths unchanged', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<script src="\.\/theme\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/theme-daily\.css" \/>/);
  const css = fs.readFileSync(path.join(root, 'theme-daily.css'), 'utf8');
  // every rule outside @font-face and the hidden default of #look-back is scoped to the look
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')[0].trim()).filter(Boolean);
  for (const sel of rules) {
    if (sel === '@font-face' || sel === '#look-back') continue;
    for (const part of sel.split(',')) assert.match(part.trim(), /^html\[data-look="daily"\]/, part);
  }
  assert.ok(fs.existsSync(path.join(root, 'fonts/anton-latin-400-normal.woff2')));
  assert.ok(fs.existsSync(path.join(root, 'fonts/Anton-OFL.txt')));
  const docker = fs.readFileSync(path.join(root, 'Caddy.Dockerfile'), 'utf8');
  for (const f of ['theme.js', 'theme-daily.css', 'fonts']) assert.match(docker, new RegExp('COPY ' + f.replace('.', '\\.') + ' /srv/' + f.replace('.', '\\.')));
  const caddy = fs.readFileSync(path.join(root, 'Caddyfile.selfservice'), 'utf8');
  assert.match(caddy, /@gated \{\n\t\tpath \/ws\/channel \/api\/\*\n\t\}/);
  assert.match(caddy, /script-src 'self' 'wasm-unsafe-eval'/);
});
