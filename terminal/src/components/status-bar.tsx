// The thin status bar: connection state and latency per venue, the live
// stream state, how many writes are in flight, and the last action-log
// line (the venue's own words on a refusal).
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { fmtAge, fmtTimeET } from "@/lib/fmt";
import { rateLine, rateNotice, subscribeRate } from "@/lib/mfp_rate";
import { mfpStreamState, subscribeMfpStream } from "@/lib/mfp_stream";
import { subscribeTicker, tickerState } from "@/lib/ticker_store";
import { VENUE_LABEL } from "@/lib/types";
import { manualRefresh, subscribeVenues, venueState } from "@/lib/venue_store";
import { C, F, T } from "@/theme";

export function StatusBar({ phone }: { phone?: boolean }) {
  const v = useSyncExternalStore(subscribeVenues, venueState);
  const t = useSyncExternalStore(subscribeTicker, tickerState);
  const rate = useSyncExternalStore(subscribeRate, rateNotice, rateNotice);
  // MFP's account stream: a change signal only (it says when to read; it
  // never supplies what is shown). "key rejected": the venue closed it on
  // the key and it is not tried again until a key is stored.
  const stream = useSyncExternalStore(subscribeMfpStream, mfpStreamState, mfpStreamState);
  const streamText = v.mock || stream.status === "off" ? null : stream.status === "live" ? "stream" : stream.status === "connecting" ? "stream connecting" : stream.status === "rejected" ? "stream: key rejected" : "stream down";
  const streamColor = stream.status === "live" ? C.bull : stream.status === "rejected" ? C.bear : C.faint;
  const [, tick] = useState(0);
  // A hold counts down in seconds; otherwise the ages move every 5 s.
  const counting = (v.status.mfp.heldUntil ?? 0) > Date.now() || rate.heldUntil > Date.now();
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), counting ? 1000 : 5000); return () => clearInterval(id); }, [counting]);
  const now = Date.now();
  const last = v.log[0];
  const lastColor = !last ? C.faint : last.state === "rejected" ? C.bear : last.state === "confirmed" ? C.bull : last.state === "unknown" || last.state === "partial" ? C.warn : C.muted;
  // MFP's request budget: a read that was held back (by this app's own count
  // or by the venue's 429), or the venue's warning that the key is over its
  // limit (sent instead of a 429 while the limit is not yet enforced).
  const held = v.status.mfp.heldUntil !== null && v.status.mfp.heldUntil > now ? "rate limited, next read in " + Math.max(1, Math.ceil((v.status.mfp.heldUntil - now) / 1000)) + " s" : null;
  const rateText = held ?? rateLine(rate, now);
  return (
    <View style={[s.bar, phone && s.barPhone]}>
      {(["hl", "mfp"] as const).map((id) => {
        const st = v.status[id];
        const color = st.state === "ok" ? C.bull : st.state === "error" ? C.bear : st.state === "nokey" ? C.faint : C.warn;
        return (
          <Pressable key={id} onPress={manualRefresh} style={s.item} accessibilityRole="button" accessibilityLabel={VENUE_LABEL[id] + " status, tap to refresh"}>
            <View style={[s.dot, { backgroundColor: color }]} />
            <Text style={s.venue}>{VENUE_LABEL[id]}</Text>
            <Text style={s.sub} numberOfLines={1}>{st.state === "ok" ? (st.latencyMs ?? "-") + " ms" : st.state === "nokey" ? (phone ? "off" : st.error ?? "not set") : st.error ?? st.state}</Text>
            {st.lastAt && !phone ? <Text style={s.sub}>{fmtAge(now - st.lastAt)}</Text> : null}
            {id === "mfp" && streamText && st.state !== "nokey" ? <Text style={[s.sub, { color: streamColor, flexShrink: 1 }]} numberOfLines={1}>{streamText}</Text> : null}
            {id === "mfp" && rateText && st.state !== "nokey" ? <Text style={[s.sub, s.rate]} numberOfLines={1}>{rateText}</Text> : null}
          </Pressable>
        );
      })}
      <View style={s.item}>
        <View style={[s.dot, { backgroundColor: t.live ? C.bull : C.faint }]} />
        <Text style={s.sub}>{t.live ? "stream" : "no stream"}</Text>
      </View>
      {v.busy ? <Text style={[s.sub, { color: C.warn }]}>{v.busy + " in flight"}</Text> : null}
      {v.mock ? <Text style={[s.sub, { color: C.warn }]}>demo</Text> : null}
      {last ? <Text style={[s.last, { color: lastColor }]} numberOfLines={1}>{fmtTimeET(last.at) + " " + VENUE_LABEL[last.venue] + ": " + last.text}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 10, minHeight: 24, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.card },
  barPhone: { gap: 10, minHeight: 22 },
  item: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  venue: { ...F.semibold, color: C.muted, fontSize: T.micro },
  sub: { ...F.regular, color: C.faint, fontSize: T.micro, fontVariant: ["tabular-nums"] },
  rate: { color: C.warn, flexShrink: 1 },
  last: { ...F.regular, fontSize: T.micro, flexShrink: 1, flex: 1 },
});
