// Close / flatten / reverse confirmation sheet. Shows EXACTLY the orders
// that will be signed (ClosePreview / ReversePreview from hl_exchange), a
// hold-to-confirm bar (1.2 s, release cancels), then the biometric prompt
// from the secure store, then per-coin progress and the venue's answers
// verbatim. A reverse is two legs under the one prompt: the close, then -
// only when the venue reads the coin flat - the opposite-side IoC open. No
// extra warning step (design decision: the button exists for speed).
// The agent key lives in a local variable inside the run function for the
// duration of one wallet's run and is never placed in state or props.
//
// Automated wallets (Wallet.automated) carry a warning: a close here is a
// venue-level exit; whatever process trades the wallet keeps running and
// has to be stopped on its own side.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Tag, walletName } from "@/components/trade-bits";
import { clearAgentMeta, getAgentKey } from "@/lib/agent_store";
import { fmtPx, fmtUsd } from "@/lib/fmt";
import { fmtSize } from "@/lib/perf_fmt";
import {
  closePosition, CloseResult, CloseStep, flattenWallet, OpenResult, previewClose, previewReverse,
  ReversePreview, ReverseResult, reversePosition,
} from "@/lib/hl_exchange";
import type { ClosePreview } from "@/lib/hl_orders";
import type { Position } from "@/lib/hyperliquid";
import type { Wallet } from "@/lib/store";
import { C } from "@/theme";

export type CloseTarget = { wallet: Wallet; positions: Position[] };

type Props = {
  visible: boolean;
  mode: "one" | "all" | "reverse";
  targets: CloseTarget[];          // one wallet + position for "one" / "reverse"; every keyed wallet for "all"
  onClose: () => void;
  onFinished: () => void;          // the parent re-polls the venue
};

type Phase = "preview" | "running" | "done";
type WalletOutcome = {
  wallet: Wallet; results: CloseResult[]; sweptOrders: number; sweepError: string | null; error: string | null;
  reverse?: ReverseResult;
};
type Preview = ClosePreview | ReversePreview;
const isReversePreview = (p: Preview): p is ReversePreview => "open" in p;

const HOLD_MS = 1200;

