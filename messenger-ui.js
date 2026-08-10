// Messenger/conversation UI: the currently-open conversation pane (right
// pane on desktop, full-screen on mobile below the 859px breakpoint -- see
// index.html's own media query), message bubble rendering (text + file
// attachments), and the blocked-contacts list. Split out of app.js as part
// of the client-code consolidation (CADS-webconference-demo#91); every
// function/const here is a verbatim move, comments included, with no
// behavior change.
//
// Circular with contacts.js, on purpose -- see that module's own header
// comment for the full reasoning (same safe live-binding/hoisted-function
// pattern as everywhere else in this consolidation). dialerChatStore still
// comes from app.js (hasn't moved yet -- chat-glue.js, a later cycle).

import {
  blockedList, blockedEmpty, dialEmailInput, msgConvPlaceholder, msgConversation,
  messengerShell, convAvatar, convName, convStatus, convMessages,
} from './ui-dom.js';
import { blockedEmails, myContacts, myNames, api, refreshContacts } from './contacts.js';
import { dialerChatStore } from './app.js';

function formatMsgTime(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderBlockedList() {
  blockedList.querySelectorAll('li:not(#blocked-empty)').forEach((li) => li.remove());
  const blocked = blockedEmails.all();
  blockedEmpty.hidden = blocked.length > 0;
  for (const email of blocked) {
    const li = document.createElement('li');
    li.style.cursor = 'default';
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-row-body';
    nameEl.textContent = email;
    const unblockBtn = document.createElement('button');
    unblockBtn.type = 'button';
    unblockBtn.className = 'decline';
    unblockBtn.style.flexShrink = '0';
    unblockBtn.textContent = 'Unblock';
    unblockBtn.addEventListener('click', () => {
      blockedEmails.remove(email);
      // Whether they landed on the block list via the conversation's Block
      // button or an admin's Revoke action, unblocking always means "back
      // in my contacts" -- it does NOT restore server login access on its
      // own if that was also revoked (see the revoke panel's own note).
      myContacts.add(email);
      renderBlockedList();
      refreshContacts();
    });
    li.append(nameEl, unblockBtn);
    blockedList.appendChild(li);
  }
}

// State for the currently-open conversation (messenger shell's right pane /
// mobile full-screen conversation view). null when nothing is selected.
let currentConversationEmail = null;
// CADS-webconference-demo#59: every blob: URL appendConvMessage creates for
// a file message is tracked here so it can be revoked before the next
// render replaces it -- without this, URL.createObjectURL was never
// balanced by a revokeObjectURL anywhere, so re-opening an attachment-heavy
// conversation leaked a fresh, unreclaimable set of blob URLs (each pinning
// up to MAX_FILE_BYTES of decrypted bytes) every single time.
let convBlobUrls = [];
function revokeConvBlobUrls() {
  for (const url of convBlobUrls) URL.revokeObjectURL(url);
  convBlobUrls = [];
}

async function openConversation(email) {
  currentConversationEmail = email;
  dialEmailInput.value = email; // dial-form's existing submit handler reads this as the call target
  msgConvPlaceholder.hidden = true;
  msgConversation.hidden = false;
  messengerShell.dataset.conversationOpen = '1';
  convAvatar.textContent = (email[0] || '?').toUpperCase();
  convName.textContent = myNames?.get(email) || email; // CADS-webconference-demo#54
  const presence = await api(`/presence?email=${encodeURIComponent(email)}`);
  convStatus.textContent = presence.online ? 'online' : 'offline';
  convStatus.dataset.online = presence.online ? '1' : '0';
  revokeConvBlobUrls(); // #59 -- release the previous render's file-attachment blob URLs before creating new ones
  convMessages.innerHTML = '';
  if (dialerChatStore) {
    const history = await dialerChatStore.history(email);
    for (const m of history) appendConvMessage(m);
  }
  await refreshContacts(); // updates the .active row highlight
}

// Shared by history load (openConversation) and a just-composed message
// (msgComposeForm below) so both render identically. `pending` (queued,
// not yet sent over any live channel -- see chatStore's outbox) shows a
// dimmed bubble with "sending…" instead of "you". data-seq (only set for
// my own messages, where seq is always present and unique per
// conversation) lets markConvMessageDelivered below find this exact bubble
// again later and flip it live -- see #49's comment on flushOutbox's
// onDelivered for why that's needed now.
// CADS-webconference-demo#50: formats a byte count the same way any real
// file-transfer UI does (nearest sensible unit, not a raw byte count).
// CADS-webconference-demo#58: an explicit allowlist of raster formats that
// can NEVER carry executable content, not a blocklist of the one bad case
// found so far. `startsWith('image/')` let image/svg+xml through -- SVG is
// XML, can embed <script>, and blob: URLs inherit the ORIGIN of the page
// that created them (this app's own origin). The inline <img src=blob:>
// itself is safe (browsers sandbox SVG loaded that way, no script runs) --
// the actual hole was the "open full-size" link doing a top-level
// target=_blank NAVIGATION to that same blob: URL, which for an SVG
// document DOES execute its script, in this app's own origin, with full
// access to localStorage (identity private keys), IndexedDB, and the gate
// session. A real PoC confirmed this exfiltrates ct-webconference-
// identity:<email> (holderPriv/noisePriv) via one click on a peer-sent
// "image". Anything not in this allowlist (SVG included) now falls
// through to the existing download-only branch below, which never
// navigates to or renders the blob at all -- safe regardless of content,
// same as any other unrecognized file type already was.
const SAFE_INLINE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'image/x-icon']);
function formatFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function appendConvMessage({ from, text, pending, corrupted, seq, kind, fileName, fileMimeType, fileSize, blob }) {
  const div = document.createElement('div');
  div.className = `chat-msg ${from}${pending ? ' pending' : ''}`;
  if (from === 'me' && seq != null) div.dataset.seq = seq;
  const body = document.createElement('div');
  if (corrupted) {
    // CADS-webconference-demo#24: a record chatStore.history() couldn't
    // decrypt (corrupted/tampered row) comes back with corrupted:true and
    // no text -- show that honestly instead of rendering an empty bubble
    // as if it were a genuine blank message.
    body.textContent = '⚠ this message could not be decrypted';
    body.style.opacity = '.6';
  } else if (kind === 'file') {
    // CADS-webconference-demo#50: an image renders inline (click to open
    // full-size in a new tab, same pattern any real messenger uses);
    // anything else renders as a filename + size + download link -- no
    // in-page preview attempted for arbitrary file types.
    const url = URL.createObjectURL(blob);
    convBlobUrls.push(url); // #59 -- revoked by revokeConvBlobUrls() on the next render or conversation close
    if (SAFE_INLINE_IMAGE_MIME_TYPES.has(fileMimeType || '')) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.src = url;
      img.alt = fileName || 'image';
      img.className = 'chat-file-image';
      link.appendChild(img);
      body.appendChild(link);
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName || 'file';
      link.className = 'chat-file-link';
      link.textContent = `📎 ${fileName || 'file'}`;
      const size = document.createElement('span');
      size.className = 'chat-file-size';
      size.textContent = formatFileSize(fileSize);
      body.append(link, size);
    }
  } else {
    body.textContent = text;
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = from === 'me' ? (pending ? 'sending…' : 'you') : 'peer';
  div.append(body, meta);
  convMessages.appendChild(div);
  convMessages.scrollTop = convMessages.scrollHeight;
}

