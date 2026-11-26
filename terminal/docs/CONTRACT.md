# Safety contract

A chart-first trading terminal for Hyperliquid perps (including HIP-3
equity perps) and MyFundedPerps (MFP) prop accounts. One Expo SDK 57
codebase, two layouts: a desktop browser build (react-native-web, run
locally, never deployed) and Android.

This file is the specification the code is held to. It was written before
the code and it says what the app may send to a venue, how each write is
sent and confirmed, and where keys may live. Three things enforce it:

- `scripts/check-exchange-guard.js` (`npm run guard:exchange`), a static
  check of `src/`, `server/`, `test/` and `docs/`;
- runtime assertions that run before anything is signed or sent
  (`assertScopedAction` for Hyperliquid, `assertMfpWrite` for MFP);
- the tests in `test/`, including `test/exchange_guard.test.mjs`, which
  mutates the source tree in memory and requires the guard to fail.

A change to this file is a change to the guard and to the tests, in the
same commit.

Contents:

1. Allowed venue writes
2. The MFP request budget
3. The MFP pass-through
4. The MFP account stream
5. Forbidden on both venues
6. Order discipline
7. Keys and privacy
8. Conventions the checks rely on
9. Verification

## 1. Allowed venue writes

The guard enforces this surface. Nothing outside it may be added.

### Hyperliquid

The Hyperliquid EXCHANGE API (https://api.hyperliquid.xyz/exchange), signed
with an API-wallet (agent) key only, from `src/lib/hl_exchange.ts` only
(signing in `src/lib/hl_sign.ts`, builders in `src/lib/hl_orders.ts`, key
access in `src/lib/agent_store.ts`). Exactly these action types:

- `order`: market-style IoC limit with a slippage cap; limit Gtc / Alo;
  reduce-only flag; TP / SL trigger orders (reduce-only, isMarket) on an
  existing position. grouping "na" only. One cloid per order.
- `cancel`: cancel the tracked wallet's own open orders (by oid).
- `modify`: move a resting limit or a TP / SL trigger (price, size).
- `updateLeverage`: set cross / isolated and the leverage for one asset.

Nothing else. `hl_orders.ts` may name no other action type and the runtime
guard (`assertScopedAction`) refuses any other shape before signing.

### MyFundedPerps

MyFundedPerps REST (developers.myfundedperpetuals.com for a live key,
sandbox.myfundedperpetuals.com for a sandbox key), bearer key, from
`src/lib/mfp_exchange.ts` only (builders in `src/lib/mfp_orders.ts`, key
access in `src/lib/agent_store.ts`), plus the keyless public market list in
`src/lib/mfp_market_list.ts` (GET /v1/markets?venues=all, no header that
could carry a key), plus the receive-only account stream in
`src/lib/mfp_stream.ts` (section 4). Exactly these writes:

- POST /v1/orders: create order, type market or limit only, optional
  attached take_profit_price / stop_loss_price, reduce_only, leverage,
  margin_mode.
- PATCH /v1/orders/{id}: modify (price, optional size).
- DELETE /v1/orders/{id}: cancel one order.
- POST /v1/positions/{id}/close: close a position; full when no size,
  partial with `size` (a partial close is reduce-only by construction on
  the server).
- PUT /v1/positions/{id}/exit-orders: set or replace a position's TP / SL
  exits (place / modify / cancel operations with the stale-snapshot guard).

Reads: GET /v1/accounts, /v1/accounts/{id},
/v1/accounts/{id}/trading-policy, /v1/positions, /v1/orders (including the
client_order_id lookup), /v1/markets, /v1/markets/{id}/quote, /v1/fills.

## 2. The MFP request budget

(Added 2026-11-26.) MFP counts GETs per API key: 60 a minute on a live key,
30 on a sandbox key; writes are not counted. The app counts what it sends,
per key (`src/lib/mfp_rate.ts`), and:

- a read ON THE TRADE PATH (the pre-trade re-read of a position, the price,
  the account's rules before an order, the lookup of an order a call just
  sent) is ALWAYS sent, whatever the count says and even while the key is
  held by a 429: an exit is always attempted. Every gate that depends on
  such a read still fails closed when the read fails;
- every other read (the timer's poll, history, the ledger's lookups, the
  re-read after a write) is sent only under its share of the minute and
  never while the key is held. A read that is held back is SHOWN ("rate
  limited, next read in N s"); the lists stay as the last read left them
  and nothing is taken from a read that did not run;
- a 429 holds the key for the venue's Retry-After (60 s when it gives
  none). Nothing retries against a hold: the poll skips its beats and reads
  again when the hold ends; the order lookup waits the hold out and is owed
  one look after it (and stops at once when there is no time for that
  look). A 429 that answers a trade-path read inside a hold does not push
  the hold out (each attempt to close would otherwise keep the display's
  reads away for another Retry-After); with no hold running it sets one;
- while a write is unsettled, the reads of the book that can settle it get
  more of the minute than the lookups, the account and the history do, so a
  tight budget (a sandbox key) never leaves the book unread for them;
- a REVERSE must not end flat between its legs for want of requests. It is
  refused up front unless its whole sequence (about 18 reads) fits under
  the venue's limit on the trade key right now and the key is not held. Its
  opening leg is NOT sent when the close was confirmed only after a
  rate-limit wait, or when the re-read between the legs runs into a hold
  longer than 5 s: it would go out late, at another price. The account then
  stays flat and the reason is shown. A plain close, Flat and cancel are
  never held back by the count;
- the poll is read in parts (the book of positions and working orders, the
  account, the trading policy) at their own pace. The book is read whole on
  every snapshot: a write is only ever judged on positions and working
  orders read after its answer ("What counts as confirmed" in section 6 is
  unchanged);
- no REST poll per market or per position is added. A price feed for MFP
  markets, if it is ever built, is MFP's market-data stream, not GETs.

A live setup uses TWO keys (a Read Only view key for the reads, the trade
key for writes): each has its own 60 a minute, so the poll cannot take the
close path's reads. One key (the web build's trade key alone; every sandbox
setup) shares one budget between them.

