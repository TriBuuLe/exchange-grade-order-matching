import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { getTopOfBook } from "../grpc/engineClient";

type ClientState = {
  ws: WebSocket;
  symbol: string | null;
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

  // Track last payload sent per socket to avoid duplicate pushes
  const lastSent = new WeakMap<WebSocket, string>();

  wss.on("connection", (ws) => {
    clients.set(ws, { ws, symbol: null });

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

      // Force next tick to push immediately
      lastSent.delete(ws);

      ws.send(JSON.stringify({ type: "subscribed", symbol: msg.symbol }));
    });

    ws.on("close", () => {
      clients.delete(ws);
      lastSent.delete(ws);
    });
  });

  // Poll loop: fetch TOB per symbol and broadcast ONLY when changed
  const interval = setInterval(async () => {
    const symbols = new Set<string>();
    for (const st of clients.values()) {
      if (st.symbol) symbols.add(st.symbol);
    }
    if (symbols.size === 0) return;

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
      const prev = lastSent.get(st.ws);
      if (prev === serialized) continue;

      lastSent.set(st.ws, serialized);
      st.ws.send(serialized);
    }
  }, 100);

  wss.on("close", () => clearInterval(interval));

  console.log("WebSocket attached at ws://localhost:8080/ws");
}

// IMPORTANT: also export default so any module system can import it reliably
export default attachWs;
