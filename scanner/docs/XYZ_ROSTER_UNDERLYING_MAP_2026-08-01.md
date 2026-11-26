# HIP-3 "xyz" dex roster -> real-world underlying map

> STATUS: reference table, compiled 2026-08-01. It is the
> ticker-to-underlying reference for any xyz work, and
> `src/underlying_map.js` is generated from it (a test re-parses this file).
>
> READ THIS BEFORE USING THE TABLE: several xyz tickers actively mislead, and
> a wrong mapping would silently corrupt a score rather than fail loudly.
> XYZ100 is the Nasdaq-100, DRAM is an equity ETF and not a memory-price
> index, STRC is a Strategy Inc preferred and not MSTR common, SMSN tracks the
> KRX ordinary rather than the LSE GDR it is named after, and SKHX / SKHY are
> two non-interchangeable listings of SK hynix. Section (c) lists every cell
> that rests on inference rather than the deployer's own statement.
>
> The roster is a SNAPSHOT. The dex carried 103 markets on the compile date;
> the 15 not covered here are listed in the final appendix.

Date compiled: 2026-08-01. Roster as supplied: 88 symbols.

## Primary sources

1. **trade[XYZ] official docs, Specification Index** -
   https://docs.trade.xyz/consolidated-resources/specification-index
   This is the deployer's own per-market contract spec. For nearly every market
   it states verbatim what the perp tracks, including the local exchange code
   and the FX conversion. This is the authoritative source and is what most
   rows below rest on.
2. **Hyperliquid info API** (`POST https://api.hyperliquid.xyz/info`,
   `{"type":"meta","dex":"xyz"}`) - confirms the live on-chain roster. All 88
   supplied symbols are live. The dex now carries 103 markets; the 15 not in
   the supplied list are noted at the end.
3. **Stooq quote pages** (keyless) - used to confirm symbol resolution and the
   vendor's instrument name.
4. Company/exchange/IPO press for listing venue and listing date.

## How to read the Stooq column

The Stooq **CSV** endpoint (`/q/d/l/?s=...&i=d`) returned `Access denied` from
this environment on every attempt - it is IP-blocked for datacenter ranges, not
symbol-dependent. Stooq also fronts the whole site with a SHA-256
proof-of-work JS challenge, which had to be solved before any request
succeeded. Verification was therefore done against the **quote page**
(`/q/?s=...`), which resolves the same symbol namespace and returns the
instrument's name; a bad symbol falls through to the symbol-search page (this
was controlled for with a deliberate junk symbol).

After roughly 70 successful probes the IP was rate-limited into the challenge
loop, so a tail of intended probes could not be completed.

- `YES` - probed on the compile date, resolved, name matched.
- `NO` - probed on the compile date, did NOT resolve (server returned the
  symbol-search page, same response as the known-bad control).
- `untested` - not probed before the block. The symbol given follows the
  Stooq convention verified on sibling symbols but is NOT confirmed.

**Stooq conventions confirmed on the compile date:** US `aapl.us`; Japan `9984.jp`;
Shanghai `603986.cn` (note: `.ss` does NOT work); FX `eurusd` / `usdjpy` /
`gbpusd`; metals `xauusd` / `xagusd`; indices `^ndq` (Nasdaq Composite),
`^nkx` (Nikkei 225), `^kospi` (KOSPI).

**Confirmed NOT covered by Stooq:** Korean equities (`005930`, `000660`,
`005380` all failed against `.kr`, `.ks`, `.kq`, `.kos`), Hong Kong equities
(`0700.hk` failed), Taiwan equities (`2330.tw` failed), and `^spx`.

## The table

