# Third-party notices

## TradingView Lightweight Charts

Used by the Portfolio position charts (`src/components/price-chart.tsx`),
version pinned in `package.json`. Licensed under the Apache License,
Version 2.0 (`node_modules/lightweight-charts/LICENSE`).

Attribution notice:

    TradingView Lightweight Charts (TM)
    Copyright (c) 2025 TradingView, Inc. https://www.tradingview.com/

The chart keeps the library's TradingView attribution logo visible
(`layout.attributionLogo: true`), which links to tradingview.com and opens
in the browser.

## hyperliquid-python-sdk (signing port)

`src/lib/hl_sign.ts` is a TypeScript port of the L1 action signing in the
Hyperliquid Python SDK's `hyperliquid/utils/signing.py` (`action_hash`,
`construct_phantom_agent`, `l1_payload`, `sign_l1_action`). The test vectors
in `test/hl_sign.test.mjs` are the SDK's own (`tests/signing_test.py`) plus
vectors generated from the same SDK with its published test key.

Upstream: https://github.com/hyperliquid-dex/hyperliquid-python-sdk

Licensed under the MIT License:

    The MIT License (MIT)

    Copyright (c) 2024 Hyperliquid Labs Pte. Ltd.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
    THE SOFTWARE.

## Other dependencies

The remaining runtime dependencies (Expo, React Native, noble, msgpack and
the others in `package.json`) are used unmodified through npm; each package
carries its own licence under `node_modules/`.
