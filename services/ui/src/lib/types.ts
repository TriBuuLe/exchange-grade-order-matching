export type TopOfBook = {
  best_bid_price: string;
  best_bid_qty: string;
  best_ask_price: string;
  best_ask_qty: string;
};

export type DepthLevel = { price: string; qty: string };
export type BookDepth = { bids: DepthLevel[]; asks: DepthLevel[] };

// Fill reporting (from SubmitOrder response)
export type Fill = {
  maker_seq: string;
  taker_seq: string;
  price: string;
  qty: string;
};

export type SubmitOrderOk = {
  accepted_seq: string;
  fills: Fill[];
};

// ---- Trade Tape (legacy /events) ----
// (We will remove this later; for refactor we keep behavior identical.)
export type OrderAcceptedEvent = {
  type: "order_accepted";
  ts: number;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  accepted_seq: string;
  client_order_id?: string;
};

export type FillEvent = {
  type: "fill";
  ts: number;
  symbol: string;
  price: number;
  qty: number;
  maker_seq: string;
  taker_seq: string;
};

export type TradeEvent = OrderAcceptedEvent | FillEvent;
export type EventsResponse = { symbol: string; events: TradeEvent[] };
