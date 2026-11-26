// MyFundedPerps close / reverse confirmation sheet (see
// SECURITY.md). Same shape as the Hyperliquid CloseSheet: the legs as they
// will be sent, a hold-to-confirm bar (1.2 s, release cancels), then the
// biometric prompt for the trade key, then progress and the venue's answers
// verbatim. A full close only (no partial); a reverse is that close, then -
// only once the close filled flat and the account may open - one market
// order on the other side for the same size. The trade key lives in a local
// variable for one run and is never placed in state or props.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Tag } from "@/components/trade-bits";
import { clearMfpMeta, getMfpKey } from "@/lib/agent_store";
import { fmtPx } from "@/lib/fmt";
import { mfpClosePosition, MfpCloseResult, MfpOpenResult, mfpReversePosition, MfpStep } from "@/lib/mfp_exchange";
import type { MfpPosition } from "@/lib/mfp_orders";
import { fmtSize } from "@/lib/perf_fmt";
import { C } from "@/theme";

type Props = {
  visible: boolean;
  mode: "close" | "reverse";
  position: MfpPosition | null;
  mid: number | null;            // last polled mid, for the preview only
  onClose: () => void;
  onFinished: () => void;        // the parent re-polls the venue
};

type Phase = "preview" | "running" | "done";
type Outcome = { close: MfpCloseResult | null; open: MfpOpenResult | null; stopped: string | null; error: string | null };

const HOLD_MS = 1200;