| # | Ticker | Underlying full name | Primary listing exchange | Yahoo-style | Stooq | Category | Conf | Stooq resolved |
|---|--------|----------------------|--------------------------|-------------|-------|----------|------|----------------|
| 1 | XYZ100 | Nasdaq-100 Index (deployer-branded "XYZ100 Index" for licensing reasons) | Nasdaq (index) | `^NDX` | `^ndx` | index | high | untested (`^ndq` = Composite, resolved, but is NOT this index) |
| 2 | TSLA | Tesla, Inc. | Nasdaq | `TSLA` | `tsla.us` | us_equity | high | YES |
| 3 | NVDA | NVIDIA Corporation | Nasdaq | `NVDA` | `nvda.us` | us_equity | high | YES |
| 4 | GOLD | Gold spot, 1 troy ounce (XAU/USD) | OTC / LBMA | `GC=F` (futures proxy) | `xauusd` | commodity | high | YES |
| 5 | HOOD | Robinhood Markets, Inc. | Nasdaq | `HOOD` | `hood.us` | us_equity | high | YES |
| 6 | INTC | Intel Corporation | Nasdaq | `INTC` | `intc.us` | us_equity | high | YES |
| 7 | PLTR | Palantir Technologies Inc. | Nasdaq | `PLTR` | `pltr.us` | us_equity | high | YES |
| 8 | COIN | Coinbase Global, Inc. | Nasdaq | `COIN` | `coin.us` | us_equity | high | YES |
| 9 | META | Meta Platforms, Inc. | Nasdaq | `META` | `meta.us` | us_equity | high | YES |
| 10 | AAPL | Apple Inc. | Nasdaq | `AAPL` | `aapl.us` | us_equity | high | YES |
| 11 | MSFT | Microsoft Corporation | Nasdaq | `MSFT` | `msft.us` | us_equity | high | YES |
| 12 | ORCL | Oracle Corporation | NYSE | `ORCL` | `orcl.us` | us_equity | high | YES |
| 13 | GOOGL | Alphabet Inc. Class A | Nasdaq | `GOOGL` | `googl.us` | us_equity | high | YES |
| 14 | AMZN | Amazon.com, Inc. | Nasdaq | `AMZN` | `amzn.us` | us_equity | high | YES |
| 15 | AMD | Advanced Micro Devices, Inc. | Nasdaq | `AMD` | `amd.us` | us_equity | high | YES |
| 16 | MU | Micron Technology, Inc. | Nasdaq | `MU` | `mu.us` | us_equity | high | YES |
| 17 | SNDK | Sandisk Corporation | Nasdaq | `SNDK` | `sndk.us` | us_equity | high | YES |
| 18 | MSTR | Strategy Inc (fmr MicroStrategy), common stock | Nasdaq | `MSTR` | `mstr.us` | us_equity | high | YES |
| 19 | CRCL | Circle Internet Group, Inc. | NYSE | `CRCL` | `crcl.us` | us_equity | high | YES |
| 20 | NFLX | Netflix, Inc. | Nasdaq | `NFLX` | `nflx.us` | us_equity | high | YES |
| 21 | COST | Costco Wholesale Corporation | Nasdaq | `COST` | `cost.us` | us_equity | high | YES |
| 22 | LLY | Eli Lilly and Company | NYSE | `LLY` | `lly.us` | us_equity | high | YES |
| 23 | SKHX | SK hynix Inc. - **KRX ordinary share**, KRW converted to USD | Korea Exchange | `000660.KS` | none (not covered) | asia_equity | high | NO (Korea absent from Stooq) |
| 24 | TSM | Taiwan Semiconductor Manufacturing Co. Ltd., ADS | NYSE | `TSM` | `tsm.us` | adr | high | YES |
| 25 | JPY | USD/JPY exchange rate | OTC interbank | `JPY=X` | `usdjpy` | fx | high | YES |
| 26 | EUR | EUR/USD exchange rate | OTC interbank | `EURUSD=X` | `eurusd` | fx | high | YES |
| 27 | SILVER | Silver spot, 1 troy ounce (XAG/USD) | OTC / LBMA | `SI=F` (futures proxy) | `xagusd` | commodity | high | YES |
| 28 | RIVN | Rivian Automotive, Inc. | Nasdaq | `RIVN` | `rivn.us` | us_equity | high | YES |
| 29 | BABA | Alibaba Group Holding Ltd., ADS | NYSE | `BABA` | `baba.us` | adr | high | YES |
| 30 | CL | WTI Light Sweet Crude Oil, 1 barrel (docs name: WTIOIL) | NYMEX | `CL=F` | `cl.f` | commodity | high | untested |
| 31 | COPPER | Copper, 1 pound | COMEX | `HG=F` | `hg.f` | commodity | high | untested |
| 32 | NATGAS | Henry Hub Natural Gas, 1 MMBtu | NYMEX | `NG=F` | `ng.f` | commodity | high | untested |
| 33 | SMSN | Samsung Electronics Co., Ltd. - **KRX ordinary share**, KRW converted to USD (ticker borrows the LSE GDR symbol; the underlying is NOT the GDR) | Korea Exchange | `005930.KS` | none (not covered) | asia_equity | high | NO (Korea absent from Stooq) |
| 34 | PLATINUM | Platinum spot, 1 troy ounce (XPT/USD) | OTC | `PL=F` (futures proxy) | `xptusd` | commodity | high | untested |
| 35 | USAR | USA Rare Earth, Inc. | Nasdaq | `USAR` | `usar.us` | us_equity | high | YES |
| 36 | CRWV | CoreWeave, Inc. | Nasdaq | `CRWV` | `crwv.us` | us_equity | high | YES |
| 37 | URNM | Sprott Uranium Miners ETF | NYSE Arca | `URNM` | `urnm.us` | us_etf | high | YES |
| 38 | PALLADIUM | Palladium spot, 1 troy ounce (XPD/USD) | OTC | `PA=F` (futures proxy) | `xpdusd` | commodity | high | untested |
| 39 | GME | GameStop Corp. | NYSE | `GME` | `gme.us` | us_equity | high | YES |
| 40 | KR200 | KOSPI 200 Index (docs: "Korea 200", KRW-denominated, quanto) | Korea Exchange | `^KS200` | none verified | index | high | NO (`^kospi` resolves but is the broad KOSPI, a DIFFERENT index) |
| 41 | SOFTBANK | SoftBank Group Corp. | Tokyo Stock Exchange | `9984.T` | `9984.jp` | asia_equity | high | YES |
| 42 | JP225 | Nikkei 225 Index (JPY-denominated, quanto) | Osaka / Nikkei Inc. | `^N225` | `^nkx` | index | high | YES |
| 43 | HYUNDAI | Hyundai Motor Company | Korea Exchange | `005380.KS` | none (not covered) | asia_equity | high | NO (Korea absent from Stooq) |
| 44 | KIOXIA | Kioxia Holdings Corporation | Tokyo Stock Exchange | `285A.T` | `285a.jp` | asia_equity | high | YES |
| 45 | EWY | iShares MSCI South Korea ETF | NYSE Arca | `EWY` | `ewy.us` | us_etf | high | YES |
| 46 | EWJ | iShares MSCI Japan ETF | NYSE Arca | `EWJ` | `ewj.us` | us_etf | high | YES |
| 47 | BRENTOIL | Brent Crude Oil, 1 barrel | ICE | `BZ=F` | `brn.f` | commodity | high | untested |
| 48 | HIMS | Hims & Hers Health, Inc. | NYSE | `HIMS` | `hims.us` | us_equity | high | YES |
| 49 | SP500 | S&P 500 Index | S&P Dow Jones / CME | `^GSPC` | none verified | index | high | NO (`^spx` did not resolve) |
| 50 | DKNG | DraftKings Inc. | Nasdaq | `DKNG` | `dkng.us` | us_equity | high | YES |
| 51 | LITE | Lumentum Holdings Inc. | Nasdaq | `LITE` | `lite.us` | us_equity | high | YES |
| 52 | XLE | Energy Select Sector SPDR Fund | NYSE Arca | `XLE` | `xle.us` | us_etf | high | YES |
| 53 | BX | Blackstone Inc. | NYSE | `BX` | `bx.us` | us_equity | high | YES |
| 54 | PURRDAT | Hyperliquid Strategies Inc. - a HYPE digital-asset-treasury company. **"DAT" suffix only disambiguates it from the PURR memecoin; the underlying is the Nasdaq common stock, ticker PURR** | Nasdaq | `PURR` | `purr.us` | us_equity | high | untested |
| 55 | MRVL | Marvell Technology, Inc. | Nasdaq | `MRVL` | `mrvl.us` | us_equity | high | YES |
| 56 | RKLB | Rocket Lab Corporation | Nasdaq | `RKLB` | `rklb.us` | us_equity | high | YES |
| 57 | BIRD | NewBird AI - i.e. Allbirds, Inc. mid-rebrand (sold the footwear business, pivoting to GPU-as-a-Service). Same listed security throughout | Nasdaq | `BIRD` | `bird.us` | us_equity | high | untested |
| 58 | DRAM | **Roundhill Memory ETF** - an equity ETF of memory-semiconductor companies. **NOT a DRAM spot/contract price index** | Cboe BZX | `DRAM` | `dram.us` | us_etf | high | untested |
| 59 | CBRS | Cerebras Systems Inc. Class A | Nasdaq | `CBRS` | `cbrs.us` | us_equity | high | untested |
| 60 | EWZ | iShares MSCI Brazil ETF | NYSE Arca | `EWZ` | `ewz.us` | us_etf | high | YES |
| 61 | ZM | Zoom Communications, Inc. | Nasdaq | `ZM` | `zm.us` | us_equity | high | YES |
| 62 | EBAY | eBay Inc. | Nasdaq | `EBAY` | `ebay.us` | us_equity | high | YES |
| 63 | ARM | Arm Holdings plc, ADS | Nasdaq | `ARM` | `arm.us` | adr | high | YES |
| 64 | EWT | iShares MSCI Taiwan ETF | NYSE Arca | `EWT` | `ewt.us` | us_etf | high | YES |
| 65 | GBP | GBP/USD exchange rate | OTC interbank | `GBPUSD=X` | `gbpusd` | fx | high | YES |
| 66 | SPCX | Space Exploration Technologies Corp. (SpaceX) Class A | Nasdaq | `SPCX` | `spcx.us` | us_equity | high | untested |
| 67 | ASML | ASML Holding N.V., ADR / NY registry shares | Nasdaq | `ASML` | `asml.us` | adr | high | YES |
| 68 | MINIMAX | MiniMax Group Inc., Class A ordinary share, HKD converted to USD | HKEX | `0100.HK` | none (not covered) | asia_equity | high | NO (HK absent from Stooq) |
| 69 | BB | BlackBerry Limited (Canadian issuer; the perp references the US line) | NYSE (dual-listed TSX) | `BB` | `bb.us` | us_equity | high | YES |
| 70 | QNT | Quantinuum Inc. Class A (quantum computing; Honeywell-originated) | Nasdaq | `QNT` | `qnt.us` | us_equity | high | untested |
| 71 | DELL | Dell Technologies Inc. | NYSE | `DELL` | `dell.us` | us_equity | high | YES |
| 72 | IBM | International Business Machines Corporation | NYSE | `IBM` | `ibm.us` | us_equity | high | YES |
| 73 | AVGO | Broadcom Inc. | Nasdaq | `AVGO` | `avgo.us` | us_equity | high | YES |
| 74 | NOW | ServiceNow, Inc. | NYSE | `NOW` | `now.us` | us_equity | high | YES |
| 75 | NBIS | Nebius Group N.V. (Dutch issuer, Nasdaq-listed ordinary shares - not an ADR) | Nasdaq | `NBIS` | `nbis.us` | us_equity | high | YES |
| 76 | WDC | Western Digital Corporation | Nasdaq | `WDC` | `wdc.us` | us_equity | high | YES |
| 77 | NOK | Nokia Corporation (Nokia Oyj), ADR | NYSE | `NOK` | `nok.us` | adr | high | YES |
| 78 | SMH | VanEck Semiconductor ETF | Nasdaq | `SMH` | `smh.us` | us_etf | high | YES |
| 79 | BE | Bloom Energy Corporation | NYSE | `BE` | `be.us` | us_equity | high | YES |
| 80 | ZHIPU | Knowledge Atlas Technology Joint Stock Co. Ltd. (Zhipu AI / Z.ai), H share, HKD converted to USD | HKEX | `2513.HK` | none (not covered) | asia_equity | high | NO (HK absent from Stooq) |
| 81 | QCOM | QUALCOMM Incorporated | Nasdaq | `QCOM` | `qcom.us` | us_equity | high | YES |
| 82 | STRC | Strategy Inc **Variable Rate Series A Perpetual Stretch Preferred Stock** - a preferred security, NOT the MSTR common | Nasdaq | `STRC` | `strc.us` | us_equity | high | YES |
| 83 | BOT | RoboStrategy, Inc. - a publicly listed closed-end investment company holding private + public robotics/physical-AI names | Nasdaq | `BOT` | `bot.us` | us_equity | high | untested |
| 84 | AMAT | Applied Materials, Inc. | Nasdaq | `AMAT` | `amat.us` | us_equity | high | YES |
| 85 | GIGADEV | GigaDevice Semiconductor Inc., A-share, CNH converted to USD | Shanghai Stock Exchange | `603986.SS` | `603986.cn` | asia_equity | high | YES |
| 86 | SHAZ | SharonAI Holdings Inc. Class A (GPU neocloud) | Nasdaq | `SHAZ` | `shaz.us` | us_equity | high | untested |
| 87 | SKHY | SK hynix Inc. - **Nasdaq ADS**, USD-native | Nasdaq | `SKHY` | `skhy.us` | adr | high | untested |
| 88 | CXMT | ChangXin Technology Group Co., Ltd. (ChangXin Memory / CXMT), A-share, CNH converted to USD | Shanghai Stock Exchange STAR Market | `688825.SS` | `688825.cn` | asia_equity | high | untested |

