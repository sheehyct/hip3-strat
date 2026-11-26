// The venue client interface the app drives. Three implementations:
// hl_venue.ts (Hyperliquid), mfp_venue.ts (MyFundedPerps) and
// mock_venue.ts (the screenshot / demo layer with fake positions and
// fills). Screens never call a venue directly: venue_store.ts owns the
// clients, the polling and the pending ledger.
//
// Every write resolves to a WriteOutcome. It is what the venue ANSWERED,
// never proof: the store (write_ledger.ts) keeps the write pending until a
// venue re-read taken after the answer shows the effect.
// - "confirmed": the venue answered yes for the whole intent. A claim.
// - "pending": the venue is still working on it (an MFP order not yet
//   terminal).
// - "partial": part of the intent executed and nothing more of THIS item is
//   in flight (an IoC partly filled; closed but not reopened; flat but a
//   cancel was refused). The message says what is left. Anything of the
//   sequence that IS still alive at the venue (a cancel whose answer was
//   lost, a close the venue is still working on) is listed in `live` and
//   becomes its own pending item: "partial" never erases a live write.
// - "rejected": nothing executed. With ambiguous = true the answer was lost
//   and only the adapter's own look says so: the store treats it as unknown.
// - "unknown": the answer was lost and the lookup could not settle it.
import type { Balance, Market, OpenOrder, Position, Quote, VenueId, VenueSnapshot, HistoryRow } from "./types";
import type { OrderIntent } from "./order_policy";

export type WriteState = "confirmed" | "pending" | "partial" | "rejected" | "unknown";

// The identity this app gave an order: what the venue can be asked about
// later (a read, never a resend) and what an open order carries back.
export type WriteRef = { venue: "hl"; cloid: string } | { venue: "mfp"; clientOrderId: string };

// One attached exit of an entry. "sent" = the venue took it (or attaches it
// itself); "rejected" = it is NOT there; "unknown" = its answer was lost;
// "waiting" = the venue holds it on an entry that has not filled yet (MFP:
// the entry is resting, still pending, or its answer was lost) - it is
// tracked with the entry and verified by itself once the entry fills.
export type ExitLeg = {
  kind: "tp" | "sl";
  price: number;             // the price that went on the wire
  state: "sent" | "rejected" | "unknown" | "waiting";
  message: string | null;
  orderKey: string | null;   // the resting order's key when the answer named it
  ref: WriteRef | null;
  deadAfter: number | null;
};

// A write of a sequence (Flat, Reverse) that is still alive at the venue
// when the adapter returns.
// - cancel: its answer was lost and the orders were still there; it can
//   land until deadAfter (null = the venue gives no such bound).
// - close: the venue is still working on it ("sent") or its answer was lost
//   ("unknown"); `ref` is the close order's id.
export type LiveLeg =
  | { kind: "cancel"; orderKeys: string[]; message: string | null; deadAfter: number | null }
  | { kind: "close"; state: "sent" | "unknown"; ref: WriteRef | null; message: string | null; deadAfter: number | null };

export type LeverageRead = { leverage: number; marginMode: "cross" | "isolated" };

export type WriteOutcome = {
  state: WriteState;
  message: string | null;
  ambiguous: boolean;
  // The one order this write SENT or CREATED (an entry, a close, a new exit,
  // a Hyperliquid move's replacement). Its presence on the venue proves the
  // write; the venue is asked about it by this id.
  ref?: WriteRef | null;
  // An order that EXISTED before this write and whose fate settles it (a
  // moved order on a venue that keeps the order's id). Asked about, never
  // taken as proof: it was there already.
  watch?: WriteRef | null;
  // Hyperliquid: the signed payload cannot land after this time (its expiry
  // plus a settle margin). null / absent = the venue gives no such bound.
  deadAfter?: number | null;
  filled?: number | null;       // base units the answer reported filled (a hint)
  // A close: the venue position (absolute) the adapter sized it on, read at
  // that moment, and the size it sent. The shown position can be a poll old.
  sized?: { from: number; size: number } | null;
  orderKey?: string | null;     // the order the answer says now rests
  price?: number | null;        // the price that went on the wire (after rounding)
  // A move: the size the venue took the order to (MFP floors a modify's size
  // to the market's step). null / absent = the size that was asked for.
  size?: number | null;
  legs?: ExitLeg[];             // attached exits, each verified by itself
  live?: LiveLeg[];             // writes of the sequence still alive at the venue
  nothingSent?: boolean;        // no venue write happened (MFP leverage is per order)
};

// What the venue says about one order when asked by its WriteRef.
// - "open": it exists and can still change (resting, armed, pending);
//   `resting` = it is on the book / armed (as against still being placed).
// - "done": it is finished. `full` = the venue's status says it filled
//   completely; otherwise `filled` is the executed size as far as the venue's
//   record shows it (0 = nothing). On an "open" order `filled` is what has
//   executed so far (a limit that filled in part and still works).
// - "unseen": the venue does not know this order.
// - "unreadable": the read failed or the status was not understood. With
//   `held` it was not SENT at all (the venue's request budget): nothing was
//   asked, so the write has not had its turn.
export type Lookup = { status: "open" | "done" | "unseen" | "unreadable"; full: boolean; filled: number; message: string | null; resting?: boolean; held?: boolean };

