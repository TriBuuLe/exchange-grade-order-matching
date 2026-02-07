import express from "express";
import http from "http";
import attachWs from "./ws/server";
import { getTopOfBook, submitOrder } from "./grpc/engineClient";

const app = express();

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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "gateway" });
});

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

app.get("/markets/:symbol/top", async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const out = await getTopOfBook(symbol);
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

const PORT = 8080;
const server = http.createServer(app);

attachWs(server);

server.listen(PORT, () => {
  console.log(`Gateway listening on http://localhost:${PORT}`);
});