---

## (a) Counts per category

| Category | Count |
|----------|-------|
| us_equity | 50 |
| asia_equity | 9 |
| us_etf | 8 |
| commodity | 8 |
| adr | 6 |
| index | 4 |
| fx | 3 |
| europe_equity | 0 |
| private_or_prelisting | 0 |
| synthetic_or_index_proprietary | 0 |
| unknown | 0 |
| **Total** | **88** |

---

## (b) Definitive NO-PUBLIC-UNDERLYING list

**The list is empty. All 88 symbols map to a real, publicly traded underlying.**

This is the single most surprising result of the exercise and it is worth
stating plainly, because the roster *looks* like it should contain private
names. It does not - a wave of 2026 IPOs closed every gap:

| Ticker | Looked private because | Actual status |
|--------|------------------------|---------------|
| SPCX | SpaceX was the canonical private mega-cap | IPO'd Nasdaq 2026-06-12 at $135/sh - the largest IPO ever |
| CBRS | Cerebras' IPO had been pending since 2024 | IPO'd Nasdaq 2026-05-14 at $185/sh |
| QNT | Quantinuum was a Honeywell-held private | IPO'd Nasdaq 2026-06-04 at $60/sh |
| CXMT | ChangXin was a state-backed private DRAM maker; the perp *launched* as an explicitly pre-IPO market at a ~526% premium | IPO'd Shanghai STAR 2026-07-27 (code 688825), +466% on debut |
| ZHIPU | Chinese "AI tiger", assumed private | IPO'd HKEX 2026-01-08, code 2513 |
| MINIMAX | Chinese "AI tiger", assumed private | IPO'd HKEX 2026-01-09, code 0100 |
| SHAZ | Unrecognizable ticker | SharonAI Holdings, IPO'd Nasdaq 2026-02-18 |
| BOT | Holds *private* robotics companies (Figure AI, Apptronik, ...) | The fund itself is public: RoboStrategy, Nasdaq: BOT since 2026-05-11. Its NAV is private-asset-driven but the security has ordinary daily bars |
| PURRDAT | Non-standard ticker | Hyperliquid Strategies Inc., Nasdaq: PURR since Dec 2025 |
| BIRD | "NewBird AI" is not a listed name | It is Allbirds, Inc. mid-rebrand. Same Nasdaq security, ticker BIRD, continuous history |
| USAR / SNDK / CRCL / LITE / BE / NBIS / CRWV | flagged as suspect before checking | All ordinary US listings; all seven verified resolving on Stooq on the compile date |

