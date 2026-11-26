// The ONLY file that talks to the Hyperliquid EXCHANGE endpoint or calls
// signL1Action (scripts/check-exchange-guard.js enforces both). The actions
// here exist nowhere else: a reduce-only IoC close of a tracked wallet's
// position, a cancel of that wallet's own resting orders, and a REVERSE -
// that same close, then (only once the venue reads the coin flat and its
// resting orders are cleared) ONE IoC order opening the opposite side for
// the size just closed (see SECURITY.md).
// Everything is signed with a Hyperliquid API-wallet key the caller read
// from the secure store for this one flow and passes in; the key never
// enters state, storage or logs here.
//
// Truth is the venue: a "filled" status is NOT proof of a flat position -
// the coin's clearinghouse is re-read and any residual reported.
// Only a proven-flat coin has its resting
// orders cancelled. A transport failure is AMBIGUOUS (the venue may have
// executed): never resend the same signed payload; re-read the venue, and
// retry ONCE with a fresh nonce only if the position is still there.
import { infoPost, listDexes } from "./hyperliquid";
import type { Position } from "./hyperliquid";
import {
  AssetInfo, assertScopedAction, buildCancelAction, buildClosePositionOrder, buildReverseOpenOrder,
  ClosePreview, DEFAULT_SLIPPAGE, ExchangeAction, OpenPreview, parseCancelResponse, parseOrderResponse,
  previewReverseOpen, reverseGate, reversePreCheck,
} from "./hl_orders";
import { signL1Action } from "./hl_sign";

const EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";
const IS_MAINNET = true;             // testnet would be "https://api.hyperliquid-testnet.xyz/exchange" + false
const EXPIRES_AFTER_MS = 60_000;
// The reverse's opening leg lives far shorter: after a transport failure it
// is never resent, and the venue is re-read only once this has passed (plus
// OPEN_SETTLE_MS for clock skew and read lag), so no earlier payload can
// still land after the reading.
const OPEN_EXPIRES_MS = 15_000;
const OPEN_SETTLE_MS = 5_000;
const VERIFY_DELAY_MS = 1_500;

// ---- asset table ----------------------------------------------------------

type RawMeta = { universe?: { name?: string; szDecimals?: number }[] };
let assetTable: Map<string, AssetInfo> | null = null;

// perpDexs + meta per dex -> coin id -> {assetId, szDecimals}. Session
// cache; `force` refreshes after an unknown coin (a new listing).
export async function loadAssetTable(force = false): Promise<Map<string, AssetInfo>> {
  if (assetTable && !force) return assetTable;
  const dexes = await listDexes(); // ["", ...builder dexes] in perpDexs order - the same list the portfolio poll uses
  const table = new Map<string, AssetInfo>();
  for (let di = 0; di < dexes.length; di++) {
    const dex = dexes[di];
    const meta = await infoPost<RawMeta>(dex ? { type: "meta", dex } : { type: "meta" });
    const uni = meta.universe || [];
    for (let i = 0; i < uni.length; i++) {
      const u = uni[i];
      if (!u || typeof u.name !== "string" || typeof u.szDecimals !== "number") continue;
      const assetId = di === 0 ? i : 110000 + (di - 1) * 10000 + i;
      table.set(u.name, { coin: u.name, assetId, szDecimals: u.szDecimals, dex, index: i });
    }
  }
  assetTable = table;
  return table;
}

async function assetFor(coin: string): Promise<AssetInfo> {
  let t = await loadAssetTable();
  let a = t.get(coin);
  if (!a) { t = await loadAssetTable(true); a = t.get(coin); }
  if (!a) throw new Error("unknown asset " + coin);
  return a;
}

async function midFor(coin: string, dex: string): Promise<number> {
  const mids = await infoPost<Record<string, string>>(dex ? { type: "allMids", dex } : { type: "allMids" });
  const v = parseFloat(mids[coin] ?? "");
  if (!(v > 0)) throw new Error("no mid for " + coin);
  return v;
}

