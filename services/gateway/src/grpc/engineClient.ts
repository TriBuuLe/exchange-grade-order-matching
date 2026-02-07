import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const PROTO_PATH = path.join(__dirname, "../../proto/engine.proto");

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const loaded = grpc.loadPackageDefinition(packageDef) as any;

// Based on your proto: package engine.v1; service Engine { ... }
const EngineService = loaded.engine.v1.Engine;

const ENGINE_ADDR = process.env.ENGINE_ADDR ?? "localhost:50051";

const client = new EngineService(
  ENGINE_ADDR,
  grpc.credentials.createInsecure()
);

// ---- Types (minimal, only what we need) ----
export type Side = "BUY" | "SELL";

export type SubmitOrderInput = {
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  client_order_id?: string;
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
export async function health() {
  // proto fields may be empty; keep it simple
  return unary<any, any>(client.Health, {});
}

export async function submitOrder(input: SubmitOrderInput) {
  return unary<any, any>(client.SubmitOrder, {
    symbol: input.symbol,
    side: input.side,
    price: input.price,
    qty: input.qty,
    client_order_id: input.client_order_id ?? "",
  });
}

export async function getTopOfBook(symbol: string) {
  return unary<any, any>(client.GetTopOfBook, { symbol });
}