export function CloseSheet({ visible, mode, targets, onClose, onFinished }: Props) {
  const [phase, setPhase] = useState<Phase>("preview");
  const [previews, setPreviews] = useState<Record<string, Preview | string>>({});
  const [steps, setSteps] = useState<CloseStep[]>([]);
  const [outcomes, setOutcomes] = useState<WalletOutcome[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const holdAnim = useRef<Animated.CompositeAnimation | null>(null);
  const runningRef = useRef(false);
  const visibleRef = useRef(visible);

  // A sheet dismissed mid-hold (back button, Cancel with a second finger)
  // unmounts the bar without onPressOut: stop the hold here, and run()
  // refuses to start once the sheet is gone - no invisible trade.
  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) {
      if (holdAnim.current) holdAnim.current.stop();
      progress.setValue(0);
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const key = (w: Wallet, p: Position) => w.address.toLowerCase() + "|" + p.coin;
  const total = targets.reduce((n, t) => n + t.positions.length, 0);
  const anyAutomated = targets.some((t) => t.wallet.automated);

  // Previews: the exact order per position, read fresh each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setPhase("preview"); setSteps([]); setOutcomes([]); setNote(null); setPreviews({});
    progress.setValue(0);
    let cancelled = false;
    (async () => {
      for (const t of targets) {
        for (const p of t.positions) {
          try {
            const pv = mode === "reverse" ? await previewReverse(p) : await previewClose(p);
            if (!cancelled) setPreviews((m) => ({ ...m, [key(t.wallet, p)]: pv }));
          } catch (e) {
            if (!cancelled) setPreviews((m) => ({ ...m, [key(t.wallet, p)]: e instanceof Error ? e.message : "preview failed" }));
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [visible, targets, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async () => {
    if (runningRef.current || !visibleRef.current) return;
    runningRef.current = true;
    setPhase("running");
    const done: WalletOutcome[] = [];
    for (const t of targets) {
      // The Reverse button is hidden on automated wallets; this is the second
      // lock, checked before the fingerprint so nothing is unlocked for it.
      if (mode === "reverse" && (t.wallet.automated || t.positions.length !== 1)) {
        done.push({ wallet: t.wallet, results: [], sweptOrders: 0, sweepError: null, error: t.wallet.automated ? "reverse is not offered on an automated wallet" : "a reverse takes exactly one position" });
        setOutcomes([...done]);
        continue;
      }
      let agentKey: string | null = null;
      try {
        agentKey = await getAgentKey(t.wallet.address); // the biometric prompt
      } catch (e) {
        done.push({ wallet: t.wallet, results: [], sweptOrders: 0, sweepError: null, error: "cancelled: " + (e instanceof Error ? e.message : "authentication failed") });
        setOutcomes([...done]);
        continue;
      }
      if (!agentKey) {
        await clearAgentMeta(t.wallet.address);
        done.push({ wallet: t.wallet, results: [], sweptOrders: 0, sweepError: null, error: "agent key missing or invalidated by a biometrics change - add it again in Settings" });
        setOutcomes([...done]);
        continue;
      }
      const onStep = (s: CloseStep) => setSteps((arr) => [...arr, s]);
      try {
        if (mode === "reverse") {
          const rv = await reversePosition(t.wallet.address, t.positions[0], agentKey, onStep);
          done.push({ wallet: t.wallet, results: rv.close ? [rv.close] : [], sweptOrders: 0, sweepError: null, error: null, reverse: rv });
        } else if (mode === "one") {
          const r = await closePosition(t.wallet.address, t.positions[0], agentKey, { cancelRest: true }, onStep);
          done.push({ wallet: t.wallet, results: [r], sweptOrders: 0, sweepError: null, error: null });
        } else {
          const f = await flattenWallet(t.wallet.address, t.positions, agentKey, { cancelRest: true }, onStep);
          done.push({ wallet: t.wallet, results: f.results, sweptOrders: f.sweptOrders, sweepError: f.sweepError, error: null });
        }
      } catch (e) {
        done.push({ wallet: t.wallet, results: [], sweptOrders: 0, sweepError: null, error: e instanceof Error ? e.message : "failed" });
      } finally {
        agentKey = null; // dropped; never stored
      }
      setOutcomes([...done]);
    }
    setPhase("done");
    runningRef.current = false;
    onFinished();
  }, [targets, mode, onFinished]);

  const holdStart = () => {
    progress.setValue(0);
    holdAnim.current = Animated.timing(progress, { toValue: 1, duration: HOLD_MS, useNativeDriver: false });
    holdAnim.current.start(({ finished }) => { if (finished) run(); });
  };
  const holdEnd = () => {
    if (holdAnim.current) holdAnim.current.stop();
    if (phase === "preview") progress.setValue(0);
  };

  const previewReady = targets.every((t) => t.positions.every((p) => typeof previews[key(t.wallet, p)] === "object"));
  const firstSym = targets[0]?.positions[0] ? targets[0].positions[0].coin.replace(/^.*:/, "") : "";
  const title = mode === "one" ? "Close " + firstSym
    : mode === "reverse" ? "Reverse " + firstSym
    : "Flatten " + (targets.length === 1 ? walletName(targets[0].wallet) : targets.length + " wallets");

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={phase === "running" ? () => undefined : onClose}>
      <View style={s.scrim}>
        <View style={s.sheet}>
          <View style={s.head}>
            <Text style={s.title}>{title}</Text>
            <Text style={s.headMeta}>
              {phase === "done"
                ? "done"
                : mode === "reverse" ? "close, then open the other side"
                : total + (total === 1 ? " position" : " positions") + (mode === "all" ? " \u00b7 resting orders swept after" : "")}
            </Text>
          </View>
          {anyAutomated && phase !== "done" ? (
            <View style={s.warn}>
              <Text style={s.warnText}>
                This wallet is marked as automated: another process may be trading it. Closing here is
                a venue-level exit only: that process keeps running and can open new positions. To
                halt it, stop that process itself.
              </Text>
            </View>
          ) : null}

          <ScrollView style={s.body} contentContainerStyle={{ paddingBottom: 4 }}>
            {phase === "preview" ? targets.map((t) => t.positions.map((p) => {
              const pv = previews[key(t.wallet, p)];
              const sym = p.coin.replace(/^.*:/, "");
              const unreal = fmtUsd(p.unrealizedPnl) !== "-" ? " \u00b7 unrealized " + fmtUsd(p.unrealizedPnl) : "";
              if (typeof pv !== "object") {
                return (
                  <View key={key(t.wallet, p)} style={s.row}>
                    <View style={s.rowTop}>
                      <Text style={s.rowSym}>{sym}</Text>
                      <Text style={[s.rowRight, { color: pv ? C.bear : C.faint }]}>{pv ? String(pv) : "reading mid..."}</Text>
                    </View>
                    <Text style={s.rowSub}>{mode === "reverse" ? "the reverse cannot be prepared" : "this position will be skipped"}</Text>
                  </View>
                );
              }
              const tags = (
                <>
                  <Tag label={p.dex || "main"} />
                  {targets.length > 1 ? <Tag label={walletName(t.wallet)} /> : null}
                </>
              );
              if (isReversePreview(pv)) {
                const newSide = pv.open.side === "BUY" ? "long" : "short";
                return (
                  <View key={key(t.wallet, p)}>
                    <LegRow leg="1" side={pv.close.side} size={pv.close.size} sym={sym} mid={pv.close.mid} cap={pv.close.capPx} tags={tags}
                      sub={"close: reduce-only IoC, cap " + Math.round(pv.close.slippage * 100) + "% from mid" + unreal + " \u00b7 then cancel resting orders on " + sym} />
                    <LegRow leg="2" side={pv.open.side} size={pv.open.size} sym={sym} mid={pv.open.mid} cap={pv.open.capPx} tags={null}
                      sub={"open " + newSide + ": IoC at a fresh mid, sent only once the close reads flat"} />
                  </View>
                );
              }
              return (
                <LegRow key={key(t.wallet, p)} side={pv.side} size={pv.size} sym={sym} mid={pv.mid} cap={pv.capPx} tags={tags}
                  sub={"reduce-only IoC, cap " + Math.round(pv.slippage * 100) + "% from mid" + unreal + " \u00b7 then cancel resting orders on " + sym} />
              );
            })) : null}

            {phase !== "preview" ? (
              <>
                {outcomes.map((o) => (
                  <View key={o.wallet.address}>
                    {targets.length > 1 ? <Text style={s.walletHead}>{walletName(o.wallet)}</Text> : null}
                    {o.error ? <Text style={[s.resLine, { color: C.bear }]}>{o.error}</Text> : null}
                    {o.results.map((r) => <ResultRow key={r.coin} r={r} />)}
                    {o.reverse ? <ReverseRow rv={o.reverse} /> : null}
                    {o.sweptOrders ? <Text style={s.resSub}>{"swept " + o.sweptOrders + " resting order" + (o.sweptOrders > 1 ? "s" : "") + " across dexes"}</Text> : null}
                    {o.sweepError ? <Text style={[s.resSub, { color: C.warn }]}>{"order sweep: " + o.sweepError}</Text> : null}
                  </View>
                ))}
                {phase === "running" ? (
                  <View style={s.stepsBox}>
                    {steps.slice(-4).map((st, i) => (
                      <Text key={i} style={s.stepText}>{(st.coin ? st.coin.replace(/^.*:/, "") + ": " : "") + st.text}</Text>
                    ))}
                    {!steps.length ? <Text style={s.stepText}>waiting for the fingerprint prompt...</Text> : null}
                  </View>
                ) : null}
                {phase === "done" ? (
                  <Text style={s.foot}>Positions re-polled from the venue. The venue is the truth; this list is what it answered.</Text>
                ) : null}
              </>
            ) : null}
            {note ? <Text style={[s.foot, { color: C.bear }]}>{note}</Text> : null}
          </ScrollView>

          {phase === "preview" ? (
            <>
              <Pressable
                onPressIn={previewReady ? holdStart : undefined}
                onPressOut={holdEnd}
                disabled={!previewReady || !total}
                accessibilityRole="button"
                accessibilityLabel={"Hold to confirm: " + title}
                style={[s.hold, (!previewReady || !total) && s.holdDisabled]}
              >
                <Animated.View style={[s.holdFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]} />
                <Text style={s.holdText}>{previewReady ? "Hold to " + (mode === "one" ? "close" : mode === "reverse" ? "reverse" : "flatten") + " \u00b7 then fingerprint" : "preparing orders..."}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={s.cancel} accessibilityRole="button">
                <Text style={s.cancelText}>Cancel</Text>
              </Pressable>
            </>
          ) : phase === "done" ? (
            <Pressable onPress={onClose} style={s.doneBtn} accessibilityRole="button">
              <Text style={s.doneText}>Done</Text>
            </Pressable>
          ) : (
            <Text style={s.runningNote}>working - do not leave the app</Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

// One order as it will be signed: side, size, where the price is capped.
// `leg` numbers the two halves of a reverse. Separate Text nodes (nested
// values clipped on an Android build at a large font scale).
function LegRow({ leg, side, size, sym, mid, cap, tags, sub }: {
  leg?: string; side: "SELL" | "BUY"; size: number; sym: string; mid: number; cap: number;
  tags: ReactNode; sub: string;
}) {
  return (
    <View style={s.row}>
      <View style={s.rowTop}>
        {leg ? <Text style={s.legNo}>{leg}</Text> : null}
        <Text style={[s.side, { color: side === "SELL" ? C.bear : C.bull }]}>{side}</Text>
        <Text style={s.rowSym}>{fmtSize(size) + " " + sym}</Text>
        {tags}
        <Text style={s.rowRight}>{"mid " + fmtPx(mid) + " \u00b7 cap"}</Text>
        <Text style={[s.rowRight, { marginLeft: 0, color: C.text }]}>{fmtPx(cap)}</Text>
      </View>
      <Text style={s.rowSub}>{sub}</Text>
    </View>
  );
}

// Leg 2 of a reverse, after the close's own ResultRow: what opened, or why
// nothing did. "Flat" is the stated end state whenever leg 2 did not open.
function ReverseRow({ rv }: { rv: ReverseResult }) {
  let line: string, color: string;
  const o: OpenResult | null = rv.open;
  const held = o && o.position !== null && o.position !== 0 ? o.position : null;
  let errShown = false;
  if (rv.stopped) { line = "not reversed - " + rv.stopped; color = C.warn; }
  else if (held !== null) {
    // Whatever the order status said, lead with what the venue holds - a
    // "not reopened" line over a real position would invite a manual double.
    line = "venue now holds " + (held > 0 ? "long " : "short ") + fmtSize(Math.abs(held)) + (o?.avgPx ? " @ " + fmtPx(o.avgPx) : "");
    color = o?.error ? C.warn : C.bull;
  } else if (!o || o.filled === 0) {
    line = "closed, not reopened: " + (o?.error ?? "no answer");
    color = C.warn;
    errShown = true;
  } else {
    line = "opened " + fmtSize(o.filled) + (o.avgPx ? " @ " + fmtPx(o.avgPx) : "") + (o.filled < o.requested ? " of " + fmtSize(o.requested) : "");
    color = C.bull;
  }
  const sub = [
    o && o.position === null && !rv.stopped && o.filled > 0 ? "could not re-read the venue" : null,
    o && held !== null && o.filled < o.requested ? "asked " + fmtSize(o.requested) : null,
    o && o.ambiguous ? "a send was ambiguous; the venue was re-read after the order expired" : null,
    o && o.error && !errShown ? o.error : null,
  ].filter(Boolean).join(" \u00b7 ");
  return (
    <View style={s.row}>
      <View style={s.rowTop}>
        <Text style={s.legNo}>2</Text>
        <Text style={[s.resLine, { color, flexShrink: 1 }]}>{line}</Text>
      </View>
      {sub ? <Text style={s.rowSub}>{sub}</Text> : null}
    </View>
  );
}

function ResultRow({ r }: { r: CloseResult }) {
  const sym = r.coin.replace(/^.*:/, "");
  let line: string, color: string;
  if (r.error && r.filled === 0) { line = "error: " + r.error; color = C.bear; }
  else if (r.residual !== null && r.residual > 0) { line = "partial: filled " + fmtSize(r.filled) + " of " + fmtSize(r.requested) + ", residual " + fmtSize(r.residual); color = C.warn; }
  else if (r.residual === null) { line = "filled " + fmtSize(r.filled) + (r.avgPx ? " @ " + fmtPx(r.avgPx) : "") + " - could not re-read the venue"; color = C.warn; }
  else { line = "filled " + fmtSize(r.filled) + (r.avgPx ? " @ " + fmtPx(r.avgPx) : ""); color = C.bull; }
  const sub = [
    r.cancelled ? "cancelled " + r.cancelled + " order" + (r.cancelled > 1 ? "s" : "") : null,
    r.residual !== null && r.residual > 0 ? "orders kept" : null,
    r.ambiguous ? "a send was ambiguous; the venue was re-read" : null,
    r.error && r.filled > 0 ? r.error : null,
  ].filter(Boolean).join(" \u00b7 ");
  return (
    <View style={s.row}>
      <View style={s.rowTop}>
        <Text style={s.rowSym}>{sym}</Text>
        <Text style={[s.resLine, { color, flexShrink: 1 }]}>{line}</Text>
      </View>
      {sub ? <Text style={s.rowSub}>{sub}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(9,9,11,0.35)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: C.card, borderTopWidth: 1, borderColor: C.border,
    borderTopLeftRadius: 14, borderTopRightRadius: 14,
    paddingHorizontal: 14, paddingTop: 14, paddingBottom: 28, gap: 10, maxHeight: "88%",
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: C.text, fontSize: 15, fontWeight: "600" },
  headMeta: { color: C.faint, fontSize: 11 },
  warn: { backgroundColor: C.warnBg, borderWidth: 1, borderColor: "rgba(255,184,0,0.3)", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  warnText: { color: C.warn, fontSize: 11, lineHeight: 15 },
  body: { flexGrow: 0 },
  row: { paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.border, gap: 2 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  side: { fontSize: 11, fontWeight: "600" },
  legNo: { color: C.faint, fontSize: 10, fontWeight: "600", minWidth: 10 },
  rowSym: { color: C.text, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  rowRight: { marginLeft: "auto", color: C.muted, fontSize: 11, fontVariant: ["tabular-nums"] },
  rowSub: { color: C.faint, fontSize: 10.5 },
  walletHead: { color: C.muted, fontSize: 10, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.7, marginTop: 6 },
  resLine: { fontSize: 11.5, fontVariant: ["tabular-nums"] },
  resSub: { color: C.faint, fontSize: 10.5, marginTop: 4 },
  stepsBox: { marginTop: 8, gap: 2 },
  stepText: { color: C.muted, fontSize: 11, fontVariant: ["tabular-nums"] },
  foot: { color: C.faint, fontSize: 10.5, lineHeight: 14, marginTop: 8 },
  hold: {
    position: "relative", overflow: "hidden", minHeight: 44,
    borderWidth: 1, borderColor: "rgba(255,59,92,0.35)", borderRadius: 8, backgroundColor: C.bearBg,
    alignItems: "center", justifyContent: "center",
  },
  holdDisabled: { opacity: 0.5 },
  holdFill: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: "rgba(255,59,92,0.28)" },
  holdText: { color: C.bear, fontSize: 13, fontWeight: "600" },
  cancel: { alignItems: "center", paddingVertical: 8, minHeight: 44, justifyContent: "center" },
  cancelText: { color: C.muted, fontSize: 13, fontWeight: "500" },
  doneBtn: { borderWidth: 1, borderColor: C.border, borderRadius: 8, minHeight: 44, alignItems: "center", justifyContent: "center" },
  doneText: { color: C.muted, fontSize: 13, fontWeight: "500" },
  runningNote: { color: C.faint, fontSize: 11, textAlign: "center", paddingVertical: 8 },
});
