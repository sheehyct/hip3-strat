// Screener controls, collapsed: the dashboard's Filters /
// Patterns dropdown chips plus a Sort chip, one row tall when closed. Each
// chip opens ONE inline panel at a time; the list below keeps the rest of the
// screen. An active filter is never invisible while the panels are shut: the
// chip carries the dashboard's count badge and a one-line summary under the
// row names every active dimension with a one-tap Clear (the lesson
// behind it - a persisted scope once made a healthy feed read as dead).
//
// UI state only. Every rule lives in src/lib/filters.ts (the dashboard's
// filter model); nothing here classifies a bar or detects a pattern.
import { ReactNode, useEffect, useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import Ionicons from "@expo/vector-icons/Ionicons";

import { CategoryId, PERP_CATEGORIES } from "@/lib/categories";
import {
  applyPreset, Filters, parsePositive, parseVolAmount, SIGTF_LABELS, STAGES, toggleIn, UniKey,
  VOL_OPS, volText,
} from "@/lib/filters";
import { PATTERN_FAMILIES } from "@/lib/patterns";
import { C } from "@/theme";

export type PanelId = "filters" | "patterns" | "sort";
export type SortOption = { id: string; label: string };

// Every active dimension as a short token, in the panel's row order.
function summaryTokens(f: Filters, uni: UniKey, category: CategoryId): string[] {
  const t: string[] = [];
  if (f.favs) t.push("Favs");
  if (f.inside) t.push("Inside bars");
  if (f.movers) t.push("Movers");
  if (f.ftfc) t.push("FTFC " + f.ftfc);
  if (f.dir) t.push("Dir " + f.dir);
  if (f.stages.length)
    t.push(STAGES.filter((s) => f.stages.includes(s.id)).map((s) => s.label).join(", "));
  if (f.tfs.length) t.push(SIGTF_LABELS.filter((l) => f.tfs.includes(l)).join(", "));
  if (f.levMin !== null) t.push("Lev >= " + f.levMin);
  if (f.pxMax !== null) t.push("Px <= " + f.pxMax);
  const vd = f.vol[uni];
  if (vd.n !== null) t.push("Vol " + (VOL_OPS.find((o) => o.id === vd.op)?.label ?? ">=") + " " + volText(vd.n));
  if (category !== "all") t.push(PERP_CATEGORIES.find((c) => c.id === category)?.label ?? category);
  if (f.pats.length)
    t.push(PATTERN_FAMILIES.filter((p) => f.pats.includes(p.id)).map((p) => p.label).join(", "));
  return t;
}

export function FilterBar({
  filters, onFilters, universe, category, onCategory, onClearAll, resetKey, sorts, sortKey, sortDesc,
  onSort, open, onOpen, filterCount, shown, total, panelMaxHeight,
}: {
  filters: Filters;
  onFilters: (f: Filters) => void;
  universe: UniKey;
  category: CategoryId;
  onCategory: (c: CategoryId) => void;
  // Clears every filter dimension AND the category (the summary's Clear).
  onClearAll: () => void;
  // Bumped by the parent on a whole-filter reset; remounts the number boxes.
  resetKey: number;
  sorts: readonly SortOption[];
  sortKey: string;
  sortDesc: boolean;
  onSort: (id: string) => void;
  open: PanelId | null;
  onOpen: (p: PanelId | null) => void;
  filterCount: number;
  shown: number;
  total: number;
  panelMaxHeight: number;
}) {
  const f = filters;
  const set = (patch: Partial<Filters>) => onFilters({ ...f, ...patch });
  const toggle = (p: PanelId) => onOpen(open === p ? null : p);
  const sortLabel = sorts.find((o) => o.id === sortKey)?.label ?? "";
  const tokens = summaryTokens(f, universe, category);
  // Presets re-key the number boxes too, so a junk amount (already "off" in
  // state) cannot survive a reset as text with a warning border. The
  // universe is part of the key because the volume box edits THAT
  // universe's bound.
  const [epoch, setEpoch] = useState(0);
  const boxKey = universe + ":" + resetKey + ":" + epoch;
  const preset = (p: "all" | "actionable") => { onFilters(applyPreset(p)); setEpoch((n) => n + 1); };
  // The Lev / Px / Vol boxes sit at the panel's foot, where the soft keyboard
  // lands. While it is up, the panel shrinks and scrolls to its end so the box
  // being typed in stays above it.
  const scrollRef = useRef<ScrollView>(null);
  const [kbUp, setKbUp] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => {
      setKbUp(true);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => setKbUp(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  return (
    <View style={s.wrap}>
      <View style={s.chipRow}>
        <DropChip label="Filters" count={filterCount} on={open === "filters"} onPress={() => toggle("filters")} />
        <DropChip label="Patterns" count={f.pats.length} on={open === "patterns"} onPress={() => toggle("patterns")} />
        <DropChip
          label={"Sort: " + sortLabel}
          dir={sortDesc ? "down" : "up"}
          on={open === "sort"}
          onPress={() => toggle("sort")}
        />
      </View>

      {tokens.length > 0 && (
        <View style={s.summary}>
          <Pressable
            onPress={() => onOpen(open === "filters" ? null : "filters")}
            style={s.summaryText}
            accessibilityRole="button"
            accessibilityLabel={"Active filters: " + tokens.join(", ") + ". Showing " + shown + " of " + total + ". Tap to edit."}
          >
            <Text style={s.summaryCount}>{shown + "/" + total}</Text>
            <Text style={s.summaryTokens}>{tokens.join("  \u00b7  ")}</Text>
          </Pressable>
          <Pressable
            onPress={onClearAll}
            hitSlop={10}
            style={({ pressed }) => [s.clear, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Clear every filter"
          >
            <Ionicons name="close" size={13} color={C.info} />
            <Text style={s.clearText}>Clear</Text>
          </Pressable>
        </View>
      )}

      {open !== null && (
        <View style={[s.panel, { maxHeight: kbUp ? Math.round(panelMaxHeight * 0.45) : panelMaxHeight }]}>
          <ScrollView ref={scrollRef} keyboardShouldPersistTaps="handled" contentContainerStyle={s.panelBody}>
            {open === "filters" && (
              <>
                <Row label="Preset">
                  <Pill label="All" on={false} onPress={() => preset("all")} />
                  <Pill label="Actionable now" on={false} onPress={() => preset("actionable")} />
                </Row>
                <Row label="Show">
                  <Pill label="Favs" on={f.favs} onPress={() => set({ favs: !f.favs })} />
                  <Pill label="Inside bars" on={f.inside} onPress={() => set({ inside: !f.inside })} />
                  <Pill label="Movers" on={f.movers} onPress={() => set({ movers: !f.movers })} />
                </Row>
                <Row label="FTFC">
                  <Pill label="Up" on={f.ftfc === "up"} onPress={() => set({ ftfc: f.ftfc === "up" ? null : "up" })} />
                  <Pill label="Down" on={f.ftfc === "down"} onPress={() => set({ ftfc: f.ftfc === "down" ? null : "down" })} />
                </Row>
                <Row label="Dir">
                  <Pill label="Up" on={f.dir === "up"} onPress={() => set({ dir: f.dir === "up" ? null : "up" })} />
                  <Pill label="Down" on={f.dir === "down"} onPress={() => set({ dir: f.dir === "down" ? null : "down" })} />
                </Row>
                <Row label="Sig TF">
                  {SIGTF_LABELS.map((l) => (
                    <Pill key={l} label={l} on={f.tfs.includes(l)} onPress={() => set({ tfs: toggleIn(f.tfs, l) })} />
                  ))}
                </Row>
                <Row label="Stage">
                  {STAGES.map((st) => (
                    <Pill key={st.id} label={st.label} on={f.stages.includes(st.id)}
                      onPress={() => set({ stages: toggleIn(f.stages, st.id) })} />
                  ))}
                </Row>
                {universe === "perps" && (
                  <Row label="Cats">
                    {PERP_CATEGORIES.map((c) => (
                      <Pill key={c.id} label={c.label} on={category === c.id} onPress={() => onCategory(c.id)} />
                    ))}
                  </Row>
                )}
                <Row label="Lev >=">
                  <NumberBox key={"lev" + boxKey} value={f.levMin} onValue={(v) => set({ levMin: v })} label="minimum venue leverage" />
                  <Text style={s.rowLabelInline}>Px &lt;=</Text>
                  <NumberBox key={"px" + boxKey} value={f.pxMax} onValue={(v) => set({ pxMax: v })} label="maximum price" />
                </Row>
                <Row label="24h Vol">
                  {VOL_OPS.map((o) => (
                    <Pill key={o.id} label={o.label} on={f.vol[universe].op === o.id} compact
                      onPress={() => set({ vol: { ...f.vol, [universe]: { ...f.vol[universe], op: o.id } } })} />
                  ))}
                  <VolBox
                    key={"vol" + boxKey}
                    value={f.vol[universe].n}
                    onValue={(n) => set({ vol: { ...f.vol, [universe]: { ...f.vol[universe], n } } })}
                  />
                  <Text style={s.hint}>{universe === "perps" ? "(crypto)" : "(HIP-3)"}</Text>
                </Row>
                <Text style={s.help}>
                  Dir, Sig TF, Stage and Patterns pick which signal a card shows and hide coins
                  with none. Unknown leverage or volume never passes a bound. Volume takes 500k,
                  1m, 2.5b; each universe keeps its own.
                </Text>
              </>
            )}
            {open === "patterns" && (
              <>
                <View style={s.pills}>
                  {PATTERN_FAMILIES.map((p) => (
                    <Pill key={p.id} label={p.label} on={f.pats.includes(p.id)}
                      onPress={() => set({ pats: toggleIn(f.pats, p.id) })} />
                  ))}
                </View>
                <View style={s.panelFoot}>
                  <Text style={s.hint}>None selected = every pattern.</Text>
                  {f.pats.length > 0 && (
                    <Pressable onPress={() => set({ pats: [] })} hitSlop={10} accessibilityRole="button">
                      <Text style={s.clearText}>Clear</Text>
                    </Pressable>
                  )}
                </View>
              </>
            )}
            {open === "sort" && (
              <>
                <View style={s.pills}>
                  {sorts.map((o) => {
                    const on = sortKey === o.id;
                    return (
                      <Pill key={o.id} label={o.label + (on ? (sortDesc ? " v" : " ^") : "")} on={on} tone="bull"
                        onPress={() => onSort(o.id)} />
                    );
                  })}
                </View>
                <Text style={s.hint}>Tap the active key again to flip direction. Favorites stay on top.</Text>
              </>
            )}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

// `dir` is the sort direction, drawn as an arrow so it cannot be mistaken for
// the open/close chevron beside it.
function DropChip({ label, count, dir, on, onPress }: {
  label: string; count?: number; dir?: "up" | "down"; on: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.drop, on && s.dropOn, pressed && { opacity: 0.7 }]}
      accessibilityRole="button"
      accessibilityState={{ expanded: on }}
      accessibilityLabel={label + (dir ? (dir === "down" ? " descending" : " ascending") : "") + (count ? ", " + count + " active" : "")}
    >
      <Text style={[s.dropText, on && s.dropTextOn]}>{label}</Text>
      {dir ? <Ionicons name={dir === "down" ? "arrow-down" : "arrow-up"} size={12} color={C.bull} /> : null}
      {count ? (
        <View style={s.badge}><Text style={s.badgeText}>{count}</Text></View>
      ) : null}
      <Ionicons name={on ? "chevron-up" : "chevron-down"} size={12} color={on ? C.text : C.faint} />
    </Pressable>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label.toUpperCase()}</Text>
      <View style={s.pills}>{children}</View>
    </View>
  );
}

function Pill({ label, on, onPress, tone = "info", compact }: {
  label: string; on: boolean; onPress: () => void; tone?: "info" | "bull"; compact?: boolean;
}) {
  const onStyle = tone === "bull" ? s.pillOnBull : s.pillOn;
  const onText = tone === "bull" ? s.pillTextOnBull : s.pillTextOn;
  return (
    <Pressable
      onPress={onPress}
      style={[s.pill, compact && s.pillCompact, on && onStyle]}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
    >
      <Text style={[s.pillText, on && onText]}>{label}</Text>
    </Pressable>
  );
}

// Lev / Px: the text is local so typing "0." or clearing mid-edit is not
// clobbered; the parsed value commits on every change. A preset or Clear
// that changes the value from outside resets the text.
function NumberBox({ value, onValue, label }: { value: number | null; onValue: (v: number | null) => void; label: string }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    if (parsePositive(text) !== value) setText(value === null ? "" : String(value));
  }, [value]);
  return (
    <TextInput
      style={s.num}
      value={text}
      onChangeText={(t) => { setText(t); onValue(parsePositive(t)); }}
      placeholder="any"
      placeholderTextColor={C.faint}
      keyboardType="decimal-pad"
      accessibilityLabel={label}
    />
  );
}

// 24h volume amount: digits or a k/m/b suffix, so the default keyboard (a
// numeric pad blocks the suffix on some keyboards).
// Junk turns the bound OFF and flags the box - never a guess.
function VolBox({ value, onValue }: { value: number | null; onValue: (n: number | null) => void }) {
  const [text, setText] = useState(value === null ? "" : volText(value));
  const bad = text.trim() !== "" && parseVolAmount(text) === null;
  useEffect(() => {
    if (parseVolAmount(text) !== value) setText(value === null ? "" : volText(value));
  }, [value]);
  return (
    <TextInput
      style={[s.num, s.volNum, bad && s.numBad]}
      value={text}
      onChangeText={(t) => { setText(t); onValue(parseVolAmount(t)); }}
      placeholder="any"
      placeholderTextColor={C.faint}
      autoCapitalize="none"
      autoCorrect={false}
      accessibilityLabel="24 hour volume amount, for example 500k or 1m"
    />
  );
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 14, marginBottom: 8, flexShrink: 0 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  drop: {
    flexDirection: "row", alignItems: "center", gap: 5,
    borderWidth: 1, borderColor: C.border, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, backgroundColor: C.card,
  },
  dropOn: { borderColor: "rgba(59,130,246,0.45)" },
  dropText: { color: C.muted, fontSize: 12, fontWeight: "500" },
  dropTextOn: { color: C.text },
  badge: {
    minWidth: 16, paddingHorizontal: 4, borderRadius: 999, backgroundColor: C.infoBg,
    alignItems: "center",
  },
  badgeText: { color: C.info, fontSize: 10.5, fontWeight: "600", fontVariant: ["tabular-nums"] },
  summary: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 6 },
  summaryText: { flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", columnGap: 8 },
  summaryCount: { color: C.muted, fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"], lineHeight: 16 },
  summaryTokens: { color: C.info, fontSize: 11, flexShrink: 1, lineHeight: 16 },
  clear: { flexDirection: "row", alignItems: "center", gap: 2 },
  clearText: { color: C.info, fontSize: 11.5, fontWeight: "600", lineHeight: 16 },
  // No overflow clipping: the ScrollView clips its own content, and a clipped
  // box cut the last line of a paragraph on a phone at a large font scale before.
  panel: {
    marginTop: 8, borderWidth: 1, borderColor: C.border, borderRadius: 10, backgroundColor: C.card,
  },
  panelBody: { padding: 10, gap: 8 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  rowLabel: {
    // minWidth, not width: a one-word label at a large font scale must widen
    // the column rather than be cut.
    minWidth: 54, paddingTop: 6, color: C.faint, fontSize: 9.5, fontWeight: "500", letterSpacing: 0.6,
  },
  rowLabelInline: { color: C.faint, fontSize: 9.5, fontWeight: "500", letterSpacing: 0.6, alignSelf: "center" },
  pills: { flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" },
  pill: {
    borderWidth: 1, borderColor: C.border, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 4,
  },
  pillCompact: { paddingHorizontal: 8 },
  pillOn: { borderColor: "rgba(59,130,246,0.35)", backgroundColor: C.infoBg },
  pillOnBull: { borderColor: "rgba(0,220,130,0.35)", backgroundColor: C.bullBg },
  pillText: { color: C.muted, fontSize: 12, fontWeight: "500", fontVariant: ["tabular-nums"] },
  pillTextOn: { color: C.info },
  pillTextOnBull: { color: C.bull },
  // Fixed widths: a web TextInput's intrinsic width is ~20 characters, which
  // pushed Px onto its own line at 390px.
  num: {
    width: 68, borderWidth: 1, borderColor: C.input, borderRadius: 8,
    paddingHorizontal: 9, paddingVertical: 4, color: C.text, fontSize: 12.5,
  },
  volNum: { width: 80 },
  numBad: { borderColor: C.warn },
  hint: { color: C.faint, fontSize: 10.5, lineHeight: 15, flexShrink: 1 },
  help: { color: C.faint, fontSize: 10.5, lineHeight: 15, flexShrink: 1, marginTop: 2 },
  panelFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 },
});
