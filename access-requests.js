// Admin-only panel for reviewing/approving/declining login-allowlist access
// requests (people who hit /request-access.html because the gate's
// allowlist rejected them) -- distinct from the separate "contact requests"
// feature (someone wanting to be added as a contact, still in app.js/
// contacts.js), which is a different concept entirely despite the similar
// name. Split out of app.js as part of the client-code consolidation
// (CADS-webconference-demo#91); every function/const here is a verbatim
// move, comments included, with no behavior change.

import { accessRequestsList, accessRequestsEmpty, accessRequestsBadge, log } from './ui-dom.js';
import { api } from './app.js';

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
    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'accept';
    approveBtn.textContent = 'Admit';
    approveBtn.addEventListener('click', async () => {
      approveBtn.disabled = true;
      // CADS-webconference-demo#41 (finding 1): no callerEmail to send --
      // the bridge derives the admin check from X-Gate-Email itself now,
      // same as /api/is-admin (#46). Never actually a real admin proof to
      // begin with; sending it was misleading.
      const resp = await api('/access-requests/approve', { body: { email } });
      if (resp.error) { approveBtn.disabled = false; log(`couldn't admit ${email}: ${resp.error}`); return; }
      refreshAccessRequests();
    });
    const declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.className = 'decline';
    declineBtn.textContent = 'Dismiss';
    declineBtn.addEventListener('click', async () => {
      declineBtn.disabled = true;
      await api('/access-requests/decline', { body: { email } });
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