**Caveat that matters more than the empty list:** several underlyings exist but
have very little history. For a STRAT scanner this breaks weekly/monthly/
quarterly timeframes even though daily bars fetch fine. Ranked by severity as
of 2026-08-01:

| Ticker | Listed since | Approx trading days | Usable timeframes |
|--------|--------------|---------------------|-------------------|
| CXMT | 2026-07-27 | ~5 | daily only; no weekly structure yet |
| SKHY | 2026-07-10 | ~16 | daily, barely weekly |
| SPCX | 2026-06-12 | ~35 | daily/weekly; no monthly |
| QNT | 2026-06-04 | ~41 | daily/weekly; no monthly |
| CBRS | 2026-05-14 | ~56 | daily/weekly; ~2 monthly bars |
| BOT | 2026-05-11 | ~59 | daily/weekly; ~2 monthly bars |
| DRAM | 2026-04-02 | ~85 | daily/weekly; ~4 monthly bars |
| SHAZ | 2026-02-18 | ~115 | daily/weekly/monthly; no quarterly |
| MINIMAX | 2026-01-09 | ~140 | daily/weekly/monthly; ~2 quarterly |
| ZHIPU | 2026-01-08 | ~141 | daily/weekly/monthly; ~2 quarterly |
| PURR | 2025-12 | ~160 | daily/weekly/monthly; ~2-3 quarterly |

