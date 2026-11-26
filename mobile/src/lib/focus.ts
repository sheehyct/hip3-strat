// Matched-signal row model for the main list - the dashboard's Command view
// (hip3_strat_screener.html: simpleItems, simpleCandidate, simpleFocusRank,
// simpleProgressRank, targetRankItem, simpleDistRank, simpleMagLeftRank,
// slowLayer, slowFtfcRank, provText) re-expressed natively, one function per
// dashboard function so the two stay readable side by side.
//
// Display aggregation over server output only: every signal, level and bar
// direction comes from /api/state, and every piece of math comes from the
// vendored DISPLAY-CORE block (magProgress, sigInForce, distToTargetPct,
// magRemaining). Nothing here classifies a bar or detects a pattern.
//
// SCOPE (a design decision, same as chips.ts): the dashboard
// feeds these from the user's TOGGLED timeframes; this app has no TF toggle,
// so it feeds ALL seven. Logic mirrored exactly, scope departs. (The Sig TF
// FILTER is a different control - it narrows which of the seven MATCH; see
// matchedItems.)
import {
  Coin, distToTargetPct, LiveSig, magProgress, magRemaining, Setup, sigInForce, TF_ORDER,
  UniverseId,
} from "./api";
import { Filters, itemMatches, sigDimsActive, sigStage } from "./filters";
import { patFamily } from "./patterns";

export type FocusStatus = "live" | "cont" | "setup" | "inval";

// One entry of the dashboard's simpleItems(): a signal with the lifecycle
// status the Command row shows. `tf` is the TF LABEL ("15m", "D").
export type FocusItem = {
  tf: string;
  sig: LiveSig | Setup;
  status: FocusStatus;
  // Other MATCHING items on this coin (the "+N more" the row prints). Set on
  // the candidate only.
  more: number;
};

// simpleItems(): every live signal in TF display order (inval / cont / live
// by the worker's flags), then reversal-kind setups, deduped by tf|name|dir.
export function focusItems(coin: Coin): FocusItem[] {
  const out: FocusItem[] = [];
  const seen = new Set<string>();
  const add = (tf: string, sig: LiveSig | Setup, status: FocusStatus) => {
    const key = tf + "|" + sig.name + "|" + sig.dir;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ tf, sig, status, more: 0 });
  };
  for (const { id, label } of TF_ORDER) {
    const an = coin.tf[id];
    if (!an) continue;
    for (const l of an.live) {
      // rev3 (1-3 Rev Strat) is BORN on the 3 - the TF-level invalidation is
      // its birth event, not its death (worker coinSummary does the same).
      const inval = an.invalidated && l.rev3 !== true;
      add(label, l, inval ? "inval" : l.kind === "cont" ? "cont" : "live");
    }
  }
  for (const { id, label } of TF_ORDER) {
    const an = coin.tf[id];
    if (!an) continue;
    for (const st of an.setups) if (st.kind === "rev") add(label, st, "setup");
  }
  return out;
}

// sigStage over the vendored predicates. Only a "live" item consults them,
// exactly as the dashboard's sigStage short-circuits.
export function focusStage(item: FocusItem, mid: number | null) {
  const live = item.status === "live";
  return sigStage(
    item.status,
    live ? sigInForce(item.sig as LiveSig, mid) : true,
    live ? magProgress(item.sig as LiveSig, mid) : null,
  );
}

// matchedItems(): the items that MATCH the active signal dimensions (dir, sig
// TF, pattern family, stage) - all of them when none is active. THE threading
// point: the card shows the first of THESE, so a coin never qualifies on a
// signal it does not show (the dashboard's rule).
export function matchedItems(coin: Coin, f: Filters): FocusItem[] {
  const items = focusItems(coin);
  if (!sigDimsActive(f)) return items;
  return items.filter((it) =>
    itemMatches(f, {
      tf: it.tf, dir: it.sig.dir, family: patFamily(it.sig.name), stage: focusStage(it, coin.mid),
    }),
  );
}

// simpleCandidate(): exactly ONE ranker - status priority live > cont >
// setup > inval, first match in TF display order within a status. "+N more"
// counts the other MATCHING items, not the coin's whole signal population.
const STATUS_ORDER: FocusStatus[] = ["live", "cont", "setup", "inval"];
export function focusCandidate(items: FocusItem[]): FocusItem | null {
  for (const status of STATUS_ORDER) {
    const item = items.find((it) => it.status === status);
    if (item) return { ...item, more: Math.max(0, items.length - 1) };
  }
  return null;
}

// simpleFocusRank(): the "Signal" sort. 0 for a coin with no item - a real
// rank, not a null, so such coins order at the bottom descending and the top
// ascending, exactly as the dashboard does.
export function focusRank(item: FocusItem | null): number {
  if (!item) return 0;
  return item.status === "live" ? 4 : item.status === "cont" ? 3 : item.status === "setup" ? 2 : 1;
}

