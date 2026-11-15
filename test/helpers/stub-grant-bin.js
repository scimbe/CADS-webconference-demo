#!/usr/bin/env node
// CADS-webconference-demo#175: a stand-in for ct-video-call-grant (a separately
// compiled Rust binary this repo doesn't build in CI) so tests can exercise
// /api/call, /api/attest, and the play lifecycle without it. Mimics only the
// shape mintGrants()/mintPlayGrants() in bridge/server.js actually parse: a
// `key=value` line per field, and a channel id that's the SAME for a given
// holder-pubkey PAIR regardless of which one is passed first -- matching the
// real binary's documented channel_id_for_link behavior that CADS-webconference-
// demo#158 depends on. Not real cryptography; never use this for anything but
// a local test process.
const crypto = require('crypto');

const args = process.argv.slice(2);
const [holderA, holderB] = args;
const pairKey = [holderA, holderB].sort().join(':');

function hash(label) {
  return crypto.createHash('sha256').update(`${label}:${pairKey}`).digest('hex');
}

console.log(`channel_id_hex=${hash('channel')}`);
console.log(`grant_a_hex=${hash('grant_a')}`);
console.log(`grant_b_hex=${hash('grant_b')}`);
console.log(`operator_public_hex=${hash('operator')}`);