## 3. The MFP pass-through

(Added 2026-11-14.) A browser cannot call MyFundedPerps: its CORS policy
names one origin, MFP's own docs site. So the WEB build sends the requests
of section 1 to its OWN origin, under /mfp/live/v1/... and
/mfp/sandbox/v1/..., and the pass-through in `server/` (`mfp_route.mjs`
decides, `mfp_passthrough.mjs` sends) forwards them. Android calls MFP
directly and never uses it. The pass-through:

- forwards exactly the reads and writes listed in section 1, to the same
  path on the same two hosts, and refuses anything else WITHOUT sending it
  (so it cannot be used for anything in section 5, whatever calls it);
- sends ONE request per request: never a retry, never a redirect followed.
  A refusal of its own answers 4xx (nothing was sent); any failure after
  the upstream request started answers 5xx, which the app already treats as
  unknown (look the order up, never resend);
- answers its own origin only: no CORS header, ever; a request from another
  origin, site or Host is refused;
- forwards four headers (Authorization, Accept, Content-Type,
  Idempotency-Key), stores nothing, and logs only method, path and status:
  never a header, a body or a query string. Of MFP's answer it hands back
  the status, the body, the content type and MFP's four rate-limit headers
  (Retry-After, X-RateLimit-Warning, X-RateLimit-Scope, X-RateLimit-Limit),
  and no other header.

The two host declarations (`HOSTS` in `mfp_exchange.ts`, `LIST_URL` in
`mfp_market_list.ts`) choose between the two by `Platform.OS === "web"` and
nothing else; the guard pins both, and pins `server/` to MFP's two hosts,
one send, and no other way out (the stream relay of section 4 aside).

## 4. The MFP account stream

(Added 2026-11-26.) MFP pushes order, fill, position and account changes
over a WebSocket: host account-stream.myfundedperpetuals.com, path
/v1/stream for a live key (fp_live_) and /v1/sandbox/stream for a sandbox
key (fp_test_). The app uses it from `src/lib/mfp_stream.ts` only (the
frame reading and the reconnect rules in the pure
`src/lib/mfp_stream_core.ts`), under these rules:

- it is a CHANGE SIGNAL and nothing more. A pushed frame says "read the
  venue now"; it triggers the REST reads of section 1 (the book, the
  history) through the same path the timer uses. No frame's payload is read
  beyond its envelope (type, event, account_id, seq, time), nothing pushed
  is ever shown as venue state, and nothing pushed settles a write: "What
  counts as confirmed" in section 6 is unchanged - a venue READ started
  after the answer, or the venue's status for the order asked by its id;
- it is RECEIVE-ONLY. After the one request that opens it, neither the app
  nor the relay writes anything to the venue on it: no frame, and not the
  optional ping either. The guard bans the words "send" and "ping" from
  both files, comments included;
- it is held on the READ key (`mfpReadKey()`: the view key, or on web the
  trade key the tab already holds). The key is asked for once per
  connection attempt and kept nowhere in the stream's files; the stream
  never unlocks a gated key by itself, and `mfp_stream.ts` imports neither
  the key store nor the REST client. The key travels in the Authorization
  header of the request that opens the stream and is NEVER placed in a URL;
- frames for any account but the one the app reads are ignored. While the
  stream is live AND has named that account in a snapshot, the timer drops
  to a safety pace (the book once a minute, every 15 s while a position is
  open; the account every 15 s; the history every 5 minutes). At any other
  time - connecting, down, rejected, no key, the venue's own feed reported
  down - the full pace of section 2 applies. One book read is made as the
  stream goes live, and one whenever something may have been missed (a
  stream that could not be resumed, a gap in seq, a seq that does not go up
  on a frame of ours, the venue's own resync);
- SETTLEMENT NEVER DEPENDS ON THE STREAM. While a write on MFP is
  unsettled, or a resting entry's attached exits are being watched, the
  timer keeps the FULL pace whether the stream is live or not. The stream's
  frames are unverified: were the one event that tells of a fill missed,
  the write must still be seen settled by the timer's own read, not a
  minute later;
- the stream's seq is only ever a reason to read MORE. No frame is skipped
  because of its seq;
- Android connects directly, with the Authorization header on the upgrade
  request. The web build cannot (a browser's WebSocket carries no such
  header), so it reads the stream from its OWN origin, GET
  /mfp/live/v1/stream or /mfp/sandbox/v1/stream, through the relay in
  `server/mfp_stream_relay.mjs`. `Platform.OS === "web"` and nothing else
  chooses between the two;
- the relay opens ONE upstream socket per request, to that host and one of
  those two paths, with the key the request brought, and hands each text
  frame down as one line of the response body (JSON written out again). It
  is receive-only by construction, never reconnects (the app does), refuses
  WITHOUT connecting anything that is not exactly right (another origin,
  site or Host; any method but GET; a body; a key whose prefix does not
  match the path; any query but resume / last_seq / since, each checked),
  runs at most four streams at once, drops a reader that stops reading, and
  stores nothing. Its log has the method, the path without its query, the
  status and, when a stream ends, its close code, duration and frame count:
  never a header, a query or a frame;
- the venue closing the stream with code 4001, or refusing the upgrade with
  401 / 403, means the key is not accepted: the stream stops and is not
  tried again until the MFP read key (or its account) changes - saving any
  other setting neither restarts a live stream nor retries a rejected key.
  Every other ending is retried with back-off (1, 2, 5, 10, 30, then 60 s,
  with jitter), asking to resume while the venue can still hold the stream
  (heard from within 60 s, and the last attempt received something). On the
  WEB build a refused upgrade cannot be told from an unreachable venue (the
  relay's runtime reports no status), so 401 / 403 / 429 there are retried
  on that plain ladder, at most once a minute.

The stream adds no write and no REST endpoint. It does not carry equity,
rule room, mark price, unrealized PnL or the trading policy: those stay
REST.

## 5. Forbidden on both venues

No exceptions, and no "stub that sends":

- withdrawals;
- any transfer (usdSend, spotSend, usdClassTransfer, vaultTransfer);
- approveAgent, builder fees, referrals;
- sub-accounts, vaults, spot;
- TWAP, scaled orders, chase orders, copy trading;
- isolated-margin top-ups (set-position-isolated-margin);
- cancel-all, close-all;
- price alerts.

`npm run guard:exchange` fails if any other action or endpoint appears
anywhere in `src/`. A feature that would need one of these is stubbed
behind a clearly named no-op and documented as not built.

## 6. Order discipline

Applies to every write.

- Send once. A fresh cloid (Hyperliquid) / client_order_id plus
  Idempotency-Key (MFP) per intended operation. Sent ONCE. Never retried
  automatically. An uncertain result (transport failure, timeout, 5xx,
  unreadable answer) is resolved by looking the order up (Hyperliquid: open
  orders + fills by cloid / oid; MFP: the client_order_id lookup), never by
  resending.
- Nothing is shown as done on an answer alone. The UI never shows an order,
  fill, TP / SL or position change as done until a venue re-read confirms
  it. Pending is visible: dashed line, dimmed tag, "pending" text. The
  venue is the truth; the response is a hint.
- What counts as confirmed (`src/lib/write_ledger.ts`): a venue read
  STARTED AFTER the venue's answer that shows the write's own effect (the
  position moved by the filled size, the order rests, the order is gone,
  the exit is there), or the venue's status for that order, asked by the
  cloid / client_order_id this app gave it. A read that merely succeeded
  proves nothing, and a read that could not see everything (one dex, one
  order list) is not a read. Each attached TP / SL is confirmed by itself;
  a leg that was refused or never sent is reported as NOT placed, never
  dropped.
- An unsettled write (answered but not shown yet, or its answer lost) never
  expires by time. It settles on venue evidence - on Hyperliquid a read
  taken after the signed payload's expiry counts as proof it did not land -
  or when the user dismisses it after checking the venue (the unsettled
  strip's Dismiss). A write still in flight cannot be dismissed.
- The lock: while a write on a market is unsettled, nothing that could open
  or add exposure, or re-arrange orders, is sent on that market (an opening
  order, reverse, modify, set TP / SL, leverage). Close, Flat and cancel
  are never locked behind an unsettled write; they wait only for a write
  that is in flight this instant. The store enforces it; the buttons mirror
  it.
- A venue's limits are refused before the confirm sheet, never accepted and
  dropped: no TP / SL on a Hyperliquid limit order, no post-only on MFP.
- Every market order carries a slippage cap: a per-market setting, default
  1 percent; the builder refuses above 5 percent.
- A max notional per order, per market, set in Settings (default $1,000 on
  a market with no setting). The order builder refuses above it; one-click
  never bypasses it. It also bounds a moved order that is not reduce-only
  (at its new price and size) and a reverse's opening leg (at the size and
  price it is about to be sent at).
- Closes (X, Close 25 / 50 / 100 percent, Flat) can only reduce:
  reduce-only on Hyperliquid, the close endpoint on MFP. A close that would
  increase or flip a position is refused by the builder. Flat = close that
  position and cancel that symbol's orders on that venue.
- Reverse: close first, then open the opposite side only after the venue
  reads flat and the coin's orders are cleared. The sequence: pre-check,
  close on the venue's size, strict gate, one short-expiry opening order,
  never retried after a transport failure. On MFP it also keeps to section
  2: not started without room for the whole sequence, not opened after a
  rate-limit wait.
- One-click: an OPENING order sends on one tap with no confirm sheet only
  when the "One-click trading" toggle is on (default OFF) AND the order is
  under the market's max notional. Closing is always one tap. Leverage and
  margin-mode changes are always a separate, explicit action.
- An armed drawing tool never sends an order; a tag, its X, or a TP / SL
  drag is never a drawing gesture (separate layers, separate hit-tests).

## 7. Keys and privacy

- Hyperliquid: an API-wallet (agent) key only, never a master key.
  `agent_store` refuses a key whose derived address equals the tracked
  wallet address. The key is tied to the wallet it was verified for
  (`src/lib/agent_binding.ts`): it is refused for any other tracked wallet,
  before the key is read and again after, and a change of the tracked
  wallet starts a new session exactly as a demo / live switch does.
- Android: trade keys (the Hyperliquid agent key, the MFP trade key) live
  only in expo-secure-store with requireAuthentication (a biometric gate on
  every read); a separate MFP READ-ONLY view key is stored without the gate
  for silent polling. Both MFP keys must resolve to the same single account
  and must differ from each other (sha256 fingerprint check).
- One MFP account per key (both platforms). A live key (fp_live_) must see
  exactly one account; one that sees more is refused. A sandbox key
  (fp_test_) may see more (added 2026-11-17: MFP issues one sandbox key for
  every sandbox account and its scope cannot be changed). Such a key is
  stored only for the ONE account the user picks from the venue's list when
  storing it; the app reads and writes that account only, and a venue
  answer that names another account is treated as unreadable, never shown
  or acted on.
- Web: there is no secure store (SDK 57's SecureStore web module is empty).
  Trade keys live in memory only, for that browser tab, entered once per
  session, never in localStorage, IndexedDB, cookies or the URL. The wallet
  address (read-only) and the MFP view key's NON-secret meta may persist in
  localStorage. The web build runs locally (`npm run serve`: the exported
  app and the MFP pass-through from one origin on 127.0.0.1) and is never
  deployed anywhere. An MFP key crosses the pass-through in the
  Authorization header of each request, and the stream relay in the
  Authorization header of the one request that opens a stream; it is never
  stored or logged in either, and never placed in a URL.
- Keys never appear in source, logs, tests, screenshots, fixtures or
  commits. Tests use fake keys and the Hyperliquid SDK's published test key
  (0x0123...0123) only. No real wallet addresses anywhere. The guard fails
  on any console line mentioning "key" or "priv", and on any 40-hex address
  or 64-hex key in `src/`, `test/` or `docs/` that is not a known test
  vector or an obviously fake pattern.
- Every AsyncStorage / SecureStore key this app writes starts with "tt.".

## 8. Conventions the checks rely on

- Pure modules (`hl_sign`, `hl_orders`, `mfp_orders`, `candles`,
  `drawings`, `order_policy`, `mfp_markets`, `write_ledger`, `session`,
  `agent_binding`, `mfp_rate`, `mfp_stream_core`) stay import-free of
  platform packages so `node --test` loads them straight from source
  (`write_ledger` has type-only imports; `session`, `agent_binding`,
  `mfp_rate` and `mfp_stream_core` have none at all). The guard fails on an
  import in any of them but `hl_sign` (noble and msgpack only) and
  `write_ledger`.
- Expo DOM components ("use dom", a WebView on Android): an engine draws
  only what it is given - no network, no storage, no keys inside a DOM
  component. Live ticks go through the imperative handle, never props;
  history redraws only on a revision bump; lines, tags and markers only
  when their JSON content changes; one ref per mounted chart.
- React Compiler is on: module state is read through useSyncExternalStore,
  never by a bare function call during render.
- This app never detects: drawings and chart data are display only and are
  never read into a filter, a score, an alert or a classification.
- Times are displayed in America/New_York.
- Plain ASCII in code and docs.
- Android cuts overflowing text at a large system font scale: label and
  value are separate Text nodes, flexShrink: 1 on a Text beside a sibling,
  flexWrap on rows that can crowd, minWidth instead of fixed widths. Touch
  targets are at least 40 px on the phone layout.

## 9. Verification

Every change keeps all of these green (`npm run check` runs the first
four):

- `npm test` (`node --test test/*.test.mjs`), including a unit test for
  every request builder (exact Hyperliquid action payloads and MFP request
  bodies) and every refusal (over max notional, slippage above 5 percent,
  an opening order flagged reduce-only, a close that would increase a
  position).
- `npm run guard:exchange`.
- `npx tsc --noEmit` clean.
- `npx expo export --platform android` bundles.
- Web screenshots of every screen and state at 1440x900 and 390 px wide
  (`npm run shots`), driven by the MOCK venue layer
  (`src/lib/mock_venue.ts`) with fake positions and fills, written to
  `shots/` (generated, not committed).

No keyed call is made in any automated check.
