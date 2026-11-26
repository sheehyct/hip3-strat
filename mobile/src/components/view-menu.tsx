// The Portfolio view switch: a dropdown chip in the dashboard's DD-chip idiom
// (a chip naming the active value with a caret; tap opens a panel). Built
// from RN primitives - a Pressable chip and a transparent Modal whose card
// is anchored under the chip - so it renders on the web export the visual
// gate screenshots, and it needs no native module (OTA-safe).
import { useCallback, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { C } from "@/theme";

export type PortfolioView = "positions" | "performance" | "trades";

export const VIEWS: { id: PortfolioView; label: string }[] = [
  { id: "positions", label: "Positions" },
  { id: "performance", label: "Performance" },
  { id: "trades", label: "Trades" },
];

function Caret({ color }: { color: string }) {
  return (
    <Svg width={12} height={12} viewBox="0 0 16 16" fill="none" style={s.caret}>
      <Path d="M4 6l4 4 4-4" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function Check() {
  return (
    <Svg width={14} height={14} viewBox="0 0 16 16" fill="none">
      <Path d="M3 8.5l3 3 7-7" stroke={C.bull} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

type Anchor = { x: number; y: number; w: number; h: number };

export function ViewMenu({ value, onChange }: { value: PortfolioView; onChange: (v: PortfolioView) => void }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const ref = useRef<View>(null);
  const { width: winW } = useWindowDimensions();
  const label = VIEWS.find((v) => v.id === value)?.label ?? "Positions";

  const show = useCallback(() => {
    const node = ref.current;
    if (!node) { setOpen(true); return; }
    node.measureInWindow((x, y, w, h) => {
      setAnchor({ x, y, w, h });
      setOpen(true);
    });
  }, []);
  const hide = useCallback(() => setOpen(false), []);

  // Anchored under the chip's right edge; falls back to the top-right corner
  // when a measurement is unavailable (never off-screen).
  const top = anchor ? anchor.y + anchor.h + 6 : 60;
  const right = anchor ? Math.max(8, winW - (anchor.x + anchor.w)) : 14;

  return (
    <>
      <Pressable
        ref={ref}
        onPress={show}
        accessibilityRole="button"
        accessibilityLabel={"View: " + label}
        accessibilityState={{ expanded: open }}
        style={[s.chip, open && s.chipOn]}
      >
        <Text style={[s.chipText, open && s.chipTextOn]}>{label}</Text>
        <Caret color={open ? C.bull : C.muted} />
      </Pressable>
      <Modal transparent visible={open} animationType="fade" onRequestClose={hide}>
        <Pressable style={s.scrim} onPress={hide} accessibilityLabel="close menu">
          <View style={[s.panel, { top, right }]} accessibilityRole="menu">
            {VIEWS.map((v) => {
              const on = v.id === value;
              return (
                <Pressable
                  key={v.id}
                  onPress={() => { onChange(v.id); hide(); }}
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected: on }}
                  style={({ pressed }) => [s.row, on && s.rowOn, pressed && s.rowOn]}
                >
                  <Text style={[s.rowText, on && s.rowTextOn]}>{v.label}</Text>
                  {on ? <Check /> : null}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  chip: {
    flexDirection: "row", alignItems: "center",
    borderWidth: 1, borderColor: C.border, borderRadius: 999,
    paddingLeft: 12, paddingRight: 10, paddingVertical: 5, minHeight: 28,
    backgroundColor: C.card,
  },
  chipOn: { borderColor: "rgba(0,220,130,0.35)", backgroundColor: C.bullBg },
  chipText: { color: C.muted, fontSize: 12, fontWeight: "500" },
  chipTextOn: { color: C.bull },
  caret: { marginLeft: 6 },
  scrim: { flex: 1, backgroundColor: "rgba(9,9,11,0.35)" },
  panel: {
    position: "absolute", width: 190, padding: 4,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 10,
    shadowColor: "#000", shadowOpacity: 0.55, shadowRadius: 16, shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  row: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    minHeight: 44, paddingHorizontal: 12, borderRadius: 7,
  },
  rowOn: { backgroundColor: C.cardActive },
  rowText: { color: C.muted, fontSize: 13, fontWeight: "500" },
  rowTextOn: { color: C.text, fontWeight: "600" },
});
