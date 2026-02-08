// services/gateway/src/index.ts

import "dotenv/config";
import express from "express";
import http from "http";
import attachWs from "./ws/server";
import {
  getTopOfBook,
  getBookDepth,
  submitOrder,
  health,
  getRecentTrades,
} from "./grpc/engineClient";

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

function parseIntervalToMs(s: string): number | null {
  const v = String(s ?? "").trim().toLowerCase();
  const map: Record<string, number> = {
    "1s": 1_000,
    "5s": 5_000,
    "10s": 10_000,
    "30s": 30_000,
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
  };
  return map[v] ?? null;
}

type Candle = {
  ts: number; // bucket start time (ms)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // sum qty
};

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

// GET /depth?symbol=BTC-USD&levels=10 -> Engine.GetBookDepth (gRPC)
app.get("/depth", async (req, res) => {
  try {
    const symbol = String(req.query.symbol ?? "").trim();
    const levelsRaw = String(req.query.levels ?? "").trim();

    if (!symbol) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_SYMBOL",
        message: "Provide ?symbol=BTC-USD",
      });
    }

    const levels = levelsRaw ? Number(levelsRaw) : 10;
    if (!Number.isFinite(levels) || levels <= 0) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_LEVELS",
        message: "Provide ?levels=10 (positive number)",
      });
    }

    const out = await getBookDepth(symbol, levels);
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

// GET /candles?symbol=BTC-USD&interval=1s&limit=300
app.get("/candles", async (req, res) => {
  try {
    const symbol = String(req.query.symbol ?? "").trim();
    if (!symbol) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_SYMBOL",
        message: "Provide ?symbol=BTC-USD",
      });
    }

    const intervalRaw = String(req.query.interval ?? "1s");
    const intervalMs = parseIntervalToMs(intervalRaw);
    if (!intervalMs) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_INTERVAL",
        message: "Use interval=1s|5s|10s|30s|1m|5m|15m|1h",
      });
    }

    const limitRaw = String(req.query.limit ?? "300").trim();
    let limit = Number(limitRaw);
    if (!Number.isFinite(limit) || limit <= 0) limit = 300;
    if (limit > 2000) limit = 2000; // keep response bounded

    // Pull recent trades from engine (most recent N, capped by engine)
    // We request a lot so candles can fill; if there aren't enough trades, you'll get fewer candles.
    const tradeRes = await getRecentTrades(symbol, 0, 1000);
    const trades = tradeRes.trades ?? [];

    // Expect ts_ms from engine (proto field becomes tsMs in JS with keepCase:true? actually keepCase:true keeps ts_ms)
    // But ws server uses t.ts_ms, so we support both for safety.
    const normalized = trades
      .map((t: any) => {
        const ts = Number(t.ts_ms ?? t.tsMs ?? 0);
        const price = Number(t.price);
        const qty = Number(t.qty);
        if (!Number.isFinite(ts) || ts <= 0) return null;
        if (!Number.isFinite(price)) return null;
        if (!Number.isFinite(qty)) return null;
        return { ts, price, qty };
      })
      .filter(Boolean) as Array<{ ts: number; price: number; qty: number }>;

    // Sort ascending by time to build candles deterministically
    normalized.sort((a, b) => a.ts - b.ts);

    const buckets = new Map<number, Candle>();

    for (const tr of normalized) {
      const bucketStart = Math.floor(tr.ts / intervalMs) * intervalMs;
      const c = buckets.get(bucketStart);
      if (!c) {
        buckets.set(bucketStart, {
          ts: bucketStart,
          open: tr.price,
          high: tr.price,
          low: tr.price,
          close: tr.price,
          volume: tr.qty,
        });
      } else {
        c.high = Math.max(c.high, tr.price);
        c.low = Math.min(c.low, tr.price);
        c.close = tr.price;
        c.volume += tr.qty;
      }
    }

    const out = Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);

    // Keep only last `limit` candles
    const sliced = out.slice(-limit);

    return res.json({
      ok: true,
      symbol,
      interval: intervalRaw,
      interval_ms: intervalMs,
      count: sliced.length,
      candles: sliced,
    });
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
// NOTE: Gateway does NOT create trades or events.
// Engine is the single source of truth.
if (process.env.ENABLE_ORDERS === "true") {
  app.post("/orders", async (req, res) => {
    try {
      const { symbol, side, price, qty, clientOrderId } = req.body ?? {};

      const sym = String(symbol ?? "").trim();
      const s = String(side ?? "").trim().toUpperCase() as "BUY" | "SELL";
      const p = Number(price);
      const q = Number(qty);
      const cid = String(clientOrderId ?? "").trim();

      const out = await submitOrder({
        symbol: sym,
        side: s,
        price: p,
        qty: q,
        client_order_id: cid,
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
