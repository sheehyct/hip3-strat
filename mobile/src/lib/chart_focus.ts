// Which position chart is open (at most one, app-wide: one live candle
// subscription, one WebView), the last timeframe chosen and whether the
// scanner's levels are drawn. Components read all three through
// useSyncExternalStore (the React Compiler memoizes a bare module read - see
// state_cache.ts).
import AsyncStorage from "@react-native-async-storage/async-storage";

import { ChartTf, DEFAULT_TF, isChartTf } from "./candles";

const K_TF = "hip3.chartTf";
const K_LEVELS = "hip3.chartLevels"; // "0" = hidden; anything else = shown

let openKey: string | null = null;
let tf: ChartTf = DEFAULT_TF;
let levels = true;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

AsyncStorage.getItem(K_TF).then((v) => { if (isChartTf(v) && v !== tf) { tf = v; emit(); } }).catch(() => undefined);
AsyncStorage.getItem(K_LEVELS).then((v) => { if (v === "0" && levels) { levels = false; emit(); } }).catch(() => undefined);

export function subscribeChart(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export const openChartKey = (): string | null => openKey;
export const chartTf = (): ChartTf => tf;
export const chartLevels = (): boolean => levels;

export function toggleChart(key: string): void {
  openKey = openKey === key ? null : key;
  emit();
}

export function closeChart(key: string): void {
  if (openKey !== key) return;
  openKey = null;
  emit();
}

// Leaving the Portfolio tab closes the open chart: tabs stay mounted, and a
// hidden chart would keep its WebView and live stream running.
export function closeAllCharts(): void {
  if (openKey === null) return;
  openKey = null;
  emit();
}

export function setChartTf(next: ChartTf): void {
  if (next === tf) return;
  tf = next;
  emit();
  AsyncStorage.setItem(K_TF, next).catch(() => undefined);
}

// The scanner's levels and bar-type labels (a toggle: they
// can crowd a phone-sized chart). The position's own lines always stay.
export function setChartLevels(on: boolean): void {
  if (on === levels) return;
  levels = on;
  emit();
  AsyncStorage.setItem(K_LEVELS, on ? "1" : "0").catch(() => undefined);
}
