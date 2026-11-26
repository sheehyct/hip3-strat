"use strict";

// xyz perp symbol -> the real listed instrument it tracks.
//
// SOURCE OF TRUTH is the deployer's own specification index, transcribed into
// docs/XYZ_ROSTER_UNDERLYING_MAP_2026-08-01.md. This table is GENERATED from
// that document and a test re-parses the document to assert they still agree
// (the same drift-gate pattern the STRAT-CORE extraction uses). Edit the
// DOCUMENT, then regenerate - do not hand-edit entries here.
//
// NEVER infer an underlying from an xyz ticker. Several actively mislead:
// XYZ100 is the Nasdaq-100, DRAM is an equity ETF rather than a memory-price
// index, STRC is a Strategy Inc preferred and NOT MSTR common, SMSN tracks the
// KRX ordinary rather than the LSE GDR whose symbol it borrows, and SKHX/SKHY
// are two non-interchangeable listings of SK hynix.
//
// `usFetchable` marks the 64 of 88 symbols reachable from Massive's US stocks
// API (us_equity, us_etf, adr). The other 24 need a venue or an asset class we
// have not bought: 9 Asian equities across five exchanges, 8 commodities,
// 4 indices, 3 FX pairs. Korea and Japan intraday is not purchasable from any
// surveyed vendor at a sane price, so those are deferred, not solved.
//
// `caveat` marks symbols where the ticker resolves but the SERIES needs care.
// These are the ones that produce confident wrong numbers rather than errors.

