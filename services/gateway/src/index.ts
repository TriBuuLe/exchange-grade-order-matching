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

function bucketStart(tsMs: number, intervalMs: number) {
  return Math.floor(tsMs / intervalMs) * intervalMs;
}

type Trade = {
  trade_id: number;
  tsMs: number;
  price: number;
  qty: number;
  maker_seq?: string;
  taker_seq?: string;
  taker_side?: string;
};

type SymbolState = {
  symbol: string;
  lastTradeId: number;       // cursor
  lastTradeTsMs: number;     // last seen trade ts
  lastPrice: number | null;  // last seen trade price
  trades: Trade[];           // rolling cache
  lastTouchedMs: number;     // last time someone asked for this symbol
};

const SYMBOL_TTL_MS = 5 * 60_000; // keep active for 5 minutes since last request
const MAX_TRADES_CACHE = 10_000;  // keep enough to build candles reliably

const symbols = new Map<string, SymbolState>();

function getOrCreateSymbolState(sym: string): SymbolState {
  const s = sym.trim();
  let st = symbols.get(s);
  if (!st) {
    st = {
      symbol: s,
      lastTradeId: 0,
      lastTradeTsMs: 0,
      lastPrice: null,
      trades: [],
      lastTouchedMs: Date.now(),
    };
    symbols.set(s, st);
  } else {
    st.lastTouchedMs = Date.now();
  }
  return st;
}

// Pull new trades incrementally using cursor (never "after=0" except first time).
async function pumpTrades(sym: string): Promise<void> {
  const st = getOrCreateSymbolState(sym);

  // If nobody asked for this symbol recently, skip.
  if (Date.now() - st.lastTouchedMs > SYMBOL_TTL_MS) return;

  // Ask engine only for trades after our cursor
  const after = st.lastTradeId;

  const res = await getRecentTrades(sym, after, 1000);
  const raw = res.trades ?? [];
  if (raw.length === 0) {
    // still advance lastTradeId if engine returns it (some impls do)
    const lt = Number((res as any).last_trade_id);
    if (Number.isFinite(lt) && lt > st.lastTradeId) st.lastTradeId = lt;
    return;
  }

  // Normalize and append
  for (const t of raw as any[]) {
    const tid = Number(t.trade_id);
    const rawTs = Number(t.ts_ms ?? t.tsMs ?? 0);
    const price = Number(t.price);
    const qty = Number(t.qty);

    if (!Number.isFinite(tid)) continue;
    if (!Number.isFinite(rawTs) || rawTs <= 0) continue;
    if (!Number.isFinite(price)) continue;
    if (!Number.isFinite(qty)) continue;

    const tsMs = rawTs < 10_000_000_000 ? rawTs * 1000 : rawTs;

    // de-dupe (in case engine repeats last trade)
    if (st.trades.length && st.trades[st.trades.length - 1].trade_id === tid) continue;

    st.trades.push({
      trade_id: tid,
      tsMs,
      price,
      qty,
      maker_seq: t.maker_seq ? String(t.maker_seq) : undefined,
      taker_seq: t.taker_seq ? String(t.taker_seq) : undefined,
      taker_side: t.taker_side ? String(t.taker_side) : undefined,
    });

    st.lastTradeId = Math.max(st.lastTradeId, tid);
    st.lastTradeTsMs = Math.max(st.lastTradeTsMs, tsMs);
    st.lastPrice = price;
  }

  // cap cache
  if (st.trades.length > MAX_TRADES_CACHE) {
    st.trades = st.trades.slice(st.trades.length - MAX_TRADES_CACHE);
  }

  // some engines return last_trade_id separately; trust max
  const lt = Number((res as any).last_trade_id);
  if (Number.isFinite(lt) && lt > st.lastTradeId) st.lastTradeId = lt;
}

// Background pump for any symbol that has been requested recently.
setInterval(() => {
  for (const st of symbols.values()) {
    if (Date.now() - st.lastTouchedMs > SYMBOL_TTL_MS) continue;
    pumpTrades(st.symbol).catch(() => {});
  }
}, 200);

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
    if (limit > 2000) limit = 2000;

    // mark active + pull once to be fresh
    const st = getOrCreateSymbolState(symbol);
    await pumpTrades(symbol).catch(() => {});

    const now = Date.now();
    const end = bucketStart(now, intervalMs);
    const start = end - (limit - 1) * intervalMs;

    // Build buckets from cached trades within the requested window (plus a bit of slack)
    const buckets = new Map<number, Candle>();

    // Seed lastClose: if we have any lastPrice and it happened before window start, use it
    let lastClose: number | null = null;
    if (st.lastPrice !== null && st.lastTradeTsMs > 0 && st.lastTradeTsMs < start) {
      lastClose = st.lastPrice;
    }

    // Consider trades in cache; cache is sorted append-only
    for (const tr of st.trades) {
      if (tr.tsMs < start - 10 * intervalMs) continue; // cheap skip old
      if (tr.tsMs > end + 10 * intervalMs) continue;

      const bs = bucketStart(tr.tsMs, intervalMs);
      if (bs < start || bs > end) continue;

      const c = buckets.get(bs);
      if (!c) {
        buckets.set(bs, {
          ts: bs,
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

    // Fill forward to "now" so the series never freezes in time
    const filled: Candle[] = [];
    for (let ts = start; ts <= end; ts += intervalMs) {
      const existing = buckets.get(ts);
      if (existing) {
        filled.push(existing);
        lastClose = existing.close;
      } else if (lastClose !== null) {
        filled.push({
          ts,
          open: lastClose,
          high: lastClose,
          low: lastClose,
          close: lastClose,
          volume: 0,
        });
      }
    }

    const sliced = filled.slice(-limit);

    // Debug headers to validate behavior
    res.setHeader("X-CANDLES-START", String(sliced[0]?.ts ?? ""));
    res.setHeader("X-CANDLES-END", String(sliced[sliced.length - 1]?.ts ?? ""));
    res.setHeader("X-CURSOR-LAST_TRADE_ID", String(st.lastTradeId));
    res.setHeader("X-LAST_PRICE", String(st.lastPrice ?? ""));
    res.setHeader("X_LAST_TRADE_TS_MS", String(st.lastTradeTsMs ?? ""));

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
