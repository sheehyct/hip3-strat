// Hand-written types for the vendored DISPLAY-CORE block (display_core.js).
//
// TYPES ONLY. No behaviour is restated here - TypeScript reads this file
// instead of the .js, so a signature that lies about the block is the one way
// this vendoring can still drift. Keep every declaration a direct reading of
// display_core.js, and re-read that file after `npm run display:sync`.
//
// Shapes are declared structurally rather than imported from ./api so the
// vendored module stays a leaf: api.ts re-exports from here, and a type import
// pointing back would make the dependency read as circular to a future reader.
//
// Availability on this surface, from /api/state's payload:
//   fmtPx, magProgress, sigInForce,
//   distToTargetPct, magRemaining   USABLE - the whole point of vendoring.
//   chg24                           NOT USABLE - needs coin.ctx (the raw
//                                   Hyperliquid asset context). The worker
//                                   already applies it and serves coin.chg24.
//   tfPct                           NOT USABLE - needs slot.closed[], and
//                                   /api/state serves only types[]/forming.
//                                   Blocked on a worker payload addition.
//   esc, starSpan, sigChips         HTML emitters; unusable on React Native.
//                                   Reference semantics for native renderers.

/** HTML-escape. Web-only; React Native has no HTML sink. */
export declare function esc(s: unknown): string;

/**
 * Price formatting. Decimals step 1 / 2 / 2 / 3 / 5 at 10000 / 1000 / 100 / 1.
 * The >= 10000 branch is the one mobile's hand-written copy was missing.
 */
export declare function fmtPx(x: number | null | undefined): string;

/** Raw Hyperliquid asset context, as the dashboard holds it (strings from the API). */
export type DisplayCtx = {
  prevDayPx?: number | string | null;
  markPx?: number | string | null;
};

/** 24h change from the exchange's own prevDayPx reference. Needs coin.ctx (see header). */
export declare function chg24(coin: { ctx?: DisplayCtx | null; mid?: number | null }): number | null;

/** Forming close vs the last CLOSED bar's close on that timeframe. Needs slot.closed (see header). */
export declare function tfPct(
  coin: { mid: number | null; tf: Record<string, { closed: { c: number }[] } | undefined> },
  tfId: string,
): number | null;

/**
 * A signal as the display math reads it. `entry` is preferred and `trigger` is
 * the fallback, so one shape covers both live signals and pending setups.
 */
export type DisplaySignal = {
  dir: "up" | "down";
  entry?: number | null;
  trigger?: number | null;
  stop?: number | null;
  target: number | null;
};

/**
 * Percent of the trigger-to-target distance travelled; the negative leg is
 * scaled to the stop instead (-100% = at the stop). Null when there is no
 * usable target reference, and when mid is 0 / absent / non-finite.
 */
export declare function magProgress(
  sig: DisplaySignal,
  mid: number | null | undefined,
): number | null;

/**
 * Remaining distance to target as a % of CURRENT price - the cross-coin
 * comparable "how much move is left". Positive = target ahead, 0 = at it,
 * negative = beyond. Null without a finite mid AND target. Status/in-force
 * gating is the CALLER's job (lifecycle status lives outside the block).
 */
export declare function distToTargetPct(
  sig: Pick<DisplaySignal, "dir" | "target">,
  mid: number | null | undefined,
): number | null;

/**
 * Complement of magProgress on its POSITIVE leg only: % of the
 * trigger-to-target span still untraveled. Null when magProgress is null and
 * on the negative leg (that leg is stop-scaled - a complement would mix units).
 */
export declare function magRemaining(
  sig: DisplaySignal,
  mid: number | null | undefined,
): number | null;

/**
 * THE in-force predicate: price still holds beyond entry during the open bar.
 * Separate from the entry EVENT, which is monotonic and cannot untrigger.
 *
 * UNKNOWN INPUTS RETURN TRUE. No mid, mid of 0, or a non-finite entry all count
 * as in force, because dimming on missing data would overstate what we know.
 * Consumers must mirror that, not "helpfully" treat unknown as out of force.
 */
export declare function sigInForce(
  sig: { dir: "up" | "down"; entry: number },
  mid: number | null | undefined,
): boolean;

/** Favorites star markup. Reads the dashboard's isFav global - THROWS here. Never call. */
export declare function starSpan(name: string): string;

/** One entry of the dashboard's per-coin live-signal summary. `tf` is the TF LABEL ("15m", "D"). */
export type ChipLive = {
  tf: string;
  sig: DisplaySignal & { name: string; kind?: "rev" | "cont" };
  invalidated: boolean;
};

/**
 * One entry of the dashboard's per-coin setup summary. Reversal-kind setups
 * only. `dir` is read by the echo-dedup ledger (`tf|name|dir` keys).
 */
export type ChipSetup = { tf: string; sig: { name: string; dir: "up" | "down" } };

/**
 * Main-list signal chips as HTML. Web-only OUTPUT, but the LOGIC is the spec
 * mobile's native chip row must mirror: optional `allow(tf, sig)` scoping
 * applied FIRST (absent = render everything); an echo-dedup ledger where
 * EVERY live signal claims `tf|name|dir` up front; live chips deduped by that
 * same key, cap 4, "+N" from the allow-filtered RAW live length; magnitude on
 * non-invalidated chips, dim via sigInForce; then up to 3 NAMED setup chips
 * skipping ledger-claimed keys, and "+N setups" over the echo-FILTERED list.
 */
export declare function sigChips(
  sum: { live: ChipLive[]; setupList: ChipSetup[] },
  mid: number | null | undefined,
  allow?: (tf: string, sig: ChipLive["sig"] | ChipSetup["sig"]) => boolean,
): string;
