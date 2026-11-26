// App settings in AsyncStorage (non-secret only), read through
// useSyncExternalStore. The wallet address, the non-secret key meta, the
// per-market settings (slippage cap, max notional, size presets), the global
// dollar presets, the one-click toggle (default OFF), chart preferences
// (timeframe, magnet, hide drawings), the watchlist and demo mode.
//
// Keys here never hold a secret: trade keys live in agent_store.ts.
import AsyncStorage from "@react-native-async-storage/async-storage";

import { ChartTf, DEFAULT_TF, isChartTf } from "./candles";
import { DEFAULT_MARKET_SETTINGS, MarketSettings, sanitizeMarketSettings } from "./order_policy";

const K = "tt.settings.v1";

export type Settings = {
  wallet: string;                         // HL address, "" = none (read-only, may persist on web)
  demo: boolean;                          // mock venue layer (fake positions and fills)
  oneClick: boolean;                      // default OFF
  tf: ChartTf;
  symbol: string | null;                  // last market key viewed ("hl:BTC")
  magnet: boolean;                        // strong magnet, default ON
  hideDrawings: boolean;
  watchlist: string[];                    // market keys
  markets: Record<string, MarketSettings>;// by market key
  dollarPresets: number[];                // global quick-size presets in USD
  closePcts: number[];                    // Close 25 / 50 / 100
  bottomTab: "positions" | "orders" | "history";
  layout: "auto" | "desktop" | "phone";
};

export const DEFAULT_SETTINGS: Settings = {
  wallet: "",
  demo: false,
  oneClick: false,
  tf: DEFAULT_TF,
  symbol: null,
  magnet: true,
  hideDrawings: false,
  watchlist: ["hl:BTC", "hl:ETH", "hl:SOL", "hl:xyz:NVDA", "hl:xyz:TSLA", "hl:xyz:SP500"],
  markets: {},
  dollarPresets: [2500, 5000, 10000],
  closePcts: [25, 50, 100],
  bottomTab: "positions",
  layout: "auto",
};

let settings: Settings = DEFAULT_SETTINGS;
let hydrated = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const strs = (x: unknown, max: number): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length < 64).slice(0, max) : []);

export function sanitizeSettings(raw: unknown): Settings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const markets: Record<string, MarketSettings> = {};
  if (o.markets && typeof o.markets === "object") {
    for (const [k, v] of Object.entries(o.markets as Record<string, unknown>)) {
      if (typeof k === "string" && k.length < 64) markets[k] = sanitizeMarketSettings(v);
    }
  }
  const dollars = Array.isArray(o.dollarPresets) ? o.dollarPresets.filter((x): x is number => fin(x) && x > 0).slice(0, 3) : [];
  const pcts = Array.isArray(o.closePcts) ? o.closePcts.filter((x): x is number => fin(x) && x > 0 && x <= 100).slice(0, 3) : [];
  return {
    wallet: typeof o.wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(o.wallet) ? o.wallet : "",
    demo: o.demo === true,
    oneClick: o.oneClick === true,
    tf: isChartTf(o.tf) ? o.tf : DEFAULT_TF,
    symbol: typeof o.symbol === "string" && o.symbol.length < 64 ? o.symbol : null,
    magnet: o.magnet !== false,
    hideDrawings: o.hideDrawings === true,
    watchlist: "watchlist" in o ? strs(o.watchlist, 60) : DEFAULT_SETTINGS.watchlist,
    markets,
    dollarPresets: dollars.length ? dollars : DEFAULT_SETTINGS.dollarPresets,
    closePcts: pcts.length === 3 ? pcts : DEFAULT_SETTINGS.closePcts,
    bottomTab: o.bottomTab === "orders" || o.bottomTab === "history" ? o.bottomTab : "positions",
    layout: o.layout === "desktop" || o.layout === "phone" ? o.layout : "auto",
  };
}

async function hydrate(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(K);
    if (raw) settings = sanitizeSettings(JSON.parse(raw));
  } catch {
    // junk in storage: defaults
  } finally {
    hydrated = true;
    emit();
  }
}
const hydration = hydrate();
export const settingsReady = (): Promise<void> => hydration;

export function subscribeSettings(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export const getSettings = (): Settings => settings;
export const settingsHydrated = (): boolean => hydrated;

let writeChain: Promise<void> = Promise.resolve();
function persist(): void {
  const body = JSON.stringify(settings);
  writeChain = writeChain.catch(() => undefined).then(() => AsyncStorage.setItem(K, body)).catch(() => undefined);
}

export function updateSettings(patch: Partial<Settings>): void {
  settings = sanitizeSettings({ ...settings, ...patch });
  emit();
  persist();
}

export function marketSettings(marketKey: string): MarketSettings {
  return settings.markets[marketKey] ?? DEFAULT_MARKET_SETTINGS;
}

export function setMarketSettings(marketKey: string, patch: Partial<MarketSettings>): void {
  const cur = marketSettings(marketKey);
  updateSettings({ markets: { ...settings.markets, [marketKey]: sanitizeMarketSettings({ ...cur, ...patch }) } });
}

export function toggleWatch(marketKey: string): void {
  const has = settings.watchlist.includes(marketKey);
  updateSettings({ watchlist: has ? settings.watchlist.filter((k) => k !== marketKey) : [...settings.watchlist, marketKey] });
}