type RawClearinghouse = { assetPositions?: { position: { coin: string; szi: string } }[] };

// Signed size the venue holds for `coin` right now (0 = flat).
async function venueSize(user: string, coin: string, dex: string): Promise<number> {
  const s = await infoPost<RawClearinghouse>({ type: "clearinghouseState", user, dex });
  for (const ap of s.assetPositions || []) {
    if (ap.position && ap.position.coin === coin) {
      const v = parseFloat(ap.position.szi);
      return Number.isFinite(v) ? v : 0;
    }
  }
  return 0;
}

type RawOpenOrder = { coin: string; oid: number; reduceOnly?: boolean };

async function openOrders(user: string, dex: string): Promise<RawOpenOrder[]> {
  const raw = await infoPost<RawOpenOrder[]>({ type: "frontendOpenOrders", user, dex });
  return Array.isArray(raw) ? raw.filter((o) => o && typeof o.coin === "string" && Number.isInteger(o.oid)) : [];
}

// Strict count for the reverse gate: a non-array answer is "unknown", never
// "none" - the lenient reader above would turn it into an empty list.
async function restingCount(user: string, dex: string, coin: string): Promise<number> {
  const raw = await infoPost<unknown>({ type: "frontendOpenOrders", user, dex });
  if (!Array.isArray(raw)) throw new Error("open orders unreadable");
  return raw.filter((o) => o && typeof o === "object" && (o as RawOpenOrder).coin === coin).length;
}

// ---- signing + posting ----------------------------------------------------

let lastNonce = 0;
function nextNonce(): number {
  const n = Math.max(Date.now(), lastNonce + 1);
  lastNonce = n;
  return n;
}

type PostOutcome = { kind: "response"; json: unknown } | { kind: "transport"; message: string; status: number | null };

