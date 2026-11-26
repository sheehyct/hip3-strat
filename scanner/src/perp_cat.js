// GENERATED FILE - DO NOT HAND-EDIT.
// Extracted verbatim from hip3_strat_screener.html (PERP-CAT block)
// by scripts/extract_core.js. The dashboard is the single source of truth.
// Regenerate: npm run extract    Verify (CI anti-drift): npm run extract:check
"use strict";
// ==== PERP-CAT-BEGIN ====
// Category map for main-dex perps (Hyperliquid-style grouping). The public
// info API does not expose HL's UI categories, so this is a maintained static
// map - unmapped symbols (e.g. new listings) fall into "other".
// SINGLE SOURCE OF TRUTH: the worker extracts this block into
// src/perp_cat.js (npm run extract / extract:check) and
// serves a per-coin `cat` in /api/state, so client apps read the
// category from the payload instead of keeping their own copies. Extend the
// map HERE only.
var PERP_CAT = {
  BTC:"majors", ETH:"majors",
  SOL:"l1", AVAX:"l1", ADA:"l1", DOT:"l1", ATOM:"l1", NEAR:"l1", APT:"l1", SUI:"l1",
  SEI:"l1", TIA:"l1", TON:"l1", TRX:"l1", XRP:"l1", BNB:"l1", HYPE:"l1", INJ:"l1",
  KAS:"l1", HBAR:"l1", ALGO:"l1", ICP:"l1", XLM:"l1", LTC:"l1", BCH:"l1", ETC:"l1",
  FIL:"l1", S:"l1", FTM:"l1", BERA:"l1", MOVE:"l1", EGLD:"l1", CELO:"l1", MINA:"l1",
  KAVA:"l1", DYM:"l1", SAGA:"l1", ZETA:"l1",
  ARB:"l2", OP:"l2", STRK:"l2", ZK:"l2", MNT:"l2", POL:"l2", MATIC:"l2", IMX:"l2",
  BLAST:"l2", SCR:"l2", TAIKO:"l2", MANTA:"l2", STX:"l2",
  UNI:"defi", AAVE:"defi", CRV:"defi", LDO:"defi", MKR:"defi", SNX:"defi", COMP:"defi",
  SUSHI:"defi", PENDLE:"defi", ENA:"defi", ETHFI:"defi", JUP:"defi", RAY:"defi",
  DYDX:"defi", GMX:"defi", LINK:"defi", ONDO:"defi", EIGEN:"defi", MORPHO:"defi",
  AERO:"defi", CAKE:"defi", RUNE:"defi", JTO:"defi", USUAL:"defi", FXS:"defi",
  "1INCH":"defi", YFI:"defi",
  TAO:"ai", FET:"ai", RENDER:"ai", WLD:"ai", AI16Z:"ai", VIRTUAL:"ai", AIXBT:"ai",
  GRASS:"ai", IO:"ai", GRIFFAIN:"ai", ZEREBRO:"ai",
  DOGE:"meme", kPEPE:"meme", kBONK:"meme", kSHIB:"meme", kFLOKI:"meme", kNEIRO:"meme",
  WIF:"meme", MEW:"meme", POPCAT:"meme", FARTCOIN:"meme", PNUT:"meme", MOODENG:"meme",
  SPX:"meme", TRUMP:"meme", MELANIA:"meme", TURBO:"meme", BRETT:"meme", GOAT:"meme",
  CHILLGUY:"meme", HIPPO:"meme", BOME:"meme", MYRO:"meme", PENGU:"meme", DOGS:"meme",
  PURR:"meme",
  GALA:"gaming", SAND:"gaming", MANA:"gaming", AXS:"gaming", APE:"gaming",
  PIXEL:"gaming", YGG:"gaming", ILV:"gaming", BIGTIME:"gaming", XAI:"gaming",
  RON:"gaming", BEAM:"gaming", NOT:"gaming", PRIME:"gaming"
};
// ==== PERP-CAT-END ====

module.exports = { PERP_CAT };
