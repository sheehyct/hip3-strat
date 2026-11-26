# hip3-strat scanner

An always-on market scanner, alert worker and dashboard for Hyperliquid
perps: the HIP-3 `xyz` builder dex (equity, index and commodity perps) and,
optionally, the main-dex crypto perps.

One Node process, zero npm dependencies (Node builtins and global `fetch`).
It polls Hyperliquid's public market-data API, classifies every bar with
the STRAT method on seven timeframes, and

- serves the analyzed state as JSON at `GET /api/state` (what the mobile app
  in `../mobile` renders),
- serves a dashboard at `/` (installable as a PWA),
- fires transition-based alerts to a webhook (ntfy, Discord or Telegram)
  and to registered Expo push tokens.

It reads public market data only. It holds no wallet, no exchange key and
places no orders.

An independent project. Not affiliated with Hyperliquid or MyFundedPerps.
Nothing here is trading advice.

## Run it locally

Requires Node 18 or newer (Node 22+ for the WebSocket feed and the browser
smoke script). No install step, no account, no keys.

```bash
LOG_ONLY=1 node server.js      # PowerShell: $env:LOG_ONLY="1"; node server.js
# open http://127.0.0.1:8787
```

`LOG_ONLY=1` logs alerts instead of sending them. The process talks only to
`api.hyperliquid.xyz`. `GET /health` answers at once; the first full candle
load takes a few minutes (it is paced to stay inside the exchange's rate
limit, and longer with `perps`), and `/api/state` reports `loaded:false`
until it is done.

The dashboard file also works on its own: open `hip3_strat_screener.html`
from disk and it polls Hyperliquid directly and runs the same detection in
the browser.

## What it detects

Bars are classified 1 (inside), 2U, 2D or 3 (outside) on 15m, 30m, 1h, 4h,
1d, 1w and 1M. Weekly and monthly bars are built from daily bars, because
the exchange's own 1w / 1M candles are not calendar-aligned. From the bar
sequence the core derives pending setups (a trigger level not yet broken)
and live signals (the forming bar has broken the trigger), each with entry,
stop and target, for the 2-2, 2-1-2, 3-1-2, 3-2, 3-2-2, 1-2-2, 1-3 and PMG
patterns, plus timeframe continuity (FTFC) and a per-coin heat score.

## Alerts

Every alert fires on a TRANSITION, never on a level being true, and is
deduplicated per bar. Rule state is saved to `data/rule_state.json` every
30 s, so a restart does not re-fire.

| Tag | Fires when | `config.json` key |
| --- | ---------- | ----------------- |
| `[LIVE]` | a reversal signal goes live on a configured timeframe | `rules.live_signal` |
| `[INVAL]` | a previously alerted signal's bar becomes a 3 | `rules.invalidation` |
| `[SCORE]` | the heat score crosses a threshold (with a re-arm band) | `rules.score_cross` |
| `[FTFC]` | the configured timeframes flip into full continuity | `rules.ftfc_flip` |
| `[LEVEL]` | price crosses a level you listed for a symbol | `rules.price_level` |
| `[RVOL]` | 15m relative volume spikes above a threshold and a notional floor | `rules.rvol_spike` |
| `[SPIKE]` | price moves a multiple of the coin's own normal 15m range | `rules.move_spike` |

Delivery is serialized with a 500 ms minimum gap; network errors, HTTP 429
and 5xx are retried with backoff (up to 4 attempts); permanent failures are
logged and never crash the loop.

Run with `LOG_ONLY=1` for a day and compare the `[ALERT ...]` log lines with
the dashboard before pointing the worker at a real webhook.

## Configuration

### Environment variables

None is required. Secrets live in the environment only, never in the repo;
`.env.template` lists every variable with comments.

