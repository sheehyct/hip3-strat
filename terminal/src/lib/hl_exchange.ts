// The ONLY file that talks to the Hyperliquid EXCHANGE endpoint or calls
// signL1Action (scripts/check-exchange-guard.js enforces both, and that
// fetch appears here exactly once, inside postExchange, which runs the
// runtime guard before signing).
//
// Every write: built by hl_orders.ts, asserted, signed with the agent key
// the caller read from the secure store for this one call, sent ONCE with
// a short expiry, never retried automatically. A transport failure is
// AMBIGUOUS (the venue may have executed): the order is looked up by its
// cloid (orderStatus) and the position re-read; nothing is resent. Truth is
// the venue: a "filled" status is a hint, the re-read is the proof.
import { fetchHlMarkets, fetchOpenOrders, fetchOrderStatus, infoPost, listDexes } from "./hyperliquid";
import type { HlOpenOrder } from "./hyperliquid";
import {
  AssetInfo, assertScopedAction, buildCancelAction, buildClosePositionOrder, buildLeverageAction, buildMarketOrder,
  buildModifyAction, ClosePreview, DEFAULT_SLIPPAGE, ExchangeAction, hlOrderFate, newCloid, OrderPreview, parseCancelResponse,
  parseOrderResponse, parseSimpleResponse, reverseGate, reversePreCheck,
} from "./hl_orders";
import { signL1Action } from "./hl_sign";
import { capRefusal } from "./order_policy";
import { assertSession, StaleSession } from "./session";
import type { Session } from "./session";

const EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";
const IS_MAINNET = true;
// Every action is signed to expire 15 s after its nonce: a payload whose
// answer was lost is dead for sure once that (plus a settle margin for
// clock skew and read lag) has passed, and only THEN is the venue asked
// what happened. Nothing is ever resent.
const EXPIRES_AFTER_MS = 15_000;
const OPEN_EXPIRES_MS = 15_000;
const OPEN_SETTLE_MS = 5_000;
const VERIFY_DELAY_MS = 1_500;
// A post that never answers is cut off here and handled as a lost answer
// (the payload's expiry still bounds what the venue can do with it). Without
// it a hung request would hold the market's lock for ever.
const POST_TIMEOUT_MS = 12_000;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ---- asset table ----------------------------------------------------------

let assetTable: Map<string, AssetInfo> | null = null;

export async function loadAssetTable(force = false): Promise<Map<string, AssetInfo>> {
  if (assetTable && !force) return assetTable;
  const rows = await fetchHlMarkets(await listDexes());
  const table = new Map<string, AssetInfo>();
  for (const r of rows) table.set(r.coin, { coin: r.coin, assetId: r.assetId, szDecimals: r.szDecimals, dex: r.dex, index: r.index, maxLeverage: r.maxLeverage });
  assetTable = table;
  return table;
}

export async function assetFor(coin: string): Promise<AssetInfo> {
  let t = await loadAssetTable();
  let a = t.get(coin);
  if (!a) { t = await loadAssetTable(true); a = t.get(coin); }
  if (!a) throw new Error("unknown asset " + coin);
  return a;
}

export async function midFor(coin: string, dex: string): Promise<number> {
  const mids = await infoPost<Record<string, string>>(dex ? { type: "allMids", dex } : { type: "allMids" });
  const v = parseFloat(mids[coin] ?? "");
  if (!(v > 0)) throw new Error("no mid for " + coin);
  return v;
}

// The signed size a clearinghouse state holds for `coin` (0 = flat). Throws
// when the answer is malformed: unknown is never flat. EVERY row is checked
// before the coin is looked for - a row whose coin or size cannot be read
// could be this coin, so it makes the whole answer unreadable instead of
// being skipped (a skipped row would read as "flat" and let a reverse open).
export function sizeInClearinghouse(raw: unknown, coin: string): number {
  const s = raw as { assetPositions?: unknown } | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.assetPositions)) throw new Error("clearinghouse unreadable");
  let found: number | null = null;
  for (const ap of s.assetPositions as { position?: { coin?: unknown; szi?: unknown } }[]) {
    const p = ap && typeof ap === "object" ? ap.position : null;
    if (!p || typeof p !== "object" || typeof p.coin !== "string" || !p.coin) throw new Error("clearinghouse unreadable: a position row has no coin");
    const v = typeof p.szi === "string" && p.szi.trim() !== "" ? Number(p.szi) : typeof p.szi === "number" ? p.szi : NaN;
    if (!Number.isFinite(v)) throw new Error("position size unreadable for " + p.coin);
    if (p.coin === coin) {
      if (found !== null) throw new Error("clearinghouse unreadable: " + coin + " appears twice");
      found = v;
    }
  }
  return found ?? 0;
}

