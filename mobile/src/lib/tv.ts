// TradingView chart handoff - the scanner's symbol rule plus the SKHX
// alias, ported verbatim from the dashboard's tvSymbol/tvHref.
//
// The rule: always link the PERP listing, never the underlying (a
// basis-shifted underlying chart puts every entry/stop/target level in the
// wrong place) and never a spot tokenized-stock listing (TSLAUSDC spot exists
// on TV and is a DIFFERENT instrument). xyz builder-dex perps list under the
// HIP3XYZ exchange prefix as {SYM}USDC.P; main-dex perps under HYPERLIQUID,
// where plain uppercase covers the k-prefixed names (kPEPE -> KPEPEUSDC.P).
// Verified 2026-08-31 against TradingView's public symbol-search API,
// 279/280 exact plus the one alias below.

import type { Coin } from "./api";

// The ONE roster symbol whose TV listing name differs from its scanner sym:
// xyz:SKHX tracks SK hynix on the KRX and TV lists it as
// HIP3XYZ:SKHYNIXUSDC.P - SKHXUSDC.P does not exist. xyz:SKHY (the separate
// Nasdaq-ADS perp) matches the generic rule and needs no entry. Keyed by
// coin.name so a future main-dex SKHX could never collide. The alias ships
// with the rule as one unit.
const TV_ALIAS: Record<string, string> = { "xyz:SKHX": "SKHYNIX" };

// Mirror of the dashboard's coinUni: the served uni wins; an older worker
// omits it, so fall back to the name's dex prefix ("xyz:SKHX" -> "xyz"),
// bare name = main dex.
function coinUni(coin: Coin): string {
  if (coin.uni) return coin.uni;
  return coin.name.indexOf(":") >= 0 ? coin.name.split(":")[0] : "perps";
}

export function tvSymbol(coin: Coin): string {
  return (
    (coinUni(coin) === "xyz" ? "HIP3XYZ" : "HYPERLIQUID") +
    ":" +
    (TV_ALIAS[coin.name] || coin.sym.toUpperCase()) +
    "USDC.P"
  );
}

export function tvHref(coin: Coin): string {
  return "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(tvSymbol(coin));
}