export function MfpSheet({ visible, mode, position, mid, onClose, onFinished }: Props) {
  const [phase, setPhase] = useState<Phase>("preview");
  const [steps, setSteps] = useState<MfpStep[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
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
      return;
    }
    setPhase("preview"); setSteps([]); setOutcome(null);
    progress.setValue(0);
  }, [visible, position, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async () => {
    if (runningRef.current || !position || !visibleRef.current) return;
    runningRef.current = true;
    setPhase("running");
    let key: string | null = null;
    try {
      try {
        key = await getMfpKey("trade"); // the biometric prompt
      } catch (e) {
        setOutcome({ close: null, open: null, stopped: null, error: "cancelled: " + (e instanceof Error ? e.message : "authentication failed") });
        return;
      }
      if (!key) {
        await clearMfpMeta("trade");
        setOutcome({ close: null, open: null, stopped: null, error: "trade key missing or invalidated by a biometrics change - add it again in Settings" });
        return;
      }
      const onStep = (st: MfpStep) => setSteps((arr) => [...arr, st]);
      if (mode === "reverse") {
        const rv = await mfpReversePosition(key, position, onStep);
        setOutcome({ close: rv.close, open: rv.open, stopped: rv.stopped, error: null });
      } else {
        const c = await mfpClosePosition(key, position, onStep);
        setOutcome({ close: c.close, open: null, stopped: c.stopped, error: null });
      }
    } catch (e) {
      setOutcome({ close: null, open: null, stopped: null, error: e instanceof Error ? e.message : "failed" });
    } finally {
      key = null; // dropped; never stored
      setPhase("done");
      runningRef.current = false;
      onFinished();
    }
  }, [position, mode, onFinished]);

  const holdStart = () => {
    progress.setValue(0);
    holdAnim.current = Animated.timing(progress, { toValue: 1, duration: HOLD_MS, useNativeDriver: false });
    holdAnim.current.start(({ finished }) => { if (finished) run(); });
  };
  const holdEnd = () => {
    if (holdAnim.current) holdAnim.current.stop();
    if (phase === "preview") progress.setValue(0);
  };

  if (!position) return null;
  const p = position;
  // Both legs trade the same way: a long is sold to close, then sold again
  // to open the short (and a short bought twice).
  const side = p.side === "long" ? "SELL" : "BUY";
  const title = (mode === "reverse" ? "Reverse " : "Close ") + p.symbol;

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={phase === "running" ? () => undefined : onClose}>
      <View style={s.scrim}>
        <View style={s.sheet}>
          <View style={s.head}>
            <Text style={s.title}>{title}</Text>
            <Text style={s.headMeta}>{phase === "done" ? "done" : mode === "reverse" ? "close, then open the other side" : "full close at market"}</Text>
          </View>

          <ScrollView style={s.body} contentContainerStyle={{ paddingBottom: 4 }}>
            {phase === "preview" ? (
              <>
                <LegRow leg={mode === "reverse" ? "1" : undefined} side={side} size={p.size} sym={p.symbol} mid={mid}
                  tags={<><Tag label="MFP" /><Tag label={p.provider || "venue"} /></>}
                  sub={"close " + p.side + ": full market close (reduce-only, side set by MFP)"} />
                {mode === "reverse" ? (
                  <LegRow leg="2" side={side} size={p.size} sym={p.symbol} mid={mid} tags={null}
                    sub={"open " + (p.side === "long" ? "short" : "long") + ": market, " + p.leverage + "x " + p.marginMode + ", sent only once the close fills flat"} />
                ) : null}
              </>
            ) : null}

            {phase !== "preview" ? (
              <>
                {outcome?.error ? <Text style={[s.resLine, { color: C.bear }]}>{outcome.error}</Text> : null}
                {outcome?.close ? <CloseRow r={outcome.close} sym={p.symbol} leg={mode === "reverse"} /> : null}
                {outcome && mode === "reverse" && !outcome.error ? <OpenRow outcome={outcome} /> : null}
                {outcome && mode === "close" && outcome.stopped ? <Text style={[s.resLine, { color: C.warn }]}>{"not closed - " + outcome.stopped}</Text> : null}
                {phase === "running" ? (
                  <View style={s.stepsBox}>
                    {steps.slice(-4).map((st, i) => <Text key={i} style={s.stepText}>{st.text}</Text>)}
                    {!steps.length ? <Text style={s.stepText}>waiting for the fingerprint prompt...</Text> : null}
                  </View>
                ) : null}
                {phase === "done" ? <Text style={s.foot}>Positions re-polled from MFP. The venue is the truth; this is what it answered.</Text> : null}
              </>
            ) : null}
          </ScrollView>

          {phase === "preview" ? (
            <>
              <Pressable
                onPressIn={holdStart}
                onPressOut={holdEnd}
                accessibilityRole="button"
                accessibilityLabel={"Hold to confirm: " + title}
                style={s.hold}
              >
                <Animated.View style={[s.holdFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]} />
                <Text style={s.holdText}>{"Hold to " + (mode === "reverse" ? "reverse" : "close") + " \u00b7 then fingerprint"}</Text>
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

// Separate Text nodes (nested values clipped on an Android build at a large font scale).
function LegRow({ leg, side, size, sym, mid, tags, sub }: {
  leg?: string; side: "SELL" | "BUY"; size: number; sym: string; mid: number | null; tags: ReactNode; sub: string;
}) {
  return (
    <View style={s.row}>
      <View style={s.rowTop}>
        {leg ? <Text style={s.legNo}>{leg}</Text> : null}
        <Text style={[s.side, { color: side === "SELL" ? C.bear : C.bull }]}>{side}</Text>
        <Text style={s.rowSym}>{fmtSize(size) + " " + sym}</Text>
        {tags}
        <Text style={s.rowRight}>{mid ? "mid ~" + fmtPx(mid) : "market"}</Text>
      </View>
      <Text style={s.rowSub}>{sub}</Text>
    </View>
  );
}

function CloseRow({ r, sym, leg }: { r: MfpCloseResult; sym: string; leg: boolean }) {
  const o = r.order;
  let line: string, color: string;
  if (r.pending) { line = "close still " + (o ? o.status.toUpperCase() : "UNCONFIRMED") + " on MFP - it may still fill; check MFP before acting"; color = C.warn; }
  else if (o && o.status === "filled" && r.residual === 0) { line = "closed " + fmtSize(r.requested) + (o.fillPrice ? " @ " + fmtPx(o.fillPrice) : ""); color = C.bull; }
  else if (o && o.status === "filled" && r.residual === null) { line = "filled" + (o.fillPrice ? " @ " + fmtPx(o.fillPrice) : "") + " - could not re-read the venue"; color = C.warn; }
  else if (r.residual !== null && r.residual > 0 && o && o.status === "filled") { line = "partial: " + fmtSize(r.residual) + " still open"; color = C.warn; }
  else { line = "not closed: " + (r.error ?? (o ? o.status : "no answer")); color = C.bear; }
  const sub = [
    r.ambiguous ? "the send's answer was lost; the order was looked up, never re-sent" : null,
    r.error && o && o.status === "filled" ? r.error : null,
  ].filter(Boolean).join(" \u00b7 ");
  return (
    <View style={s.row}>
      <View style={s.rowTop}>
        {leg ? <Text style={s.legNo}>1</Text> : null}
        <Text style={s.rowSym}>{sym}</Text>
        <Text style={[s.resLine, { color, flexShrink: 1 }]}>{line}</Text>
      </View>
      {sub ? <Text style={s.rowSub}>{sub}</Text> : null}
    </View>
  );
}

// Leg 2: lead with what the venue holds - a "not reopened" line over a real
// position would invite a manual double.
function OpenRow({ outcome }: { outcome: Outcome }) {
  const o = outcome.open;
  let line: string, color: string;
  if (outcome.stopped) { line = "not reversed - " + outcome.stopped; color = C.warn; }
  else if (o && o.pending && !o.held) {
    // Not filled YET is not "not opened": a manual re-entry here would double.
    line = "opening order still " + (o.order ? o.order.status.toUpperCase() : "UNCONFIRMED") + " on MFP - it may still fill; do not re-enter by hand";
    color = C.warn;
  } else if (o && o.held) {
    line = "venue now holds " + o.held.side + " " + fmtSize(o.held.size) + (o.order?.fillPrice ? " @ " + fmtPx(o.order.fillPrice) : "");
    color = o.error ? C.warn : C.bull;
  } else if (o) {
    line = "closed, not reopened: " + (o.error ?? "no answer");
    color = C.warn;
  } else { line = "not reversed"; color = C.warn; }
  const sub = [
    o && !o.heldRead && !outcome.stopped ? "could not re-read the venue - check MFP" : null,
    o && o.ambiguous ? "the send's answer was lost; the order was looked up, never re-sent" : null,
    o && o.held && o.error ? o.error : null,
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

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(9,9,11,0.35)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: C.card, borderTopWidth: 1, borderColor: C.border,
    borderTopLeftRadius: 14, borderTopRightRadius: 14,
    paddingHorizontal: 14, paddingTop: 14, paddingBottom: 28, gap: 10, maxHeight: "88%",
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 },
  title: { color: C.text, fontSize: 15, fontWeight: "600" },
  headMeta: { color: C.faint, fontSize: 11, flexShrink: 1 },
  body: { flexGrow: 0 },
  row: { paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.border, gap: 2 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  side: { fontSize: 11, fontWeight: "600" },
  legNo: { color: C.faint, fontSize: 10, fontWeight: "600", minWidth: 10 },
  rowSym: { color: C.text, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  rowRight: { marginLeft: "auto", color: C.muted, fontSize: 11, fontVariant: ["tabular-nums"] },
  rowSub: { color: C.faint, fontSize: 10.5, flexShrink: 1 },
  resLine: { fontSize: 11.5, fontVariant: ["tabular-nums"] },
  stepsBox: { marginTop: 8, gap: 2 },
  stepText: { color: C.muted, fontSize: 11, fontVariant: ["tabular-nums"] },
  foot: { color: C.faint, fontSize: 10.5, lineHeight: 14, marginTop: 8 },
  hold: {
    position: "relative", overflow: "hidden", minHeight: 44,
    borderWidth: 1, borderColor: "rgba(255,59,92,0.35)", borderRadius: 8, backgroundColor: C.bearBg,
    alignItems: "center", justifyContent: "center",
  },
  holdFill: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: "rgba(255,59,92,0.28)" },
  holdText: { color: C.bear, fontSize: 13, fontWeight: "600" },
  cancel: { alignItems: "center", paddingVertical: 8, minHeight: 44, justifyContent: "center" },
  cancelText: { color: C.muted, fontSize: 13, fontWeight: "500" },
  doneBtn: { borderWidth: 1, borderColor: C.border, borderRadius: 8, minHeight: 44, alignItems: "center", justifyContent: "center" },
  doneText: { color: C.muted, fontSize: 13, fontWeight: "500" },
  runningNote: { color: C.faint, fontSize: 11, textAlign: "center", paddingVertical: 8 },
});
