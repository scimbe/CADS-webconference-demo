// Optional look for visitors who come from My Daily Idea
// (https://demos-34a13a96.bunsenbrenner.org/duell): ?look=daily&a=ffd400&b=ff3b1d
// restyles this page in that app's calendar-sheet look and the visitor's own
// two colours. Purely cosmetic -- nothing here touches identity, the login
// gate, /api/* or /ws/channel. Classic (non-module) script loaded from <head>
// so the look is set before first paint; CSP-wise it is just another
// same-origin script.
//
// The look survives the login round trip through sessionStorage:
// dialer.js sends a gated visitor to bunsenbrenner.org/gate/start with
// return=location.pathname only, so the query is gone on the way back, but
// sessionStorage is per tab and per origin and outlives the cross-origin hop.
//
// Only two strict hex colours and one fixed look name are accepted; the
// "back to the app" link is a constant, never taken from the URL (no open
// redirect).
(function (root) {
  'use strict';
  var KEY = 'ct-webconference-look';
  var HEX = /^[0-9a-f]{6}$/i;
  var DEFAULT = { look: 'daily', a: '#ffd400', b: '#ff3b1d' };
  var BACK = 'https://demos-34a13a96.bunsenbrenner.org/duell';

  // search string -> {look,a,b} | {off:true} (explicit ?look=off) | null (nothing asked)
  function parseLook(search) {
    var p = new URLSearchParams(search || '');
    var look = p.get('look');
    if (look === 'off') return { off: true };
    if (look !== 'daily') return null;
    var a = p.get('a'), b = p.get('b');
    return {
      look: 'daily',
      a: a && HEX.test(a) ? '#' + a.toLowerCase() : DEFAULT.a,
      b: b && HEX.test(b) ? '#' + b.toLowerCase() : DEFAULT.b,
    };
  }
  // Stored value -> same shape, re-validated (sessionStorage is writable by any same-origin script).
  function fromStore(raw) {
    try {
      var o = JSON.parse(raw);
      if (!o || o.look !== 'daily') return null;
      return parseLook('look=daily&a=' + String(o.a).slice(1) + '&b=' + String(o.b).slice(1));
    } catch (e) { return null; }
  }
  // Readable text on a colour (WCAG relative luminance, same threshold the app uses).
  function lum(hex) {
    var c = [1, 3, 5].map(function (i) {
      var v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function ink(hex) { return lum(hex) > 0.45 ? '#111111' : '#fffaf0'; }

  // The login page (Keycloak on auth.bunsenbrenner.org) is another origin, so sessionStorage does not reach
  // it. A short-lived cookie on the parent domain carries only the look and the two colours
  // ("daily.RRGGBB.RRGGBB", no identifier); the login theme re-validates it with the same strict pattern.
  // Purely cosmetic and only set after the visitor asked for the look.
  var COOKIE = 'ct_look';
  function lookCookie(chosen) {
    var tail = '; Domain=bunsenbrenner.org; Path=/; Secure; SameSite=Lax';
    if (!chosen) return COOKIE + '=; Max-Age=0' + tail;
    return COOKIE + '=daily.' + chosen.a.slice(1) + '.' + chosen.b.slice(1) + '; Max-Age=1800' + tail;
  }
  function setCookie(doc, chosen) {
    try {
      var host = doc.location && doc.location.hostname;
      if (!host || !/(^|\.)bunsenbrenner\.org$/.test(host)) return;
      doc.cookie = lookCookie(chosen);
    } catch (e) { /* cookies blocked: the login page just keeps its normal look */ }
  }

  function apply(doc, store, search) {
    var asked = parseLook(search), chosen = null;
    try {
      if (asked && asked.off) store.removeItem(KEY);
      else if (asked) { store.setItem(KEY, JSON.stringify(asked)); chosen = asked; }
      else chosen = fromStore(store.getItem(KEY));
    } catch (e) { chosen = asked && !asked.off ? asked : null; }
    if (asked && asked.off) setCookie(doc, null);
    if (!chosen) return null;
    setCookie(doc, chosen);
    var el = doc.documentElement, s = el.style;
    el.setAttribute('data-look', 'daily');
    s.setProperty('--d-a', chosen.a);
    s.setProperty('--d-b', chosen.b);
    s.setProperty('--d-on', ink(chosen.a));
    s.setProperty('--d-onb', ink(chosen.b));
    // Button text on ink: the first colour when it is light enough, else paper white (as in the app's --btn).
    s.setProperty('--d-btn', lum(chosen.a) > 0.45 ? chosen.a : '#fffaf0');
    return chosen;
  }
  // A plain "← My Daily Idea" link at the top; textContent only.
  function addBack(doc) {
    if (doc.getElementById('look-back')) return;
    var bar = doc.createElement('nav');
    bar.id = 'look-back';
    var a = doc.createElement('a');
    a.href = BACK;
    a.textContent = '← My Daily Idea';
    bar.appendChild(a);
    doc.body.insertBefore(bar, doc.body.firstChild);
  }

  var api = { parseLook: parseLook, fromStore: fromStore, ink: ink, apply: apply, lookCookie: lookCookie, KEY: KEY, BACK: BACK };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  var store;
  try { store = root.sessionStorage; } catch (e) { store = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} }; }
  if (apply(root.document, store, root.location.search)) {
    if (root.document.body) addBack(root.document);
    else root.document.addEventListener('DOMContentLoaded', function () { addBack(root.document); });
  }
})(typeof window !== 'undefined' ? window : this);