| Variable | Purpose | Default | Required? |
| -------- | ------- | ------- | --------- |
| `LOG_ONLY` | `1` = log alerts instead of sending (webhook and push) | off | no - recommended for any local run |
| `PORT` | listen port | `8787` | no |
| `HOST` | bind address | `127.0.0.1` (the Dockerfile sets `0.0.0.0`) | no |
| `UNIVERSES` | universes to track: `xyz`, `perps` | `xyz` | no |
| `ALERT_UNIVERSES` | tracked universes that alert on every coin | `xyz` | no |
| `ALERT_FAVS_UNIVERSES` | tracked universes that alert for favorited coins only; empty value = off | `perps` | no |
| `ALERT_BACKEND` | `ntfy`, `discord` or `telegram` | none (no webhook) | only to send webhook alerts |
| `ALERT_WEBHOOK_URL` | ntfy topic URL or Discord webhook URL (secret) | none | with `ntfy` / `discord` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (secret) | none | with `telegram` |
| `TELEGRAM_CHAT_ID` | Telegram chat to post to | none | with `telegram` |
| `PUSH_REGISTER_KEY` | shared secret for `/api/push/*` (sent as `x-push-key`) | none (routes answer 403) | only to enable push registration |
| `EXPO_PUSH_ACCESS_TOKEN` | Expo access token (secret) | none | only with Expo Enhanced Push Security |
| `CANDLE_FEED` | `1` = 15m candles from Hyperliquid's WebSocket instead of REST sweeps | off | no |
| `FEED_RECONCILE_MS` | REST reconciliation interval while the feed is on | `3600000` | no |
| `CONTINUITY_LEDGER` | `1` = record served continuity every 30 s and enable `POST /api/continuity_at` | off | no |
| `TELEMETRY_DISABLED` | `1` = turn off the telemetry series under `data/telemetry/` | telemetry on | no |
| `BUDGET_PER_MIN` | client-side exchange request budget, weight per minute | `2000` | no |
| `BRIEFING_INTERVAL_MS` | briefing snapshot interval | `60000` | no |
| `MASSIVE_API_KEY` | Massive (formerly Polygon.io) key for underlying equity bars (secret) | none | only for `npm run underlying:check` |

### `config.json` (committed, no secrets)

- `ftfcTfs` - the timeframes FTFC and the heat score are computed over.
- `coins.allow` / `coins.block` - symbol allow / block lists across all
  tracked universes (empty allow = all); match on symbol (`NVDA`) or full
  name (`xyz:NVDA`).
- `quietHoursUtc` - `null` or `{"start": 3, "end": 11}`; alerts inside the
  window are logged as suppressed.
- `rules.*` - one block per alert kind in the table above: `enabled` plus
  its thresholds (`tfs` and `kinds` for live signals, `threshold` / `rearm`
  for score crosses, `rearmSec` for FTFC flips, `levels` / `rearmPct` for
  price levels, `threshold` / `minNotional` for RVOL, `mult` / `minPct` for
  move spikes). The committed values are a working example, not a
  recommendation.

### Universes

A universe is one Hyperliquid perp namespace:

| id | dex | coin names | info request |
| -- | --- | ---------- | ------------ |
| `xyz` | HIP-3 builder dex `xyz` | prefixed (`xyz:NVDA`) | `{type, dex:"xyz"}` |
| `perps` | Hyperliquid main dex | bare (`BTC`) | `{type}` |

`UNIVERSES` decides what is fetched, analyzed and served; `ALERT_UNIVERSES`
decides which of those alert. A tracked universe that does not alert is
screener-only. The effective scope is served as `alertUniverses` in
`/health` and `/api/state`.

```bash
node server.js                                   # track and alert xyz
UNIVERSES=xyz,perps node server.js               # screen both, alert xyz
UNIVERSES=xyz,perps ALERT_UNIVERSES=xyz,perps node server.js
```

## Endpoints

| Route | Returns |
| ----- | ------- |
| `GET /` | the dashboard (read from disk per request) |
| `GET /health` | status `loading` / `ok` / `degraded`, coin counts, data ages, fetch failures, alert and push counters. `ok` needs fresh mids (< 30 s) AND fresh candles (< 15 min) |
| `GET /api/state` | the analyzed state: per coin price, change, volume, funding, score, RVOL, FTFC, momentum, per-timeframe bar types, forming bar, live signals and setups. `?uni=<id>` filters. gzip, CORS `*` |
| `GET /api/bootstrap` | raw candle slots so the dashboard paints without re-downloading history |
| `GET /api/briefing/latest.json`, `.csv`, `.compact.json`, `.html` | one normalized snapshot per universe, rebuilt every 60 s, for scheduled consumers. See `docs/PREMARKET_BRIEFING_API.md` |
| `GET /api/briefing/health` | snapshot identity and freshness without rows. Runbook: `docs/BRIEFING_DIAGNOSTICS.md` |
| `POST /api/push/register`, `/api/push/unregister` | body `{"token": "ExponentPushToken[...]", "favs": ["BTC"]}`. 403 until `PUSH_REGISTER_KEY` is set; clients send it as `x-push-key` |
| `POST /api/continuity_at` | served continuity at past times, `[{coin, t}, ...]`. 503 unless `CONTINUITY_LEDGER=1` |
| `GET /manifest.webmanifest`, `/sw.js`, `/icon-192.png`, `/icon-512.png`, `/favicon.ico` | PWA assets from `public/` |

All data routes are unauthenticated public market data. The push routes
are default-closed because a public worker would otherwise let anyone fill
the token store.

## One detection core, extracted and parity-checked

