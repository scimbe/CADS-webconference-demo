// Admin-only panel for reviewing/approving/declining login-allowlist access
// requests (people who hit /request-access.html because the gate's
// allowlist rejected them) -- distinct from the separate "contact requests"
// feature (someone wanting to be added as a contact, contacts.js), which
// is a different concept entirely despite the similar name. Split out of
// app.js as part of the client-code consolidation
// (CADS-webconference-demo#91); every function/const here is a verbatim
// move, comments included, with no behavior change.

import { accessRequestsList, accessRequestsEmpty, accessRequestsBadge, log } from './ui-dom.js';
import { api } from './contacts.js';

const KEYCLOAK_ADMIN_CONSOLE_BASE = 'https://auth.bunsenbrenner.org/admin/master/console/#/ct-demo/users';
function keycloakAdminConsoleLink(email) {
  return `${KEYCLOAK_ADMIN_CONSOLE_BASE}?search=${encodeURIComponent(email)}`;
}

// CADS-webconference-demo#36: admin-only panel listing everyone who hit
// /request-access.html because the login allow-list rejected them.
// Approve grants login (same control-plane call /allowlist/add uses) and
// clears the request; Decline just clears it. Both server-side calls are
// admin-gated independently of this UI (see the bridge's own comment).
async function refreshAccessRequests() {
  const resp = await api('/access-requests');
  renderAccessRequests(resp.error ? [] : resp.requests || []);
}

// Robustness audit finding (proactive review, not yet live-reproduced):
// refreshAccessRequests() isn't only called on demand -- dialer.js runs it
// on a 15s pollEvery poll, entirely independent of any in-flight Approve/
// Dismiss click. renderAccessRequests rebuilds every row from scratch on
// each call, so if that poll lands while a click's own `await api(...)`
// is still pending (a real, non-rare timing coincidence -- roughly a
// multi-second window out of every 15s), the row for that same
// still-pending email gets replaced with a FRESH, enabled pair of
// buttons, silently undoing the disabled-flag guard the click handler had
// just set. The admin (or the same rapid double-click) could then fire a
// second concurrent approve/decline for the same email -- worse, Approve
// and Dismiss are two separate buttons that never checked each other, so
// clicking one and then the other on the same row before the first
// resolves races two different bridge-side mutations (grant-then-delete
// vs. delete-only) against the same pending-request entry. Tracked here
// instead of on the (dialer.js#40-disable-guard-alone) precedent because
// a periodic background render, not just a same-button double-click, is
// what invalidates that guard -- the fix needs state that survives a
// full row rebuild, so it lives in this module-scope Set rather than on
// the (freshly recreated every render) button element itself.
const inFlightRequestActions = new Set(); // emails currently mid-approve/decline

function renderAccessRequests(requests) {
  accessRequestsList.querySelectorAll('li:not(#access-requests-empty)').forEach((li) => li.remove());
  accessRequestsEmpty.hidden = requests.length > 0;
  accessRequestsBadge.hidden = requests.length === 0;
  accessRequestsBadge.textContent = String(requests.length);
  for (const { email } of requests) {
    const li = document.createElement('li');
    li.style.cursor = 'default';
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-row-body';
    nameEl.textContent = email;
    const actions = document.createElement('div');
    actions.className = 'msg-request-actions';
    const busy = inFlightRequestActions.has(email); // survives this row being torn down and rebuilt mid-action, see comment above
    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'accept';
    approveBtn.textContent = 'Admit';
    approveBtn.disabled = busy;
    approveBtn.addEventListener('click', async () => {
      inFlightRequestActions.add(email);
      approveBtn.disabled = true;
      declineBtn.disabled = true;
      try {
        // CADS-webconference-demo#41 (finding 1): no callerEmail to send --
        // the bridge derives the admin check from X-Gate-Email itself now,
        // same as /api/is-admin (#46). Never actually a real admin proof to
        // begin with; sending it was misleading.
        const resp = await api('/access-requests/approve', { body: { email } });
        if (resp.error) log(`couldn't admit ${email}: ${resp.error}`);
      } finally {
        inFlightRequestActions.delete(email);
      }
      // Refreshed unconditionally (success or failure) rather than just
      // locally re-enabling the buttons on error -- a failed approve
      // leaves the request still pending server-side, so re-fetching is
      // the authoritative way to get back to a correct, enabled row,
      // instead of assuming local state matches the server's.
      refreshAccessRequests();
    });
    const declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.className = 'decline';
    declineBtn.textContent = 'Dismiss';
    declineBtn.disabled = busy;
    declineBtn.addEventListener('click', async () => {
      inFlightRequestActions.add(email);
      approveBtn.disabled = true;
      declineBtn.disabled = true;
      try {
        await api('/access-requests/decline', { body: { email } });
      } finally {
        inFlightRequestActions.delete(email);
      }
      refreshAccessRequests();
    });
    actions.append(approveBtn, declineBtn);
    li.append(nameEl, actions);
    accessRequestsList.appendChild(li);
  }
}

export {
  KEYCLOAK_ADMIN_CONSOLE_BASE,
  keycloakAdminConsoleLink,
  refreshAccessRequests,
  renderAccessRequests,
};
