"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MarketHeader from "../components/MarketHeader";
import MarketSubscribeCard from "../components/MarketSubscribeCard";
import OrderEntryCard from "../components/OrderEntryCard";
import TopOfBookCard from "../components/TopOfBookCard";
import DepthCard from "../components/DepthCard";
import TradeTapeCard from "../components/TradeTapeCard";
import DebugPanel from "../components/DebugPanel";
import PriceChartCard from "../components/PriceChartCard";

type TopOfBook = {
  best_bid_price: string;
  best_bid_qty: string;
  best_ask_price: string;
  best_ask_qty: string;
};

type DepthLevel = { price: string; qty: string };
type BookDepth = { bids: DepthLevel[]; asks: DepthLevel[] };

// Fill reporting
type Fill = {
  maker_seq: string;
  taker_seq: string;
  price: string;
  qty: string;
};

type SubmitOrderOk = {
  accepted_seq: string;
  fills: Fill[];
};

// --- WS trades ---
type WsTrade = {
  trade_id: string;
  symbol: string;
  price: string;
  qty: string;
  maker_seq: string;
  taker_seq: string;
  taker_side: "BUY" | "SELL";
  // Gateway SHOULD send this. If missing, we fallback to receipt time.
  ts?: number;
};

type WsTradeWithTs = WsTrade & { ts: number };

type TradesMsg = {
  type: "trades";
  symbol: string;
  trades: WsTrade[];
};

// Prefer env var (correct), fallback to same-host dev behavior
function gatewayBaseUrl() {
  const env = process.env.NEXT_PUBLIC_GATEWAY_HTTP;
  if (env && env.trim()) return env.trim();

  if (typeof window === "undefined") return "http://localhost:8080";
  const host = window.location.hostname;
  const proto = window.location.protocol; // http: or https:
  return `${proto}//${host}:8080`;
}

