// Small shared primitives: bar-type badges, chips, stat cells.
// Styling follows the dashboard's shadcn-zinc dark language.
import { StyleSheet, Text, View } from "react-native";

import { barColor, C } from "@/theme";

export function BarBadge({ t, forming }: { t: string | null; forming?: boolean }) {
  const { fg, bg } = barColor(t);
  return (
    <View style={[s.badge, { backgroundColor: bg }, forming && s.badgeForming]}>
      <Text style={[s.badgeText, { color: fg }]}>
        {t ? t + (forming ? "*" : "") : "-"}
      </Text>
    </View>
  );
}

export type ChipTone = "bull" | "bear" | "warn" | "muted";

// `dim` is the native form of the dashboard's `.chip.oof` rule: the entry fired
// this bar but price has recrossed the level, so the signal is not currently in
// force. Same 0.55 opacity, and the dashboard's tooltip text becomes an
// accessibility label because a phone has no hover.
export function Chip({ label, tone, dim }: { label: string; tone: ChipTone; dim?: boolean }) {
  const map = {
    bull: { fg: C.bull, bg: C.bullBg, bd: "rgba(0,220,130,0.3)" },
    bear: { fg: C.bear, bg: C.bearBg, bd: "rgba(255,59,92,0.3)" },
    warn: { fg: C.warn, bg: C.warnBg, bd: "rgba(255,184,0,0.3)" },
    muted: { fg: C.muted, bg: "rgba(255,255,255,0.03)", bd: C.border },
  }[tone];
  return (
    <View
      style={[s.chip, { backgroundColor: map.bg, borderColor: map.bd }, dim && s.chipDim]}
      accessibilityLabel={
        dim
          ? label + " - entry fired this bar, but price has recrossed the level, " +
            "signal not currently in force"
          : undefined
      }
    >
      <Text style={[s.chipText, { color: map.fg }]}>{label}</Text>
    </View>
  );
}

export function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

// `size` lets the D/W/M slow-layer triad render smaller than the fast FTFC
// dots it sits under (Command card, 2026-09-01); the default is unchanged.
export function Dot({ dir, size = 8 }: { dir: string; size?: number }) {
  const bg = dir === "up" ? C.bull : dir === "down" ? C.bear : "rgba(255,255,255,0.18)";
  return (
    <View
      style={[s.dot, { backgroundColor: bg, width: size, height: size, borderRadius: size / 2 }]}
    />
  );
}

// Magnitude progress (percent of the trigger-to-target distance travelled),
// drawn in the expanded card's per-timeframe signal lines. Amber at or past
// target, crimson when price sits on the wrong side of entry.
export function MagnitudeBar({ mag, compact = false }: { mag: number | null; compact?: boolean }) {
  const usable = mag !== null && isFinite(mag);
  const color = !usable ? C.faint : mag >= 100 ? C.warn : mag < 0 ? C.bear : C.bull;
  const fill = usable ? Math.min(100, Math.abs(mag)) : 0;
  const fillWidth = `${fill}%` as `${number}%`;
  return (
    <View style={[s.magRow, compact && s.magRowCompact]}>
      <Text style={s.magLabel}>MAG</Text>
      <View style={[s.magTrack, { backgroundColor: color + "26" }]}>
        {usable && <View style={[s.magFill, { backgroundColor: color, width: fillWidth }]} />}
      </View>
      <Text style={[s.magValue, { color }]}>{usable ? Math.round(mag) + "%" : "-"}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  badge: {
    minWidth: 26,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 5,
    alignItems: "center",
  },
  badgeForming: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.faint,
    borderStyle: "dashed",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  chip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    marginRight: 4,
    marginBottom: 4,
  },
  chipDim: { opacity: 0.55 }, // dashboard `.chip.oof`
  chipText: { fontSize: 11, fontWeight: "500" },
  stat: {
    flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0,
    paddingVertical: 10, paddingHorizontal: 12,
  },
  statLabel: {
    fontSize: 10,
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    color: C.muted,
  },
  statValue: {
    fontSize: 17,
    fontWeight: "600",
    color: C.text,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 3 },
  magRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 10 },
  magRowCompact: { marginTop: 6 },
  magLabel: { color: C.faint, fontSize: 9, fontWeight: "500", letterSpacing: 0.6 },
  magTrack: { height: 5, flex: 1, overflow: "hidden", borderRadius: 3 },
  magFill: { height: "100%", borderRadius: 3 },
  magValue: { minWidth: 48, textAlign: "right", fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