There is exactly one implementation of the detection logic. Four things
keep it that way.

1. **One source of truth.** The logic lives in the dashboard, between the
   `STRAT-CORE-BEGIN` / `STRAT-CORE-END` markers of
   `hip3_strat_screener.html`. It is pure: no DOM, no state.
2. **A generated module.** `scripts/extract_core.js` slices that block out
   verbatim into `src/strat_core.js`, which the worker runs. The same
   script extracts the perp category map (`src/perp_cat.js`) and the
   display math (`src/display_core.js`, whose hash is served as `display_v`
   so a client that vendors the block can detect drift). Never hand-edit
   the generated files.
3. **An anti-drift gate.** `npm run extract:check` re-extracts and
   byte-compares. It runs in the tests and in the Docker build, so an
   image cannot ship with a core that differs from the dashboard.
4. **An independent reference.** `parity/reference.py` is a separate Python
   implementation of the same rules. `node parity/run_parity.js` fetches
   live candles, runs the JavaScript core and the Python reference on the
   SAME bars and diffs bar types, setups, live signals and the week / month
   aggregation. It needs `python` on the PATH and network access to
   Hyperliquid; it refuses to run if `parity/strat_core_extracted.js` is
   stale.

```bash
npm run extract          # regenerate the src/ modules after editing a block
npm run extract:check    # exit 1 if a generated module differs
npm run parity:extract   # regenerate the parity copy
npm run parity:check     # exit 1 if it differs
node parity/run_parity.js
```

When the STRAT-CORE block changes: regenerate both copies, mirror the
change in `parity/reference.py`, and run the parity harness.

## Tests

```bash
npm test                 # node --test, 48 files, no network, no keys
npm run extract:check
```

The tests cover the detection core, the rule engine, metrics, the request
budget, the candle feed, the briefing store, the HTTP routes and the
dashboard's inline script (loaded into a stub DOM).

Optional tools, all defaulting to a local worker at `http://127.0.0.1:8787`:

- `npm run smoke` - drives headless Chrome against a running worker
  (needs a local Chrome; `SMOKE_URL` to point elsewhere).
- `node scripts/briefing_check.js [base-url]` - checks that the five
  briefing representations describe one snapshot.
- `node scripts/health_probe.js [minutes] [periodSec] [url]` - samples
  `/health` and reports stalls and data ages.
- `npm run spike:check` - shows where the move-spike floor binds per coin.
- `npm run underlying:check` - audits underlying equity history (needs
  `MASSIVE_API_KEY` in `.env`).
- `node scripts/make_icons.js` - regenerates the PWA icons.

## Deploy

Any host that runs a container (or plain Node) works.

```bash
docker build -t hip3-strat-scanner .
docker run -p 8787:8787 -e LOG_ONLY=1 -v scanner-data:/app/data hip3-strat-scanner
```

- The image sets `HOST=0.0.0.0`, exposes 8787 and runs the extract check
  at build time. Most platforms inject `PORT`.
- Mount a persistent volume at `/app/data`. It holds the rule dedup state,
  push tokens, telemetry and the continuity ledger. Without one the worker
  still runs, but a redeploy starts those empty: alerts in force re-fire
  once and clients must re-register for push.
- Run one replica: the state lives in one process.
- Health check path: `/health` (it answers 200 during the initial load,
  with `status: "loading"`).
- `railway.json` and `.railwayignore` are a ready config for Railway; they
  are optional and name no service.
- Set secrets (`ALERT_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`,
  `PUSH_REGISTER_KEY`, ...) in the platform's environment, and start with
  `LOG_ONLY=1`.

Tracking `perps` as well roughly triples the working set (two to three
hundred coins in total): the initial load, the per-poll work and the size
of `/api/state` grow in proportion.

## Layout

```
server.js                  HTTP server and wiring
hip3_strat_screener.html   dashboard; source of the extracted blocks
config.json                alert rules
src/loop.js                data loop (mids, candles, contexts)
src/strat_core.js          GENERATED detection core
src/display_core.js        GENERATED display math
src/perp_cat.js            GENERATED perp category map
src/rules.js               transition-based alert engine
src/metrics.js             FTFC, momentum, RVOL, heat score
src/apistate.js            /api/state serializer
src/deliver.js, push.js    webhook and Expo push delivery
src/budget.js              exchange request budget and ledger
src/candle_feed.js         optional WebSocket candle feed
src/briefing*.js           briefing snapshots
src/continuity_ledger.js   optional continuity history
parity/                    Python reference and the parity harness
scripts/                   extraction, smoke and diagnostic tools
test/                      node --test suites
docs/                      briefing API, its runbook, the xyz underlying map
```
