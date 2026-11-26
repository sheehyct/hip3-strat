# Security model

This project places and closes real orders, so the rules below are treated as
a specification, not as advice. Each app carries a guard script
(`scripts/check-exchange-guard.js`) that fails the build when the code steps
outside them. The terminal's test suite also tests its guard by mutation
(`terminal/test/exchange_guard.test.mjs`): a bad edit is applied to a copy of
the tree on purpose and the guard has to catch it.

The terminal has a longer, terminal-specific contract in
`terminal/docs/CONTRACT.md`. This file covers what all three parts share and
the mobile app's rules in full.

## Reporting a problem

Open a GitHub issue for anything that is not sensitive. For something that
could put a user's key or account at risk, use GitHub's private vulnerability
reporting on this repository rather than a public issue.

## Keys

- No key, wallet address or account id is in the source, the tests, the
  documentation or the commit history. Tests use the Hyperliquid SDK's
  published test key (`0x0123...0123`), fake addresses and fake `fp_test_`
  keys only.
- Keys are typed in by the user. On Android they live in the system secure
  store; trading keys are stored behind a biometric prompt that fires on
  every read. The terminal's web build keeps keys in the browser tab's memory
  only: never in localStorage, IndexedDB, cookies or a URL.
- A key is never logged. The guard fails on any console line that mentions a
  key.
- A key is sent to one place only: as a signature to Hyperliquid's exchange
  endpoint, or as the `Authorization` header to the MyFundedPerps host that
  matches its prefix (`fp_live_` to the live host, `fp_test_` to the
  sandbox).

### Hyperliquid

- The app signs with an API-wallet (agent) key, never a master key. A key
  whose address equals a tracked wallet is refused. The key is stored only
  after the venue confirms the agent approval.
- The info API is read-only. The exchange API is used by one file
  (`mobile/src/lib/hl_exchange.ts`; signing in `hl_sign.ts`, key access in
  `agent_store.ts`).

### MyFundedPerps

- Two keys. A Read Only "view" key does all the watching, silently. A
  separate Read And Trade key is read only at the moment of a close or a
  reverse, behind a fingerprint, and is scoped to one account.
- A key is stored only after `GET /v1/accounts` succeeds with it, only when
  its prefix matches the host, and the view key is refused if it equals the
  trade key. Both must resolve to the same account.
- The API cannot report a key's permission level, so Read Only is set on the
  MyFundedPerps site; the app cannot verify it.

## What the mobile app may send

The mobile app can reduce risk and nothing else, with one exception (the
second leg of a reverse).

Hyperliquid, exactly two action types:

- `order`: reduce-only IoC limit orders that close or reduce an existing
  position of a tracked wallet. As the second leg of a reverse only, ONE
  non-reduce-only IoC order opening the opposite side for the size the first
  leg closed. It is sent alone, only after the venue reads the coin flat with
  its resting orders cancelled, once, with a short expiry, and is never
  retried after a transport failure.
- `cancel`: cancels of a tracked wallet's own open orders.

No withdrawals, transfers, agent approvals, leverage or margin changes, spot,
vault or sub-account actions, and no resting or trigger orders.

MyFundedPerps:

- Reads: accounts, one account, its trading policy, open positions, orders
  (including the lookup by `client_order_id`), a market quote, and the
  closed positions (view key only).
- Close: `POST /v1/positions/{id}/close`, type market, no size (a full
  close). Sent only after the position the screen showed is re-read open
  with the same side and size.
- The second leg of a reverse only: one market order on the opposite side
  for the re-read pre-close size, with leverage and margin mode copied from
  that position and no attached exits. Sent only after the close order reads
  filled and flat, the re-read positions and working orders show nothing
  left on that market, and the account's trading policy allows opening.

No partial closes, cancels, cancel-all or close-all, exit-order edits,
isolated-margin changes, limit, conditional, TWAP, scaled or copy-trading
actions.

## Order discipline

- Every write carries a fresh `Idempotency-Key` and `client_order_id`.
- A write is sent ONCE and never resent. A 4xx is a definite refusal. A
  network error, a timeout, a 5xx or an unreadable answer is ambiguous: the
  order may exist, so it is looked up by its `client_order_id` until it
  shows or a deadline passes.
- The venue is the truth. Positions are re-read after every write, and any
  doubt ends flat, never doubled.

## Request budget and the account stream

MyFundedPerps limits REST GETs per key (60 a minute on a live key, 30 on a
sandbox key).

- Every GET is counted per key. Background reads (the portfolio poll, a
  stream signal's re-read, the history sync) are refused before they are
  sent when they would pass a soft cap below the venue's limit, or while the
  venue's `Retry-After` is running.
- The reads of a close are always sent. An order lookup the venue
  rate-limits waits the time it names: it never spins and never resends.
- A reverse is refused before anything is sent when the trade key has no
  room left for its whole sequence, and its opening leg is not sent when the
  close was confirmed only after a rate-limit wait.
- The account stream is one WebSocket per watched account, on the view key
  only, with the key in the upgrade request's `Authorization` header and
  never in a URL. It is receive-only: the app sends no frame on it. A frame
  is a change signal that makes the app take its normal REST reading again.
  Nothing in a frame is shown as venue state, and none stands in for a
  re-read, a gate or an order lookup.

## The scanner

The scanner holds no trading key and places no order. It reads Hyperliquid's
public market data and sends alerts to the channels its operator configures
through environment variables (see `scanner/.env.template`). The mobile app
renders the scanner's output and performs no detection of its own.

## Not affiliated

An independent project. Not affiliated with or endorsed by Hyperliquid or
MyFundedPerps. Nothing here is financial advice or a promise of profit.