function wsUrl() {
  if (typeof window === "undefined") return "ws://localhost:8080/ws";
  const host = window.location.hostname;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${host}:8080/ws`;
}

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function fmtTime(ts: number) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString();
  } catch {
    return String(ts);
  }
}

export default function Page() {
  const [symbol, setSymbol] = useState("BTC-USD");
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">(
    "disconnected"
  );

  const [tob, setTob] = useState<TopOfBook | null>(null);
  const [depth, setDepth] = useState<BookDepth | null>(null);
  const [lastMsg, setLastMsg] = useState<string>("");

  const [showDebug, setShowDebug] = useState(false);

  const pollRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // order entry
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [price, setPrice] = useState<string>("102");
  const [qty, setQty] = useState<string>("1");
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string>("");

  // last fills panel state
  const [lastAcceptedSeq, setLastAcceptedSeq] = useState<string | null>(null);
  const [lastFills, setLastFills] = useState<Fill[]>([]);

  // WS-driven trades (tape)
  const [trades, setTrades] = useState<WsTradeWithTs[]>([]);

  const bid = useMemo(() => (tob ? Number(tob.best_bid_price) : 0), [tob]);
  const ask = useMemo(() => (tob ? Number(tob.best_ask_price) : 0), [tob]);

  const spread = useMemo(() => {
    if (!tob) return null;
    if (ask === 0 || bid === 0) return null;
    return ask - bid;
  }, [bid, ask, tob]);

  async function fetchTopOfBook(sym: string) {
    const base = gatewayBaseUrl();
    const url = `${base}/tob?symbol=${encodeURIComponent(sym)}`;

    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();

    setLastMsg(text);

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);

    const data = JSON.parse(text) as TopOfBook;
    setTob(data);
  }

  async function fetchDepth(sym: string, levels: number) {
    const base = gatewayBaseUrl();
    const url = `${base}/depth?symbol=${encodeURIComponent(sym)}&levels=${levels}`;

    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();

    setLastMsg(text);

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);

    const data = JSON.parse(text) as BookDepth;
    setDepth(data);
  }

  function cleanup() {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }

  function connectAndSubscribe(sym: string) {
    cleanup();

    setStatus("connecting");
    setLastMsg("");

    const s = sym.trim();
    if (!s) {
      setStatus("disconnected");
      setTob(null);
      setDepth(null);
      setTrades([]);
      setLastMsg(`{"error":"symbol is required"}`);
      return;
    }

    // reset tape on new subscribe
    setTrades([]);

    // immediate fetch, then poll
    Promise.all([fetchTopOfBook(s), fetchDepth(s, 10)])
      .then(() => setStatus("connected"))
      .catch((e: any) => {
        setStatus("disconnected");
        setTob(null);
        setDepth(null);
        setTrades([]);
        setLastMsg(`{"error":"${e?.message ?? String(e)}"}`);
      });

    pollRef.current = window.setInterval(() => {
      Promise.all([fetchTopOfBook(s), fetchDepth(s, 10)])
        .then(() => setStatus("connected"))
        .catch((e: any) => {
          setStatus("disconnected");
          setTob(null);
          setDepth(null);
          setTrades([]);
          setLastMsg(`{"error":"${e?.message ?? String(e)}"}`);
        });
    }, 1000);

    // WS: trades stream for tape
    try {
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "subscribe", symbol: s }));
      };

      ws.onmessage = async (ev) => {
        const raw =
          typeof ev.data === "string"
            ? ev.data
            : ev.data instanceof Blob
            ? await ev.data.text()
            : String(ev.data);

        const msg = safeJsonParse(raw);
        if (!msg || typeof msg.type !== "string") return;

        if (msg.type === "trades") {
          const m = msg as TradesMsg;

          // Normalize symbol matching
          if (String(m.symbol).trim() !== s.trim()) return;
          if (!Array.isArray(m.trades)) return;

          const receiptNow = Date.now();

          const withTs: WsTradeWithTs[] = m.trades.map((t) => ({
            ...t,
            ts: typeof t.ts === "number" ? t.ts : receiptNow,
          }));

          setTrades((prev) => {
            // Dedupe by trade_id (critical for reconnect/reload)
            const seen = new Set(prev.map((x) => x.trade_id));
            const next: WsTradeWithTs[] = [...prev];

            for (const t of withTs) {
              if (!t.trade_id) continue;
              if (seen.has(t.trade_id)) continue;
              seen.add(t.trade_id);
              next.push(t);
            }

            // Keep last 50
            return next.slice(-50);
          });
        }
      };

      ws.onclose = () => {
        // not fatal; status reflects REST polling anyway
      };

      ws.onerror = () => {
        // not fatal; status reflects REST polling anyway
      };
    } catch {
      // ignore
    }
  }

  async function submitOrder() {
    setSubmitting(true);
    setSubmitResult("");

    const p = Number(price);
    const q = Number(qty);

    if (!symbol.trim()) {
      setSubmitResult("Error: symbol is required");
      setSubmitting(false);
      return;
    }
    if (!Number.isFinite(p) || p < 0) {
      setSubmitResult("Error: price must be a number >= 0");
      setSubmitting(false);
      return;
    }
    if (!Number.isFinite(q) || q <= 0) {
      setSubmitResult("Error: qty must be a number > 0");
      setSubmitting(false);
      return;
    }

    const clientOrderId = `ui-${Date.now()}`;

    try {
      const res = await fetch(`${gatewayBaseUrl()}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: symbol.trim(),
          side,
          price: p,
          qty: q,
          clientOrderId,
        }),
      });

      const text = await res.text();

      if (!res.ok) {
        setSubmitResult(`Error ${res.status}: ${text}`);
        setLastAcceptedSeq(null);
        setLastFills([]);
        return;
      }

      try {
        const data = JSON.parse(text) as SubmitOrderOk;
        setLastAcceptedSeq(String(data.accepted_seq));
        setLastFills(Array.isArray(data.fills) ? data.fills : []);
      } catch {
        setLastAcceptedSeq(null);
        setLastFills([]);
      }

      setSubmitResult(`OK: ${text}`);
    } catch (e: any) {
      setSubmitResult(`Network error: ${e?.message ?? String(e)}`);
      setLastAcceptedSeq(null);
      setLastFills([]);
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    connectAndSubscribe(symbol);

    return () => {
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <MarketHeader
          title="Exchange UI"
          subtitle="Live Top-of-Book + Depth + Order Entry via Gateway"
          status={status}
          showDebug={showDebug}
          onToggleDebug={() => setShowDebug((v) => !v)}
        />
        <div className="mt-8">
          <PriceChartCard symbol={symbol} gatewayBaseUrl={gatewayBaseUrl} />
        </div>


        <div className="mt-8 grid gap-6 lg:grid-cols-5">
          {/* Left: controls */}
          <div className="lg:col-span-2 space-y-6">
            <MarketSubscribeCard
              symbol={symbol}
              onSymbolChange={setSymbol}
              onSubscribe={() => connectAndSubscribe(symbol)}
              showDebug={showDebug}
              gatewayBaseUrl={gatewayBaseUrl}
              wsUrl={wsUrl}
            />

            <OrderEntryCard
              side={side}
              setSide={setSide}
              qty={qty}
              setQty={setQty}
              price={price}
              setPrice={setPrice}
              submitting={submitting}
              onSubmit={submitOrder}
              submitResult={submitResult}
              lastAcceptedSeq={lastAcceptedSeq}
              lastFills={lastFills}
              showDebug={showDebug}
              gatewayBaseUrl={gatewayBaseUrl}
            />
          </div>

          {/* Right: TOB + depth + tape + debug */}
          <div className="lg:col-span-3 space-y-6">
            <TopOfBookCard tob={tob} spread={spread} />

            <DepthCard depth={depth} />
            
            <TradeTapeCard
              fmtTime={fmtTime}
              events={trades.map((t) => ({
                type: "fill",
                ts: t.ts,
                symbol: t.symbol,
                price: Number(t.price),
                qty: Number(t.qty),
                maker_seq: t.maker_seq,
                taker_seq: t.taker_seq,
              }))}
            />

            <DebugPanel show={showDebug} lastMsg={lastMsg} />
          </div>
        </div>
      </div>
    </main>
  );
}
