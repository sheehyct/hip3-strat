// Client for the scanner worker's /api/state endpoint.
//
// IMPORTANT (project contract): all STRAT detection runs SERVER-SIDE in the
// worker's vendored STRAT core. This app renders that output; it must never
// grow its own bar classification or pattern logic (no third implementation).
//
// The same rule now covers DISPLAY math: formatters and predicates come from
// the vendored DISPLAY-CORE block (./display_core), never hand-written here.

import { noteAlertScope } from "./alert_scope";
import { noteServerDisplayVersion } from "./display_parity";
import { noteServedState } from "./state_cache";

export type LiveSig = {
  name: string;
  dir: "up" | "down";
  entry: number;
  stop: number;
  target: number | null;
  kind: "rev" | "cont";
  // 1-3 Rev Strat is born ON the 3, so the TF-level invalidated flag does not
  // kill it. Consumers exempt it (mirrors the worker's rules.js predicate
  // `an.invalidated && !l.rev3`). Optional: older workers omit it.
  rev3?: boolean;
};

export type Setup = {
  name: string;
  dir: "up" | "down";
  trigger: number;
  stop: number;
  target: number | null;
  kind: "rev" | "cont" | "info";
};

export type TFState = {
  types: (string | null)[];
  formingType: string | null;
  formingDir: "up" | "down" | "flat" | null;
  live: LiveSig[];
  setups: Setup[];
  invalidated: boolean;
  forming: { t: number; T: number; o: number; h: number; l: number; c: number } | null;
  // Additive 2026-08-15: the last closed bar's completed pattern and the MoMo
  // hammer/shooter shape - the two analyzeTF outputs that were not serialized
  // before the dashboard went worker-authoritative. null = the analyzer had
  // none; absent (older worker) = unknown, render nothing. The shape is
  // display-tier context, never a live entry.
  completed?: { name: string; dir: string; cont: boolean } | null;
  shape?: { type: string; confirming: boolean } | null;
};

// The worker serves two coin universes: the HIP-3 "xyz" builder dex and the
// main-dex "perps" set. Fields below are OPTIONAL so the app still typechecks
// (and renders) against an older single-universe worker that omits them.
export type UniverseId = "xyz" | "perps";

export type Coin = {
  name: string;
  sym: string;
  uni?: UniverseId;         // which universe this coin belongs to (additive)
  cat?: string | null;      // worker-served category (perps only; null for xyz,
                            // absent on older workers -> local fallback map)
  // Worker-retained 15m closes plus the live mid, oldest first. Optional so
  // older workers remain renderable while the sparkline UI collects data.
  spark?: number[] | null;
  mid: number | null;
  chg24: number | null;
  // Day %: mid vs the open of the current UTC day's 1d candle (00:00 UTC),
  // served since 2026-08-04. null = that candle is missing or has not rolled
  // - UNKNOWN, never zero; absent (older worker) likewise. The worker decides
  // null; the app never derives it. Differs from chg24 (the exchange's
  // prevDayPx window) and can disagree on sign, so both stay labelled.
  chgUtc?: number | null;
  vol: number;
  funding: number;
  // Venue max leverage (worker apistate.js: finite and > 0, else null).
  // null or absent = UNKNOWN, and unknown never passes the Lev >= filter.
  maxLeverage?: number | null;
  // score and ftfc are NULL while a coin is unready (new listing mid-backfill,
  // worker boot) - the worker stopped serving fake-neutral 0/"mixed" on
  // 2026-08-15. Null means "no reading yet", never neutral; render "-" and
  // sink in sorts, exactly like a null rvol.
  score: number | null;
  // rvol is served for xyz coins; PERPS rows are ALWAYS null since 2026-08-17
  // (the volume true-up runs only for alert universes). Same rendering rule
  // as a young coin: "-", never 0.
  rvol: number | null;
  premium: number | null;   // mark vs oracle, fraction
  mark: number | null;
  oracle: number | null;
  oiUsd: number | null;     // open interest notional in USD
  ftfc: "up" | "down" | "mixed" | null;
  dots: string[];
  // Per-coin readiness (additive 2026-08-15). Absent on older workers =
  // unknown; false = the worker is still backfilling missingTfs for this coin
  // and score/ftfc are null rather than fake-neutral.
  ready?: boolean;
  missingTfs?: string[];
  mom: { r5: number | null; r15: number | null; r30: number | null; r60: number | null };
  liveCount: number;
  setupCount: number;
  tf: Record<string, TFState>;
  // Additive 2026-08-30/31 (consumed by the Command-card list since
  // 2026-09-01). All optional: an older worker omits
  // them, and absent = unknown = render nothing.
  //
  // prov: what the perp TRACKS and its US cash-session state, from the
  // worker's generated map + NYSE calendar. kind null = unmapped (never a
  // guess); us_session null = no US cash session for this kind. Render these
  // fields verbatim - never a client-side market calendar.
  prov?: { kind: string | null; us_session: "rth" | "closed" | null } | null;
  // The perp's move since the prior scheduled US cash close. null = no
  // usable reference, NEVER zero.
  overnight_change_pct?: number | null;
  // Score deltas over the worker's 30s ring (restart-honest: all-null for up
  // to an hour after a redeploy). Each window null = not yet covered or an
  // endpoint score was null; render null as blank, never 0.
  scoreDelta?: {
    m5: ScoreDeltaWindow | null;
    m15: ScoreDeltaWindow | null;
    h1: ScoreDeltaWindow | null;
  } | null;
  // The slow continuity layer as the worker rolls it up (metrics.js
  // dwmContinuity): per-TF forming directions for 1d/1w/1M and whether all
  // three agree. Additive 2026-09-02, consumed by the portfolio continuity
  // line and stamps. Absent on older workers = unknown, render nothing.
  dwmContinuity?: {
    complete: boolean;
    dir: "up" | "down" | null;
    dots: Record<string, string | null>;
  } | null;
};

