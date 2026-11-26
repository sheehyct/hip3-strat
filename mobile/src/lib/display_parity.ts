// Runtime parity check for the vendored DISPLAY-CORE block.
//
// The worker serves `display_v` on /api/state: sha256 (first 16 hex) of its
// marker-delimited DISPLAY-CORE block, LF-normalized. We vendor the same block
// (src/lib/display_core.js) and record the same hash at vendor time
// (display_core.v.json, written and gated by scripts/check-display-core.js).
//
// Comparing the two is the ONLY check that catches "correct in git, stale on
// the phone" - an OTA that shipped before the block changed, or a device still
// on an older update. A build-time gate cannot see that, because by then the
// build is already on someone's handset. React Native has no fs and no
// node:crypto, so the local side has to be a build-time stamp rather than a
// hash computed live; check-display-core.js is what keeps that stamp honest.
//
// A mismatch is a WARNING, never a failure. The app still renders: the worker
// owns all detection and the payload contract is additive, so a display-math
// skew is a cosmetic divergence from the dashboard, not bad data. Failing shut
// would turn a formatting drift into an outage.

import stamp from "./display_core.v.json";

/** Hash of the DISPLAY-CORE block vendored into this build. */
export const DISPLAY_V_LOCAL: string = stamp.display_v;

// null until a payload arrives; stays null against a worker too old to stamp.
let serverVersion: string | null = null;
// Warn once per distinct server value, not once per 15s poll.
const warned = new Set<string>();

export type DisplayParity = {
  local: string;
  /** null = no payload yet, or a worker that does not serve display_v. */
  server: string | null;
  /** null = nothing to compare against yet - NOT a mismatch. */
  match: boolean | null;
};

/** Record the worker's display_v from a /api/state payload and warn on drift. */
export function noteServerDisplayVersion(version: string | null | undefined): void {
  if (typeof version !== "string" || version.length === 0) return;
  serverVersion = version;
  if (version === DISPLAY_V_LOCAL || warned.has(version)) return;
  warned.add(version);
  console.warn(
    "[display-core] version mismatch: this build vendors " + DISPLAY_V_LOCAL +
      ", the worker serves " + version + ". Display math (price formatting, " +
      "magnitude, the in-force predicate) may disagree with the dashboard " +
      "until this app is re-vendored and shipped.",
  );
}

export function getDisplayParity(): DisplayParity {
  return {
    local: DISPLAY_V_LOCAL,
    server: serverVersion,
    match: serverVersion === null ? null : serverVersion === DISPLAY_V_LOCAL,
  };
}