// CADS-webconference-demo#49: flips a specific "sending…" bubble to
// delivered once flushOutbox's onDelivered callback confirms its ack --
// finds it by the data-seq appendConvMessage sets above. No-ops quietly if
// the bubble isn't on screen right now (a different conversation is open,
// or this pane hasn't been opened at all this session) -- chatStore itself
// already has the correct pending:false state either way; this only keeps
// whatever's currently rendered in sync with it.
function markConvMessageDelivered(seq) {
  const bubble = convMessages.querySelector(`.chat-msg.me[data-seq="${seq}"]`);
  if (!bubble) return;
  bubble.classList.remove('pending');
  const meta = bubble.querySelector('.meta');
  if (meta) meta.textContent = 'you';
}

function closeConversation() {
  revokeConvBlobUrls(); // #59 -- nothing left open to re-render into, so release now rather than waiting for the next openConversation
  currentConversationEmail = null;
  messengerShell.dataset.conversationOpen = '0';
  // data-conversation-open only gates layout below the 859px breakpoint
  // (index.html's media query) -- on desktop's always-visible split pane,
  // these two hidden flags are the only thing selecting placeholder vs.
  // conversation, so both paths need resetting here too.
  msgConvPlaceholder.hidden = false;
  msgConversation.hidden = true;
}

export {
  formatMsgTime,
  renderBlockedList,
  currentConversationEmail,
  openConversation,
  formatFileSize,
  appendConvMessage,
  markConvMessageDelivered,
  closeConversation,
};
