'use strict';
// The /api/media-fallback decision (automatic WebRTC -> direct-channel switch,
// client side in ../ice-watchdog.js), kept pure so it can be unit-tested.
//
// - enabled: ONLY for a gate-verified account (verifiedEmail, from X-Gate-Email).
// - timeoutMs: the deployment's limit (WEBCONFERENCE_ICE_FALLBACK_TIMEOUT_MS).
// - planTimeoutMs: extension point for "subscribers first". Today nothing
//   passes it -- there is no subscription claim or role the gate forwards
//   (only the e-mail). Once a plan signal exists (e.g. a gate header), server.js
//   maps it to a limit and passes it here. It can only SHORTEN the limit for a
//   signed-in account: never switch the feature on without one, never lengthen it.
const MIN_TIMEOUT_MS = 3000; // same floor ice-watchdog.js clamps to

function mediaFallbackDecision({ verifiedEmail, defaultTimeoutMs, planTimeoutMs = null }) {
  const enabled = !!verifiedEmail;
  let timeoutMs = defaultTimeoutMs;
  let reason = enabled ? 'account' : 'no_account';
  const plan = Number(planTimeoutMs);
  if (enabled && planTimeoutMs !== null && Number.isFinite(plan) && plan > 0 && plan < defaultTimeoutMs) {
    timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.round(plan));
    reason = 'plan';
  }
  return { enabled, timeoutMs, reason };
}

module.exports = { mediaFallbackDecision };
