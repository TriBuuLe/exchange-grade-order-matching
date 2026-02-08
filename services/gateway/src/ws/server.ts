import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { getTopOfBook, getRecentTrades } from "../grpc/engineClient";

type ClientState = {
  ws: WebSocket;
  symbol: string | null;

  // Per-client cursor: the last trade_id this specific socket has seen
  lastTradeId: number;
};

type SubscribeMsg = {
  type: "subscribe";
  symbol: string;
};

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function attachWs(server: http.Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  const clients = new Map<WebSocket, ClientState>();

  // Track last TOB payload sent per socket to avoid duplicate pushes
  const lastSentTob = new WeakMap<WebSocket, string>();

  wss.on("connection", (ws) => {
    clients.set(ws, { ws, symbol: null, lastTradeId: 0 });

    ws.send(JSON.stringify({ type: "hello", msg: "connected" }));

    ws.on("message", (data) => {
      const text = data.toString("utf8");
      const msg = safeJsonParse(text) as SubscribeMsg | null;

      if (!msg || msg.type !== "subscribe" || typeof msg.symbol !== "string") {
        ws.send(JSON.stringify({ type: "error", error: "invalid_message" }));
        return;
      }

      const st = clients.get(ws);
      if (!st) return;

      st.symbol = msg.symbol;

      // Force immediate TOB push on next tick
      lastSentTob.delete(ws);

      // IMPORTANT: per-client trade cursor.
      st.lastTradeId = 0;

      console.log(`[ws] subscribed symbol=${msg.symbol}`);

      ws.send(JSON.stringify({ type: "subscribed", symbol: msg.symbol }));
    });

    ws.on("close", () => {
      clients.delete(ws);
      lastSentTob.delete(ws);
    });
  });

  // ---- Poll loop ----
  const interval = setInterval(async () => {
    const symbols = new Set<string>();
    for (const st of clients.values()) {
      if (st.symbol) symbols.add(st.symbol);
    }
    if (symbols.size === 0) return;

    // ---- Top of book polling (per-symbol, shared) ----
    const tobBySymbol = new Map<string, any>();
    for (const sym of symbols) {
      try {
        tobBySymbol.set(sym, await getTopOfBook(sym));
      } catch (e: any) {
        tobBySymbol.set(sym, { error: e?.message ?? String(e) });
      }
    }

    for (const st of clients.values()) {
      if (!st.symbol) continue;
      if (st.ws.readyState !== WebSocket.OPEN) continue;

      const payload = {
        type: "top_of_book",
        symbol: st.symbol,
        data: tobBySymbol.get(st.symbol),
      };

      const serialized = JSON.stringify(payload);
      const prev = lastSentTob.get(st.ws);
      if (prev !== serialized) {
        lastSentTob.set(st.ws, serialized);
        st.ws.send(serialized);
      }
    }

    // ---- Trade polling (per-client cursor) ----
    for (const st of clients.values()) {
      if (!st.symbol) continue;
      if (st.ws.readyState !== WebSocket.OPEN) continue;

      const sym = st.symbol;
      const after = st.lastTradeId;

      try {
        const res = await getRecentTrades(sym, after, 100);
        const trades = res.trades ?? [];
        if (trades.length === 0) continue;

        // advance THIS client's cursor
        st.lastTradeId = Number(res.last_trade_id);

        // Forward engine timestamp: ts_ms -> ts (epoch ms)
        const tradesOut = trades.map((t: any) => ({
          trade_id: String(t.trade_id),
          symbol: String(t.symbol),
          price: String(t.price),
          qty: String(t.qty),
          maker_seq: String(t.maker_seq),
          taker_seq: String(t.taker_seq),
          taker_side: t.taker_side,
          ts: Number(t.ts_ms ?? 0),
        }));

        console.log(
          `[ws] send trades symbol=${sym} count=${tradesOut.length} after=${after} last=${st.lastTradeId}`
        );

        st.ws.send(
          JSON.stringify({
            type: "trades",
            symbol: sym,
            trades: tradesOut,
          })
        );
      } catch (e: any) {
        console.log(`[ws] trade poll error symbol=${sym}: ${e?.message ?? String(e)}`);
      }
    }
  }, 100);

  wss.on("close", () => clearInterval(interval));

  console.log("WebSocket attached at ws://localhost:8080/ws");
}

export default attachWs;