Also note **BIRD**: the security has long history as Allbirds, but the April
2026 business pivot means pre-April bars describe a shoe company, not a GPU
lessor. Continuity is legally intact; economically it is a different asset.

---

## (c) LOW CONFIDENCE - needs human confirmation

Nothing in the table is below `high` on the *identity* of the underlying,
because the deployer's own specification index states each mapping explicitly.
The residual risk is concentrated in these specific cells, and each one could
silently corrupt a score if wrong:

1. **XYZ100 -> Nasdaq-100.** trade.xyz never writes "Nasdaq" anywhere - almost
   certainly deliberate, since naming it would require an index licence. What
   the docs do say is "a modified market-capitalization-weighted index of 100
   of the largest, most actively-traded, non-financial companies that are
   listed on a U.S. stock exchange", which is the Nasdaq-100 methodology
   nearly verbatim, and the oracle leg is `NMU6` (a Nasdaq-100 futures code).
   OAK Research independently labels the market "NASDAQ 100". I am confident,
   but this is an inference from a description rather than a stated ticker, and
   it is the single highest-consequence inference in the table.
2. **KR200 vs the KOSPI.** KR200 is the **KOSPI 200**, not the broad KOSPI.
   Stooq's `^kospi` resolves and is tempting, but it is the wrong index. Do not
   substitute it.
