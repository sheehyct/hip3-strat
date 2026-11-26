# HIP3 STRAT mobile

An Android app (Expo / React Native) with two jobs:

- a market screener that renders the output of the scanner worker in
  `../scanner`, and
- a portfolio view for Hyperliquid wallets and one MyFundedPerps (MFP)
  account, with a guarded close and reverse.

An independent project. Not affiliated with or endorsed by Hyperliquid or
MyFundedPerps. Nothing here is financial advice.

## What it is and is not

- It never detects. Bar classification, patterns, triggers and invalidation
  all run in the scanner worker. The app polls the worker's `GET /api/state`
  and draws it. Counting, filtering and sorting the served output is the only
  logic here. The display math is the dashboard's own code, vendored
  byte-for-byte into `src/lib/display_core.js` and tied to the worker by a
  hash (`display_v`).
- It is a portfolio tracker. It reads positions, fills and equity history
  from the venues' APIs for the wallets and the account you enter.
- It can close or reverse a position you already hold, flatten a wallet, and
  cancel a wallet's own resting orders. It cannot open a new position on its
  own (the reverse's second leg is the one exception), place resting
  or trigger orders, change leverage or margin, transfer or withdraw. The full
  list is in `../SECURITY.md`.

## Screens

- Screener: one card per coin from `/api/state` (price, 24h change, live
  signals and setups with entry, stop and target, timeframe continuity),
  with the dashboard's filters, pattern families and sort keys. Two
  universes: the HIP-3 `xyz` dex and the main crypto perps.
- Portfolio: Positions, Performance and Trades for every saved Hyperliquid
  wallet, across ALL perp dexes (each dex has its own clearinghouse; a
  main-only query hides HIP-3 positions). Position charts draw Hyperliquid
  candles with the scanner's served levels on top. The MFP account has its
  own block and is never summed into the Hyperliquid numbers.
- Settings: wallet addresses, the Hyperliquid agent key per wallet, the two
  MFP keys, the worker URL, push registration, build identity.

## Run it

Requires a recent Node (22.18 or later: the tests load the TypeScript
sources through Node's built-in type stripping).

```bash
npm install
npx expo start
```

Open it in Expo Go, an emulator, or a development build. Expo Go is enough
for the Screener and the read-only Portfolio. The stored keys and the
fingerprint prompt are built for a development or release build
(`expo-secure-store` is a native module). The web target
(`npx expo start --web`) shows no key or trading controls.

### Point it at a scanner worker

The scanner is in `../scanner`. Run it locally without sending any alert:

```bash
cd ../scanner
LOG_ONLY=1 node server.js
```

It listens on `http://127.0.0.1:8787` by default, which is also the app's
default worker URL (`http://localhost:8787`, `src/lib/api.ts`). That default
only works where "localhost" is the machine running the scanner (the web
target, or an emulator with the port forwarded). On a phone, start the
scanner with `HOST=0.0.0.0` and enter `http://<your-computer-address>:8787`
under Settings > Alert worker URL. Android release builds normally refuse
plain http, so put the worker behind HTTPS before using a release build.

## How keys are handled

Nothing is in the source. Every address and key is typed in by the user in
Settings.

- Wallet addresses: AsyncStorage on the phone. Sent only to Hyperliquid's
  public info API.
- Hyperliquid agent key: an API-wallet key, one per tracked wallet, never a
  master key. Settings refuses a key whose address is a tracked wallet, asks
  the venue whether the agent is approved for that wallet, and stores it only
  then, in the phone's secure store behind a biometric prompt on every read.
  It is excluded from Android backup.
- MFP view key: created Read Only on the MFP site. Stored in the secure
  store without the fingerprint gate so the 30 s refresh is silent. It does
  all the watching.
- MFP trade key: a Read And Trade key scoped to one account. Stored behind
  the fingerprint gate and read only for one close or reverse. Both MFP keys
  must resolve to the same single account, and the view key is refused if it
  equals the trade key. The MFP API cannot report a key's permission level,
  so the app cannot verify that the view key really is Read Only.
- A key is never logged, never placed in a URL, and never sent anywhere
  except to its own venue.

## Safety model

The rules are in `../SECURITY.md`. In this folder they are enforced by:

- `npm run guard:exchange` (`scripts/check-exchange-guard.js`), a static
  check over `src/`. It pins, among other things:
  - the Hyperliquid exchange endpoint and the signing call to
    `src/lib/hl_exchange.ts`, and `expo-secure-store` to
    `src/lib/agent_store.ts`;
  - the action types in `src/lib/hl_orders.ts` to `order` and `cancel`, and
    the one non-reduce-only order (the reverse's second leg) to one builder
    and one caller;
  - the MFP REST host to `src/lib/mfp_exchange.ts`, its methods to GET and
    POST, its resources to accounts, positions, orders and markets, one
    `fetch` in that file, and every POST to a builder-made, asserted write;
  - the MFP stream to `src/lib/mfp_stream.ts`: one socket address, the view
    key only, the key only in the upgrade request's Authorization header,
    and no transmit call at all.
- Runtime twins of the same rules (`assertScopedAction`, `assertMfpWrite`)
  that run before anything is signed or sent.
- Send-once writes. A Hyperliquid opening leg is signed with a short expiry
  and never retried. Every MFP write carries a fresh `Idempotency-Key` and
  `client_order_id`; an uncertain result is resolved by looking the order up,
  never by sending it again. The venue is re-read after every write.
- A per-key request budget (`src/lib/mfp_rate.ts`). MFP limits GETs per key
  (60 a minute live, 30 sandbox). Background reads stop at a soft cap below
  that (40 and 20) and while the venue's `Retry-After` runs; the reads of a
  close are always sent.
- A receive-only account stream. The MFP WebSocket is used only as a change
  signal: a frame makes the app take its normal REST reading again. Nothing
  in a frame is shown as venue state or stands in for a re-read.
- The confirmation sheet shows the exact orders, needs a 1.2 s hold and then
  the fingerprint, and prints the venue's answers verbatim.

Signing (`src/lib/hl_sign.ts`) is a port of the Hyperliquid Python SDK's
signing code, pinned by the SDK's test vectors. Settings prints
"signing self-test: ok" when the installed build reproduces the SDK's public
test vector on the device.

## Tests and checks

```bash
npm test                              # node --test over test/
npm run guard:exchange                # static guard on the exchange surface
node scripts/check-display-core.js    # vendored display block vs its hash
npx tsc --noEmit                      # type check
npx expo export --platform android    # the Metro bundle compiles
npm run release:check                 # all of the above, plus config checks
```

`release:check` also runs `expo install --check`, which needs network access.

Tests use the Hyperliquid SDK's published test key, fake addresses and fake
`fp_test_` keys only.

`check-display-core.js` also compares the vendored block with
`../scanner/src/display_core.js` when that folder is present.
`npm run display:sync` re-vendors it. `npm run parity:chips` and
`npm run parity:focus` compare two hand-written mirrors with the dashboard's
own functions on a live `/api/state`; they need a running worker
(`HIP3_WORKER_URL`, default `http://localhost:8787`).

## Push notifications

Not configured in this repository. The scanner worker can deliver alerts
through the Expo push service; to receive them a builder must supply:

- their own Firebase project: add its `google-services.json` here and set
  `expo.android.googleServicesFile` in `app.json`, with the Android package
  name matching `expo.android.package`;
- their own EAS project: run `eas init` (it writes `extra.eas.projectId`) and
  upload the FCM V1 service-account key with `eas credentials`;
- a build made with EAS or a local native build (Expo Go cannot receive
  Android remote push);
- the worker's push key, entered in Settings.

Without these the app runs normally and push stays unregistered: a
registration attempt in Settings stops with "missing EAS projectId".

## What is not included

- No `google-services.json` and no Firebase project.
- No EAS project id, Expo account or update channel. `expo-updates` is installed
  but has no update URL, so over-the-air updates are off until you add your
  own `updates.url` and `runtimeVersion`.
- The Android package is the placeholder `com.example.hip3strat`. Change it
  before you build.
- No wallet address, key or account id.

## Status

A prototype built for one person's use and published as is. The MFP account
stream and the request budget are covered by tests but are not yet in a
released build. Expect rough edges; read `../SECURITY.md` and the guard
script before trusting it with a key.

## Licence

See `../LICENSE`. Third-party notices are in `THIRD_PARTY_NOTICES.md`.
