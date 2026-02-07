// services/gateway/src/grpc/engineClient.ts
import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

/**
 * Repo layout (from your screenshot):
 *   exchange-engine/
 *     proto/engine.proto
 *     services/gateway/src/grpc/engineClient.ts
 *
 * So from this file, go up 4 levels to repo root, then /proto/engine.proto
 */
const PROTO_PATH = path.resolve(__dirname, "../../../../proto/engine.proto");

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const loaded = grpc.loadPackageDefinition(packageDef) as any;

// From proto: package engine.v1; service Engine { ... }
const EngineService = loaded?.engine?.v1?.Engine;
if (!EngineService) {
  throw new Error(
    "gRPC service not found at loaded.engine.v1.Engine (check proto path/package/service)"
  );
}

// Prefer ENGINE_GRPC_ADDR, fallback to ENGINE_ADDR for compatibility
const ENGINE_ADDR =
  process.env.ENGINE_GRPC_ADDR ?? process.env.ENGINE_ADDR ?? "127.0.0.1:50051";

const client = new EngineService(ENGINE_ADDR, grpc.credentials.createInsecure());

// ---- Types (minimal, only what we need) ----
export type Side = "BUY" | "SELL";

export type SubmitOrderInput = {
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  client_order_id?: string;
};

export type BookDepthLevel = {
  price: string | number;
  qty: string | number;
};

export type BookDepth = {
  bids: BookDepthLevel[];
  asks: BookDepthLevel[];
};

function unary<TReq, TRes>(method: Function, req: TReq): Promise<TRes> {
  return new Promise((resolve, reject) => {
    method.call(client, req, (err: grpc.ServiceError | null, res: TRes) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

// ---- API ----
export async function health(): Promise<{ status: string }> {
  return unary<{}, { status: string }>(client.Health, {});
}

export async function submitOrder(
  input: SubmitOrderInput
): Promise<{ accepted_seq: string | number }> {
  return unary<any, any>(client.SubmitOrder, {
    symbol: input.symbol,
    // proto enum Side will accept string names when enums: String is used
    side: input.side,
    price: input.price,
    qty: input.qty,
    client_order_id: input.client_order_id ?? "",
  });
}

export async function getTopOfBook(symbol: string): Promise<{
  best_bid_price: string | number;
  best_bid_qty: string | number;
  best_ask_price: string | number;
  best_ask_qty: string | number;
}> {
  return unary<any, any>(client.GetTopOfBook, { symbol });
}

// NEW: GetBookDepth
export async function getBookDepth(
  symbol: string,
  levels: number
): Promise<BookDepth> {
  return unary<any, any>(client.GetBookDepth, { symbol, levels });
}
