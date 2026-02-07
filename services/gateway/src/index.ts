import "dotenv/config";
import express from "express";
import http from "http";
import attachWs from "./ws/server";
import { getTopOfBook, submitOrder, health } from "./grpc/engineClient";

const app = express();
console.log("[gateway] ENABLE_ORDERS =", process.env.ENABLE_ORDERS);

/**
 * CORS for dev: UI (localhost:3000) -> Gateway (localhost:8080)
 */
app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(express.json({ limit: "1mb" }));

// GET /health -> Engine.Health (gRPC)
app.get("/health", async (_req, res) => {
  try {
    const engine = await health();
    res.json({
      status: "ok",
      service: "gateway",
      engine,
    });
  } catch (e: any) {
    res.status(502).json({
      status: "error",
      service: "gateway",
      engine: "unreachable",
      error: e?.message ?? String(e),
    });
  }
});

// GET /tob?symbol=BTC-USD -> Engine.GetTopOfBook (gRPC)
app.get("/tob", async (req, res) => {
  try {
    const symbol = String(req.query.symbol ?? "").trim();
    if (!symbol) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_SYMBOL",
        message: "Provide ?symbol=BTC-USD",
      });
    }

    const out = await getTopOfBook(symbol);
    return res.json(out);
  } catch (e: any) {
    return res.status(400).json({
      ok: false,
      error: e?.message ?? String(e),
      code: e?.code,
      details: e?.details,
    });
  }
});

// POST /orders -> Engine.SubmitOrder (gRPC)
if (process.env.ENABLE_ORDERS === "true") {
  app.post("/orders", async (req, res) => {
    try {
      const { symbol, side, price, qty, clientOrderId } = req.body ?? {};

      const out = await submitOrder({
        symbol,
        side,
        price,
        qty,
        client_order_id: clientOrderId ?? "",
      });

      res.json(out);
    } catch (e: any) {
      res.status(400).json({
        ok: false,
        error: e?.message ?? String(e),
        code: e?.code,
        details: e?.details,
      });
    }
  });
}

const PORT = 8080;
const server = http.createServer(app);

attachWs(server);

server.listen(PORT, () => {
  console.log(`Gateway listening on http://localhost:${PORT}`);
});