// The level the row prints as E: a setup's trigger, a signal's entry.
export function focusEntry(item: FocusItem): number | null {
  const v = item.status === "setup" ? (item.sig as Setup).trigger : (item.sig as LiveSig).entry;
  return v != null && Number.isFinite(v) ? v : null;
}

// In-force reading for the row's dimming. Setups and INVAL items are never
// "out of force" (they are saying something else), so those return true -
// mirrors the `item.status !== "setup" && item.status !== "inval" &&
// !sigInForce(...)` guard in simpleRowHTML.
export function focusInForce(item: FocusItem, mid: number | null): boolean {
  if (item.status === "setup" || item.status === "inval") return true;
  return sigInForce(item.sig as LiveSig, mid);
}

// simpleProgressRank(): the Progress sort quantity. Only live/cont items
// carry a magnitude; setups (% to trigger) and INVAL are not comparable on
// the same axis and return null so they sink in both directions.
export function focusProgress(item: FocusItem | null, mid: number | null): number | null {
  if (!item || item.status === "setup" || item.status === "inval") return null;
  return magProgress(item.sig as LiveSig, mid);
}

// A setup's distance to its trigger as a % of price. The dashboard hand-writes
// this in simpleProgressHTML (outside the DISPLAY-CORE block), so it is
// mirrored verbatim here rather than re-derived: `Math.abs(trigger-mid)/mid*100`,
// "-" when mid is falsy or the trigger is not finite.
export function setupAwayPct(item: FocusItem, mid: number | null): number | null {
  if (item.status !== "setup") return null;
  const trigger = (item.sig as Setup).trigger;
  if (!mid || trigger === null || trigger === undefined || !isFinite(trigger)) return null;
  return Math.abs(trigger - mid) / mid * 100;
}

// targetRankItem(): the To Target gate - IN-FORCE live/cont
// items only. A setup's distance would include the untriggered gap, and an
// out-of-force signal is not "already occurring"; both return null and sink.
export function targetItem(item: FocusItem | null, mid: number | null): FocusItem | null {
  if (!item || item.status === "setup" || item.status === "inval") return null;
  if (!sigInForce(item.sig as LiveSig, mid)) return null;
  return item;
}

// simpleDistRank(): remaining % of PRICE to target (cross-coin comparable).
export function focusDist(item: FocusItem | null, mid: number | null): number | null {
  const it = targetItem(item, mid);
  return it ? distToTargetPct(it.sig, mid) : null;
}

// simpleMagLeftRank(): % of the trigger-to-target span untraveled.
export function focusMagLeft(item: FocusItem | null, mid: number | null): number | null {
  const it = targetItem(item, mid);
  return it ? magRemaining(it.sig as LiveSig, mid) : null;
}

// slowLayer(): the D/W/M forming directions - the Structure cell's slow
// layer (the fast layer is the coin's own dots). Missing slot or null
// direction reads "flat" (unknown), exactly the dashboard's fallback.
export type SlowLayer = { dirs: string[]; up: number; known: number };
export function slowLayer(coin: Coin): SlowLayer {
  let up = 0, known = 0;
  const dirs = ["1d", "1w", "1M"].map((id) => {
    const an = coin.tf[id];
    const d = an && an.formingDir ? an.formingDir : "flat";
    if (d === "up") up++;
    if (d !== "flat") known++;
    return d;
  });
  return { dirs, up, known };
}

// slowFtfcRank(): orders by ups, ties broken by fewer downs - the quantity
// the cell prints (display and sort must read
// the same layer).
export function slowFtfcRank(coin: Coin): number {
  const s = slowLayer(coin);
  return s.up * 4 + (3 - (s.known - s.up));
}

// provText(): identity line 2 - what this perp tracks and its cash-session
// state, from the worker-served prov field. Labels verbatim from the
// dashboard's PROV_KIND_LABEL. With no prov (older worker) the perps universe
// still reads "Crypto" by the name rule the dashboard applies standalone;
// xyz stays silent rather than guessing.
const PROV_KIND_LABEL: Record<string, string> = {
  us_equity: "US equity", us_etf: "US ETF", adr: "ADR", index: "Index",
  commodity: "Commodity", fx: "FX", asia_equity: "Asia equity", crypto: "Crypto",
};
export function provText(coin: Coin, universe: UniverseId): string {
  const p = coin.prov;
  const kind = p ? p.kind : universe === "perps" ? "crypto" : null;
  if (!kind || !PROV_KIND_LABEL[kind]) return "";
  const session = kind === "crypto" ? "24/7"
    : p && p.us_session === "rth" ? "RTH open"
    : p && p.us_session === "closed" ? "US closed" : "";
  return PROV_KIND_LABEL[kind] + (session ? " \u00b7 " + session : "");
}
