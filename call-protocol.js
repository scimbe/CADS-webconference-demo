// Wire-protocol constants for the direct-channel media transport (the
// experimental WebRTC alternative that tunnels audio/video/chat through the
// already-encrypted Noise_IK Agent-Fabric channel -- see call-channel.js's
// own header comment for the full design). Pure data, no logic, imported by
// every module that reads or writes this transport's tagged-frame envelope
// (1-byte tag + payload, sent via writeFramed(stream, noiseTransport.encrypt(bytes))).
const TAG_MEDIA_INIT = 1;
const TAG_MEDIA_CHUNK = 2;
const TAG_CHAT = 3;
const TAG_BYE = 4;
// CADS-webconference-demo#50: same tagged-frame pattern as TAG_MEDIA_*
// above (used for the experimental video path) -- FILE_INIT carries a
// small JSON header (seq/name/mimeType/size) as a text frame, FILE_CHUNK
// carries raw chunked bytes, reassembled by total size on the receiving
// end exactly like TAG_MEDIA_CHUNK already is.
const TAG_FILE_INIT = 5;
const TAG_FILE_CHUNK = 6;
// CADS-webconference-demo (live-reported): attemptChannelFallback below
// decides to switch to the direct-channel transport based purely on THIS
// side's own pc.connectionState -- with no way for the peer to find out.
// On an asymmetric ICE failure (only one side's path actually breaks,
// common on a flaky mobile link -- the other side's connectionState can
// stay 'connected' the whole time) that left the two sides speaking two
// totally incompatible wire formats over the same shared Noise channel:
// the webrtc side kept sending wasm.decodeSignalMessage-encoded SDP/ICE/bye
// frames, while the fallen-back side was reading raw TAG_* bytes. A real
// SignalMessage's first byte is never expected to equal a live TAG_*
// value, so those frames were just silently swallowed by the fallen-back
// side's tag dispatch (no matching `if`, no error) instead of erroring --
// meaning a peer that had already fallen back never saw remote video AND
// never even saw the other side's eventual 'bye' (only noticed the peer
// was gone once the socket itself closed, well after the ICE_RESTART_GRACE_MS
// + CHANNEL_RECONNECT_GRACE_MS timeouts had to run their course). This one
// raw byte -- checked before wasm.decodeSignalMessage is even called, so it
// never needs to understand this tag -- is sent by whichever side decides
// to fall back, BEFORE it tears down its own pc, so the peer switches into
// channel mode in lockstep instead of being left behind on the old protocol.
const TAG_FALLBACK = 7;
// 25MB: a well-known, widely-recognized web-app attachment ceiling (the
// same order of magnitude as Gmail's own long-standing attachment limit) --
// generous for a real file/image/document, small enough that a chunked
// transfer over a relayed channel finishes in a reasonable time instead of
// minutes.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const FILE_CHUNK_BYTES = 49152; // matches TAG_MEDIA_CHUNK's own chunk size below

export {
  TAG_MEDIA_INIT,
  TAG_MEDIA_CHUNK,
  TAG_CHAT,
  TAG_BYE,
  TAG_FILE_INIT,
  TAG_FILE_CHUNK,
  TAG_FALLBACK,
  MAX_FILE_BYTES,
  FILE_CHUNK_BYTES,
};
