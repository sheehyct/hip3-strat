// Shared visual kit:
// cards, headers, tabs, pills, buttons, a bottom sheet, stat tiles.
// Presentation only - no data, no logic. Screens compose these; colors and
// type come from src/theme.ts.
//
// Android rules baked in (at a large system font scale Android CUTS text
// that overflows its box): label/value pairs are separate Text nodes,
// any Text beside a sibling gets flexShrink: 1, rows that can crowd wrap,
// and touch targets are at least 44dp.
import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps, ReactNode } from "react";
import { Image, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { C, F, S, T } from "@/theme";

type IconName = ComponentProps<typeof Ionicons>["name"];

// ---- surfaces ---------------------------------------------------------------

export function Card({
  children, style, onPress, accessibilityLabel,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  if (!onPress) return <View style={[k.card, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [k.card, style, pressed && { backgroundColor: C.cardActive }]}
    >
      {children}
    </Pressable>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: C.border }, style]} />;
}

// ---- headers ----------------------------------------------------------------

// The small brand line above a screen title.
export function BrandLine({ right }: { right?: ReactNode }) {
  return (
    <View style={k.brand}>
      <Image source={require("../../assets/images/icon.png")} style={k.brandIcon} />
      <Text style={k.brandText}>HIP-3 STRAT</Text>
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

export function ScreenHeader({
  title, subtitle, right, left,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  left?: ReactNode;
}) {
  return (
    <View style={k.header}>
      <View style={k.headerRow}>
        {left}
        <Text style={k.h1} numberOfLines={1}>{title}</Text>
        <View style={{ flex: 1 }} />
        {right}
      </View>
      {subtitle ? <Text style={k.headerSub}>{subtitle}</Text> : null}
    </View>
  );
}

export function SectionHeading({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <View style={k.section}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={k.h2}>{title}</Text>
        {subtitle ? <Text style={k.sectionSub}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

// Uppercase group label.
export function GroupLabel({ children }: { children: string }) {
  return <Text style={k.group}>{children.toUpperCase()}</Text>;
}

// ---- controls ---------------------------------------------------------------

export function IconButton({
  name, onPress, label, active, size = 18, badge,
}: {
  name: IconName;
  onPress: () => void;
  label: string;
  active?: boolean;
  size?: number;
  badge?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active === undefined ? undefined : { selected: active }}
      style={({ pressed }) => [k.iconBtn, active && k.iconBtnOn, pressed && { opacity: 0.7 }]}
    >
      <Ionicons name={name} size={size} color={active ? C.accentText : C.muted} />
      {badge ? (
        <View style={k.badge}><Text style={k.badgeText}>{badge}</Text></View>
      ) : null}
    </Pressable>
  );
}

// Text tabs with an accent underline.
export function UnderlineTabs<T extends string>({
  items, value, onChange, right,
}: {
  items: readonly { id: T; label: string }[];
  value: T | null;
  onChange: (id: T) => void;
  right?: ReactNode;
}) {
  // The tabs scroll horizontally: at a large font scale three tabs
  // ("Positions (12)" / "Performance" / "Trades") overflow a phone row, and
  // Android CUTS overflowing text. A scroll row
  // never clips a label; the right slot stays pinned outside it.
  return (
    <View style={k.utabs} accessibilityRole="tablist">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={k.utabsScroll}
        contentContainerStyle={k.utabsContent}
      >
        {items.map((it) => {
          const on = it.id === value;
          return (
            <Pressable
              key={it.id}
              onPress={() => onChange(it.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={k.utab}
            >
              <Text style={[k.utabText, on && k.utabTextOn]}>{it.label}</Text>
              <View style={[k.utabBar, on && k.utabBarOn]} />
            </Pressable>
          );
        })}
      </ScrollView>
      {right ? <View style={k.utabsRight}>{right}</View> : null}
    </View>
  );
}

// A toggle pill (quick filters, filter choices).
export function Pill({
  label, on, onPress, count, icon,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  count?: number;
  icon?: IconName;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={({ pressed }) => [k.pill, on && k.pillOn, pressed && { opacity: 0.75 }]}
    >
      {icon ? <Ionicons name={icon} size={12} color={on ? C.accentText : C.muted} /> : null}
      <Text style={[k.pillText, on && k.pillTextOn]}>{label}</Text>
      {count ? <Text style={[k.pillCount, on && k.pillTextOn]}>{count}</Text> : null}
    </Pressable>
  );
}

export function Button({
  label, onPress, variant = "outline", disabled, icon, style,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "outline" | "ghost" | "danger";
  disabled?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const fg = variant === "primary" ? "#ffffff" : variant === "danger" ? C.bear : variant === "ghost" ? C.accent : C.text;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        k.btn,
        variant === "primary" && k.btnPrimary,
        variant === "outline" && k.btnOutline,
        variant === "danger" && k.btnDanger,
        variant === "ghost" && k.btnGhost,
        disabled && { opacity: 0.45 },
        pressed && !disabled && { opacity: 0.8 },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={15} color={fg} /> : null}
      <Text style={[k.btnText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

// ---- values -----------------------------------------------------------------

// Label over value, two separate Text nodes (Android clipping).
export function StatTile({ label, value, color, style }: { label: string; value: string; color?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[k.tile, style]}>
      <Text style={k.tileLabel}>{label}</Text>
      <Text style={[k.tileValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

// Inline label + value row (separate Text nodes; the label shrinks first).
export function KV({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={k.kv}>
      <Text style={k.kvLabel}>{label}</Text>
      <Text style={[k.kvValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

// ---- bottom sheet -----------------------------------------------------------

// Phone-scoped bottom sheet: a transparent Modal with
// a dimmed backdrop; tapping the backdrop or Android back closes it.
//
// Keyboard: number inputs (Lev / Px / Vol) sit near the sheet's foot. With
// Android 15+ edge-to-edge the window is not guaranteed to resize for the
// IME, so a KeyboardAvoidingView pads by the MEASURED overlap - correct
// whether or not the window resized (no overlap -> no padding). The inner
// ScrollView then keeps the focused input reachable.
export function Sheet({
  visible, onClose, title, description, children, maxHeightPct = 0.85,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  maxHeightPct?: number;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={k.sheetWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
        <View style={[k.sheet, { maxHeight: `${Math.round(maxHeightPct * 100)}%`, paddingBottom: insets.bottom + 12 }]}>
          <View style={k.sheetHandle} />
          <View style={k.sheetHead}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={k.sheetTitle}>{title}</Text>
              {description ? <Text style={k.sheetDesc}>{description}</Text> : null}
            </View>
            <IconButton name="close" onPress={onClose} label={"Close " + title} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export const kitStyles = StyleSheet.create({
  // Exposed for screens that need the same text roles without a component.
  eyebrow: { ...F.medium, color: C.faint, fontSize: T.micro, letterSpacing: 0.6, textTransform: "uppercase" },
  caption: { ...F.regular, color: C.faint, fontSize: T.micro, fontVariant: ["tabular-nums"] },
  body: { ...F.regular, color: C.muted, fontSize: T.body },
  num: { ...F.semibold, color: C.text, fontSize: T.body, fontVariant: ["tabular-nums"] },
});

const k = StyleSheet.create({
  card: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: S.radius,
    padding: S.cardPad,
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: S.gutter, marginBottom: 6 },
  brandIcon: { width: 18, height: 18, borderRadius: 5 },
  brandText: { ...F.semibold, color: C.muted, fontSize: T.micro, letterSpacing: 0.8 },
  header: { paddingHorizontal: S.gutter, paddingBottom: 10, gap: 2 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: S.hit },
  h1: { ...F.semibold, color: C.text, fontSize: T.h1, letterSpacing: -0.4, flexShrink: 1 },
  headerSub: { ...F.regular, color: C.faint, fontSize: T.micro, fontVariant: ["tabular-nums"] },
  section: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14, marginBottom: 8 },
  h2: { ...F.semibold, color: C.text, fontSize: T.h2, letterSpacing: -0.2 },
  sectionSub: { ...F.regular, color: C.faint, fontSize: T.micro, marginTop: 2 },
  group: { ...F.semibold, color: C.faint, fontSize: T.micro, letterSpacing: 0.9, marginTop: 18, marginBottom: 8 },
  iconBtn: {
    minWidth: 38, minHeight: 38, borderRadius: 10, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: C.border, backgroundColor: C.card,
  },
  iconBtnOn: { borderColor: C.accentBorder, backgroundColor: C.accentBg },
  badge: {
    position: "absolute", top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3,
    backgroundColor: C.accent, alignItems: "center", justifyContent: "center",
  },
  badgeText: { ...F.semibold, color: "#fff", fontSize: 10 },
  utabs: {
    flexDirection: "row", alignItems: "flex-end", borderBottomWidth: 1, borderBottomColor: C.border,
    minHeight: 40,
  },
  utabsScroll: { flex: 1 },
  utabsContent: { flexDirection: "row", alignItems: "flex-end", gap: 24, paddingHorizontal: S.gutter },
  utabsRight: { paddingRight: S.gutter, paddingBottom: 4, justifyContent: "flex-end" },
  utab: { paddingTop: 6, minHeight: 40, justifyContent: "flex-end" },
  utabText: { ...F.medium, color: C.muted, fontSize: T.body, paddingBottom: 9 },
  utabTextOn: { color: C.text },
  utabBar: { height: 2, borderRadius: 2, backgroundColor: "transparent" },
  utabBarOn: { backgroundColor: C.accent },
  pill: {
    flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderColor: C.border,
    borderRadius: S.radiusSm, paddingHorizontal: 11, paddingVertical: 7, backgroundColor: C.card,
    minHeight: 34,
  },
  pillOn: { borderColor: C.accentBorder, backgroundColor: C.accentBg },
  pillText: { ...F.medium, color: C.muted, fontSize: T.caption },
  pillTextOn: { color: C.accentText },
  pillCount: { ...F.semibold, color: C.faint, fontSize: T.micro },
  btn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, minHeight: S.hit,
    borderRadius: 10, paddingHorizontal: 16,
  },
  btnPrimary: { backgroundColor: C.accent },
  btnOutline: { borderWidth: 1, borderColor: C.borderStrong, backgroundColor: C.card },
  btnDanger: { borderWidth: 1, borderColor: "rgba(255,59,92,0.4)", backgroundColor: C.bearBg },
  btnGhost: { backgroundColor: "transparent" },
  btnText: { ...F.semibold, fontSize: T.body },
  tile: {
    flex: 1, minWidth: 0, backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: S.radiusMd, padding: 12, gap: 4,
  },
  tileLabel: { ...F.regular, color: C.faint, fontSize: T.micro },
  tileValue: { ...F.semibold, color: C.text, fontSize: T.title, fontVariant: ["tabular-nums"] },
  kv: { flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
  kvLabel: { ...F.regular, color: C.faint, fontSize: T.micro, flexShrink: 1 },
  kvValue: { ...F.semibold, color: C.text, fontSize: T.caption, fontVariant: ["tabular-nums"] },
  sheetWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: {
    backgroundColor: C.raised, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1,
    borderColor: C.border, paddingHorizontal: S.gutter,
  },
  sheetHandle: { alignSelf: "center", width: 38, height: 4, borderRadius: 2, backgroundColor: C.borderStrong, marginTop: 8 },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 12 },
  sheetTitle: { ...F.semibold, color: C.text, fontSize: T.h2 },
  sheetDesc: { ...F.regular, color: C.faint, fontSize: T.caption, marginTop: 3 },
});
