// Cumulative PnL line(s) over a window, drawn with react-native-svg like the
// existing Sparkline. One series is coloured by its sign (emerald above zero,
// crimson below - the app's semantic accents); several series carry their
// own identity colours and end labels. x is TIME, so gaps stay visible and
// are never interpolated; the zero baseline is a dashed faint line.
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Line, Path, Text as SvgText } from "react-native-svg";

import type { Series } from "@/lib/trades";
import { C } from "@/theme";

export type ChartSeries = {
  data: Series;
  color?: string;        // identity colour; omitted = colour by sign of the last value
  label?: string | null; // end label; omitted = the last value formatted by `fmt`; null = none
  fill?: boolean;        // area tint under the line
};

export function PnlChart({
  series, width, height = 132, startLabel, endLabel, fmt, padRight,
}: {
  series: ChartSeries[];
  width: number;
  height?: number;
  startLabel: string;
  endLabel: string;
  fmt: (v: number) => string;
  padRight?: number;
}) {
  const all = series.flatMap((s) => s.data);
  if (width <= 0 || all.length < 2) {
    return (
      <View style={[s.empty, { width: Math.max(width, 0), height }]}>
        <Text style={s.emptyText}>no history yet</Text>
      </View>
    );
  }
  const padL = 6, padR = padRight ?? 58, padT = 10, padB = 18;
  const tmin = Math.min(...all.map((p) => p[0])), tmax = Math.max(...all.map((p) => p[0]));
  let vmin = Math.min(0, ...all.map((p) => p[1])), vmax = Math.max(0, ...all.map((p) => p[1]));
  const span = vmax - vmin || 1;
  vmin -= span * 0.06; vmax += span * 0.06;
  const iw = Math.max(1, width - padL - padR), ih = Math.max(1, height - padT - padB);
  const X = (t: number) => padL + ((t - tmin) / (tmax - tmin || 1)) * iw;
  const Y = (v: number) => padT + (1 - (v - vmin) / (vmax - vmin)) * ih;
  const y0 = Y(0);

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Line x1={padL} y1={y0} x2={padL + iw} y2={y0} stroke="rgba(255,255,255,0.18)" strokeWidth={1} strokeDasharray="3 4" />
      {series.map((sr, i) => {
        if (sr.data.length < 2) return null;
        const last = sr.data[sr.data.length - 1];
        const color = sr.color ?? (last[1] >= 0 ? C.bull : C.bear);
        const d = sr.data.map(([t, v], j) => (j ? "L" : "M") + X(t).toFixed(1) + " " + Y(v).toFixed(1)).join(" ");
        const area = d + " L" + X(last[0]).toFixed(1) + " " + y0.toFixed(1) + " L" + X(sr.data[0][0]).toFixed(1) + " " + y0.toFixed(1) + " Z";
        return (
          <G key={i}>
            {sr.fill ? <Path d={area} fill={color} fillOpacity={0.1} /> : null}
            <Path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <Circle cx={X(last[0])} cy={Y(last[1])} r={3.5} fill={color} stroke={C.card} strokeWidth={2} />
            {sr.label === null ? null : (
              <SvgText x={X(last[0]) + 7} y={Y(last[1]) + 3.5} fontSize={10.5} fontWeight="600" fill={color}>
                {sr.label ?? fmt(last[1])}
              </SvgText>
            )}
          </G>
        );
      })}
      <SvgText x={padL} y={height - 4} fontSize={9.5} fill={C.faint}>{startLabel}</SvgText>
      <SvgText x={padL + iw} y={height - 4} fontSize={9.5} fill={C.faint} textAnchor="end">{endLabel}</SvgText>
      {/* the baseline label yields to an end label sitting on the baseline */}
      {series.some((sr) => sr.label !== null && sr.data.length > 1 && Math.abs(Y(sr.data[sr.data.length - 1][1]) - y0) < 10)
        ? null
        : <SvgText x={padL + iw + 4} y={y0 + 3.5} fontSize={9.5} fill={C.faint}>0</SvgText>}
    </Svg>
  );
}

const s = StyleSheet.create({
  empty: { alignItems: "center", justifyContent: "center" },
  emptyText: { color: C.faint, fontSize: 11, fontVariant: ["tabular-nums"] },
});
