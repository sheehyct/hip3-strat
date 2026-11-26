# Premarket briefing snapshot API

The worker exposes a read-only, in-memory snapshot for automated HIP-3
briefings. No briefing endpoint starts a new Hyperliquid warmup or writes
state. Every representation is derived from the same normalized snapshot.

## Endpoints

```text
GET /api/briefing/latest.json
GET /api/briefing/latest.csv
GET /api/briefing/latest.compact.json
GET /api/briefing/latest.html
GET /api/briefing/health
```

All five routes serve ONE materialized snapshot per universe (rebuilt every
60s from worker state, identified by `snapshot_id`); `HEAD` is honored on
each. `health` is the lightweight probe (no rows). Operational reading of
these routes, header by header: `docs/BRIEFING_DIAGNOSTICS.md`.

On a deployed worker (replace the host with your own; a local boot is
`http://127.0.0.1:8787`):

```text
https://<your-worker-host>/api/briefing/latest.json
https://<your-worker-host>/api/briefing/latest.csv
https://<your-worker-host>/api/briefing/latest.compact.json
https://<your-worker-host>/api/briefing/latest.html
```

`uni` defaults to `xyz` and must be one of the worker's tracked universes.
The default route returns HTTP 200 whenever at least one normalized row exists,
even when the snapshot is stale or incomplete. Add `require_complete=1` only
when a strict caller prefers HTTP 503 for partial/stale data:

```text
GET /api/briefing/latest.json?uni=xyz&require_complete=1
```

With no usable rows, the JSON forms return HTTP 503 with a normal JSON envelope
plus `error.code: "snapshot_unavailable"`; HTML returns the same condition as a
server-rendered HTTP 503 page. An unknown universe returns HTTP 400. Responses
are unauthenticated, `Cache-Control: no-store`, CORS-readable public market
data and may be gzip encoded. CSV includes a download filename.

Example requests:

```bash
curl -fsS https://<your-worker-host>/api/briefing/latest.json
curl -fsS https://<your-worker-host>/api/briefing/latest.compact.json
curl -fSLOJ https://<your-worker-host>/api/briefing/latest.csv
```

```powershell
Invoke-RestMethod https://<your-worker-host>/api/briefing/latest.json |
    ConvertTo-Json -Depth 5
Invoke-RestMethod https://<your-worker-host>/api/briefing/latest.compact.json |
    ConvertTo-Json -Depth 5
Invoke-WebRequest https://<your-worker-host>/api/briefing/latest.csv `
    -OutFile hip3_briefing_latest.csv
