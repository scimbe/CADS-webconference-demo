// Chat delivery glue: the ack-matching primitive, the outbox flusher, the
// background (no call, no page reload) chat-delivery session used both by
// the caller-initiated compose-time trigger and the periodic sweep, and the
// in-call chat channel wiring (setupChatChannel) used by both call
// transports. Also owns dialerChatStore, the dialer screen's own
// ChatStore instance (separate from any call-scoped one) -- exported with a
// setter since it's instantiated once identity is known (runDialer, still
// in app.js) but read from here and from sync.js/contacts.js/messenger-ui.js.
// Split out of app.js as part of the client-code consolidation
// (CADS-webconference-demo#91); every function/const here is a verbatim
// move, comments included, with no behavior change.

import * as wasm from './pkg/ct_agent_wasm.js';
import { TAG_CHAT, TAG_FILE_INIT, TAG_FILE_CHUNK, MAX_FILE_BYTES, FILE_CHUNK_BYTES, NO_CAMERA_SENTINEL } from './call-protocol.js';
import { writeFramed, readFramed, joinChannel, sendTaggedFrame } from './call-transport-shared.js';
import { computeAttestation, ensureWasmInit } from './identity.js';
import {
  chatInput, chatSend, chatForm, remoteEmpty, log, addChatMessage, notifyIfHidden, playMessageSound,
} from './ui-dom.js';
import { currentConversationEmail, appendConvMessage, markConvMessageDelivered } from './messenger-ui.js';
import { api, refreshContacts, pollCallStatus, blockedEmails } from './contacts.js';