export async function venueSize(user: string, coin: string, dex: string): Promise<number> {
  return sizeInClearinghouse(await infoPost<unknown>({ type: "clearinghouseState", user, dex }), coin);
}

async function restingOnCoin(user: string, dex: string, coin: string): Promise<HlOpenOrder[]> {
  return (await fetchOpenOrders(user, dex)).filter((o) => o.coin === coin);
}

// ---- signing + posting ----------------------------------------------------

let lastNonce = 0;
function nextNonce(): number {
  const n = Math.max(Date.now(), lastNonce + 1);
  lastNonce = n;
  return n;
}

export type PostOutcome = { kind: "response"; json: unknown } | { kind: "transport"; message: string; status: number | null };

// Sign and send ONE action. Runs the runtime guard before signing. Returns
// the venue's JSON, or a transport outcome the caller treats as ambiguous.
// Never retries by itself.
//
// `s` is the write session the operation began in. It is checked HERE, on
// the last line before signing, because every await above this point (key
// access behind a fingerprint prompt, a mid read, the first leg of a
// sequence) is a moment in which the app can have left live mode. A stale
// session throws StaleSession: nothing is signed and nothing is sent.
async function postExchange(s: Session, key: string, action: ExchangeAction, expiresMs: number = EXPIRES_AFTER_MS): Promise<PostOutcome & { expiresAfter: number }> {
  assertScopedAction(action);
  assertSession(s);
  const nonce = nextNonce();
  const expiresAfter = nonce + expiresMs;
  const signature = signL1Action(key, action, nonce, null, expiresAfter, IS_MAINNET);
  const body = JSON.stringify({ action, nonce, signature, vaultAddress: null, expiresAfter });
  let r: Response;
  const ctl = new AbortController();
  // The deadline covers the body as well as the headers, and is raced
  // against both so it holds even where a body read ignores the abort.
  let cut: (e: Error) => void = () => undefined;
  const deadline = new Promise<never>((_, reject) => { cut = reject; });
  deadline.catch(() => undefined);
  const timer = setTimeout(() => { ctl.abort(); cut(new Error("timed out")); }, POST_TIMEOUT_MS);
  try {
    try {
      r = await Promise.race([fetch(EXCHANGE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ctl.signal }), deadline]);
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "AbortError" || e.message === "timed out");
      return { kind: "transport", message: timedOut ? "timed out" : e instanceof Error ? e.message : "network error", status: null, expiresAfter };
    }
    if (!r.ok) return { kind: "transport", message: "HTTP " + r.status, status: r.status, expiresAfter };
    try {
      return { kind: "response", json: await Promise.race([r.json(), deadline]), expiresAfter };
    } catch {
      return { kind: "transport", message: "unreadable response", status: r.status, expiresAfter };
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---- one order --------------------------------------------------------------

export type SendResult = {
  kind: "filled" | "resting" | "rejected" | "unknown";
  oid: number | null;
  cloid: string;
  filledSz: number;
  avgPx: number | null;
  message: string | null;   // the venue's text on a refusal, the transport text on unknown
  ambiguous: boolean;       // the answer was lost and the order was looked up instead
  deadAfter: number;        // the signed payload cannot land after this (expiry + settle margin)
};

// The time after which a signed payload is dead for sure.
const deadAfterOf = (expiresAfter: number): number => expiresAfter + OPEN_SETTLE_MS;

// Send one built order ONCE. On a lost answer - a transport failure, or an
// answer that arrived but cannot be read - wait until the signed payload
// has expired (plus a settle margin), then look the cloid up (the order's
// own status). Never resend. Only the venue's own refusal is "rejected".
export async function sendOrder(s: Session, user: string, key: string, preview: OrderPreview, expiresMs: number = EXPIRES_AFTER_MS, onStep?: (text: string, lost?: boolean) => void): Promise<SendResult> {
  const res = await postExchange(s, key, preview.action, expiresMs);
  const out: SendResult = { kind: "unknown", oid: null, cloid: preview.cloid, filledSz: 0, avgPx: null, message: null, ambiguous: false, deadAfter: deadAfterOf(res.expiresAfter) };
  let lost: string;
  if (res.kind === "response") {
    const st = parseOrderResponse(res.json);
    if (st.kind === "filled") return { ...out, kind: "filled", oid: st.oid, filledSz: st.totalSz, avgPx: st.avgPx };
    if (st.kind === "resting") return { ...out, kind: "resting", oid: st.oid };
    if (st.kind === "error" || st.kind === "err") return { ...out, kind: "rejected", message: st.message };
    lost = "unreadable answer: " + st.message;
  } else {
    lost = "transport: " + res.message;
  }
  out.ambiguous = true;
  out.message = lost;
  const wait = Math.max(VERIFY_DELAY_MS, out.deadAfter - Date.now());
  // lost = true: from here this call only waits and reads. The caller is told
  // so it can stop treating the write as in flight (exits must not wait on it).
  onStep?.("answer lost (" + lost + "); waiting " + Math.ceil(wait / 1000) + " s for the payload to expire, then looking it up - not resending", true);
  await sleep(wait);
  try {
    const h = await fetchOrderStatus(user, preview.cloid);
    if (!h) return out;   // never seen: unknown; the store asks again and reads the venue
    out.oid = h.oid;
    const f = hlOrderFate(h.status, h.origSz, h.sz);
    if (f.fate === "open") return { ...out, kind: "resting" };
    // Finished: whatever executed counts, even when the remainder was canceled.
    if (f.fate === "done") return f.filled > 0 ? { ...out, kind: "filled", filledSz: f.filled, avgPx: null } : { ...out, kind: "rejected", message: h.status };
    return out;
  } catch {
    return out;
  }
}

export type SimpleResult = { ok: boolean; message: string | null; ambiguous: boolean; deadAfter: number | null };

export async function cancelOrders(s: Session, user: string, key: string, list: { asset: AssetInfo; oid: number }[]): Promise<SimpleResult> {
  const res = await postExchange(s, key, buildCancelAction(list));
  const deadAfter = deadAfterOf(res.expiresAfter);
  let lost: string;
  if (res.kind === "response") {
    const c = parseCancelResponse(res.json);
    if ("ok" in c) return { ok: c.errors.length === 0, message: c.errors.length ? c.errors.join("; ") : null, ambiguous: false, deadAfter };
    if (c.kind === "err") return { ok: false, message: c.message, ambiguous: false, deadAfter };
    lost = "unreadable answer: " + c.message;
  } else {
    lost = "transport: " + res.message;
  }
  // Lost answer: proof is the open-orders re-read.
  await sleep(VERIFY_DELAY_MS);
  try {
    const dexes = [...new Set(list.map((l) => l.asset.dex))];
    const oids = new Set(list.map((l) => l.oid));
    for (const dex of dexes) {
      const still = (await fetchOpenOrders(user, dex)).some((o) => oids.has(o.oid));
      if (still) return { ok: false, message: lost + "; the order still rests", ambiguous: true, deadAfter };
    }
    return { ok: true, message: null, ambiguous: true, deadAfter };
  } catch {
    return { ok: false, message: lost + "; could not re-read the venue", ambiguous: true, deadAfter };
  }
}

export async function modifyOrder(s: Session, user: string, key: string, oid: number, replacement: OrderPreview, dex: string): Promise<SimpleResult> {
  const res = await postExchange(s, key, buildModifyAction(oid, replacement));
  const deadAfter = deadAfterOf(res.expiresAfter);
  let lost: string;
  if (res.kind === "response") {
    const s = parseSimpleResponse(res.json);
    if (s.kind === "ok") return { ok: true, message: null, ambiguous: false, deadAfter };
    if (s.kind !== "malformed") return { ok: false, message: s.message, ambiguous: false, deadAfter };
    lost = "unreadable answer: " + s.message;
  } else {
    lost = "transport: " + res.message;
  }
  await sleep(VERIFY_DELAY_MS);
  try {
    // A modify replaces the oid; the new order carries the replacement's cloid.
    const rows = await fetchOpenOrders(user, dex);
    if (rows.some((o) => o.cloid === replacement.cloid)) return { ok: true, message: null, ambiguous: true, deadAfter };
    if (rows.some((o) => o.oid === oid)) return { ok: false, message: lost + "; the order is unchanged", ambiguous: true, deadAfter };
    return { ok: false, message: lost + "; the order is gone - check the venue", ambiguous: true, deadAfter };
  } catch {
    return { ok: false, message: lost + "; could not re-read the venue", ambiguous: true, deadAfter };
  }
}

export async function setLeverage(s: Session, key: string, asset: AssetInfo, isCross: boolean, leverage: number): Promise<SimpleResult> {
  const res = await postExchange(s, key, buildLeverageAction(asset, isCross, leverage));
  const deadAfter = deadAfterOf(res.expiresAfter);
  if (res.kind === "response") {
    const s = parseSimpleResponse(res.json);
    if (s.kind === "ok") return { ok: true, message: null, ambiguous: false, deadAfter };
    if (s.kind !== "malformed") return { ok: false, message: s.message, ambiguous: false, deadAfter };
    return { ok: false, message: "unreadable answer: " + s.message, ambiguous: true, deadAfter };
  }
  return { ok: false, message: "transport: " + res.message, ambiguous: true, deadAfter };
}

// ---- close one position ---------------------------------------------------

// "waiting": an answer was lost and the call is only waiting out the payload.
export type CloseStage = "preparing" | "signing" | "sent" | "verifying" | "waiting" | "cancelling" | "done";
export type CloseStep = { coin: string; stage: CloseStage; text: string };
export type CloseResult = {
  coin: string;
  dex: string;
  requested: number;        // size the order asked to close
  filled: number;           // size the venue reports filled (0 on refusal)
  avgPx: number | null;
  residual: number | null;  // venue size after the close (0 = proven flat; null = could not verify)
  cancelled: number;        // resting orders cancelled on this coin
  error: string | null;
  ambiguous: boolean;
  cloid: string | null;     // the close order's id (null = nothing was sent)
  deadAfter: number | null; // the close payload cannot land after this
  // Flat's cancel, when its answer was lost and the re-read did not show the
  // orders gone: the cancel can still land until its own payload expires.
  // It is a write that is still alive, never just an error string.
  cancelLive: { oids: number[]; deadAfter: number | null; message: string } | null;
};

export type CloseOptions = { cancelRest: boolean; slippage?: number; fraction?: number };

export async function previewClose(pos: { coin: string; szi: number }, slippage: number = DEFAULT_SLIPPAGE, fraction = 1): Promise<ClosePreview> {
  const asset = await assetFor(pos.coin);
  const mid = await midFor(pos.coin, asset.dex);
  return buildClosePositionOrder({ coin: pos.coin, szi: pos.szi }, asset, mid, newCloid(Date.now()), slippage, fraction);
}

// A reduce-only IoC close of `fraction` of the position. ONE send. A lost
// answer is resolved by sendOrder's cloid lookup after the payload has
// expired, then by the venue's own position; it is never resent.
export async function closePosition(
  s: Session, user: string, pos: { coin: string; dex: string; szi: number }, key: string, opts: CloseOptions, onStep?: (s: CloseStep) => void,
): Promise<CloseResult> {
  const step = (stage: CloseStage, text: string) => onStep && onStep({ coin: pos.coin, stage, text });
  const out: CloseResult = { coin: pos.coin, dex: pos.dex, requested: 0, filled: 0, avgPx: null, residual: null, cancelled: 0, error: null, ambiguous: false, cloid: null, deadAfter: null, cancelLive: null };
  let asset: AssetInfo;
  try {
    asset = await assetFor(pos.coin);
  } catch (e) {
    out.error = e instanceof Error ? e.message : "unknown asset";
    return out;
  }
  const slippage = opts.slippage ?? DEFAULT_SLIPPAGE;
  const fraction = opts.fraction ?? 1;
  let preview: ClosePreview;
  try {
    step("preparing", "reading mid");
    const mid = await midFor(pos.coin, asset.dex);
    preview = buildClosePositionOrder({ coin: pos.coin, szi: pos.szi }, asset, mid, newCloid(Date.now()), slippage, fraction);
  } catch (e) {
    out.error = e instanceof Error ? e.message : "could not prepare the order";
    return out;
  }
  out.requested = preview.size;
  step("signing", "signing " + preview.side + " " + preview.wire.s + " " + pos.coin);
  out.cloid = preview.cloid;
  const res = await sendOrder(s, user, key, preview, EXPIRES_AFTER_MS, (t, lost) => step(lost ? "waiting" : "verifying", t));
  step("sent", "sent");
  out.ambiguous = res.ambiguous;
  out.deadAfter = res.deadAfter;
  if (res.kind === "filled") { out.filled = res.filledSz; out.avgPx = res.avgPx; }
  else if (res.kind === "resting") { out.error = "order rested instead of filling (oid " + res.oid + ")"; return out; }
  else if (res.kind === "rejected") { out.error = res.message; return out; }

  if (res.kind === "unknown") {
    // Unknown even after the lookup (the venue does not know the order, or
    // its status could not be read). The position is read for what is LEFT,
    // but a smaller position is not credited to this order: something else
    // can have reduced it. What this order did stays unknown until the
    // venue's status for it says so (the store keeps asking).
    try {
      const size = await venueSize(user, pos.coin, asset.dex);
      out.residual = Math.abs(size);
      if (out.residual > 0) out.error = (res.message ?? "answer lost") + "; the venue has not said what happened to the close (not resent)";
    } catch {
      out.error = (res.message ?? "answer lost") + "; could not re-read the venue";
      return out;
    }
  } else {
    step("verifying", "reading the venue");
    try {
      await sleep(500);
      out.residual = Math.abs(await venueSize(user, pos.coin, asset.dex));
    } catch {
      out.residual = null;
      return out;
    }
  }
  // Flat's second half runs on EVERY path that proved the position flat,
  // the lost-answer path included: a resting order must not outlive it.
  if (out.residual === null || out.residual > 0 || !opts.cancelRest) return out;

  // Proven flat: cancel what still rests on this coin.
  try {
    const rest = await restingOnCoin(user, asset.dex, pos.coin);
    if (rest.length) {
      step("cancelling", "cancelling " + rest.length + " resting order" + (rest.length > 1 ? "s" : ""));
      const c = await cancelOrders(s, user, key, rest.map((o) => ({ asset, oid: o.oid })));
      if (c.ok) out.cancelled = rest.length;
      else {
        out.error = "cancel: " + (c.message ?? "failed");
        if (c.ambiguous) out.cancelLive = { oids: rest.map((o) => o.oid), deadAfter: c.deadAfter, message: c.message ?? "answer lost" };
      }
    }
  } catch (e) {
    out.error = "cancel: " + (e instanceof Error ? e.message : "failed");
  }
  step("done", "done");
  return out;
}

// ---- reverse one position -------------------------------------------------

export type OpenResult = {
  requested: number;
  filled: number;
  avgPx: number | null;
  position: number | null;  // the venue's signed size afterwards (null = could not re-read)
  error: string | null;
  ambiguous: boolean;
  deadAfter: number | null; // the opening payload cannot land after this
  cloid: string | null;     // the opening order's id (null = it was never sent)
  // What the opening order did, from the order itself (the venue's answer,
  // or its status for the order when the answer was lost) - never inferred
  // from the position, which something else can have opened. "unknown" =
  // the venue has not said.
  fate: "filled" | "none" | "unknown";
};

export type ReverseResult = {
  close: CloseResult | null; // null = stopped before leg 1 (nothing sent at all)
  open: OpenResult | null;  // null = leg 2 never sent
  stopped: string | null;   // why leg 2 was not sent
};

// The reverse sequence: pre-check the venue still holds
// the shown position; close on the VENUE's size with the coin's resting
// orders cancelled; the strict gate (proven flat, no error, no orders left,
// size capped by every truth); then ONE short-expiry opening IoC, never
// retried after a transport failure (the app waits out the expiry and
// reports what the venue holds).
export async function reversePosition(
  s: Session, user: string, pos: { coin: string; dex: string; szi: number }, key: string, maxNotional: number, onStep?: (s: CloseStep) => void, slippage: number = DEFAULT_SLIPPAGE,
): Promise<ReverseResult> {
  const step = (stage: CloseStage, text: string) => onStep && onStep({ coin: pos.coin, stage, text });
  const stopBefore = (why: string): ReverseResult => ({ close: null, open: null, stopped: why + "; nothing was sent" });
  let asset: AssetInfo;
  let venuePre: number;
  try {
    asset = await assetFor(pos.coin);
    step("preparing", "re-reading the position");
    venuePre = await venueSize(user, pos.coin, asset.dex);
  } catch (e) {
    return stopBefore(e instanceof Error ? e.message : "could not read the venue");
  }
  const pre = reversePreCheck(pos.szi, venuePre, asset.szDecimals);
  if (pre) return stopBefore(pre);

  const close = await closePosition(s, user, { ...pos, szi: venuePre }, key, { cancelRest: true, slippage }, onStep);
  let resting: number | null = null;
  if (close.residual === 0 && !close.error) {
    try {
      step("verifying", "checking the coin's orders are cleared");
      resting = (await restingOnCoin(user, asset.dex, pos.coin)).length;
    } catch {
      resting = null;
    }
  }
  const gate = reverseGate({
    venueSzi: venuePre, closeRequested: close.requested, closeFilled: close.filled,
    closeAmbiguous: close.ambiguous, closeResidual: close.residual, closeError: close.error,
    restingOnCoin: resting, szDecimals: asset.szDecimals,
  });
  if (!gate.ok) return { close, open: null, stopped: gate.reason + "; no opening order was sent" };

  const newSign = venuePre > 0 ? -1 : 1;
  const open: OpenResult = { requested: 0, filled: 0, avgPx: null, position: null, error: null, ambiguous: false, deadAfter: null, cloid: null, fate: "none" };
  let preview: OrderPreview;
  try {
    step("preparing", "reading mid for the reverse");
    const mid = await midFor(pos.coin, asset.dex);
    // Leg 2 OPENS: the market's cap applies to the size and the price it is
    // about to be sent at, not to the mark the reverse was asked on.
    const cap = capRefusal(gate.size, mid, maxNotional);
    if (cap) {
      open.error = cap + " - the opening order was not sent";
      return { close, open, stopped: null };
    }
    preview = buildMarketOrder(asset, newSign > 0, gate.size, mid, slippage, false, newCloid(Date.now()));
  } catch (e) {
    open.error = e instanceof Error ? e.message : "could not prepare the reverse";
    return { close, open, stopped: null };
  }
  step("signing", "signing " + preview.side + " " + preview.wire.s + " " + pos.coin + " (open)");
  // ONE send, through the same path as every other order: on a lost answer
  // (a transport failure, or an answer that cannot be read) it waits out the
  // payload's expiry and then asks the venue about THIS order by its id.
  // Never resent. What the order did is taken from the order - the answer,
  // or that status - and never from the position: a position on the new
  // side says a position exists, not that this order opened it.
  let res: SendResult;
  try {
    res = await sendOrder(s, user, key, preview, OPEN_EXPIRES_MS, (t, lost) => step(lost ? "waiting" : "verifying", t));
  } catch (e) {
    // The app left this session between the close and the opening order:
    // the opening order was never signed. Closed, not reopened.
    if (!(e instanceof StaleSession)) throw e;
    open.error = e.message;
    return { close, open, stopped: null };
  }
  open.requested = preview.size;
  open.cloid = preview.cloid;
  step("sent", "sent");
  open.deadAfter = res.deadAfter;
  open.ambiguous = res.ambiguous;
  if (res.kind === "filled") { open.filled = res.filledSz; open.avgPx = res.avgPx; open.fate = "filled"; }
  else if (res.kind === "resting") open.error = "order rested instead of filling (oid " + res.oid + ")";
  else if (res.kind === "rejected") open.error = (res.message ?? "refused") + (res.ambiguous ? "; nothing opened (not retried)" : "");
  else { open.fate = "unknown"; open.error = (res.message ?? "answer lost") + "; the venue has not said what happened to the opening order (not retried)"; }
  step("verifying", "reading the venue");
  try {
    if (!res.ambiguous) await sleep(500);
    open.position = await venueSize(user, pos.coin, asset.dex);
  } catch {
    open.position = null;
  }
  const stepSz = Math.pow(10, -asset.szDecimals);
  if (open.position !== null && Math.abs(open.position) > open.requested + stepSz + 1e-12) {
    open.error = (open.error ? open.error + "; " : "") + "the venue holds MORE than the reverse asked for - check the position";
  }
  step("done", "done");
  return { close, open, stopped: null };
}
