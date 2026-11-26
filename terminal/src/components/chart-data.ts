// Chart DATA for one coin and timeframe (market-chart.tsx):
// Hyperliquid candles for the chosen
// timeframe (300 bars, older pages on demand, the gap refilled after a
// reconnect), the live forming bar over the shared candle WebSocket, a
// data-level REST watchdog for a stalled stream, and `resend` for a chart
// that mounts mid-stream. The candle source (real or mock) is
// src/lib/candle_source.ts.
//
// Plain OHLC only: no classification of any kind.
//
// Bridge discipline: live bars go through `pushLive` (the mounted engine's
// imperative handle - no React render per tick), and `bars` changes only on
// a new history snapshot (`rev`).
import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyLive, Bar, candleWindow, ChartTf, HISTORY_BARS, mergeBars, OLDER_BARS, toWire, WireBar,
} from "@/lib/candles";
import { fetchCandles, restartCandles, streamCandles } from "@/lib/candle_source";

export const NO_BARS: WireBar[] = [];
const STREAM_QUIET_MS = 30_000;   // no streamed bar for this long -> check REST for a stalled stream
const WATCH_EVERY_MS = 10_000;

export type ChartStatus = "loading" | "ready" | "error";

export function useChartData(coin: string | null, tf: ChartTf, pushLive: (b: WireBar) => void) {
  const key = (coin ?? "") + "|" + tf;
  // The snapshot is tagged with the series it belongs to: during a TF or
  // coin switch the previous series' bars are never paired with the new key.
  const [snap, setSnap] = useState<{ key: string; bars: WireBar[]; rev: number }>({ key: "", bars: NO_BARS, rev: 0 });
  const [newest, setNewest] = useState(0);   // newest bar open (s), for the lag note; changes once per bar
  const [status, setStatus] = useState<ChartStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);    // false while the candle socket is down or reconnecting
  // When the stream last came back after a drop or a stall: shown so a heal
  // is visible (a freeze WITHOUT this line has some other cause).
  const [reconnectedAt, setReconnectedAt] = useState<number | null>(null);
  const liveNow = useRef(true);
  const [nonce, setNonce] = useState(0);
  const barsRef = useRef<Bar[]>([]);        // history + folded live bars: older pages and gap refills merge into THIS
  const gen = useRef(0);
  const olderBusy = useRef(false);
  const olderDone = useRef(false);
  const liveRef = useRef(pushLive);
  useEffect(() => { liveRef.current = pushLive; }, [pushLive]);

  const publish = useCallback((k: string) => {
    const bars = barsRef.current;
    setSnap((s) => ({ key: k, bars: bars.map(toWire), rev: s.rev + 1 }));
    setNewest(bars.at(-1)?.time ?? 0);
  }, []);
  // A chart that mounts mid-stream (fullscreen opened or left) starts from
  // the last snapshot, which lacks every live bar folded in since: hand it
  // the current bars. The snapshot keeps its own key - a series switch
  // empties barsRef before any of its bars land.
  const resend = useCallback(() => {
    const wire = barsRef.current.map(toWire);
    if (!wire.length) return;
    setSnap((s) => ({ ...s, bars: wire, rev: s.rev + 1 }));
  }, []);

  useEffect(() => {
    if (!coin) return;
    const mine = ++gen.current;
    barsRef.current = [];
    olderBusy.current = false;
    olderDone.current = false;
    setSnap((s) => ({ key, bars: NO_BARS, rev: s.rev + 1 }));
    setNewest(0); setStatus("loading"); setError(null); setLive(true); setReconnectedAt(null);
    liveNow.current = true;
    const w = candleWindow(tf, Date.now(), HISTORY_BARS);
    fetchCandles(coin, tf, w.startTime, w.endTime).then((b) => {
      if (mine !== gen.current) return;
      if (!b) { setStatus("error"); setError("the candle answer was unreadable"); return; }
      // Keep any live bars that already arrived past this history.
      barsRef.current = mergeBars(b, barsRef.current.filter((x) => x.time >= (b.at(-1)?.time ?? 0)));
      publish(key);
      setStatus("ready");
    }).catch((e) => {
      if (mine !== gen.current) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : "candles unavailable");
    });
    const refill = () => {
      // Bars traded while the socket was down never arrive by themselves.
      const lastT = barsRef.current.at(-1)?.time;
      if (lastT === undefined) return;
      fetchCandles(coin, tf, lastT * 1000, Date.now()).then((b) => {
        if (mine !== gen.current) return;
        if (!b || !b.length) return;
        barsRef.current = mergeBars(barsRef.current, b);
        publish(key);
      }).catch(() => undefined);
    };
    // Data-level watchdog (seen on a phone, 2026-10-23: seven charts, BTC
    // included, froze while their history loaded fine). A socket can stall while it
    // still answers pings, so after STREAM_QUIET_MS without a streamed bar
    // ask REST whether the market moved. Moved = the stream is dead: fold in
    // what REST has and reconnect. Unmoved = a quiet market: ask again after
    // another quiet spell.
    let lastLive = Date.now();
    let probing = false;
    const watch = setInterval(() => {
      if (probing || Date.now() - lastLive < STREAM_QUIET_MS) return;
      const ours = barsRef.current.at(-1);
      if (!ours) return;
      probing = true;
      fetchCandles(coin, tf, ours.time * 1000, Date.now()).then((b) => {
        if (mine !== gen.current) return;
        const theirs = b?.at(-1);
        if (!b || !theirs) return;
        const now = barsRef.current.at(-1) ?? ours;
        const moved = theirs.time > now.time ||
          (theirs.time === now.time && (theirs.close !== now.close || theirs.high !== now.high || theirs.low !== now.low));
        if (!moved) return;
        barsRef.current = mergeBars(barsRef.current, b);
        publish(key);
        restartCandles();
      }).catch(() => undefined).finally(() => {
        probing = false;
        lastLive = Date.now();   // asked (answered or failed): wait out another quiet spell
      });
    }, WATCH_EVERY_MS);
    const stop = streamCandles(coin, tf, (bar) => {
      if (mine !== gen.current) return;
      lastLive = Date.now();
      const before = barsRef.current.at(-1)?.time;
      barsRef.current = applyLive(barsRef.current, bar);
      liveRef.current(toWire(bar));
      if (before !== undefined && bar.time > before) setNewest(bar.time);
    }, refill, (on) => {
      if (mine !== gen.current) return;
      if (on && !liveNow.current) setReconnectedAt(Date.now());
      liveNow.current = on;
      setLive(on);
    });
    return () => { clearInterval(watch); stop(); };
  }, [coin, tf, key, nonce, publish]);

  // History before `oldestSec`; true = there may be more. A request for a
  // series that is no longer shown is ignored.
  const loadOlder = useCallback(async (oldestSec: number, forKey: string): Promise<boolean> => {
    if (!coin || forKey !== key || olderDone.current) return !olderDone.current;
    if (olderBusy.current) return true;
    olderBusy.current = true;
    const mine = gen.current;
    try {
      const w = candleWindow(tf, oldestSec * 1000 - 1, OLDER_BARS);
      const older = (await fetchCandles(coin, tf, w.startTime, w.endTime)) ?? [];
      if (mine !== gen.current) return true;
      const fresh = older.filter((b) => b.time < oldestSec);
      if (!fresh.length) { olderDone.current = true; return false; } // the venue's history ends here
      barsRef.current = mergeBars(fresh, barsRef.current);
      publish(key);
      return true;
    } finally {
      if (mine === gen.current) olderBusy.current = false;
    }
  }, [coin, tf, key, publish]);

  const bars = snap.key === key ? snap.bars : NO_BARS;
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { key, bars, rev: snap.rev, newest, status, error, live, reconnectedAt, loadOlder, retry, resend };
}