// CADS-webconference-demo#21: markDelivered() used to run immediately after
// send(), with nothing confirming the peer actually got the frame -- a
// channel/tab/network death between send() and the peer processing it
// silently and PERMANENTLY lost the message (already marked delivered
// locally, so it would never be retried). Every place that handles an
// incoming TAG_CHAT frame now sends a small {ack:seq} envelope right back
// over the same channel (see each receive loop's own comment); an
// AckWaiter matches those to the sends still waiting on them. One per
// live channel/session -- never shared across connections, so a stale ack
// from a previous session can't spuriously resolve a new one.
function createAckWaiter() {
  const pending = new Map(); // seq -> {resolve, reject}
  return {
    wait(seq, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(seq);
          reject(new Error(`no ack for seq ${seq} within ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(seq, { resolve: () => { clearTimeout(timer); pending.delete(seq); resolve(); } });
      });
    },
    resolve(seq) {
      pending.get(seq)?.resolve();
    },
  };
}

// Sends every message composed while offline (chatStore.pendingOutbox) the
// moment a live channel to that peer actually opens -- called from both
// transports' own "channel just opened" point. `send` is transport-specific
// (WebRTC datachannel.send(str) vs. the Noise-channel sendText(TAG_CHAT, str))
// so this stays agnostic to which one is live. Only marks a message
// delivered once its ack actually arrives; stops flushing (leaving the rest
// pending) the moment one doesn't -- a dead channel mid-flush shouldn't
// spray the remaining queue into the void, just leave it for next time.
// CADS-webconference-demo#49: onDelivered is an optional callback fired
// with each message's seq right after it's actually confirmed delivered --
// added specifically so the messenger conversation pane (appendConvMessage)
// can flip an already-rendered "sending…" bubble to delivered live,
// without this function needing to know anything about that DOM. Before
// this, a message delivered entirely in the background (no call, no page
// reload -- the whole point of the async chat-delivery feature) left its
// bubble showing "sending…" forever, even though it had genuinely gone
// through -- the only way to see the correct state was to close and reopen
// the conversation (a fresh history() read). Not wired into the in-call
// chat panels' own two flushOutbox call sites (a separate DOM, #chat-log,
// that doesn't have a "pending" concept at all -- addChatMessage renders
// a live send immediately, no bubble to update).
// CADS-webconference-demo#50: sendFile is an optional transport-specific
// callback for a kind:'file' outbox item -- (m) => Promise<void>, expected
// to have fully sent the file's init+chunks by the time it resolves (the
// ack this function awaits right after is what actually confirms
// delivery, same contract as a text send). Only backgroundChatSession
// passes one today (the async/offline-capable delivery path -- the same
// one text already uses, per the "offline behaves like messages" design);
// the two in-call chat panels don't, so a file outbox item reaching
// either of those two call sites is simply skipped rather than sent as
// malformed text -- correct today since composing a file attachment only
// ever happens from the messenger pane, which always delivers through
// backgroundChatSession.
async function flushOutbox(chatStore, peerEmail, send, ackWaiter, onDelivered, sendFile) {
  if (!chatStore || !peerEmail) return;
  const outbox = await chatStore.pendingOutbox(peerEmail);
  for (const m of outbox) {
    if (m.kind === 'file' && !sendFile) continue; // this transport can't send files -- leave it pending for a transport that can
    // CADS-webconference-demo#43 (finding 3): only ackWaiter.wait() was
    // wrapped -- send() itself could throw synchronously (e.g. a data
    // channel raising InvalidStateError mid-close) and propagate straight
    // out of this function. Both call sites are fire-and-forget with no
    // .catch(), so that surfaced as an unhandled promise rejection. The
    // message was never actually lost either way (it just stays pending,
    // same as an ack timeout) -- this only changes whether the failure is
    // handled cleanly or crashes out as unhandled.
    try {
      if (m.kind === 'file') await sendFile(m);
      else send(JSON.stringify({ seq: m.seq, text: m.text }));
      await ackWaiter.wait(m.seq);
    } catch (e) {
      log(`flushOutbox: stopping (seq ${m.seq} to ${peerEmail} not confirmed: ${e.message || e}) -- rest stays queued for next attempt`);
      break;
    }
    await chatStore.markDelivered(peerEmail, m.seq);
    onDelivered?.(m.seq);
  }
}

// ============ Background chat delivery (no call, no page reload) ============
// Being mutual contacts and both online was never enough on its own for a
// queued message to actually leave the device -- delivery only ever
// happened as a side effect of a REAL call's chat channel opening. This
// closes that gap with its own lightweight session over the exact same
// grant/attest/channel/Noise_IK machinery a real call uses (bridge's
// /api/call now accepts kind:'chat-delivery' -- see server.js), just
// without ever reaching startCallFromIdentity's location.search reload:
// run() and its call-screen UI are never involved, so a message send can't
// visibly interrupt whatever the recipient is doing. Both sides run the
// SAME backgroundChatSession once connected -- there's no "sender vs.
// receiver" asymmetry once the channel is up, only caller-vs-callee for
// the Noise handshake's own initiator/responder roles.

// How long a background session keeps listening for a reply after sending
// its own outbox -- bounded so an idle WS doesn't linger forever holding a
// channel open. Generous enough to comfortably cover the peer's own
// symmetric flush-then-listen sequence on a slow connection.
const BACKGROUND_CHAT_WINDOW_MS = 8000;
// CADS-webconference-demo#50: BACKGROUND_CHAT_WINDOW_MS above was sized
// for tiny text messages -- nowhere near enough for a chunked multi-MB
// file transfer over a relayed connection. fileTransferWindowMs extends
// the session's deadline (see backgroundChatSession) based on the
// declared file size the moment a transfer starts, assuming a
// deliberately pessimistic ~50KB/s floor throughput, capped at 5 minutes
// so a stalled/hostile peer still can't hold the connection open forever.
function fileTransferWindowMs(sizeBytes) {
  return Math.min(5 * 60 * 1000, Math.max(BACKGROUND_CHAT_WINDOW_MS, (sizeBytes / 1024) * 50));
}

async function connectBackgroundChannel(wsUrl, grantHex, holderPrivHex, noisePrivHex, isCaller) {
  const { stream, peerNoiseHex } = await joinChannel(wsUrl, grantHex, holderPrivHex);
  if (!peerNoiseHex) throw new Error('no peer Noise key in ack -- peer not registered with a Noise key');
  const hs = isCaller ? wasm.NoiseHandshake.newInitiator(noisePrivHex, peerNoiseHex) : wasm.NoiseHandshake.newResponder(noisePrivHex);
  if (isCaller) {
    await writeFramed(stream, hs.writeMessage(new Uint8Array(0)));
    hs.readMessage(await readFramed(stream));
  } else {
    hs.readMessage(await readFramed(stream));
    await writeFramed(stream, hs.writeMessage(new Uint8Array(0)));
  }
  if (!hs.isFinished()) throw new Error('Noise handshake did not finish after 2 messages');
  return { stream, noiseTransport: hs.intoTransport() };
}

// Flushes this identity's own outbox, then listens for up to
// BACKGROUND_CHAT_WINDOW_MS for anything the peer sends back (their own
// symmetric flush) -- decrypts and records it via the SAME chatStore the
// messenger pane reads from, and live-appends it if that conversation
// happens to be open right now. Never touches call-status/ringing state;
// a plain WS close at the end is a normal, expected end to this session,
// not a "peer hung up" signal the way it would be mid-call.
async function backgroundChatSession(stream, noiseTransport, isCaller, chatStore, peerEmail) {
  // CADS-webconference-demo#91: delegates to the shared, catch+log-hardened
  // implementation in call-transport-shared.js (this local closure used to
  // duplicate the send logic itself, without a .catch -- see
  // sendTaggedFrame's own comment for why that copy has been retired).
  const sendTagged = (tag, bytes) => sendTaggedFrame(stream, noiseTransport, tag, bytes);
  const send = (text) => sendTagged(TAG_CHAT, new TextEncoder().encode(text));
  // CADS-webconference-demo#50: sends a pending file outbox item's
  // TAG_FILE_INIT header (seq/name/mimeType/size, so the receiver knows
  // what's coming and how to reassemble it) followed by its bytes chunked
  // at FILE_CHUNK_BYTES -- same shape as TAG_MEDIA_INIT/CHUNK already used
  // for the experimental video path. Resolves once every chunk has been
  // handed to the socket; flushOutbox (the caller) then awaits the ack the
  // same way it does for a text send.
  // Robustness audit finding (proactive review, not yet live-reproduced):
  // this loop used to fire every chunk of a file transfer (up to
  // MAX_FILE_BYTES = 25MB, ~512 chunks) into stream.ws.send() with no
  // backpressure at all -- unlike call-channel.js's own media-chunk
  // sender (#70), which explicitly watches ws.bufferedAmount and pauses
  // rather than letting it grow unbounded on a slow/lossy connection.
  // WebSocket.send() is non-blocking and just keeps queuing into
  // bufferedAmount if the network can't keep up; nothing here was
  // checking it. waitForDrain below pauses between chunks once buffered
  // data crosses the same high-water mark call-channel.js already
  // established as reasonable, so a large attachment degrades to a
  // slower send instead of ballooning the tab's outgoing buffer.
  const FILE_SEND_HIGH_WATER = 262144; // matches call-channel.js's MEDIA_BACKPRESSURE_HIGH_WATER
  async function waitForDrain() {
    while (stream.ws.bufferedAmount > FILE_SEND_HIGH_WATER) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const sendFile = async (m) => {
    deadline = Math.max(deadline, Date.now() + fileTransferWindowMs(m.fileBytes.length));
    sendTagged(TAG_FILE_INIT, new TextEncoder().encode(JSON.stringify({ seq: m.seq, name: m.fileName, mimeType: m.fileMimeType, size: m.fileSize })));
    for (let off = 0; off < m.fileBytes.length; off += FILE_CHUNK_BYTES) {
      await waitForDrain();
      sendTagged(TAG_FILE_CHUNK, m.fileBytes.subarray(off, off + FILE_CHUNK_BYTES));
    }
  };
  const ackWaiter = createAckWaiter();
  // Runs CONCURRENTLY with the receive loop below, not before it -- flushOutbox
  // now awaits an ack for each send, and that ack can only ever arrive via
  // this same function's own receive loop, so awaiting the flush first would
  // deadlock waiting for a reply nothing is listening for yet.
  // CADS-webconference-demo#49: this is the async/background delivery path
  // (no call, no page reload) -- exactly the case a message could go from
  // pending to delivered while the messenger conversation pane is sitting
  // open, so it's the one flushOutbox call site that needs to keep an
  // already-rendered bubble in sync. Scoped to the currently-open
  // conversation only -- markConvMessageDelivered itself already no-ops if
  // its bubble isn't on screen, but checking here too avoids searching the
  // DOM at all for the (common) case where a different or no conversation
  // is open.
  const flushPromise = flushOutbox(chatStore, peerEmail, send, ackWaiter, (seq) => {
    if (currentConversationEmail === peerEmail.toLowerCase()) markConvMessageDelivered(seq);
  }, sendFile);
  // CADS-webconference-demo#50: an in-progress incoming file transfer --
  // only one at a time can be in flight (the sender's own flushOutbox is
  // ack-gated, one outbox item fully delivered before the next starts), so
  // tracking a single "current" transfer by seq is enough, no need to key
  // this by anything else.
  let incomingFile = null;
  // CADS-webconference-demo#50: mutable (not const) -- extended by
  // fileTransferWindowMs whenever a file transfer starts, in either
  // direction (sendFile below, and the TAG_FILE_INIT receive handler),
  // since BACKGROUND_CHAT_WINDOW_MS alone is nowhere near enough for a
  // multi-MB chunked transfer.
  let deadline = Date.now() + BACKGROUND_CHAT_WINDOW_MS;
  try {
    while (Date.now() < deadline) {
      const cipher = await readFramed(stream, deadline - Date.now());
      const plain = noiseTransport.decrypt(cipher);
      const tag = plain[0];
      const payload = plain.slice(1);
      if (tag === TAG_FILE_INIT) {
        let header;
        try {
          header = JSON.parse(new TextDecoder().decode(payload));
        } catch {
          continue; // malformed header -- nothing to reassemble
        }
        // CADS-webconference-demo#58 (secondary finding): the cap check
        // only ever rejected a `size` that WAS a number and over the cap --
        // a missing/non-number/negative size skipped the check entirely,
        // and `received < size` (below) is immediately false for a
        // negative/zero/undefined size, so the very first chunk completed
        // reassembly with the declared size never actually validated
        // against anything. Coerced to a safe non-negative integer up
        // front instead; anything that doesn't coerce cleanly is treated
        // as a hostile/malformed header, same as exceeding the cap.
        const declaredSize = Number(header.size);
        if (!Number.isInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_FILE_BYTES) {
          log(`incoming file from ${peerEmail} has an invalid or over-cap declared size (${header.size}) -- refusing to buffer it`);
          incomingFile = null;
          continue;
        }
        // CADS-webconference-demo#75: a single pre-sized buffer, written at
        // an advancing offset, instead of an array of per-chunk Uint8Arrays
        // concatenated at the end. The byte cap above (declaredSize <=
        // MAX_FILE_BYTES) bounds cumulative BYTES but not CHUNK COUNT -- a
        // peer sending an under-cap file as millions of 1-byte chunks paid
        // no penalty from that check at all: each chunk is its own
        // Uint8Array/ArrayBuffer (V8 per-object overhead runs to hundreds
        // of bytes even for a 1-byte view), so `chunks` could balloon to
        // multiple GB well before `received` ever approached the byte cap,
        // and concatBytes(...chunks) then spread millions of arguments onto
        // one call, which V8 either hangs on or throws "Maximum call stack
        // size exceeded" for. A fixed buffer makes both impossible
        // regardless of how the peer chunks the transfer: resident memory
        // is capped at declaredSize (one allocation, not N), and there's no
        // spread left to blow up.
        incomingFile = { seq: header.seq, name: header.name, mimeType: header.mimeType, size: declaredSize, buf: new Uint8Array(declaredSize), received: 0 };
        deadline = Math.max(deadline, Date.now() + fileTransferWindowMs(declaredSize));
        continue;
      }
      if (tag === TAG_FILE_CHUNK) {
        if (!incomingFile) continue; // chunk with no preceding (or an already-abandoned) init -- nothing to append to
        // CADS-webconference-demo#75: a chunk that would overshoot the
        // buffer sized to the DECLARED size is abandoned outright, not
        // silently truncated -- a sender that can't stick to its own
        // declared size is either lying or buggy, and truncating a chunk
        // instead of failing loudly would deliver a corrupted file with no
        // indication anything was wrong. This also closes the pre-existing
        // wrinkle where the final chunk could overshoot `size` and the
        // whole oversized chunk still got concatenated in. No separate
        // MAX_FILE_BYTES check needed here anymore -- TAG_FILE_INIT above
        // already rejects any declaredSize over that cap, so `size` (and
        // therefore this buffer) can never itself exceed MAX_FILE_BYTES.
        if (incomingFile.received + payload.length > incomingFile.size) {
          log(`incoming file from ${peerEmail} sent more data than its declared size -- abandoning it`);
          incomingFile = null;
          continue;
        }
        incomingFile.buf.set(payload, incomingFile.received);
        incomingFile.received += payload.length;
        if (incomingFile.received < incomingFile.size) continue; // more chunks still coming
        const fileBytes = incomingFile.buf.subarray(0, incomingFile.received);
        const { seq, name, mimeType } = incomingFile;
        incomingFile = null;
        if (chatStore && peerEmail) {
          // CADS-webconference-demo#58 (secondary finding): record the
          // ACTUAL reassembled byte length, not the sender's declared
          // size -- a sender can freely lie about the header (declare 100,
          // send 200), and storing the declared value would persist that
          // mismatch as fileSize metadata forever. fileBytes.length is
          // exactly what's really there.
          const recorded = await chatStore.record({ peerEmail, from: 'peer', seq, received: true, kind: 'file', fileName: name, fileMimeType: mimeType, fileSize: fileBytes.length, fileBytes });
          send(JSON.stringify({ ack: seq }));
          if (currentConversationEmail === peerEmail.toLowerCase()) appendConvMessage(recorded);
          refreshContacts();
          notifyIfHidden(peerEmail, `📎 ${name || 'Sent a file'}`); // CADS-webconference-demo#55/#56
          playMessageSound();
        }
        continue;
      }
      if (tag !== TAG_CHAT) continue;
      const raw = new TextDecoder().decode(payload);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // sentinel or malformed frame -- nothing to record
      }
      if (parsed.ack != null) {
        ackWaiter.resolve(parsed.ack);
        continue;
      }
      const { seq, text } = parsed;
      if (chatStore && peerEmail && seq != null && text != null) {
        // CADS-webconference-demo#43 (finding 2): used to send the ack
        // BEFORE persisting -- if record() ever threw, the sender would
        // already have its ack and mark the message delivered even though
        // this side never actually stored it, a narrow window where #21's
        // "ack implies persisted" guarantee didn't fully hold. Persist
        // first, ack only once that succeeds.
        await chatStore.record({ peerEmail, from: 'peer', text, seq, received: true });
        send(JSON.stringify({ ack: seq })); // CADS-webconference-demo#21 -- see createAckWaiter's comment
        if (currentConversationEmail === peerEmail.toLowerCase()) appendConvMessage({ from: 'peer', text, pending: false });
        refreshContacts(); // updates the list-pane preview text
        notifyIfHidden(peerEmail, text); // CADS-webconference-demo#55/#56
        playMessageSound();
      }
    }
  } catch {
    // Timed out waiting for more, or the peer closed -- a normal end to a
    // background session, not an error worth surfacing anywhere.
  } finally {
    await flushPromise.catch(() => {}); // let any still-in-flight send finish before we close under it
    stream.ws.close();
  }
}

// Per-peer guard so the compose-time trigger and the periodic sweep below
// can't both open a second background session for the same peer at once.
const deliveryInFlight = new Set();

// Caller-initiated half: called (a) right after composing a message, and
// (b) periodically for any contact with a non-empty outbox, so a message
// composed while the peer was offline still gets picked up once they come
// back online without needing another explicit action. No-ops quietly if
// there's nothing queued or the peer isn't online -- this is a background
// sweep, not a user-facing action, so it never surfaces its own errors.
async function tryBackgroundDeliver(identity, peerEmail) {
  const key = peerEmail.toLowerCase();
  if (deliveryInFlight.has(key)) return;
  if (!dialerChatStore) return;
  // CADS-webconference-demo#39 (finding 1): blocking someone is supposed to
  // stop them being reached "at all" (see showIncoming's own comment on the
  // inbound side, which already checks this) -- this outbound sweep never
  // did, so a queued outbox message to a peer blocked AFTER composing it
  // still got delivered on the next sweep.
  if (blockedEmails.has(key)) return;
  // CADS-webconference-demo#39 (finding 2): used to add(key) only after
  // awaiting pendingOutbox()/presence below -- two concurrent triggers for
  // the same peer (the compose-time call and the 10s periodic sweep landing
  // together) both passed the has() check above before either finished
  // those awaits, both proceeded, and both delivered the entire outbox --
  // every queued message sent twice. Marking in-flight synchronously here,
  // before any await, closes that window; the try/finally below now covers
  // every return path so this always gets cleared.
  deliveryInFlight.add(key);
  try {
    const outbox = await dialerChatStore.pendingOutbox(peerEmail);
    if (!outbox.length) return;
    const presence = await api(`/presence?email=${encodeURIComponent(peerEmail)}`);
    if (!presence.online) return;
    await ensureWasmInit();
    const resp = await api('/call', { body: { fromEmail: identity.email, toEmail: peerEmail, transport: 'channel', kind: 'chat-delivery' } });
    if (resp.error || resp.status === 'offline') return;
    const attestation = computeAttestation(resp.channel, identity.holderPriv, identity.holderPub, identity.noisePub);
    const attestResp = await api('/attest', {
      body: { channel: resp.channel, role: 'caller', holderPub: identity.holderPub, noisePub: identity.noisePub, attestation },
    });
    if (attestResp.error) return;
    if (attestResp.status?.state !== 'accepted_and_registered') {
      // The callee auto-attests near-instantly (no human ringing wait for
      // chat-delivery) -- a short poll covers the one real round-trip delay
      // (their attest + this bridge's own tryRegister control-plane calls).
      let accepted = false;
      await pollCallStatus(resp.channel, {
        timeoutMs: 10000,
        intervalMs: 500,
        onDone: (ok) => { accepted = ok; },
      });
      if (!accepted) return;
    }
    const { stream, noiseTransport } = await connectBackgroundChannel(resp.ws, resp.grant, identity.holderPriv, identity.noisePriv, true);
    await backgroundChatSession(stream, noiseTransport, true, dialerChatStore, peerEmail);
  } catch (e) {
    log(`background chat delivery to ${peerEmail} failed (will retry next sweep): ${e.message || e}`);
  } finally {
    deliveryInFlight.delete(key);
  }
}

// Callee-initiated half: showIncoming branches here for kind:'chat-delivery'
// instead of ever showing the ringing card -- see its own comment.
async function autoAcceptChatDelivery(incoming, identity) {
  const key = incoming.fromEmail.toLowerCase();
  if (deliveryInFlight.has(key)) return;
  deliveryInFlight.add(key);
  try {
    await ensureWasmInit();
    const attestation = computeAttestation(incoming.channel, identity.holderPriv, identity.holderPub, identity.noisePub);
    const attestResp = await api('/attest', {
      body: { channel: incoming.channel, role: 'callee', holderPub: identity.holderPub, noisePub: identity.noisePub, attestation },
    });
    // The callee's incoming WS push fires the instant the bridge mints the
    // channel -- BEFORE the caller has even issued its own /api/attest call
    // (a separate, later HTTP round-trip on the caller's side). This attest
    // call almost always lands first, with the caller's own callerAttest
    // still null -- the bridge's tryRegister() then no-ops (needs both
    // sides) and this response's status stays 'ringing', not
    // 'accepted_and_registered'. The channel's members are only actually
    // registered with the control plane once BOTH attestations are in, and
    // the edge refuses a join for a not-yet-registered member -- joining
    // immediately here, without waiting for that, is exactly what produced
    // a consistent, reproducible "channel join refused" on every background
    // delivery tested live. tryBackgroundDeliver (the caller-initiated half
    // of this same feature) already polls for this same reason; this was
    // the one call site that didn't.
    if (attestResp.status?.state !== 'accepted_and_registered') {
      let accepted = false;
      await pollCallStatus(incoming.channel, {
        timeoutMs: 10000,
        intervalMs: 500,
        onDone: (ok) => { accepted = ok; },
      });
      if (!accepted) return;
    }
    const { stream, noiseTransport } = await connectBackgroundChannel(incoming.ws, incoming.grant, identity.holderPriv, identity.noisePriv, false);
    await backgroundChatSession(stream, noiseTransport, false, dialerChatStore, incoming.fromEmail);
  } catch (e) {
    log(`background chat delivery from ${incoming.fromEmail} failed: ${e.message || e}`);
  } finally {
    deliveryInFlight.delete(key);
  }
}

// chatStore/peerEmail are both optional (see startCallFromIdentity's
// comment -- a manually-built call link has no identity to key a store to).
// When present: past history for this contact is loaded and rendered
// before any live message, every send/receive is persisted (encrypted,
// Lamport-ordered), and a message recorded by this SAME
// identity's OTHER open tab (via chatStore's BroadcastChannel) also renders
// live here if it's for this same conversation.
function setupChatChannel(channel, localHasCamera, chatStore, peerEmail) {
  const ackWaiter = createAckWaiter(); // CADS-webconference-demo#21 -- see createAckWaiter's own comment
  if (chatStore && peerEmail) {
    chatStore.history(peerEmail).then((history) => {
      for (const m of history) addChatMessage(m.text, m.from);
    });
    chatStore.onMessage((msg) => {
      if (msg.peerEmail === peerEmail.toLowerCase()) addChatMessage(msg.text, msg.from);
    });
  }
  channel.addEventListener('open', () => {
    chatInput.disabled = false;
    chatSend.disabled = false;
    addChatMessage('chat connected (real WebRTC data channel, DTLS-encrypted)', 'system');
    if (!localHasCamera) channel.send(NO_CAMERA_SENTINEL);
    flushOutbox(chatStore, peerEmail, (payload) => channel.send(payload), ackWaiter);
  });
  channel.addEventListener('close', () => {
    chatInput.disabled = true;
    chatSend.disabled = true;
  });
  channel.addEventListener('message', async (ev) => {
    if (ev.data === NO_CAMERA_SENTINEL) {
      addChatMessage('Your peer joined without a working camera/microphone -- that\'s why you can\'t see or hear them, not a bug.', 'system');
      remoteEmpty.textContent = 'peer has no camera';
      return;
    }
    // JSON envelope carries the sender's Lamport seq so record({received:true})
    // can preserve causal order -- tolerate a plain-text payload too (e.g. an
    // older/manual-link peer with no chatStore of its own) by just showing it.
    let parsed;
    try {
      parsed = JSON.parse(ev.data);
    } catch (_) {
      addChatMessage(ev.data, 'peer');
      return;
    }
    if (parsed.ack != null) {
      ackWaiter.resolve(parsed.ack);
      return;
    }
    const { seq, text } = parsed;
    addChatMessage(text, 'peer');
    if (chatStore && peerEmail && seq != null) {
      // CADS-webconference-demo#43 (finding 2) -- see backgroundChatSession's
      // matching comment. Used to send the ack (and not even await record()
      // at all) before persisting; persist first now, ack only once that
      // succeeds.
      await chatStore.record({ peerEmail, from: 'peer', text, seq, received: true });
      channel.send(JSON.stringify({ ack: seq }));
    }
  });
  chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = chatInput.value.trim();
    if (!text || channel.readyState !== 'open') return;
    if (chatStore && peerEmail) {
      const seq = await chatStore.nextSeqForSend();
      // CADS-webconference-demo#44: used to record(...) with pending left
      // at its default (false, i.e. "delivered") immediately after send(),
      // the same silent-loss class #21 already fixed for the outbox path --
      // a channel/tab/network death in the small window between send()
      // succeeding locally and the peer actually persisting the message
      // marked it delivered and dropped it for good, with no retry. Record
      // pending, same as the outbox does, and only flip it once the peer's
      // own {ack:seq} reply actually arrives -- a dead channel before that
      // just leaves it in the outbox for the normal background-delivery
      // sweep to pick up later, instead of losing it.
      chatStore.record({ peerEmail, from: 'me', text, seq, pending: true });
      channel.send(JSON.stringify({ seq, text }));
      ackWaiter.wait(seq).then(() => chatStore.markDelivered(peerEmail, seq)).catch(() => {});
    } else {
      channel.send(JSON.stringify({ text }));
    }
    addChatMessage(text, 'me');
    chatInput.value = '';
  });
}

// Instantiated once identity is known so the chat list can show last-message
// previews (chatStore.history()) even before any call has been placed this
// session -- a separate instance from run()'s call-scoped one (different
// module load, this page never reaches run()'s call-setup path at all until
// a call actually starts and reloads into it). Set via setDialerChatStore
// from runDialer (app.js, its only reassignment site -- see this
// consolidation's own "setter for anything reassigned outside its new
// module" pattern, first established in contacts.js).
let dialerChatStore = null;
function setDialerChatStore(v) { dialerChatStore = v; }

export {
  createAckWaiter,
  flushOutbox,
  BACKGROUND_CHAT_WINDOW_MS,
  fileTransferWindowMs,
  connectBackgroundChannel,
  backgroundChatSession,
  deliveryInFlight,
  tryBackgroundDeliver,
  autoAcceptChatDelivery,
  setupChatChannel,
  dialerChatStore,
  setDialerChatStore,
};
