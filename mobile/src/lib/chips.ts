// Main-list signal chips (the expanded card's roster). Display aggregation over
// server output only. Every value comes from /api/state and every rule below
// is the vendored sigChips'.
import type { ChipTone } from "@/components/ui";

import { Coin, LiveSig, Setup, sigInForce, TF_ORDER } from "./api";

export type SignalChip = { label: string; tone: ChipTone; dim?: boolean };

/**
 * Mirrors the vendored sigChips (display_core.js) element for element:
 * optional allow(tf, sig) scoping applied FIRST, an echo-dedup ledger where
 * EVERY live signal claims tf|name|dir up front, live chips deduped by that
 * key, cap 4, "+N" from the allow-filtered RAW live length, then up to 3
 * NAMED setup chips skipping ledger-claimed keys and "+N setups" over the
 * echo-FILTERED list. sigChips emits HTML, so this is the one place mobile
 * must re-express vendored logic natively rather than call it - keep the two
 * readable side by side.
 *
 * SCOPE (design decision): the dashboard feeds sigChips from the
 * user's toggled timeframes; this app has no TF toggle, so it feeds ALL of
 * them. That keeps 30m/W/M signals visible on a phone with no way to toggle
 * them back on. The chips and the count now come from ONE walk - the version
 * this replaces drew chips from all 7 timeframes but read "+N" off the worker's
 * liveCount, which covers only the four FTFC timeframes, so a coin whose extra
 * signals lived on 30m/W/M hid them with no indicator at all.
 *
 * `allow` mirrors the block's third parameter: which patterns a user trades is
 * UI state, deliberately outside the vendored math. Absent renders everything,
 * so existing one-argument callers are unchanged.
 *
 * Still absent vs the dashboard: the magnitude bar inside a live chip
 * (divergence matrix (b)9).
 */
export function buildSignalChips(
  coin: Coin,
  allow?: (tf: string, sig: LiveSig | Setup) => boolean,
): SignalChip[] {
  // sum.live / sum.setupList, built the way metrics.js coinSummary builds them:
  // every live signal in TF display order, then reversal-kind setups only.
  let live: { tf: string; sig: LiveSig; invalidated: boolean }[] = [];
  let setupList: { tf: string; sig: Setup }[] = [];
  for (const { id, label } of TF_ORDER) {
    const an = coin.tf[id];
    if (!an) continue;
    for (const sig of an.live)
      // rev3 (1-3 Rev Strat) is BORN on the 3, so the TF-level invalidation is
      // its birth event, not its death; exempt it (worker rules.js does the same).
      live.push({ tf: label, sig, invalidated: an.invalidated && sig.rev3 !== true });
    for (const sig of an.setups) if (sig.kind === "rev") setupList.push({ tf: label, sig });
  }
  // Scoping first - before the dedup ledger and BOTH overflow counts - so no
  // count ever advertises a chip the scope suppressed (sigChips' own order).
  if (allow) {
    live = live.filter((v) => allow(v.tf, v.sig));
    setupList = setupList.filter((v) => allow(v.tf, v.sig));
  }

  // Echo-dedup ledger: EVERY live signal claims its slot up front (not just
  // the four that render), so a fired setup never re-renders as a setup chip
  // below. Keys carry dir because 1-2-2 and PMG use one name for both
  // directions.
  const seen = new Set<string>();
  for (const l of live) seen.add(l.tf + "|" + l.sig.name + "|" + l.sig.dir);

  const out: SignalChip[] = [];
  const drawn = new Set<string>();
  for (let i = 0; i < live.length && out.length < 4; i++) {
    const l = live[i], key = l.tf + "|" + l.sig.name + "|" + l.sig.dir;
    if (drawn.has(key)) continue;
    drawn.add(key);
    out.push({
      label: l.tf + " " + l.sig.name +
        (l.invalidated ? " INVAL" : l.sig.kind === "cont" ? " CONT" : " LIVE"),
      tone: l.invalidated ? "warn" : l.sig.dir === "up" ? "bull" : "bear",
      // Recrossed the entry level -> dimmed. Only consulted when the chip is
      // not already saying INVAL, exactly as sigChips orders it. The same
      // predicate feeds the SCORE server-side, so a bright chip on a recrossed
      // signal was mobile disagreeing with its own score (divergence (e)3).
      dim: l.invalidated ? false : !sigInForce(l.sig, coin.mid),
    });
  }
  // Raw length, not the deduped count - sigChips' own arithmetic for the LIVE
  // overflow (the setups overflow below counts its filtered list instead).
  if (live.length > 4) out.push({ label: "+" + (live.length - 4), tone: "muted" });
  // Named setups echo-filtered FIRST, and "+N setups" counts the FILTERED
  // list, so the count never advertises chips the dedup suppressed.
  const named = setupList.filter(
    (s) => !seen.has(s.tf + "|" + s.sig.name + "|" + s.sig.dir),
  );
  for (let n = 0; n < named.length && n < 3; n++)
    out.push({ label: named[n].tf + " " + named[n].sig.name, tone: "muted" });
  if (named.length > 3)
    out.push({ label: "+" + (named.length - 3) + " setups", tone: "muted" });
  return out;
}