// Sign and send ONE action. Runs the runtime guard before signing. Returns
// the venue's JSON, or a transport outcome the caller must treat as
// ambiguous, plus the expiresAfter it was signed with (the moment after
// which the venue can no longer execute it). Never retries by itself.
async function postExchange(key: string, action: ExchangeAction, expiresMs: number = EXPIRES_AFTER_MS): Promise<PostOutcome & { expiresAfter: number }> {
  assertScopedAction(action);
  const nonce = nextNonce();
  const expiresAfter = nonce + expiresMs;
  const signature = signL1Action(key, action, nonce, null, expiresAfter, IS_MAINNET);
  const body = JSON.stringify({ action, nonce, signature, vaultAddress: null, expiresAfter });
  let r: Response;
  try {
    r = await fetch(EXCHANGE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  } catch (e) {
    return { kind: "transport", message: e instanceof Error ? e.message : "network error", status: null, expiresAfter };
  }
  if (!r.ok) return { kind: "transport", message: "HTTP " + r.status, status: r.status, expiresAfter };
  try {
    return { kind: "response", json: await r.json(), expiresAfter };
  } catch {
    return { kind: "transport", message: "unreadable response", status: r.status, expiresAfter };
  }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ---- close one position ---------------------------------------------------

export type CloseStage = "preparing" | "signing" | "sent" | "verifying" | "cancelling" | "done";
export type CloseStep = { coin: string; stage: CloseStage; text: string };
export type CloseResult = {
  coin: string;
  dex: string;
  requested: number;        // size the order asked to close
  filled: number;           // size the venue reports filled (0 on refusal)
  avgPx: number | null;
  residual: number | null;  // venue size after the close (0 = proven flat; null = could not verify)
  cancelled: number;        // resting orders cancelled on this coin
  error: string | null;     // venue text verbatim, or the transport text
  ambiguous: boolean;       // a transport failure left the outcome unproven at some point
};

export type CloseOptions = { cancelRest: boolean; slippage?: number };

// Build the preview the confirmation sheet shows: exactly the action that
// will be signed. Pure apart from the mid and asset lookups.
export async function previewClose(pos: Position, slippage: number = DEFAULT_SLIPPAGE): Promise<ClosePreview> {
  const asset = await assetFor(pos.coin);
  const mid = await midFor(pos.coin, asset.dex);
  return buildClosePositionOrder({ coin: pos.coin, szi: pos.szi }, asset, mid, slippage);
}

export async function closePosition(
  user: string, pos: Position, key: string, opts: CloseOptions, onStep?: (s: CloseStep) => void,
): Promise<CloseResult> {
  const step = (stage: CloseStage, text: string) => onStep && onStep({ coin: pos.coin, stage, text });
  const out: CloseResult = { coin: pos.coin, dex: pos.dex, requested: 0, filled: 0, avgPx: null, residual: null, cancelled: 0, error: null, ambiguous: false };
  let asset: AssetInfo;
  try {
    asset = await assetFor(pos.coin);
  } catch (e) {
    out.error = e instanceof Error ? e.message : "unknown asset";
    return out;
  }
  const slippage = opts.slippage ?? DEFAULT_SLIPPAGE;
  // The size to close: the caller's position, replaced by the venue's own
  // reading after an ambiguous send (a partial may already have happened).
  let szi = pos.szi;

  // One send, at most one retry, and only after the venue says the
  // position is still there following an AMBIGUOUS transport failure.
  // Every attempt reads a FRESH mid and rebuilds its cap: a retry never
  // reuses a stale price.
  for (let attempt = 0; attempt < 2; attempt++) {
    let preview: ClosePreview;
    try {
      step("preparing", "reading mid");
      const mid = await midFor(pos.coin, asset.dex);
      preview = buildClosePositionOrder({ coin: pos.coin, szi }, asset, mid, slippage);
    } catch (e) {
      out.error = e instanceof Error ? e.message : "could not prepare the order";
      return out;
    }
    if (attempt === 0) out.requested = preview.size;
    step("signing", "signing " + preview.side + " " + preview.wire.s + " " + pos.coin);
    const res = await postExchange(key, preview.action);
    step("sent", "sent");
    if (res.kind === "transport") {
      out.ambiguous = true;
      await sleep(res.status === 429 ? 2_000 : VERIFY_DELAY_MS);
      let size: number;
      try {
        size = await venueSize(user, pos.coin, asset.dex);
      } catch (e) {
        out.error = "transport: " + res.message + "; could not re-read the venue";
        return out;
      }
      if (Math.abs(size) < Math.abs(pos.szi) * 0.5) {
        // the venue moved: treat the earlier send as the close
        out.filled = Math.abs(pos.szi) - Math.abs(size);
        out.residual = Math.abs(size);
        break;
      }
      if (attempt === 1) { out.error = "transport: " + res.message + "; position still open"; return out; }
      szi = size; // whatever the venue still holds is what the retry closes
      continue;   // fresh mid, fresh nonce, fresh signature
    }
    const st = parseOrderResponse(res.json);
    if (st.kind === "filled") { out.filled = st.totalSz; out.avgPx = st.avgPx; break; }
    if (st.kind === "resting") { out.error = "order rested instead of filling (oid " + st.oid + ")"; return out; }
    out.error = st.message;
    return out;
  }

  // Proof: the venue's own position, not the order status.
  step("verifying", "reading the venue");
  try {
    await sleep(500);
    out.residual = Math.abs(await venueSize(user, pos.coin, asset.dex));
  } catch {
    out.residual = null;
    return out;
  }
  if (out.residual > 0 || !opts.cancelRest) return out;

  // Proven flat: cancel what still rests on this coin.
  try {
    const rest = (await openOrders(user, asset.dex)).filter((o) => o.coin === pos.coin);
    if (rest.length) {
      step("cancelling", "cancelling " + rest.length + " resting order" + (rest.length > 1 ? "s" : ""));
      const cres = await postExchange(key, buildCancelAction(rest.map((o) => ({ asset, oid: o.oid }))));
      if (cres.kind === "response") {
        const c = parseCancelResponse(cres.json);
        if ("ok" in c) { out.cancelled = c.ok; if (c.errors.length) out.error = "cancel: " + c.errors.join("; "); }
        else out.error = "cancel: " + c.message;
      } else {
        out.error = "cancel transport: " + cres.message;
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
  requested: number;        // size the opening order asked for
  filled: number;           // size the venue reports opened (0 on refusal)
  avgPx: number | null;
  position: number | null;  // the venue's signed size afterwards (null = could not re-read)
  error: string | null;
  ambiguous: boolean;
};

export type ReverseResult = {
  close: CloseResult | null; // null = stopped before leg 1 (nothing sent at all)
  open: OpenResult | null;  // null = leg 2 never sent
  stopped: string | null;   // why leg 2 was not sent (the account is flat or partly closed, never doubled)
};

export type ReversePreview = { close: ClosePreview; open: OpenPreview };

// Both legs as the sheet shows them. Leg 2's real order is rebuilt at a
// fresh mid after leg 1 proves flat; this preview uses the same mid for both.
export async function previewReverse(pos: Position, slippage: number = DEFAULT_SLIPPAGE): Promise<ReversePreview> {
  const asset = await assetFor(pos.coin);
  const mid = await midFor(pos.coin, asset.dex);
  const close = buildClosePositionOrder({ coin: pos.coin, szi: pos.szi }, asset, mid, slippage);
  const open = previewReverseOpen({ coin: pos.coin, priorSzi: pos.szi, closedSize: close.size }, asset, mid, slippage);
  return { close, open };
}

// Three gates, each ending the reverse FLAT (or untouched), never doubled:
// 1. before leg 1, the venue must still hold the position the sheet showed
//    (reversePreCheck) - a shrunk or flipped position never sizes a reverse;
// 2. leg 1 is closePosition exactly, run on the VENUE's size (reduce-only
//    IoC, re-read, the coin's resting orders cancelled);
// 3. leg 2 is sent only when reverseGate passes: proven flat, no error, the
//    coin's open orders re-read (strictly) as none, and a size capped by
//    what the venue held, what leg 1 asked and what it filled.
// Leg 2 is sent ONCE, signed to expire in OPEN_EXPIRES_MS. A transport
// failure is never retried: the app waits out that expiry and reports what
// the venue then holds - a retry could land beside a delayed first payload
// and double the new position.
export async function reversePosition(
  user: string, pos: Position, key: string, onStep?: (s: CloseStep) => void, slippage: number = DEFAULT_SLIPPAGE,
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

  const close = await closePosition(user, { ...pos, szi: venuePre }, key, { cancelRest: true, slippage }, onStep);
  let resting: number | null = null;
  if (close.residual === 0 && !close.error) {
    try {
      step("verifying", "checking the coin's orders are cleared");
      resting = await restingCount(user, asset.dex, pos.coin);
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
  const open: OpenResult = { requested: 0, filled: 0, avgPx: null, position: null, error: null, ambiguous: false };
  let preview: OpenPreview;
  try {
    step("preparing", "reading mid for the reverse");
    const mid = await midFor(pos.coin, asset.dex);
    preview = buildReverseOpenOrder(gate, { coin: pos.coin, priorSzi: venuePre }, asset, mid, slippage);
  } catch (e) {
    open.error = e instanceof Error ? e.message : "could not prepare the reverse";
    return { close, open, stopped: null };
  }
  open.requested = preview.size;
  step("signing", "signing " + preview.side + " " + preview.wire.s + " " + pos.coin + " (open)");
  const res = await postExchange(key, preview.action, OPEN_EXPIRES_MS);
  step("sent", "sent");
  if (res.kind === "transport") {
    open.ambiguous = true;
    const wait = Math.max(0, res.expiresAfter + OPEN_SETTLE_MS - Date.now());
    step("verifying", "waiting " + Math.ceil(wait / 1000) + " s for the order to expire, then reading the venue");
    await sleep(wait);
    try {
      open.position = await venueSize(user, pos.coin, asset.dex);
    } catch {
      open.error = "transport: " + res.message + "; could not re-read the venue";
      return { close, open, stopped: null };
    }
    if (open.position !== 0 && Math.sign(open.position) === newSign) open.filled = Math.abs(open.position);
    else if (open.position !== 0) open.error = "venue shows an unexpected " + (open.position > 0 ? "long" : "short");
    else open.error = "transport: " + res.message + "; nothing opened (not retried)";
  } else {
    const st = parseOrderResponse(res.json);
    if (st.kind === "filled") { open.filled = st.totalSz; open.avgPx = st.avgPx; }
    else if (st.kind === "resting") open.error = "order rested instead of filling (oid " + st.oid + ")";
    else open.error = st.message;
    step("verifying", "reading the venue");
    try {
      await sleep(500);
      open.position = await venueSize(user, pos.coin, asset.dex);
    } catch {
      open.position = null;
    }
    // The venue is the truth: a malformed or error status beside a new-side
    // position still means it opened.
    if (open.filled === 0 && open.position !== null && open.position !== 0 && Math.sign(open.position) === newSign) {
      open.filled = Math.abs(open.position);
    }
  }
  // Loud flag, never an automatic extra trade: the new side should never
  // exceed what was asked.
  const stepSz = Math.pow(10, -asset.szDecimals);
  if (open.position !== null && Math.abs(open.position) > open.requested + stepSz + 1e-12) {
    open.error = (open.error ? open.error + "; " : "") + "the venue holds MORE than the reverse asked for - check the position";
  }
  step("done", "done");
  return { close, open, stopped: null };
}

// ---- flatten a wallet -----------------------------------------------------

// Close every position in sequence (never in parallel), then sweep the
// wallet's remaining resting orders on every dex - EXCEPT coins whose close
// was not proven flat, which keep their orders (a residual stays covered).
export async function flattenWallet(
  user: string, positions: Position[], key: string, opts: CloseOptions, onStep?: (s: CloseStep) => void,
): Promise<{ results: CloseResult[]; sweptOrders: number; sweepError: string | null }> {
  const results: CloseResult[] = [];
  for (const p of positions) results.push(await closePosition(user, p, key, { ...opts, cancelRest: false }, onStep));
  const keepOrders = new Set(results.filter((r) => r.residual === null || r.residual > 0).map((r) => r.coin));
  let sweptOrders = 0;
  let sweepError: string | null = null;
  if (opts.cancelRest) {
    try {
      const table = await loadAssetTable();
      const dexes = [...new Set([...table.values()].map((a) => a.dex))];
      const cancels: { asset: AssetInfo; oid: number }[] = [];
      for (const dex of dexes) {
        for (const o of await openOrders(user, dex)) {
          const asset = table.get(o.coin);
          if (!asset || keepOrders.has(o.coin)) continue;
          cancels.push({ asset, oid: o.oid });
        }
      }
      if (cancels.length) {
        onStep && onStep({ coin: "", stage: "cancelling", text: "cancelling " + cancels.length + " resting order" + (cancels.length > 1 ? "s" : "") });
        const cres = await postExchange(key, buildCancelAction(cancels));
        if (cres.kind === "response") {
          const c = parseCancelResponse(cres.json);
          if ("ok" in c) { sweptOrders = c.ok; if (c.errors.length) sweepError = c.errors.join("; "); }
          else sweepError = c.message;
        } else {
          sweepError = "transport: " + cres.message;
        }
      }
    } catch (e) {
      sweepError = e instanceof Error ? e.message : "order sweep failed";
    }
  }
  return { results, sweptOrders, sweepError };
}
