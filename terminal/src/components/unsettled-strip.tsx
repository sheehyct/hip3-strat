// Writes the venue has not settled yet: answered but not shown by a venue
// re-read, or sent with the answer lost. Each row says what was asked and
// what is known, and carries Dismiss (the user checked the venue). Nothing
// here is a guess: a row leaves by venue evidence or by the user's tap,
// never by a timer. While a row is up, new exposure on that market is
// refused; closing and cancelling still work.
import { useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { VenueBadge } from "@/components/positions-table";
import { canDismiss, dismissPending, subscribeVenues, venueState } from "@/lib/venue_store";
import { C, F, S, T } from "@/theme";

export function UnsettledStrip({ top, phone }: { top: number; phone?: boolean }) {
  const v = useSyncExternalStore(subscribeVenues, venueState);
  const rows = v.pending.filter((p) => p.state !== "working");
  if (!rows.length) return null;
  return (
    <View style={[s.wrap, { top }, phone ? s.wrapPhone : s.wrapDesk]} pointerEvents="box-none">
      {rows.map((p) => (
        <View key={p.id} style={[s.row, p.state === "unknown" && s.rowUnknown]}>
          <VenueBadge venue={p.venue} />
          <View style={s.body}>
            <Text style={s.label}>{p.label}</Text>
            <Text style={[s.text, p.state === "unknown" && { color: C.warn }]}>{p.text}</Text>
          </View>
          {/* A write still waiting out its lost answer has nothing to dismiss yet. */}
          {canDismiss(p) ? (
            <Pressable onPress={() => dismissPending(p.id)} style={({ pressed }) => [s.btn, phone && s.btnPhone, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={"Dismiss " + p.label}>
              <Text style={s.btnText}>Dismiss</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { position: "absolute", zIndex: 20, gap: 4 },
  wrapDesk: { left: 10, maxWidth: 620 },
  wrapPhone: { left: 8, right: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 5, borderRadius: S.radiusSm, borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.raised },
  rowUnknown: { borderColor: "rgba(255,184,0,0.45)" },
  body: { flexShrink: 1, flexGrow: 1, gap: 1 },
  label: { ...F.semibold, color: C.text, fontSize: T.caption, flexShrink: 1 },
  text: { ...F.regular, color: C.muted, fontSize: T.micro, lineHeight: 14, flexShrink: 1 },
  btn: { minHeight: 30, minWidth: 64, paddingHorizontal: 10, borderRadius: S.radiusSm, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, alignItems: "center", justifyContent: "center" },
  btnPhone: { minHeight: 40 },
  btnText: { ...F.semibold, color: C.muted, fontSize: T.caption },
});