3. **Stooq symbols marked `untested`** (rows 30, 31, 32, 34, 38, 47, 54, 57,
   58, 59, 66, 70, 83, 86, 87, 88, and `^ndx` for row 1). The convention is
   verified on sibling symbols but these exact strings were never confirmed,
   and the recent-IPO names in particular may simply not be in Stooq's
   universe yet. Re-probe from an unblocked IP before trusting them.
4. **MINIMAX = 0100.HK.** The trade.xyz spec states the company and the HKD
   conversion but *not* the stock code. 0100 comes from four independent
   finance sources plus the HKEX listing document. Solid, but not from the
   deployer.
5. **ETF listing venues** for URNM (NYSE Arca) and DRAM (Cboe BZX) are from
   secondary sources. Immaterial for data fetching, wrong-ish possible.
6. **BB categorized `us_equity`.** BlackBerry is a Canadian issuer dual-listed
   on NYSE and TSX. The perp references the US line, so `us_equity` is right
   for data-sourcing purposes, but it is not a US company.
7. **STRC is a preferred share, not common.** Anyone pattern-matching "STRC ~
   Strategy ~ MSTR" will get a completely different price series. Stooq
   correctly returns the issuer name "Strategy Inc" for *both* `mstr.us` and
   `strc.us`, so the vendor name is not a safe disambiguator here.

---

## (d) Non-US exchanges required, and how many symbols depend on each

Counting only markets whose oracle references a **non-US** listing or venue.
US-listed ADRs (TSM, BABA, ARM, ASML, NOK, SKHY) are deliberately **excluded** -
they need no foreign venue.