const UNDERLYING = {
  "XYZ100": { ticker: null, cat: "index", usFetchable: false },
  "TSLA": { ticker: "TSLA", cat: "us_equity", usFetchable: true },
  "NVDA": { ticker: "NVDA", cat: "us_equity", usFetchable: true },
  "GOLD": { ticker: null, cat: "commodity", usFetchable: false },
  "HOOD": { ticker: "HOOD", cat: "us_equity", usFetchable: true },
  "INTC": { ticker: "INTC", cat: "us_equity", usFetchable: true },
  "PLTR": { ticker: "PLTR", cat: "us_equity", usFetchable: true },
  "COIN": { ticker: "COIN", cat: "us_equity", usFetchable: true },
  "META": { ticker: "META", cat: "us_equity", usFetchable: true },
  "AAPL": { ticker: "AAPL", cat: "us_equity", usFetchable: true },
  "MSFT": { ticker: "MSFT", cat: "us_equity", usFetchable: true },
  "ORCL": { ticker: "ORCL", cat: "us_equity", usFetchable: true },
  "GOOGL": { ticker: "GOOGL", cat: "us_equity", usFetchable: true },
  "AMZN": { ticker: "AMZN", cat: "us_equity", usFetchable: true },
  "AMD": { ticker: "AMD", cat: "us_equity", usFetchable: true },
  "MU": { ticker: "MU", cat: "us_equity", usFetchable: true },
  "SNDK": { ticker: "SNDK", cat: "us_equity", usFetchable: true },
  "MSTR": { ticker: "MSTR", cat: "us_equity", usFetchable: true },
  "CRCL": { ticker: "CRCL", cat: "us_equity", usFetchable: true },
  "NFLX": { ticker: "NFLX", cat: "us_equity", usFetchable: true },
  "COST": { ticker: "COST", cat: "us_equity", usFetchable: true },
  "LLY": { ticker: "LLY", cat: "us_equity", usFetchable: true },
  "SKHX": { ticker: null, cat: "asia_equity", usFetchable: false },
  "TSM": { ticker: "TSM", cat: "adr", usFetchable: true },
  "JPY": { ticker: null, cat: "fx", usFetchable: false },
  "EUR": { ticker: null, cat: "fx", usFetchable: false },
  "SILVER": { ticker: null, cat: "commodity", usFetchable: false },
  "RIVN": { ticker: "RIVN", cat: "us_equity", usFetchable: true },
  "BABA": { ticker: "BABA", cat: "adr", usFetchable: true },
  "CL": { ticker: null, cat: "commodity", usFetchable: false },
  "COPPER": { ticker: null, cat: "commodity", usFetchable: false },
  "NATGAS": { ticker: null, cat: "commodity", usFetchable: false },
  "SMSN": { ticker: null, cat: "asia_equity", usFetchable: false },
  "PLATINUM": { ticker: null, cat: "commodity", usFetchable: false },
  "USAR": { ticker: "USAR", cat: "us_equity", usFetchable: true },
  "CRWV": { ticker: "CRWV", cat: "us_equity", usFetchable: true },
  "URNM": { ticker: "URNM", cat: "us_etf", usFetchable: true },
  "PALLADIUM": { ticker: null, cat: "commodity", usFetchable: false },
  "GME": { ticker: "GME", cat: "us_equity", usFetchable: true },
  "KR200": { ticker: null, cat: "index", usFetchable: false },
  "SOFTBANK": { ticker: null, cat: "asia_equity", usFetchable: false },
  "JP225": { ticker: null, cat: "index", usFetchable: false },
  "HYUNDAI": { ticker: null, cat: "asia_equity", usFetchable: false },
  "KIOXIA": { ticker: null, cat: "asia_equity", usFetchable: false },
  "EWY": { ticker: "EWY", cat: "us_etf", usFetchable: true },
  "EWJ": { ticker: "EWJ", cat: "us_etf", usFetchable: true },
  "BRENTOIL": { ticker: null, cat: "commodity", usFetchable: false },
  "HIMS": { ticker: "HIMS", cat: "us_equity", usFetchable: true },
  "SP500": { ticker: null, cat: "index", usFetchable: false },
  "DKNG": { ticker: "DKNG", cat: "us_equity", usFetchable: true },
  "LITE": { ticker: "LITE", cat: "us_equity", usFetchable: true },
  "XLE": { ticker: "XLE", cat: "us_etf", usFetchable: true },
  "BX": { ticker: "BX", cat: "us_equity", usFetchable: true },
  "PURRDAT": { ticker: "PURR", cat: "us_equity", usFetchable: true,
    caveat: "trades as PURR; the DAT suffix only disambiguates it from the PURR memecoin." },
  "MRVL": { ticker: "MRVL", cat: "us_equity", usFetchable: true },
  "RKLB": { ticker: "RKLB", cat: "us_equity", usFetchable: true },
  "BIRD": { ticker: "BIRD", cat: "us_equity", usFetchable: true,
    caveat: "entity change with NO gap - pre-April-2026 bars are Allbirds the shoe company, not the GPU lessor. Continuity analysis CANNOT catch this." },
  "DRAM": { ticker: "DRAM", cat: "us_etf", usFetchable: true,
    caveat: "the Roundhill Memory ETF, not a memory-price index." },
  "CBRS": { ticker: "CBRS", cat: "us_equity", usFetchable: true },
  "EWZ": { ticker: "EWZ", cat: "us_etf", usFetchable: true },
  "ZM": { ticker: "ZM", cat: "us_equity", usFetchable: true },
  "EBAY": { ticker: "EBAY", cat: "us_equity", usFetchable: true },
  "ARM": { ticker: "ARM", cat: "adr", usFetchable: true },
  "EWT": { ticker: "EWT", cat: "us_etf", usFetchable: true },
  "GBP": { ticker: null, cat: "fx", usFetchable: false },
  "SPCX": { ticker: "SPCX", cat: "us_equity", usFetchable: true,
    caveat: "ticker reuse - a flat ~$23 SPAC trust until 2026-04-06, then SpaceX from the 2026-06-12 IPO. ALWAYS scope with analyzeContinuity()." },
  "ASML": { ticker: "ASML", cat: "adr", usFetchable: true },
  "MINIMAX": { ticker: null, cat: "asia_equity", usFetchable: false },
  "BB": { ticker: "BB", cat: "us_equity", usFetchable: true },
  "QNT": { ticker: "QNT", cat: "us_equity", usFetchable: true },
  "DELL": { ticker: "DELL", cat: "us_equity", usFetchable: true },
  "IBM": { ticker: "IBM", cat: "us_equity", usFetchable: true },
  "AVGO": { ticker: "AVGO", cat: "us_equity", usFetchable: true },
  "NOW": { ticker: "NOW", cat: "us_equity", usFetchable: true },
  "NBIS": { ticker: "NBIS", cat: "us_equity", usFetchable: true },
  "WDC": { ticker: "WDC", cat: "us_equity", usFetchable: true },
  "NOK": { ticker: "NOK", cat: "adr", usFetchable: true },
  "SMH": { ticker: "SMH", cat: "us_etf", usFetchable: true },
  "BE": { ticker: "BE", cat: "us_equity", usFetchable: true },
  "ZHIPU": { ticker: null, cat: "asia_equity", usFetchable: false },
  "QCOM": { ticker: "QCOM", cat: "us_equity", usFetchable: true },
  "STRC": { ticker: "STRC", cat: "us_equity", usFetchable: true,
    caveat: "a Strategy Inc PREFERRED, not MSTR common. Different price series; vendor issuer names match for both, so name-checking will not save you." },
  "BOT": { ticker: "BOT", cat: "us_equity", usFetchable: true },
  "AMAT": { ticker: "AMAT", cat: "us_equity", usFetchable: true },
  "GIGADEV": { ticker: null, cat: "asia_equity", usFetchable: false },
  "SHAZ": { ticker: "SHAZ", cat: "us_equity", usFetchable: true },
  "SKHY": { ticker: "SKHY", cat: "adr", usFetchable: true,
    caveat: "the Nasdaq ADS of SK hynix. SKHX is the KRX ordinary - different currency, hours and history. Not interchangeable." },
  "CXMT": { ticker: null, cat: "asia_equity", usFetchable: false }
};

const CATEGORIES = ["us_equity", "us_etf", "adr", "asia_equity", "commodity", "index", "fx"];

// Look up one xyz symbol. Accepts either the bare symbol ("TSLA") or the
// universe-prefixed coin name the worker uses internally ("xyz:TSLA"), because
// callers hold it in both forms and silently returning null for the prefixed
// form would look like "no underlying" rather than "wrong argument".
function lookup(symbol) {
  if (typeof symbol !== "string" || !symbol) return null;
  const bare = symbol.indexOf(":") >= 0 ? symbol.slice(symbol.indexOf(":") + 1) : symbol;
  const hit = Object.prototype.hasOwnProperty.call(UNDERLYING, bare) ? UNDERLYING[bare] : null;
  if (!hit) return null;
  return {
    xyzSymbol: bare,
    ticker: hit.ticker,
    cat: hit.cat,
    usFetchable: hit.usFetchable,
    caveat: hit.caveat || null
  };
}

// Every symbol we can currently fetch bars for, as xyz symbols.
function fetchableSymbols() {
  return Object.keys(UNDERLYING).filter(function (s) { return UNDERLYING[s].usFetchable; });
}

module.exports = { UNDERLYING, CATEGORIES, lookup, fetchableSymbols };
