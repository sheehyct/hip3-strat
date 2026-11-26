// Where candles come from: the mock layer (demo / screenshots) or the
// public Hyperliquid info API and WebSocket. chart-data.ts reads only this.
import { Bar, ChartTf, parseHlCandles } from "./candles";
import { restartStream, streamCandles as hlStreamCandles } from "./hl_stream";
import { fetchCandlesRaw } from "./hyperliquid";
import { isMock } from "./mode";
import { mockBars, mockStream } from "./mock_venue";

export async function fetchCandles(coin: string, tf: ChartTf, startMs: number, endMs: number): Promise<Bar[] | null> {
  if (isMock()) return mockBars(coin, tf, startMs, endMs);
  return parseHlCandles(await fetchCandlesRaw(coin, tf, startMs, endMs));
}

export function streamCandles(
  coin: string, tf: ChartTf, onBar: (b: Bar) => void, onGap?: () => void, onLive?: (live: boolean) => void,
): () => void {
  if (isMock()) {
    onLive?.(true);
    return mockStream(coin, tf, onBar);
  }
  return hlStreamCandles(coin, tf, onBar, onGap, onLive);
}

export function restartCandles(): void {
  if (!isMock()) restartStream();
}
