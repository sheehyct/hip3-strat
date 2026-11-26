// The drawing toolbar: the four tools (horizontal line, horizontal ray,
// extended line, info line), delete-selected, clear-all (two-step), the
// strong-magnet toggle (on by default, remembered) and the hide-drawings
// toggle. Vertical on the left edge of the desktop layout, a horizontal
// strip on the phone. Presentation only: the panel owns the state.
//
// Drawings are the user's own annotations: display only, never an order.
import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { DRAWING_KINDS, DRAWING_LABEL, DRAWING_SHORT, DrawingKind } from "@/lib/drawings";
import { C, F, S, T } from "@/theme";

const CLEAR_CONFIRM_MS = 3000;
type IconName = ComponentProps<typeof Ionicons>["name"];

const TOOL_ICON: Record<DrawingKind, IconName> = {
  hline: "remove-outline",
  hray: "arrow-forward-outline",
  xline: "analytics-outline",
  info: "resize-outline",
};

export type ChartToolbarProps = {
  vertical: boolean;
  tool: DrawingKind | null;
  onTool: (next: DrawingKind | null) => void;
  enabled: boolean;
  selected: boolean;
  onDelete: () => void;
  count: number;
  onClear: () => void;
  magnet: boolean;
  onMagnet: () => void;
  hidden: boolean;
  onHidden: () => void;
};

export function ChartToolbar({ vertical, tool, onTool, enabled, selected, onDelete, count, onClear, magnet, onMagnet, hidden, onHidden }: ChartToolbarProps) {
  const [confirm, setConfirm] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const clearPress = () => {
    if (count === 0) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!confirm) {
      setConfirm(true);
      timer.current = setTimeout(() => { timer.current = null; setConfirm(false); }, CLEAR_CONFIRM_MS);
      return;
    }
    setConfirm(false);
    onClear();
  };
  const confirming = confirm && count > 0;
  const off = !enabled || hidden;
  const body = (
    <>
      {DRAWING_KINDS.map((k) => (
        <Tool key={k} icon={TOOL_ICON[k]} label={DRAWING_SHORT[k]} a11y={DRAWING_LABEL[k]} on={tool === k} disabled={off} vertical={vertical}
          onPress={() => { if (!off) onTool(tool === k ? null : k); }} />
      ))}
      <View style={vertical ? t.sepV : t.sepH} />
      <Tool icon="magnet-outline" label="Magnet" a11y={"Strong magnet " + (magnet ? "on" : "off")} on={magnet} disabled={false} vertical={vertical} onPress={onMagnet} />
      <Tool icon={hidden ? "eye-off-outline" : "eye-outline"} label={hidden ? "Hidden" : "Shown"} a11y={hidden ? "Show drawings" : "Hide all drawings"} on={false} disabled={false} vertical={vertical} onPress={onHidden} />
      <View style={vertical ? t.sepV : t.sepH} />
      <Tool icon="trash-outline" label="Delete" a11y="Delete the selected drawing" on={false} disabled={!selected || off} vertical={vertical} onPress={onDelete} />
      <Tool icon={confirming ? "alert-circle-outline" : "close-circle-outline"} label={confirming ? "Clear " + count + "?" : "Clear"} a11y={confirming ? "Tap again to clear all " + count + " drawings" : "Clear all drawings on this chart"} on={false} danger={confirming} disabled={count === 0} vertical={vertical} onPress={clearPress} />
    </>
  );
  if (vertical) return <View style={[t.bar, t.vert]} accessibilityRole="toolbar">{body}</View>;
  // One scrollable row on the phone: never wraps, never pushes the bottom
  // bar off the screen.
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[t.bar, t.horizWrap]} contentContainerStyle={t.horiz} accessibilityRole="toolbar">
      {body}
    </ScrollView>
  );
}

function Tool({ icon, label, a11y, on, disabled, danger, vertical, onPress }: { icon: IconName; label: string; a11y: string; on: boolean; disabled: boolean; danger?: boolean; vertical: boolean; onPress: () => void }) {
  const fg = danger ? C.bear : on ? C.accentText : disabled ? C.faint : C.muted;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ selected: on, disabled }}
      style={({ pressed }) => [t.tool, vertical ? t.toolV : t.toolH, on && t.toolOn, danger && t.toolDanger, disabled && { opacity: 0.4 }, pressed && !disabled && { opacity: 0.7 }]}
    >
      <Ionicons name={icon} size={vertical ? 17 : 16} color={fg} />
      <Text style={[t.label, { color: fg }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const t = StyleSheet.create({
  bar: { backgroundColor: C.card, borderColor: C.border },
  vert: { width: 54, borderRightWidth: 1, paddingVertical: 6, alignItems: "center", gap: 2 },
  horizWrap: { borderTopWidth: 1, flexGrow: 0 },
  horiz: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 5 },
  tool: { alignItems: "center", justifyContent: "center", borderRadius: S.radiusSm, borderWidth: 1, borderColor: "transparent" },
  toolV: { width: 46, minHeight: 44, gap: 1 },
  toolH: { minHeight: 40, minWidth: 48, paddingHorizontal: 6, gap: 1 },
  toolOn: { backgroundColor: C.accentBg, borderColor: C.accentBorder },
  toolDanger: { backgroundColor: C.bearBg, borderColor: "rgba(255,59,92,0.4)" },
  label: { ...F.medium, fontSize: T.micro },
  sepV: { width: 30, height: 1, backgroundColor: C.border, marginVertical: 4 },
  sepH: { width: 1, height: 26, backgroundColor: C.border, marginHorizontal: 2 },
});
