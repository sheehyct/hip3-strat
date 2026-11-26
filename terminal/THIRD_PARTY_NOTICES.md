# Third-party notices

## TradingView Lightweight Charts

This app renders its charts with TradingView Lightweight Charts
(https://github.com/tradingview/lightweight-charts), version 5.2.1, used
under the Apache License, Version 2.0. As the library's NOTICE asks, the
TradingView attribution logo stays visible on every chart
(`layout.attributionLogo: true`) and the attribution link opens in the
browser.

Copyright (c) 2025 TradingView, Inc. https://www.tradingview.com/

Licensed under the Apache License, Version 2.0 (the "License"); you may not
use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

## Hyperliquid Python SDK (signing port)

`src/lib/hl_sign.ts` is a port to TypeScript of the L1 action signing in
the Hyperliquid Python SDK
(https://github.com/hyperliquid-dex/hyperliquid-python-sdk), file
`hyperliquid/utils/signing.py`: action_hash, construct_phantom_agent,
l1_payload and sign_l1_action. `test/hl_sign.test.mjs` checks the port
against that SDK's own published test vectors, which use the SDK's
published test key (0x0123...0123); that key and the values derived from it
are public test data, not credentials.

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

## Inter

The Inter typeface (https://rsms.me/inter/) is used under the SIL Open Font
License 1.1 via @expo-google-fonts/inter.

## Other dependencies

Expo, React, React Native, react-native-web, @noble/curves and
@noble/hashes are used under their respective MIT licenses, and
@msgpack/msgpack under the ISC license; see each package's LICENSE file in
node_modules.
