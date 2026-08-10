// CADS-webconference-demo#36: split out of request-access.html's inline
// <script> -- the site-wide CSP (script-src 'self', no 'unsafe-inline')
// blocked the inline version outright (caught live). Needs its own gate
// exemption in Caddyfile.selfservice alongside the page itself, same
// reasoning as that page's own header comment.
const form = document.getElementById('request-form');
const note = document.getElementById('note');
// Live-reported: the landing page's gate-required panel now links here with
// ?email=... pre-filled (the person already typed it once, no reason to ask
// again) -- same #api/access-requests POST below, just skips retyping.
const prefillEmail = new URLSearchParams(location.search).get('email');
if (prefillEmail) document.getElementById('request-email').value = prefillEmail;
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = document.getElementById('request-email').value.trim();
  if (!email) return;
  const btn = form.querySelector('button');
  btn.disabled = true;
  note.textContent = '';
  try {
    const resp = await fetch('/api/access-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const body = await resp.json();
    if (!resp.ok || body.error) throw new Error(body.error || `request failed (${resp.status})`);
    note.dataset.kind = 'ok';
    note.textContent = 'Request sent. An existing member needs to admit you before you can sign in.';
    form.querySelector('input').value = '';
  } catch (e) {
    note.dataset.kind = 'error';
    note.textContent = `Couldn't send the request: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});