```

## Compatibility views

The canonical JSON and 49-column CSV remain unchanged. Two additive views are
available for retrieval adapters that do not expose a large raw JSON response
or reject `text/csv`:

- `latest.compact.json` retains every normalized symbol and the briefing's
  essential metadata, return fields, liquidity/momentum context, STRAT
  sequences, and exact signal/setup counts. Repeated row keys are represented
  once in `row_fields`; each item in `rows` is a same-order value array. Signal
  and setup detail is capped at the first three items per row and disclosed by
  `notable_items_per_row_limit` and `details_truncated`. The full lists and
  complete audit fields remain available in canonical JSON.
- `latest.html` is a script-free, server-rendered view of that compact
  projection. Its `briefing-data` block contains one tab-separated header and
  one line for every row, so a browsing adapter can read the payload without
  executing JavaScript.

Both views are pure projections of `buildBriefingSnapshot()` output. They do
not calculate indicators or fetch market data. A regression test keeps a
representative 100-row compact JSON response below 64 KiB.

## Metadata and readiness

The JSON envelope includes:

- `snapshot_id`: `<boot hex>-<7-digit sequence>`;
  identical across every representation built from the same materialized
  snapshot, different when two requests straddled a materialization
- `schema_version`, `generated_at_utc` (materialization time), `data_as_of_utc`
- `served_at_utc`, `age_seconds`, `producer_status` :
  serve-time fields - `age_seconds` and `is_stale` are recomputed from
  `data_as_of_utc` at response time, so an aging snapshot never reads fresh
- `universe`, `row_count`, `expected_row_count`, `data_complete`
- `is_stale`, `stale_after_seconds` (default 900), `missing_symbols`
- `issues`, `warnings`, and per-field `field_coverage`
- source-specific `freshness` for mids, candles, and asset contexts
- `session_definitions`, the prior US close target, and score policy
- normalized `rows`

`data_complete` requires a loaded worker, a tracked non-empty universe, every
expected symbol exactly once, every row to have a current price, mids newer
than 30 seconds, candles newer than 15 minutes, and asset contexts newer than
3 minutes. The expected roster comes from the latest successful universe
metadata response. `is_stale` compares server time with `data_as_of_utc` using
the 900-second threshold. Optional return anchors can still be null for a
sparse instrument; use `field_coverage` and `warnings` before publishing basket
statistics.

The same core metadata is repeated in every CSV row and in these HTTP headers:
`X-Generated-At`, `X-Data-As-Of`, `X-Row-Count`,
`X-Expected-Row-Count`, `X-Universe`, `X-Data-Complete`, `X-Is-Stale`,
and `X-Score-Policy`; plus `X-Snapshot-ID`,
`X-Age-Seconds`, `X-Producer-Status` and `X-Request-ID` (the hosting edge's
request id, echoed, and the key to the matching `[briefing] request` log
line). `Cache-Control` is `no-store, no-cache, must-revalidate`. The HTML
view renders `snapshot_id`, `served_at_utc`, `age_seconds` and
`producer_status` in its metadata list for adapters that hide headers. The
CSV carries the identity in headers only - its 49 columns are unchanged.

`GET /api/briefing/health?uni=xyz` returns the envelope WITHOUT rows plus a
`status` of `ok` (200), `degraded` (200 - stale, incomplete, or a producer
problem; the body says which) or `unavailable` (503 - no usable snapshot),
a `producer` block (boot id, sequence, materialization age, build errors)
and the loop's upstream failure counters.

## Return fields

- `utc_session_change_pct`: last price versus the current daily candle open.
  Hyperliquid daily candles start at 00:00 UTC.
- `overnight_change_pct`: last price versus the prior scheduled US equity
  cash close. The reference is New York-time and accounts for DST, weekends,
  standard US market holidays, and scheduled 13:00 ET early closes.
- `exchange_24h_change_pct`: last price versus Hyperliquid `prevDayPx`. It is
  deliberately labeled exchange-defined; it is not treated as the UTC
  session return.

Each row also exposes the prices and timestamps behind those calculations.
For the US close, inspect `prior_us_cash_close_target_utc`,
`prior_us_cash_close_as_of_utc`, and `prior_us_cash_close_lag_minutes`.
Extraordinary one-off exchange closures cannot be predicted by the built-in
calendar and should be qualified when relevant.

Other fields include exchange volume/funding, short-horizon momentum, RVOL,
ATR, FTFC/DWM context, flat per-timeframe sequence/change fields, live signals,
and setups. Additive nested `timeframes` and `dwm_continuity` detail remains
available to existing JSON consumers. The CSV keeps its established 49-column
schema and serializes the same flat row values as JSON.
`score_beta` is stamped with `score_v`, but `score_policy` is
`experimental_low_weight`: the scheduled brief must not use score as a thesis,
ranking authority, or substitute for news and macro analysis.

## Scheduled briefing consumption

1. In an LLM scheduled task, request `latest.compact.json` first. If the
   retrieval adapter does not expose a parseable body, request `latest.html`.
   Ordinary HTTP clients should continue to use canonical JSON; CSV remains a
   download/integration format, not the scheduled-task fallback.
2. Require the expected schema/universe, `data_complete: true`, acceptable
   timestamps, and sufficient field coverage. A short retry is reasonable
   during worker startup. Record the `snapshot_id` (and `X-Request-ID` if
   the tool exposes headers) with the brief: a later question about that
   brief's data can then be answered from the worker log. If a second
   representation is fetched as a cross-check, compare it only when the
   ids match - different ids mean the two fetches straddled a
   materialization, not that the data is inconsistent.
3. Use UTC-session and overnight returns for factual price context. Keep the
   exchange 24-hour field secondary and explicitly labeled.
4. Lead the report with current geopolitical, macro, cross-asset, earnings,
   and verified ticker-specific news. Use scanner/STRAT fields only as
   secondary structure and relative-strength context.
5. If the endpoint remains stale or incomplete, produce the news/macro brief
   with a clear scanner-data qualification. Do not silently reuse a prior
   day's snapshot.

The dashboard's Export CSV button downloads the same server CSV for the
selected universe. When the HTML is opened standalone or served by an older
host, it falls back to the original current-view browser export. The adjacent
JSON API link opens the public JSON endpoint directly.