// A write's progress line. `phase` says the request is OUT and the adapter is
// now only waiting, not sending: "lost" = its answer was lost and the
// adapter is waiting to look the order up; "placed" = the venue has it and is
// still working on it. From that step on the write no longer counts as "in
// flight this instant": Close, Flat and Cancel are free again, while new
// exposure stays locked. A later step with no phase (the next send or read
// of a sequence) puts it back in flight. Whether that next SEND may go out
// is decided at the exchange client's last line (session.ts claim): not if
// another write on the market started while this one waited.
export type StepPhase = "lost" | "placed";
export type StepFn = (text: string, phase?: StepPhase) => void;

// A read that was NOT sent, or that the venue refused, because the key's
// request budget is spent (MFP counts GETs per key: mfp_rate.ts). Nothing is
// wrong with the venue and nothing was learned about it: the store shows
// "rate limited, next read in N s" and keeps the last lists. `heldUntil`:
// when the next such read may go (epoch ms).
export function heldError(heldUntil: number, message = "rate limited"): Error {
  return Object.assign(new Error(message), { heldUntil });
}
export function heldUntilOf(e: unknown): number | null {
  const t = e !== null && typeof e === "object" ? (e as { heldUntil?: unknown }).heldUntil : undefined;
  return typeof t === "number" && Number.isFinite(t) ? t : null;
}

// Why a snapshot is being read. "tick": the timer or a push signal (a
// background read). "settle": a write is unsettled and this read can settle
// it - the re-read right after the write, and every timed read of the book
// until it settles. A venue with a request budget gives the second more room.
export type ReadWhy = "tick" | "settle";

// What a venue's push channel says (MFP's account stream, mfp_stream.ts).
// It carries NO venue state: "state" / "resync" mean "read the venue now",
// "history" means "read the history now", "live" / "down" say whether the
// channel can be relied on to say so (the store polls less while it can).
export type WatchSignal = "state" | "history" | "resync" | "live" | "down";

export interface VenueClient {
  readonly id: VenueId;
  // True when the venue can be read (an address / a view key is set).
  ready(): Promise<boolean>;
  // Reasons the venue cannot trade (no trade key, no address), or null.
  tradeBlocked(): Promise<string | null>;
  markets(): Promise<Market[]>;
  // The venue's positions and working orders, read NOW (always: a snapshot
  // is the read the ledger judges writes on), with its balance. Throws a
  // heldError when the read may not be sent yet.
  snapshot(why?: ReadWhy): Promise<VenueSnapshot>;
  // The balance alone, when the venue reads it apart from the book and it is
  // due (MFP: the account every 15 to 30 s, the policy every 60 s). null =
  // nothing was read. It is never a read of positions or orders.
  balance?(): Promise<Balance | null>;
  // Start listening to the venue's push channel; returns the stop.
  watch?(on: (signal: WatchSignal) => void): () => void;
  // Settings were saved: start the push channel over ONLY if the key or the
  // account it runs on is not the one it was started for.
  rewatch?(): void | Promise<void>;
  // How many order lookups one reconcile pass may make (absent = no cap).
  readonly maxLookups?: number;
  history(): Promise<HistoryRow[]>;
  quote(marketId: string): Promise<Quote>;
  // Ask the venue about one order this app sent. A read; never sends.
  lookup(ref: WriteRef): Promise<Lookup>;
  // The venue's leverage and margin mode for one market, position or not
  // (how a leverage change is verified with no position open). A read.
  // null = this venue has no such setting to read; throws when unreadable.
  leverage(market: Market): Promise<LeverageRead | null>;

  placeOrder(intent: OrderIntent, market: Market, mark: number | null, step: StepFn): Promise<WriteOutcome>;
  closePosition(pos: Position, fraction: number, slippage: number, step: StepFn): Promise<WriteOutcome>;
  flat(pos: Position, slippage: number, step: StepFn): Promise<WriteOutcome>;
  // maxNotional: the market's cap, re-checked on the OPENING leg at the size
  // and price it is about to be sent at.
  reverse(pos: Position, slippage: number, step: StepFn, maxNotional: number): Promise<WriteOutcome>;
  cancelOrder(order: OpenOrder): Promise<WriteOutcome>;
  // `mark` lets a venue re-check a trigger's side on a move.
  modifyOrder(order: OpenOrder, price: number, size: number | null, mark: number | null): Promise<WriteOutcome>;
  // Place (existing null) or move (existing set) a position's TP / SL.
  // `step` reports a lost answer's wait (Close is not held behind it).
  setExit(pos: Position, kind: "tp" | "sl", price: number, existing: OpenOrder | null, mark: number | null, step?: StepFn): Promise<WriteOutcome>;
  cancelExit(pos: Position, order: OpenOrder): Promise<WriteOutcome>;
  setLeverage(market: Market, leverage: number, isCross: boolean): Promise<WriteOutcome>;
}

export const noKey = (what: string): WriteOutcome => ({ state: "rejected", message: what, ambiguous: false });
