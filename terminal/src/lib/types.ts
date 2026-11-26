// Venue-neutral shapes the UI reads. Both venue clients (hl_venue.ts,
// mfp_venue.ts) and the mock (mock_venue.ts) produce exactly these; the
// screens never see a raw venue payload.

export type VenueId = "hl" | "mfp";
export type Side = "long" | "short";
export type OrderSide = "buy" | "sell";

export const VENUE_LABEL: Record<VenueId, string> = { hl: "HL", mfp: "MFP" };

// A market the app can trade or watch. `id` is the venue's own identifier
// (HL: the coin id "BTC" / "xyz:NVDA"; MFP: the market_id
// "hyperliquid|BTC" / "binance|ETHUSDT"). `chartCoin` is the Hyperliquid
// coin whose candles draw the chart (null = no chart source).
export type Market = {
  key: string;           // venue + ":" + id, unique app-wide
  venue: VenueId;
  id: string;
  symbol: string;        // display: "BTC", "NVDA"
  chartCoin: string | null;
  chartNote: string | null;
  szDecimals: number | null;
  maxLeverage: number | null;
  provider: string | null;   // MFP execution venue ("hyperliquid", "binance")
};

export type Position = {
  key: string;           // venue + ":" + marketId
  venue: VenueId;
  marketId: string;
  symbol: string;
  chartCoin: string | null;
  side: Side;
  size: number;          // absolute, base units
  entry: number;
  mark: number | null;
  pnl: number | null;    // unrealized, USD
  notional: number;      // abs, USD
  liq: number | null;
  leverage: number | null;
  marginMode: "cross" | "isolated" | null;
  marginUsed: number | null;
  ref:
    | { kind: "hl"; dex: string; szi: number }
    | { kind: "mfp"; positionId: string; accountId: string; sizeDecimals: number | null };
};

export type OrderKind = "limit" | "tp" | "sl" | "market" | "other";

export type OpenOrder = {
  key: string;           // venue + ":" + venue order id
  venue: VenueId;
  marketId: string;
  symbol: string;
  side: OrderSide;
  kind: OrderKind;
  price: number;         // limit price, or the trigger price for tp / sl
  size: number;
  reduceOnly: boolean;
  status: "resting" | "pending";   // pending = the venue says it is still being placed / armed
  createdAt: number | null;        // ms
  // What of this order already executed while it works (MFP filled_size).
  // Absent / 0 = nothing, as far as the venue's row says.
  filled?: number;
  ref:
    | { kind: "hl"; dex: string; oid: number; cloid: string | null; isTrigger: boolean }
    | { kind: "mfp"; orderId: string; clientOrderId: string | null; positionId: string | null };
};

export type HistoryRow = {
  key: string;
  venue: VenueId;
  marketId: string;
  symbol: string;
  time: number;          // ms
  side: OrderSide | null;
  size: number | null;
  price: number | null;
  pnl: number | null;    // realized, when the venue reports it
  fee: number | null;
  text: string;          // "filled", "canceled", "rejected: ...", "Open Long", ...
  status: "filled" | "canceled" | "rejected" | "expired" | "other";
};

export type Balance = {
  venue: VenueId;
  equity: number | null;
  available: number | null;
  marginUsed: number | null;
  // MFP account risk (trading-policy / account risk block)
  dailyLossRoom: number | null;
  drawdownRoom: number | null;
  // MFP exposure caps when the venue reports them
  exposureCap: number | null;
  accountExposureCap: number | null;
  label: string;         // "main", "acct A1 evaluation"
};

export type VenueStatus = {
  venue: VenueId;
  state: "idle" | "ok" | "error" | "nokey";
  latencyMs: number | null;
  lastAt: number | null;
  error: string | null;
  // The last read was not sent, or was refused, for the key's request
  // budget (MFP): the next one may go at this time (epoch ms). null = no
  // such hold. `state` and `lastAt` still describe the last read that ran.
  heldUntil: number | null;
};

export type Quote = { bid: number | null; ask: number | null; mid: number | null; at: number };

export type VenueSnapshot = {
  venue: VenueId;
  positions: Position[];
  orders: OpenOrder[];
  balance: Balance | null;
  mids: Record<string, number>;   // by marketId
  chg24: Record<string, number>;  // 24h change in percent, by marketId (when the venue reports it)
  at: number;
};