| Venue | Symbols | Count |
|-------|---------|-------|
| Korea Exchange (KRX) | SKHX, SMSN, HYUNDAI | 3 |
| Korea Exchange - index | KR200 (KOSPI 200) | 1 |
| Tokyo Stock Exchange | SOFTBANK (9984), KIOXIA (285A) | 2 |
| Shanghai Stock Exchange | GIGADEV (603986), CXMT (688825, STAR board) | 2 |
| Hong Kong Exchange (HKEX) | MINIMAX (0100), ZHIPU (2513) | 2 |
| Osaka / Nikkei Inc. - index | JP225 (Nikkei 225) | 1 |
| ICE (London) - futures | BRENTOIL | 1 |
| **Total symbols needing a non-US venue** | | **12** |

Rolled up by country, for vendor-shopping purposes:

| Country | Symbols | Count |
|---------|---------|-------|
| South Korea | SKHX, SMSN, HYUNDAI, KR200 | 4 |
| Japan | SOFTBANK, KIOXIA, JP225 | 3 |
| China (mainland A-shares) | GIGADEV, CXMT | 2 |
| Hong Kong | MINIMAX, ZHIPU | 2 |
| UK (ICE Brent) | BRENTOIL | 1 |

**Coverage problem:** Stooq covers **none** of the Korea, Hong Kong, or
Taiwan equity namespaces (verified by probe, not assumed). It does cover Japan
(`.jp`) and Shanghai (`.cn`), both confirmed. So of the 12 non-US-venue
symbols, Stooq can serve at most 4 outright (SOFTBANK, KIOXIA, JP225,
GIGADEV) plus CXMT if `688825.cn` exists. The remaining 7 - all four Korea
symbols and both Hong Kong symbols, plus Brent - need a different vendor.

Partial workaround worth noting: **EWY** (iShares MSCI South Korea) and
**EWJ** (iShares MSCI Japan) are already on the roster as US-listed ETFs and
are correlated proxies for the Korean and Japanese exposure. They are not
substitutes for single-name bars, but they are fetchable US symbols that cover
the same regional beta. Likewise **SKHY** (Nasdaq ADS) is a same-issuer, USD,
US-hours substitute for **SKHX** (KRX ordinary) - see below.

---

## Appendix: SKHX vs SKHY, resolved

Both track SK hynix Inc., via **two different listings**. This is not a
duplicate and the two are not interchangeable.

- **SKHX** - "SKHYNIX" in the docs. Tracks 1 share of SK hynix common stock on
  the **Korea Exchange** (`000660.KS`). The oracle converts KRW to USD at the
  prevailing USD/KRW rate, and the market follows Korean session hours. This
  is the market involved in the 2026-07-27 incident: an abnormal pre-market
  print on NXT (a Korean alternative venue) marked one share at 1,272,000 won,
  roughly 30% below the prior close, and cascaded into ~$57.4M of liquidations
  across ~960 accounts. Trade.xyz has said it will reimburse affected traders.
- **SKHY** - tracks 1 SK hynix **American Depositary Share on Nasdaq**,
  USD-native, no FX conversion, US equity hours. SK hynix listed ADSs on
  Nasdaq under `SKHY` on 2026-07-10; before that the ADR traded OTC as
  `HXSCL`.

Practical consequences for a scanner: different currencies, different session
hours, different bar boundaries, and different histories (SKHY has only ~16
trading days). Treating them as one instrument, or cross-applying levels,
would be wrong.

---

## Appendix: markets live on the xyz dex but absent from the supplied 88

The Hyperliquid API currently returns 103 xyz markets. All 88 supplied are
live. The 15 extra, listed for completeness only - not mapped here:

`URANIUM  ALUMINIUM  DXY  VIX  CORN  WHEAT  TTF  VOL  KRW  H100  NIFTY  IBOV
IBIDEN  KSTR  GEV`

Mostly commodities and indices, plus IBIDEN (Tokyo 4062, resolved on Stooq as
`4062.jp` during probing), KRW (an FX pair), NIFTY (India), IBOV (Brazil), and
GEV (GE Vernova, NYSE). If the roster is refreshed, these will need the same
treatment - `H100` and `VOL` in particular look like they need the same
careful reading that DRAM did.
