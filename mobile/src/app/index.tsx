// Screener tab: renders the worker's /api/state snapshot. All STRAT
// detection ran server-side; everything below is display aggregation
// (counting, filtering, sorting) over server output.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Ionicons from "@expo/vector-icons/Ionicons";

import { FilterBar, PanelId } from "@/components/filter-bar";
import { Sparkline } from "@/components/sparkline";
import { BarBadge, Chip, Dot, MagnitudeBar } from "@/components/ui";
import {
  ApiState, Coin, distToTargetPct, fetchState, LiveSig, magProgress, magRemaining, Setup,
  sigInForce, TF_ORDER, UniverseId, UNIVERSES,
} from "@/lib/api";
import { CategoryId, coinCategory } from "@/lib/categories";
import { buildSignalChips } from "@/lib/chips";
import { applyPreset, defaultFilters, filterCount, Filters, rowPasses, sigDimsActive } from "@/lib/filters";
import { fmtChg24, fmtPct, fmtPx, fmtSigned, fmtVol } from "@/lib/fmt";
import {
  focusCandidate, focusDist, focusEntry, focusInForce, FocusItem, focusMagLeft, focusProgress,
  focusRank, matchedItems, provText, setupAwayPct, slowFtfcRank, slowLayer, targetItem,
} from "@/lib/focus";
import { famAllowed } from "@/lib/patterns";
import { syncFavoritesToPush } from "@/lib/push";
import {
  getFavorites,
  getFilters,
  getUniverse,
  getWorkerUrl,
  setFavorites,
  setFilters as storeFilters,
  setUniverse,
} from "@/lib/store";
import { tvHref, tvSymbol } from "@/lib/tv";
import { C } from "@/theme";

// The dashboard's Command sort chip, key for key and in its order (design
// decision: match the chip). Vol and RVOL left with it - the Command card
// no longer prints either number, so sorting by them ranked the list on an
// invisible quantity (both still show in the detail TAPE). Trend % is the one
// chip key not offered: it ranks the sparkline trend, which lives in the
// detail sheet here for the same reason. Ids are the dashboard's own sort
// keys and every ranking rule is a pre-existing dashboard sort - the strip
// adds no ranking of its own. Volume stays as the tiebreak, not a key.
const SORTS = [
  { id: "name", label: "Symbol" },
  { id: "px", label: "Price" },
  { id: "chg", label: "24h %" },
  { id: "chgutc", label: "Day %" },
  { id: "score", label: "Score" },
  { id: "focus", label: "Signal" },
  { id: "prog", label: "Progress" },
  { id: "dist", label: "Tgt %" },
  { id: "magleft", label: "Mag Left" },
  { id: "slowftfc", label: "D/W/M" },
] as const;
type SortId = (typeof SORTS)[number]["id"];
// Symbol is the one string key; the comparator handles it directly and the
// numeric keys go through sortValue below.
type NumericSortId = Exclude<SortId, "name">;

// null = no reading (unready score, missing mid or chg24, no in-force
// signal for the To Target keys, no magnitude for Progress). Callers sink
// nulls in BOTH sort directions - the dashboard's own rule for its sorts. The
// -Infinity idiom this replaces flipped every null coin to the TOP on an
// ascending sort, exactly the bug the scanner side documented and avoided.
// "focus" and "slowftfc" are RANKS, never null: a coin with no signal ranks 0
// (bottom descending, top ascending), as the dashboard's simpleFocusRank does.
function sortValue(c: Coin, k: NumericSortId, item: FocusItem | null): number | null {
  let v: number | null;
  switch (k) {
    case "px": v = c.mid; break;
    case "chg": v = c.chg24; break;
    case "chgutc": v = c.chgUtc ?? null; break;
    case "score": v = c.score; break;
    case "dist": v = focusDist(item, c.mid); break;
    case "magleft": v = focusMagLeft(item, c.mid); break;
    case "prog": v = focusProgress(item, c.mid); break;
    case "focus": v = focusRank(item); break;
    case "slowftfc": v = slowFtfcRank(c); break;
    default: v = null;
  }
  return v === null || !isFinite(v) ? null : v;
}

// Non-continuation live signals by direction over the configured FTFC set
// (mirrors the dashboard's stat strip; counting only, no detection).
function liveByDir(c: Coin, tfs: string[]) {
  let up = 0, down = 0;
  for (const id of tfs) {
    const an = c.tf[id];
    if (!an) continue;
    for (const l of an.live) {
      if (l.kind === "cont") continue;
      if (l.dir === "up") up++; else down++;
    }
  }
  return { up, down };
}

// The dashboard's sum.hasInsideSetup: last CLOSED bar is a 1 on an active
// timeframe. Its default actives (15m / 1H / 4H / D) are exactly the served
// ftfcTfs, so that set - the same one the FTFC filter and stats read.
function hasInsideSetup(c: Coin, tfs: string[]) {
  return tfs.some((id) => {
    const an = c.tf[id];
    return !!an && an.types.length > 0 && an.types[an.types.length - 1] === "1";
  });
}

