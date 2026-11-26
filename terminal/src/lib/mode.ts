// Mock vs real venues. The web URL ?mock=1 (the screenshot gate) or the
// Demo toggle in Settings selects the mock layer: fake positions and
// fills, synthetic candles, no network, no keys. Read-only public
// Hyperliquid market data is still real when the network allows it.
import { Platform } from "react-native";

import { getSettings } from "./settings_store";

function urlMock(): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search);
    return q.get("mock") === "1";
  } catch {
    return false;
  }
}

const URL_MOCK = urlMock();

export function isMock(): boolean {
  return URL_MOCK || getSettings().demo;
}

// The screenshot gate can pin the mock clock so shots are reproducible.
export function mockScenario(): string {
  if (Platform.OS !== "web" || typeof window === "undefined") return "";
  try { return new URLSearchParams(window.location.search).get("scenario") ?? ""; } catch { return ""; }
}
