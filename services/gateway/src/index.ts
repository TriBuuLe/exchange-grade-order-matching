import "dotenv/config";
import express from "express";
import http from "http";
import attachWs from "./ws/server";
import { getTopOfBook, getBookDepth, submitOrder, health } from "./grpc/engineClient";

const app = express();
console.log("[gateway] ENABLE_ORDERS =", process.env.ENABLE_ORDERS);

/**
 * ---- In-memory Trade Tape (dev) ----
 * Keeps last N events so UI can show "what happened".
 */
type TradeEvent =
  | {
      type: "order_accepted";
      ts: number;
      symbol: string;
      side: "BUY" | "SELL";
      price: number;
      qty: number;
      accepted_seq: string;
      client_order_id?: string;
    }
  | {
      type: "fill";
      ts: number;
      symbol: string;
      price: number;
      qty: number;
      maker_seq: string;
      taker_seq: string;
    };

const EVENT_MAX = 300;
const events: TradeEvent[] = [];

function pushEvent(ev: TradeEvent) {
  events.push(ev);
  if (events.length > EVENT_MAX) {
    events.splice(0, events.length - EVENT_MAX);
  }
}

function listEvents(symbol: string, limit: number) {
  const out: TradeEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.symbol === symbol) out.push(ev);
    if (out.length >= limit) break;
  }
  return out;
}

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

// GET /events?symbol=BTC-USD&limit=50
app.get("/events", (req, res) => {
  const symbol = String(req.query.symbol ?? "").trim();
  const limitRaw = String(req.query.limit ?? "50").trim();
  const limit = Math.min(200, Math.max(1, Number(limitRaw)));

  if (!symbol) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_SYMBOL",
      message: "Provide ?symbol=BTC-USD",
    });
  }

  if (!Number.isFinite(limit)) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_LIMIT",
      message: "Provide ?limit=50 (positive number)",
    });
  }

  return res.json({ symbol, events: listEvents(symbol, limit) });
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

      // Record an order accepted event + any fills (best-effort, non-blocking).
      try {
        pushEvent({
          type: "order_accepted",
          ts: Date.now(),
          symbol: sym,
          side: s,
          price: p,
          qty: q,
          accepted_seq: String((out as any).accepted_seq),
          client_order_id: cid || undefined,
        });

        const fills = (out as any).fills ?? [];
        for (const f of fills) {
          pushEvent({
            type: "fill",
            ts: Date.now(),
            symbol: sym,
            price: Number(f.price),
            qty: Number(f.qty),
            maker_seq: String(f.maker_seq),
            taker_seq: String(f.taker_seq),
          });
        }
      } catch {
        // ignore tape failures
      }

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
