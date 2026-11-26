import { StyleSheet, Text, View } from "react-native";
import Svg, { Polyline } from "react-native-svg";

import { C } from "@/theme";

export function Sparkline({
  points,
  width = 72,
  height = 24,
}: {
  points?: number[] | null;
  width?: number;
  height?: number;
}) {
  const values = (points ?? []).filter((point) => isFinite(point));
  if (values.length < 2) {
    return (
      <View style={[s.empty, { width, height }]}>
        <Text style={s.emptyText}>---</Text>
      </View>
    );
  }

  const pad = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const dx = width / (values.length - 1);
  const y = (point: number) =>
    pad + (1 - (point - min) / range) * (height - 2 * pad);
  const path = values
    .map((point, index) => `${(index * dx).toFixed(1)},${y(point).toFixed(1)}`)
    .join(" ");
  const color = values[values.length - 1] >= values[0] ? C.bull : C.bear;

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Polyline
        points={path}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
}

const s = StyleSheet.create({
  empty: { alignItems: "center", justifyContent: "center" },
  emptyText: { color: C.faint, fontSize: 9, fontVariant: ["tabular-nums"] },
});