export default function Screener() {
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
  const [data, setData] = useState<ApiState | null>(null);
  const [error, setError] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  // The Command view opens on Signal descending (the dashboard's
  // simpleSortKey default).
  const [sortKey, setSortKey] = useState<SortId>("focus");
  const [sortDesc, setSortDesc] = useState(true);
  const [favs, setFavs] = useState<string[]>([]);
  const [universe, setUni] = useState<UniverseId>("xyz");
  const [category, setCategory] = useState<CategoryId>("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [fetchedAt, setFetchedAt] = useState(0);
  // Worker feed clocks, anchored the dashboard's way: epoch = receipt time
  // minus the served age, so a stalled exchange feed renders AS stalled
  // instead of resetting to fresh on every successful HTTP receipt. Missing
  // fields (older worker) anchor at receipt time - additive contract,
  // missing = unknown, never warn.
  const [feedAnchors, setFeedAnchors] = useState<{ mids: number; candles: number } | null>(null);
  // The dashboard's filter state (persisted, whitelist-validated). One open
  // panel at a time; all shut is the resting state.
  const [filters, setFilterState] = useState<Filters>(defaultFilters);
  const [panel, setPanel] = useState<PanelId | null>(null);
  // Bumped by every whole-filter reset so the panel's number boxes drop any
  // unparsed text they hold (a junk amount is already "off" in state, so a
  // reset alone would not change their value).
  const [resetN, setResetN] = useState(0);
  const urlRef = useRef<string>("");
  const filtersTouchedRef = useRef(false);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    getFavorites().then(setFavs);
    getUniverse().then(setUni); // hydrate persisted universe
    getFilters().then((f) => {
      if (!filtersTouchedRef.current) setFilterState(f);
    });
  }, []);

  const onFilters = useCallback((next: Filters) => {
    filtersTouchedRef.current = true;
    setFilterState(next);
    storeFilters(next); // fire-and-forget persist
  }, []);

  // Switching universe persists the choice, resets the category filter, and
  // (via load's `universe` dependency below) triggers an immediate refetch of
  // the newly selected universe rather than waiting for the next 15s tick.
  const onUniverse = useCallback((u: UniverseId) => {
    if (u === universe) return;
    requestSeqRef.current++;
    setUni(u);
    setUniverse(u); // fire-and-forget persist
    setCategory("all");
    // Do not let the prior universe's loaded snapshot masquerade as the new
    // one while the immediate refetch is in flight. Feed ages are served per
    // requested universe, so they reset with the snapshot.
    setData(null);
    setFetchedAt(0);
    setFeedAnchors(null);
    setError("");
  }, [universe]);

  // One tap / re-tap-flips, as the old sort strip did. Symbol opens A-Z;
  // every numeric key opens descending, as the dashboard's chip does
  // (k === "name" ? 1 : -1).
  const onSort = useCallback((id: string) => {
    const k = id as SortId;
    if (k === sortKey) setSortDesc((d) => !d);
    else { setSortKey(k); setSortDesc(k !== "name"); }
  }, [sortKey]);

  const toggleFav = useCallback((sym: string) => {
    setFavs((prev) => {
      const next = prev.includes(sym) ? prev.filter((s) => s !== sym) : [...prev, sym];
      // fire-and-forget: persist, then refresh the push registration so the
      // worker's favorites scoping follows the stars (no-op if not registered)
      setFavorites(next).then(syncFavoritesToPush);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    const requestId = ++requestSeqRef.current;
    try {
      if (!urlRef.current) urlRef.current = await getWorkerUrl();
      const s = await fetchState(urlRef.current, universe);
      if (requestId !== requestSeqRef.current) return;
      setData(s);
      setFetchedAt(Date.now());
      setFeedAnchors({
        mids: Date.now() - (typeof s.midsAgeMs === "number" ? s.midsAgeMs : 0),
        candles: Date.now() - (typeof s.candlesAgeMs === "number" ? s.candlesAgeMs : 0),
      });
      setError("");
    } catch (e) {
      if (requestId !== requestSeqRef.current) return;
      setError(e instanceof Error ? e.message : "fetch failed");
    }
  }, [universe]);

  // `load` changes identity when `universe` changes, so this effect re-runs on
  // a switch: it clears the old timer, fetches the new universe immediately,
  // and restarts the 15s poll.
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = useCallback(async () => {
    urlRef.current = ""; // re-read settings in case the worker URL changed
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const ftfcTfs = useMemo(
    () => data?.ftfcTfs ?? ["15m", "1h", "4h", "1d"],
    [data]
  );

  // Client-side universe filter (belt and suspenders): the server already
  // filters via ?uni=, but an older worker returns all universes. Coins that
  // predate the `uni` field (undefined) always pass.
  const universeCoins = useMemo(
    () => (data?.coins ?? []).filter((c) => c.uni == null || c.uni === universe),
    [data, universe]
  );

  // Pattern scope for the expanded card's chip row. The dashboard feeds its
  // signal-chip column the pattern selection ONLY (sigChips(..., allowPat)),
  // not dir / sig TF / stage, so the roster one tap away stays whole on those.
  const famAllow = useMemo(
    () =>
      filters.pats.length
        ? (_tf: string, sig: LiveSig | Setup) => famAllowed(filters.pats, sig.name)
        : undefined,
    [filters.pats],
  );

  // The MATCHED signal per coin (the card's Focus), computed ONCE per
  // payload/filter state so the row filter, the sort comparator and the cards
  // read the same item - the dashboard threads simpleCandidate through all
  // three for the same reason.
  const matched = useMemo(() => {
    const m = new Map<string, { items: FocusItem[]; focus: FocusItem | null }>();
    for (const c of universeCoins) {
      const items = matchedItems(c, filters);
      m.set(c.name, { items, focus: focusCandidate(items) });
    }
    return m;
  }, [universeCoins, filters]);

  // The dashboard's row chain: search, category, the coin-level dimensions,
  // then - when a signal dimension is on - coins with no matching signal drop
  // out (a D filter is a clean list of D signals).
  const rows = useMemo(() => {
    const q = search.trim().toUpperCase();
    const sigOn = sigDimsActive(filters);
    const list = universeCoins.filter((c) => {
      if (q && !c.sym.toUpperCase().includes(q)) return false;
      if (universe === "perps" && category !== "all" && coinCategory(c) !== category) return false;
      if (!rowPasses(filters, universe, {
        fav: favs.includes(c.sym), inside: hasInsideSetup(c, ftfcTfs), ftfc: c.ftfc,
        maxLeverage: c.maxLeverage, px: c.mid || c.mark || 0, vol: c.vol,
        rvol: c.rvol, r5: c.mom.r5, r15: c.mom.r15,
      })) return false;
      if (sigOn && !(matched.get(c.name)?.items.length)) return false;
      return true;
    });
    const dir = sortDesc ? -1 : 1;
    return list.sort((a, b) => {
      // Favorites float to the top whatever the sort below says - the promise
      // the dashboard's star tooltip makes ("stays on top of any sort", vendored
      // in display_core's starSpan).
      const favDiff = Number(favs.includes(b.sym)) - Number(favs.includes(a.sym));
      if (favDiff !== 0) return favDiff;
      // Symbol: the dashboard compares coin.sym with plain < / > (no locale
      // collation), ties at 0, and opens it ascending = A-Z - the same sign
      // as this branch since the scanner fixed its name
      // comparator, so the former divergence is retired.
      if (sortKey === "name") return a.sym === b.sym ? 0 : a.sym < b.sym ? -dir : dir;
      const av = sortValue(a, sortKey, matched.get(a.name)?.focus ?? null),
        bv = sortValue(b, sortKey, matched.get(b.name)?.focus ?? null);
      // No-reading coins sink whichever way the sort points; ties (including
      // null-null) fall back to volume so the order stays stable.
      if (av === null || bv === null) {
        if (av !== null) return -1;
        if (bv !== null) return 1;
        return b.vol - a.vol;
      }
      return av === bv ? b.vol - a.vol : av < bv ? -dir : dir;
    });
  }, [universeCoins, search, universe, category, filters, ftfcTfs, favs, sortKey, sortDesc, matched]);

  const stats = useMemo(() => {
    let liveUp = 0, liveDown = 0, ftfcUp = 0, ftfcDown = 0;
    for (const c of universeCoins) {
      const d = liveByDir(c, ftfcTfs);
      liveUp += d.up;
      liveDown += d.down;
      if (c.ftfc === "up") ftfcUp++;
      if (c.ftfc === "down") ftfcDown++;
    }
    return { liveUp, liveDown, ftfcUp, ftfcDown };
  }, [universeCoins, ftfcTfs]);

  const nFilters = filterCount(filters, universe, universe === "perps" && category !== "all");
  const anyFilter = nFilters + filters.pats.length > 0;
  const clearAll = useCallback(() => {
    onFilters(applyPreset("all"));
    setCategory("all");
    setResetN((n) => n + 1);
  }, [onFilters]);

  const age = fetchedAt ? Math.round((Date.now() - fetchedAt) / 1000) : null;
  // Worker feed ages tick off the receipt-anchored epochs, exactly like the
  // dashboard's status-bar clocks ("mids Ns ago / candles Ns ago"). Rendered
  // on the status line below the header, never appended to the "updated"
  // sub: there they clipped off the right edge at real device font scales
  // (seen on a device screenshot). The status line wraps, so it cannot clip.
  const feedTxt = feedAnchors
    ? "mids " + Math.round((Date.now() - feedAnchors.mids) / 1000) +
      "s / candles " + Math.round((Date.now() - feedAnchors.candles) / 1000) + "s"
    : "";

  return (
    <View style={[s.screen, { paddingTop: insets.top + 8 }]}>
      <View style={s.header}>
        <Text style={s.title}>HIP-3 STRAT</Text>
        <View style={s.dexBadge}>
          <Text style={s.dexBadgeText}>{universe === "xyz" ? "dex: xyz" : "crypto perps"}</Text>
        </View>
        <Text style={s.sub}>
          {(data ? universeCoins.length + " assets - " : "") +
            (error ? "offline - " + error : age === null ? "connecting..." : "updated " + age + "s ago")}
        </Text>
      </View>
      {/* Status line (slim header): the worker feed
          clocks on the left, the four stat tiles this replaces folded into
          one summary on the right. flexWrap so a large device font scale
          drops the summary to its own line instead of clipping it. */}
      {((!error && age !== null && feedTxt !== "") || !!data) && (
        <View style={s.statusLine}>
          {!error && age !== null && feedTxt !== "" && (
            <Text style={s.statusText}>{feedTxt}</Text>
          )}
          {data && (
            <Text style={[s.statusText, s.statusStats]}>
              live <Text style={s.statBull}>{stats.liveUp}</Text> up{" "}
              <Text style={s.statBear}>{stats.liveDown}</Text> dn{"  \u00b7  "}FTFC{" "}
              <Text style={s.statBull}>{stats.ftfcUp}</Text> up{" "}
              <Text style={s.statBear}>{stats.ftfcDown}</Text> dn
            </Text>
          )}
        </View>
      )}

      <View style={s.segment}>
        {UNIVERSES.map((u) => {
          const on = universe === u.id;
          return (
            <Pressable
              key={u.id}
              onPress={() => onUniverse(u.id)}
              style={[s.segBtn, on && s.segBtnOn]}
            >
              <Text style={[s.segText, on && s.segTextOn]}>{u.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={s.controls}>
        <TextInput
          style={s.search}
          placeholder="Filter symbol..."
          placeholderTextColor={C.faint}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="characters"
          autoCorrect={false}
        />
      </View>
      <FilterBar
        filters={filters}
        onFilters={onFilters}
        universe={universe}
        category={category}
        onCategory={setCategory}
        onClearAll={clearAll}
        resetKey={resetN}
        sorts={SORTS}
        sortKey={sortKey}
        sortDesc={sortDesc}
        onSort={onSort}
        open={panel}
        onOpen={setPanel}
        filterCount={nFilters}
        shown={rows.length}
        total={universeCoins.length}
        panelMaxHeight={Math.max(220, Math.round(winH * 0.5))}
      />

      <FlatList
        data={rows}
        keyExtractor={(c) => c.name}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.muted} />
        }
        // Scrolling the list means you are done configuring: fold the panel
        // back so the cards get the screen.
        onScrollBeginDrag={() => { if (panel !== null) setPanel(null); }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 90 }}
        ListEmptyComponent={
          data && anyFilter && universeCoins.length > 0 ? (
            <View style={s.emptyBox}>
              <Text style={s.empty}>
                {search.trim() ? "no \"" + search.trim() + "\" coins match these filters" : "no coins match these filters"}
              </Text>
              <Pressable
                onPress={() => { clearAll(); setSearch(""); }}
                hitSlop={10}
                accessibilityRole="button"
              >
                <Text style={s.emptyClear}>{search.trim() ? "Clear filters and search" : "Clear filters"}</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={s.empty}>{data ? "no matches" : error || "loading..."}</Text>
          )
        }
        renderItem={({ item }) => (
          <CoinCard
            coin={item}
            focus={matched.get(item.name)?.focus ?? null}
            universe={universe}
            expanded={!!expanded[item.name]}
            fav={favs.includes(item.sym)}
            allow={famAllow}
            onFav={() => toggleFav(item.sym)}
            onToggle={() =>
              setExpanded((e) => ({ ...e, [item.name]: !e[item.name] }))
            }
          />
        )}
      />
    </View>
  );
}

// Command card: the dashboard's six Command-view row groups as three
// left/right pairs - Identity | Market, Focus | Attention, Levels | Structure.
// The matched signal, its progress, the To Target reading and the D/W/M
// layer all come from focus.ts (the dashboard's rules) over the vendored
// display math; the 7-bar forming row and the chip row moved to CoinDetail.
function CoinCard({
  coin, focus, universe, expanded, fav, allow, onFav, onToggle,
}: {
  coin: Coin; focus: FocusItem | null; universe: UniverseId; expanded: boolean; fav: boolean;
  allow?: (tf: string, sig: LiveSig | Setup) => boolean;
  onFav: () => void; onToggle: () => void;
}) {
  const mid = coin.mid;
  const chg = coin.chg24;
  const chgColor = chg === null ? C.muted : chg >= 0 ? C.bull : C.bear;
  const day = typeof coin.chgUtc === "number" && isFinite(coin.chgUtc) ? coin.chgUtc : null;
  const dayColor = day === null ? C.muted : day >= 0 ? C.bull : C.bear;
  const scoreColor =
    coin.score === null ? C.muted : coin.score >= 10 ? C.bull : coin.score <= -10 ? C.bear : C.muted;
  const scoreBg =
    coin.score === null ? C.neutralBg : coin.score >= 10 ? C.bullBg : coin.score <= -10 ? C.bearBg : C.neutralBg;
  // Identity line 2 and Market line 2: worker-served, absent = render nothing.
  // The overnight format is the dashboard's own (`>= 0` sign, one decimal).
  const prov = provText(coin, universe);
  const on = coin.overnight_change_pct;
  const onTxt = typeof on === "number" ? "o/n " + (on >= 0 ? "+" : "") + on.toFixed(1) + "%" : "";
  // Attention line 2: the 15m score delta. null renders nothing, never 0 (the
  // scoreDelta contract), and the dashboard hides a literal 0 as well.
  const sd = coin.scoreDelta?.m15;
  const d15 = sd && typeof sd.signed === "number" && sd.signed !== 0 ? sd.signed : null;
  // Focus: the matched signal and its lifecycle reading.
  const status = focus ? (focus.status === "live" ? "LIVE" : focus.status.toUpperCase()) : "";
  const focusColor = !focus ? C.muted
    : focus.status === "inval" ? C.warn : focus.sig.dir === "up" ? C.bull : C.bear;
  const inForce = focus ? focusInForce(focus, mid) : true;
  const mag = focusProgress(focus, mid);
  const away = focus ? setupAwayPct(focus, mid) : null;
  const magColor = mag === null ? C.faint : mag >= 100 ? C.warn : mag < 0 ? C.bear : C.bull;
  const magFill = mag === null ? "0%" : (`${Math.min(100, Math.abs(mag))}%` as `${number}%`);
  // Levels and To Target: the in-force gate lives in targetItem, the math in
  // the vendored block. Stop rides the detail, as it rides the dashboard's
  // tooltip.
  const entry = focus ? focusEntry(focus) : null;
  const target = focus ? focus.sig.target : null;
  const ti = targetItem(focus, mid);
  const dist = ti ? distToTargetPct(ti.sig, mid) : null;
  const left = ti ? magRemaining(ti.sig as LiveSig, mid) : null;
  const slow = slowLayer(coin);
  const lv = (v: number | null) => (v === null || !isFinite(v) ? "-" : fmtPx(v));

  return (
    <Pressable onPress={onToggle} style={({ pressed }) => [s.card, pressed && s.cardPressed]}>
      {/* Identity | Market */}
      <View style={s.gRow}>
        <View style={s.gLeft}>
          <View style={s.identity}>
            <Pressable onPress={onFav} hitSlop={10} style={s.star}>
              <Ionicons
                name={fav ? "star" : "star-outline"}
                size={15}
                color={fav ? C.warn : C.faint}
              />
            </Pressable>
            <Text style={s.sym}>{coin.sym}</Text>
            {/* Worker-declared readiness: score/ftfc are null while it
                backfills this coin. Absent field (older worker) = unknown,
                shows nothing. */}
            {coin.ready === false && <Text style={s.gSub}>warming up</Text>}
          </View>
          {prov !== "" && <Text style={s.gSub}>{prov}</Text>}
        </View>
        <View style={s.gRight}>
          <View style={s.market}>
            <Text style={s.px}>{fmtPx(coin.mid)}</Text>
            <Text style={[s.chg, { color: chgColor }]}>{fmtChg24(chg)}</Text>
          </View>
          {onTxt !== "" && <Text style={s.gSub}>{onTxt}</Text>}
          {/* Day %: the
              dashboard's Market-stack "day" line - dim label, value signed and
              coloured like 24h % (>= 0 is up), "-" while the worker serves
              null. Separate Text nodes: nested values clipped on an
              Android build at a large font scale. */}
          <View
            style={s.dayLine}
            accessibilityLabel={"Day percent " + fmtChg24(day) + ": mid versus the open of the current UTC day's daily candle"}
          >
            <Text style={s.gSub}>day</Text>
            <Text style={[s.gSub, s.dayVal, { color: dayColor }]}>{fmtChg24(day)}</Text>
          </View>
        </View>
      </View>

      {/* Focus | Attention */}
      <View style={[s.gRow, s.gRowGap]}>
        <View style={s.gLeft}>
          {focus ? (
            <View
              style={[s.focusLine, !inForce && s.focusOof]}
              accessibilityLabel={
                !inForce
                  ? focus.tf + " " + focus.sig.name + " - entry fired this bar, but price " +
                    "has recrossed the level, signal not currently in force"
                  : undefined
              }
            >
              <Text style={[s.focusName, { color: focusColor }]}>
                {focus.tf + " " + focus.sig.name}
              </Text>
              <Text style={s.focusStatus}>{status}</Text>
              {focus.more > 0 && <Text style={s.focusMore}>{"+" + focus.more + " more"}</Text>}
            </View>
          ) : (
            <Text style={s.gSub}>-</Text>
          )}
          {/* simpleProgressHTML: a setup's % to trigger, INVAL, or the
              magnitude bar (against / exceeded / progressing colours). */}
          {focus && (
            <View style={s.progRow}>
              {focus.status === "setup" ? (
                <Text style={[s.progText, { color: C.muted }]}>
                  {away === null ? "-" : away.toFixed(2) + "% away"}
                </Text>
              ) : focus.status === "inval" ? (
                <Text style={[s.progText, { color: C.warn }]}>INVAL</Text>
              ) : mag === null ? (
                <Text style={[s.progText, { color: C.faint }]}>-</Text>
              ) : (
                <>
                  <View style={[s.progTrack, { backgroundColor: magColor + "26" }]}>
                    <View style={[s.progFill, { backgroundColor: magColor, width: magFill }]} />
                  </View>
                  <Text style={[s.progText, { color: magColor }]}>
                    {Math.round(mag) + "% traveled"}
                  </Text>
                  {/* The dashboard dims and explains on hover; phones have no
                      hover, so the reason is inlined. */}
                  {!inForce && (
                    <Text style={[s.progText, { color: C.faint }]}>{"\u00b7 not in force"}</Text>
                  )}
                </>
              )}
            </View>
          )}
        </View>
        <View style={s.gRight}>
          {coin.score === null ? (
            <Text style={s.gSub}>-</Text>
          ) : (
            <View style={[s.scorePill, { backgroundColor: scoreBg }]}>
              <Text style={[s.scorePillText, { color: scoreColor }]}>{fmtSigned(coin.score)}</Text>
            </View>
          )}
          {d15 !== null && (
            <Text style={[s.gSub, { color: d15 > 0 ? C.bull : C.bear, marginTop: 3 }]}>
              {"\u0394 15m " + fmtSigned(d15)}
            </Text>
          )}
        </View>
      </View>

      {/* Levels | Structure */}
      <View style={[s.gRow, s.gRowGap]}>
        <View style={s.gLeft}>
          {focus ? (
            <Text style={s.lvlLineTight}>
              <Text style={s.lvlKey}>E </Text>{lv(entry)}
              <Text style={s.lvlKey}>{"   T "}</Text>{lv(target)}
            </Text>
          ) : (
            <Text style={s.gSub}>-</Text>
          )}
          {/* simpleToTargetHTML with the beyond-target case spelled out
              instead of the dashboard's hover title. */}
          {focus && (
            dist === null ? (
              <Text style={s.gSub}>Tgt -</Text>
            ) : dist < 0 ? (
              <Text style={[s.gSub, { color: C.bull }]}>
                {"Tgt " + dist.toFixed(2) + "% \u00b7 beyond target"}
              </Text>
            ) : (
              <Text style={s.gSub}>
                {"Tgt " + (dist > 0 ? "+" : "") + dist.toFixed(2) + "% away" +
                  (left !== null ? " \u00b7 " + Math.round(left) + "% mag left" : "")}
              </Text>
            )
          )}
        </View>
        <View style={s.gRight}>
          <View style={s.dots}>
            {coin.dots.map((d, i) => <Dot key={i} dir={d} />)}
            <Text style={[
              s.ftfcText,
              { color: coin.ftfc === "up" ? C.bull : coin.ftfc === "down" ? C.bear : C.muted },
            ]}>
              {/* null = unready coin (no reading yet), rendered like "mixed"'s
                  dash; calling toUpperCase on it was a crash once the worker
                  started serving null instead of fake-neutral "mixed". */}
              {coin.ftfc === "up" || coin.ftfc === "down" ? coin.ftfc.toUpperCase() : "-"}
            </Text>
          </View>
          {/* The slow layer (D/W/M forming directions). Labelled D/W/M rather
              than the dashboard's "FTFC n/n up" because the fast-layer FTFC
              label sits directly above it here - same count, same dots. */}
          <View style={s.dwmRow}>
            {slow.dirs.map((d, i) => <Dot key={i} dir={d} size={6} />)}
            <Text style={s.gSub}>
              {slow.known ? "D/W/M " + slow.up + "/" + slow.known + " up" : "warming"}
            </Text>
          </View>
        </View>
      </View>
      {expanded && <CoinDetail coin={coin} allow={allow} />}
    </Pressable>
  );
}

function CoinDetail({
  coin, allow,
}: {
  coin: Coin;
  allow?: (tf: string, sig: LiveSig | Setup) => boolean;
}) {
  const m = coin.mom;
  const mv = (v: number | null) => (v === null || !isFinite(v) ? "-" : fmtPct(v));
  // The signal chip row and the 15m sparkline moved here from the card when
  // the list adopted the Command layout (2026-09-01): the card shows ONE
  // matched signal, the detail keeps the whole roster one tap away.
  const chips = buildSignalChips(coin, allow);
  return (
    <View style={s.detail}>
      {chips.length > 0 && (
        <View style={s.detailChips}>
          {chips.map((c, i) => <Chip key={i} label={c.label} tone={c.tone} dim={c.dim} />)}
        </View>
      )}
      <View style={s.tfCard}>
        <View style={s.tfCardHead}>
          <Text style={s.tfCardTitle}>TAPE</Text>
          <Sparkline points={coin.spark} width={68} height={23} />
        </View>
        <Text style={s.lvlLine}>
          mom 5m {mv(m.r5)}  15m {mv(m.r15)}  30m {mv(m.r30)}  1h {mv(m.r60)}
        </Text>
        <Text style={s.lvlLine}>
          rvol {coin.rvol === null ? "-" : coin.rvol.toFixed(1) + "x"}
          {"   funding/hr " + (isFinite(coin.funding) ? (coin.funding * 100).toFixed(4) + "%" : "-")}
        </Text>
        <Text style={s.lvlLine}>
          premium {coin.premium === null ? "-" : fmtPct(coin.premium * 100, 3)}
          {coin.mark !== null && coin.oracle !== null
            ? "  (mark " + fmtPx(coin.mark) + " vs oracle " + fmtPx(coin.oracle) + ")"
            : ""}
        </Text>
        <Text style={s.lvlLine}>
          OI {coin.oiUsd === null ? "-" : fmtVol(coin.oiUsd)}
          {"   24h vol " + fmtVol(coin.vol)}
        </Text>
      </View>
      {TF_ORDER.map(({ id, label }) => {
        const an = coin.tf[id];
        if (!an) return null;
        return (
          <View key={id} style={s.tfCard}>
            <View style={s.tfCardHead}>
              <Text style={s.tfCardTitle}>{label}</Text>
              <View style={s.seq}>
                {an.types.map((t, i) => <BarBadge key={i} t={t} />)}
                <Text style={s.seqSep}>|</Text>
                <BarBadge t={an.formingType} forming />
              </View>
            </View>
            {an.forming && (
              <Text style={s.lvlLine}>
                o {fmtPx(an.forming.o)}  h {fmtPx(an.forming.h)}  l {fmtPx(an.forming.l)}  last {fmtPx(an.forming.c)}
              </Text>
            )}
            {an.live.map((l, i) => {
              // rev3 (1-3 Rev Strat) is born ON the 3, so the TF-level
              // invalidated flag does not kill it (mirrors the worker's
              // rules.js predicate `an.invalidated && !l.rev3`).
              const inval = an.invalidated && l.rev3 !== true;
              // Magnitude: how far mid has traveled from entry toward target.
              // Suppressed on invalidated signals (the level is no longer live).
              const mag = inval ? null : magProgress(l, coin.mid);
              // In force = price still on the trigger side of entry. Once mid
              // recrosses entry the signal is not currently in force, so dim it.
              // Vendored predicate, not a local copy: the hand-written version
              // that used to sit here treated a mid of 0 as a real price and
              // dimmed on it, where the dashboard counts unknown as in force.
              const inForce = sigInForce(l, coin.mid);
              const label = inval
                ? " WENT 3 (inval exit)"
                : l.rev3 === true
                ? " LIVE (Rev Strat)"
                : l.kind === "cont"
                ? " CONT"
                : " LIVE";
              return (
                <View key={"l" + i} style={!inval && !inForce ? { opacity: 0.55 } : null}>
                  <Text style={s.sigLine}>
                    <Text style={{
                      color: inval ? C.warn : l.kind === "cont" ? C.muted : l.dir === "up" ? C.bull : C.bear,
                      fontWeight: "600",
                    }}>
                      {l.name}{label}
                    </Text>
                    <Text style={s.lvlText}>
                      {"  entry " + (l.dir === "up" ? ">" : "<") + fmtPx(l.entry) +
                        "  stop " + fmtPx(l.stop) + "  tgt " + (l.target === null ? "-" : fmtPx(l.target))}
                    </Text>
                  </Text>
                  {mag !== null && <MagnitudeBar mag={mag} compact />}
                </View>
              );
            })}
            {an.setups
              // Only the dashboard's own filter: a setup whose name is already
              // live. `info` setups (1-1-2U / ?-1-2D structures with no valid
              // reference bar) used to be dropped here, which made them visible
              // context on one surface and invisible on the other - the
              // dashboard labels them "(no ref)" rather than hiding them
              // (divergence (e)9).
              .filter((st) => !an.live.some((l) => l.name === st.name))
              .map((st, i) => (
                <Text key={"s" + i} style={s.sigLine}>
                  <Text style={{ color: C.muted, fontWeight: "600" }}>
                    {st.name} setup
                    {st.kind === "cont" ? " (cont)" : st.kind === "info" ? " (no ref)" : ""}
                  </Text>
                  <Text style={s.lvlText}>
                    {"  trigger " + (st.dir === "up" ? ">" : "<") + fmtPx(st.trigger) +
                      "  stop " + fmtPx(st.stop) + "  tgt " + (st.target === null ? "-" : fmtPx(st.target))}
                  </Text>
                </Text>
              ))}
            {/* Mirrors the dashboard's two dim detail tags (additive payload
                fields; absent on an older worker = render nothing). The shape
                tooltip's caveat is inlined - phones have no hover, and "not an
                entry" is the part that must never be invisible. */}
            {an.completed && (
              <Text style={s.dimLine}>
                last closed completed: {an.completed.name}
                {an.completed.cont ? " (cont)" : ""}
              </Text>
            )}
            {an.shape && (
              <Text style={s.dimLine}>
                shape: {an.shape.type}
                {an.shape.confirming ? " (confirming)" : ""}
                {" - MoMo, needs higher-TF continuity; not an entry"}
              </Text>
            )}
          </View>
        );
      })}
      <Pressable
        onPress={() => {
          // https always resolves to the system browser (or the TV app via
          // its applink); a rejection means no handler exists, and there is
          // nothing useful to render in that state.
          Linking.openURL(tvHref(coin)).catch(() => {});
        }}
        style={({ pressed }) => [s.tvLink, pressed && { backgroundColor: C.cardActive }]}
      >
        <Text style={s.tvLinkText}>Open in TradingView</Text>
        <Text style={s.tvLinkSym}>{tvSymbol(coin)}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: "row", alignItems: "baseline", gap: 8,
    paddingHorizontal: 14, paddingBottom: 8, flexWrap: "wrap",
  },
  title: { color: C.text, fontSize: 17, fontWeight: "600", letterSpacing: -0.2 },
  dexBadge: {
    borderWidth: 1, borderColor: C.border, borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 1, backgroundColor: C.card,
  },
  dexBadgeText: { color: C.muted, fontSize: 10.5, fontWeight: "500" },
  sub: { color: C.faint, fontSize: 11, marginLeft: "auto" },
  statusLine: {
    flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between",
    columnGap: 10, paddingHorizontal: 14, marginBottom: 6,
  },
  statusText: { color: C.faint, fontSize: 11, fontVariant: ["tabular-nums"] },
  statusStats: { marginLeft: "auto" },
  statBull: { color: C.bull, fontWeight: "600" },
  statBear: { color: C.bear, fontWeight: "600" },
  segment: {
    flexDirection: "row", gap: 2, marginHorizontal: 14, marginBottom: 10,
    padding: 2, backgroundColor: C.card,
    borderWidth: 1, borderColor: C.border, borderRadius: 8,
  },
  segBtn: { flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 6 },
  segBtnOn: { backgroundColor: C.cardActive },
  segText: { color: C.muted, fontSize: 12.5, fontWeight: "500" },
  segTextOn: { color: C.text, fontWeight: "600" },
  controls: { paddingHorizontal: 14, marginBottom: 8 },
  search: {
    borderWidth: 1, borderColor: C.input, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 7, color: C.text, fontSize: 13,
  },
  star: { marginRight: 2, marginTop: 1 },
  empty: { color: C.faint, textAlign: "center", marginTop: 40, fontSize: 13 },
  emptyBox: { alignItems: "center", gap: 10 },
  emptyClear: { color: C.info, fontSize: 13, fontWeight: "600" },
  card: {
    marginHorizontal: 14, marginBottom: 8, padding: 12,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 10,
  },
  cardPressed: { backgroundColor: C.cardActive },
  // Command card: three left/right pairs, each cell a value over a dim sub.
  gRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
  gRowGap: { marginTop: 6 },
  gLeft: { flex: 1, minWidth: 0 },
  gRight: { alignItems: "flex-end", flexShrink: 0 },
  identity: { flexDirection: "row", alignItems: "center", gap: 8 },
  sym: { color: C.text, fontSize: 15, fontWeight: "600" },
  gSub: { color: C.muted, fontSize: 10.5, marginTop: 1, fontVariant: ["tabular-nums"] },
  market: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  dayLine: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", columnGap: 4 },
  dayVal: { fontWeight: "600" },
  px: { color: C.text, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  chg: { fontSize: 11.5, fontWeight: "600", fontVariant: ["tabular-nums"], textAlign: "right" },
  focusLine: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap" },
  focusName: { fontSize: 11.5, fontWeight: "600", fontVariant: ["tabular-nums"] },
  focusStatus: { fontSize: 10, fontWeight: "500", color: C.muted, marginLeft: 6, letterSpacing: 0.3 },
  focusMore: { fontSize: 10, color: C.faint, marginLeft: 6 },
  focusOof: { opacity: 0.55 }, // dashboard `.scan-focus.oof`
  progRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3, flexWrap: "wrap" },
  progTrack: { width: 82, height: 5, borderRadius: 3, overflow: "hidden" },
  progFill: { height: "100%", borderRadius: 3 },
  progText: { fontSize: 10.5, fontVariant: ["tabular-nums"] },
  scorePill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 },
  scorePillText: { fontSize: 12.5, fontWeight: "600", fontVariant: ["tabular-nums"] },
  lvlLineTight: { color: C.text, fontSize: 11, fontVariant: ["tabular-nums"] },
  lvlKey: { color: C.faint },
  dots: { flexDirection: "row", alignItems: "center" },
  ftfcText: { fontSize: 11, fontWeight: "600", marginLeft: 5 },
  dwmRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3 },
  detail: { marginTop: 10, gap: 8 },
  detailChips: { flexDirection: "row", flexWrap: "wrap", marginBottom: -4 },
  tfCard: {
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
    borderRadius: 8, padding: 10,
  },
  tfCardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  tfCardTitle: {
    color: C.muted, fontSize: 10.5, fontWeight: "500",
    textTransform: "uppercase", letterSpacing: 0.7,
  },
  seq: { flexDirection: "row", alignItems: "center", gap: 3 },
  seqSep: { color: C.faint, fontSize: 11, marginHorizontal: 2 },
  lvlLine: { color: C.muted, fontSize: 11.5, marginTop: 6, fontVariant: ["tabular-nums"] },
  sigLine: { marginTop: 5, fontSize: 12, lineHeight: 17 },
  lvlText: { color: C.muted, fontSize: 11.5, fontVariant: ["tabular-nums"] },
  dimLine: { color: C.faint, fontSize: 11, marginTop: 5 },
  tvLink: {
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
    borderRadius: 8, paddingVertical: 8, alignItems: "center", gap: 1,
  },
  tvLinkText: { color: C.info, fontSize: 12, fontWeight: "600" },
  tvLinkSym: { color: C.faint, fontSize: 10, fontVariant: ["tabular-nums"] },
});
