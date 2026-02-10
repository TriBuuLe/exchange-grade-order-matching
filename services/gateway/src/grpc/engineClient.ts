// services/gateway/src/grpc/engineClient.ts
import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

/**
 * Layout inside gateway container:
 *   /app
 *     ├── src/grpc/engineClient.ts
 *     └── proto/engine.proto
 */
const PROTO_PATH = path.resolve(__dirname, "../../proto/engine.proto");

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const loaded = grpc.loadPackageDefinition(packageDef) as any;

// proto: package engine.v1; service Engine { ... }
const EngineService = loaded?.engine?.v1?.Engine;
if (!EngineService) {
  throw new Error("gRPC Engine service not found (check proto package/service)");
}

// Prefer ENGINE_GRPC_ADDR, fallback for safety
const ENGINE_ADDR =
  process.env.ENGINE_GRPC_ADDR ??
  process.env.ENGINE_ADDR ??
  "127.0.0.1:50051";

const client = new EngineService(
  ENGINE_ADDR,
  grpc.credentials.createInsecure()
);

// ---- Types ----
export type Side = "BUY" | "SELL";

export type SubmitOrderInput = {
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  client_order_id?: string;
};

export type Fill = {
  maker_seq: string | number;
  taker_seq: string | number;
  price: string | number;
  qty: string | number;
};

export type SubmitOrderOutput = {
  accepted_seq: string | number;
  fills: Fill[];
};

export type BookDepthLevel = {
  price: string | number;
  qty: string | number;
};

export type BookDepth = {
  bids: BookDepthLevel[];
  asks: BookDepthLevel[];
};

export type Trade = {
  trade_id: string | number;
  symbol: string;
  price: string | number;
  qty: string | number;
  maker_seq: string | number;
  taker_seq: string | number;
  taker_side: "BUY" | "SELL";
};

// ---- Helpers ----
function unary<TReq, TRes>(
  method: (req: TReq, cb: grpc.requestCallback<TRes>) => void,
  req: TReq
): Promise<TRes> {
  return new Promise((resolve, reject) => {
    method.call(client, req, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

// ---- API (NOTE: lowerCamelCase RPC names) ----
export async function health(): Promise<{ status: string }> {
  return unary(client.health, {});
}

export async function submitOrder(
  input: SubmitOrderInput
): Promise<SubmitOrderOutput> {
  return unary(client.submitOrder, {
    symbol: input.symbol,
    side: input.side,
    price: input.price,
    qty: input.qty,
    client_order_id: input.client_order_id ?? "",
  });
}

export async function getTopOfBook(symbol: string) {
  return unary(client.getTopOfBook, { symbol });
}

export async function getBookDepth(
  symbol: string,
  levels: number
): Promise<BookDepth> {
  return unary(client.getBookDepth, { symbol, levels });
}

export async function getRecentTrades(
  symbol: string,
  after_trade_id: number | string,
  limit: number
): Promise<{ trades: Trade[]; last_trade_id: string | number }> {
  return unary(client.getRecentTrades, {
    symbol,
    after_trade_id,
    limit,
  });
}