export type ScoreDeltaWindow = {
  signed: number;              // score_now - score_then
  mag: number;                 // abs(now) - abs(then)
  flip: "up" | "down" | null;  // sign crossing
  rank: number | null;         // rank_then - rank_now within the universe
};

export type ApiState = {
  ts: number;
  loaded: boolean;
  ftfcTfs: string[];
  coins: Coin[];
  universes?: UniverseId[]; // advertised universes (additive; may be absent)
  // Hash of the worker's DISPLAY-CORE block. Optional: a worker predating the
  // 2026-08-06 stamp omits it, and absent means "cannot compare", not "stale".
  display_v?: string;
  // Alert scope (additive). alertUniverses: which universes the worker alerts
  // on at all ([] is a REAL value - alerting on nothing; never coalesce it).
  // alert_favs_universes: universes that alert ONLY for push-registered
  // favorites. Absent (older worker) = unknown - render nothing, never warn.
  alertUniverses?: string[];
  alert_favs_universes?: string[];
  // Worker feed ages at payload-build time (additive 2026-08-16): ms since
  // the worker loop's last successful mids/candles fetch, per requested
  // universe; null = never fetched. Absent (older worker) = unknown - fall
  // back to receipt time, never warn. These answer "when did the WORKER last
  // hear from the exchange"; the app's own fetch clock only answers "when did
  // I last hear from the worker", and only the former shows numbers going
  // stale while polling still succeeds.
  midsAgeMs?: number | null;
  candlesAgeMs?: number | null;
  // Continuity ledger (additive 2026-09-24): present ONLY when the worker
  // records served continuity for POST /api/continuity_at; `since` is the
  // first sample it still holds. Absent = the worker serves no ledger.
  continuity_ledger?: { since: number | null; sample_ms: number };
};

// The scanner worker's own default (127.0.0.1:8787). On a phone "localhost"
// is the phone itself: enter the worker's reachable address in Settings.
export const DEFAULT_WORKER_URL = "http://localhost:8787";

// Universe selector: display order + labels (mirrors TF_ORDER's idiom). The
// default is "xyz" - the original HIP-3 builder dex this app was built around.
export const UNIVERSES: { id: UniverseId; label: string }[] = [
  { id: "xyz", label: "HIP-3 xyz" },
  { id: "perps", label: "Crypto perps" },
];

// Display order + labels for the worker's timeframes.
export const TF_ORDER: { id: string; label: string }[] = [
  { id: "15m", label: "15m" },
  { id: "30m", label: "30m" },
  { id: "1h", label: "1H" },
  { id: "4h", label: "4H" },
  { id: "1d", label: "D" },
  { id: "1w", label: "W" },
  { id: "1M", label: "M" },
];

// `uni` filters the payload SERVER-SIDE (~200KB xyz / ~500KB perps vs ~720KB
// unfiltered), so the 15s mobile-data poll only carries the selected universe.
// An older worker ignores the query param and returns everything; the caller
// still filters client-side by coin.uni (belt and suspenders).
export async function fetchState(baseUrl: string, uni?: UniverseId): Promise<ApiState> {
  const q = uni ? "?uni=" + encodeURIComponent(uni) : "";
  const r = await fetch(baseUrl.replace(/\/+$/, "") + "/api/state" + q);
  if (!r.ok) throw new Error("worker HTTP " + r.status);
  const state = (await r.json()) as ApiState;
  // Single choke point for the display-math parity check: every consumer polls
  // through here, so no screen can forget it. Warn-only by design - see
  // display_parity.ts on why a skew must not fail the fetch.
  noteServerDisplayVersion(state.display_v);
  // Same choke-point idiom for the worker's alert scope (Settings renders it).
  noteAlertScope(state.alertUniverses, state.alert_favs_universes);
  // And for the portfolio side's read of a coin's CURRENT served continuity.
  noteServedState(state, uni);
  return state;
}

// Display math lives in the vendored DISPLAY-CORE block (./display_core), which
// is the dashboard's own code byte-for-byte. Re-exported here so the existing
// call sites keep importing from the module they already do; display_core.js is
// the home, and hand-writing a second copy is what these re-exports prevent.
//
// magProgress:      percent of the trigger-to-target distance travelled by mid.
// sigInForce:       price still holds beyond entry during the open bar - and
//                   unknown inputs count as IN FORCE (see display_core.d.ts).
// distToTargetPct:  remaining move to target as a % of CURRENT price.
// magRemaining:     % of the trigger-to-target span still untraveled.
export { distToTargetPct, magProgress, magRemaining, sigInForce } from "./display_core";
