"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type TopOfBook = {
  best_bid_price: string;
  best_bid_qty: string;
  best_ask_price: string;
  best_ask_qty: string;
};

type DepthLevel = { price: string; qty: string };
type BookDepth = { bids: DepthLevel[]; asks: DepthLevel[] };

// Keep these types for future WS (we're not deleting them)
type WsHello = { type: "hello"; msg: string };
type WsSubscribed = { type: "subscribed"; symbol: string };
type WsTopOfBook = { type: "top_of_book"; symbol: string; data: TopOfBook };
type WsError = { type: "error"; error: string };
type WsMsg = WsHello | WsSubscribed | WsTopOfBook | WsError;

// Prefer env var (correct), fallback to same-host dev behavior
function gatewayBaseUrl() {
  const env = process.env.NEXT_PUBLIC_GATEWAY_HTTP;
  if (env && env.trim()) return env.trim();

  if (typeof window === "undefined") return "http://localhost:8080";
  const host = window.location.hostname;
  const proto = window.location.protocol; // http: or https:
  return `${proto}//${host}:8080`;
}

// Keep wsUrl for future; for now UI uses REST polling (no WS server required)
function wsUrl() {
  if (typeof window === "undefined") return "ws://localhost:8080/ws";
  const host = window.location.hostname;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${host}:8080/ws`;
}

export default function Page() {
  // market / "ws" status (now reflects polling connectivity)
  const [symbol, setSymbol] = useState("BTC-USD");
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">(
    "disconnected"
  );
  const [tob, setTob] = useState<TopOfBook | null>(null);
  const [depth, setDepth] = useState<BookDepth | null>(null);
  const [lastMsg, setLastMsg] = useState<string>("");

  // Keep WS ref for later (not used in v0)
  const wsRef = useRef<WebSocket | null>(null);

  // Polling timer ref (v0)
  const pollRef = useRef<number | null>(null);

  // order entry
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [price, setPrice] = useState<string>("102");
  const [qty, setQty] = useState<string>("1");
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string>("");

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

    // keep lastMsg as debug (what the gateway returned)
    setLastMsg(text);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const data = JSON.parse(text) as TopOfBook;
    setTob(data);
  }

  async function fetchDepth(sym: string, levels: number) {
    const base = gatewayBaseUrl();
    const url = `${base}/depth?symbol=${encodeURIComponent(sym)}&levels=${levels}`;

    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();

    // keep lastMsg useful for debugging; depth will overwrite it as well
    setLastMsg(text);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const data = JSON.parse(text) as BookDepth;
    setDepth(data);
  }

  function connectAndSubscribe(sym: string) {
    // v0: REST polling, not WebSockets
    // clean up any old poll
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }

    // if any old ws exists, close it (future-proof)
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setStatus("connecting");
    setLastMsg("");

    const s = sym.trim();
    if (!s) {
      setStatus("disconnected");
      setTob(null);
      setDepth(null);
      setLastMsg(`{"error":"symbol is required"}`);
      return;
    }

    // immediate fetch, then poll
    Promise.all([fetchTopOfBook(s), fetchDepth(s, 10)])
      .then(() => setStatus("connected"))
      .catch((e: any) => {
        setStatus("disconnected");
        setTob(null);
        setDepth(null);
        setLastMsg(`{"error":"${e?.message ?? String(e)}"}`);
      });

    pollRef.current = window.setInterval(() => {
      Promise.all([fetchTopOfBook(s), fetchDepth(s, 10)])
        .then(() => setStatus("connected"))
        .catch((e: any) => {
          setStatus("disconnected");
          setTob(null);
          setDepth(null);
          setLastMsg(`{"error":"${e?.message ?? String(e)}"}`);
        });
    }, 1000);
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

    // simple deterministic-ish client id for now
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
      } else {
        setSubmitResult(`OK: ${text}`);
      }
    } catch (e: any) {
      setSubmitResult(`Network error: ${e?.message ?? String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    connectAndSubscribe(symbol);

    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (wsRef.current) wsRef.current.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Exchange UI</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Live Top-of-Book + Depth + Order Entry via Gateway
            </p>
          </div>

          <div className="rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span
                className={[
                  "h-2 w-2 rounded-full",
                  status === "connected"
                    ? "bg-green-500"
                    : status === "connecting"
                    ? "bg-yellow-500"
                    : "bg-red-500",
                ].join(" ")}
              />
              <span className="text-neutral-300">{status}</span>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-5">
          {/* Left: controls */}
          <div className="lg:col-span-2 space-y-6">
            {/* Subscribe */}
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
              <h2 className="text-sm font-semibold text-neutral-200">Market</h2>

              <label className="mt-4 block text-xs font-medium text-neutral-400">
                Symbol
              </label>
              <input
                suppressHydrationWarning
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-700"
                placeholder="BTC-USD"
              />

              <button
                onClick={() => connectAndSubscribe(symbol)}
                className="mt-3 w-full rounded-xl bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
              >
                Subscribe
              </button>

              <p className="mt-3 text-[11px] text-neutral-500">
                REST:{" "}
                <span className="text-neutral-300">
                  {gatewayBaseUrl()}/tob?symbol=...
                </span>
              </p>

              <p className="mt-1 text-[11px] text-neutral-500">
                REST:{" "}
                <span className="text-neutral-300">
                  {gatewayBaseUrl()}/depth?symbol=...&levels=10
                </span>
              </p>

              {/* Keep WS line for future, but it's not used in v0 */}
              <p className="mt-1 text-[11px] text-neutral-500">
                WS (later): <span className="text-neutral-300">{wsUrl()}</span>
              </p>
            </div>

            {/* Order Entry */}
            <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
              <h2 className="text-sm font-semibold text-neutral-200">Order Entry</h2>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-neutral-400">Side</label>
                  <select
                    value={side}
                    onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}
                    className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-700"
                  >
                    <option value="BUY">BUY</option>
                    <option value="SELL">SELL</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-medium text-neutral-400">Qty</label>
                  <input
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-700"
                    placeholder="1"
                    inputMode="numeric"
                  />
                </div>

                <div className="col-span-2">
                  <label className="text-xs font-medium text-neutral-400">Price</label>
                  <input
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-700"
                    placeholder="102"
                    inputMode="numeric"
                  />
                </div>
              </div>

              <button
                onClick={submitOrder}
                disabled={submitting}
                className="mt-4 w-full rounded-xl bg-blue-500 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-400 disabled:opacity-60"
              >
                {submitting ? "Submitting..." : "Submit Order"}
              </button>

              {submitResult ? (
                <pre className="mt-3 max-h-40 overflow-auto rounded-xl border border-neutral-800 bg-neutral-950 p-3 text-[11px] text-neutral-200">
                  {submitResult}
                </pre>
              ) : null}

              <p className="mt-3 text-[11px] text-neutral-500">
                REST: <span className="text-neutral-300">{gatewayBaseUrl()}/orders</span>
              </p>
            </div>
          </div>

          {/* Right: TOB + depth + debug */}
          <div className="lg:col-span-3 rounded-2xl border border-neutral-800 bg-neutral-900 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-200">Top of Book</h2>
              <div className="text-xs text-neutral-500">
                Spread:{" "}
                <span className="text-neutral-200">
                  {spread === null ? "—" : spread.toFixed(2)}
                </span>
              </div>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
                <div className="text-xs text-neutral-400">Best Bid</div>
                <div className="mt-2 text-2xl font-semibold">
                  {tob ? tob.best_bid_price : "—"}
                </div>
                <div className="mt-1 text-xs text-neutral-500">
                  Qty: {tob ? tob.best_bid_qty : "—"}
                </div>
              </div>

              <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
                <div className="text-xs text-neutral-400">Best Ask</div>
                <div className="mt-2 text-2xl font-semibold">
                  {tob ? tob.best_ask_price : "—"}
                </div>
                <div className="mt-1 text-xs text-neutral-500">
                  Qty: {tob ? tob.best_ask_qty : "—"}
                </div>
              </div>
            </div>

            {/* Depth (L2) */}
            <div className="mt-5 rounded-2xl border border-neutral-800 bg-neutral-950 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-neutral-200">Depth (L2)</div>
                <div className="text-xs text-neutral-500">Top 10 levels</div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-4">
                {/* Bids */}
                <div>
                  <div className="mb-2 text-xs font-medium text-neutral-400">Bids</div>
                  <div className="space-y-1">
                    {(depth?.bids ?? []).map((lvl) => (
                      <div
                        key={`b-${lvl.price}`}
                        className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs"
                      >
                        <span className="text-neutral-200">{lvl.price}</span>
                        <span className="text-neutral-400">{lvl.qty}</span>
                      </div>
                    ))}
                    {!depth?.bids?.length ? (
                      <div className="text-xs text-neutral-500">—</div>
                    ) : null}
                  </div>
                </div>

                {/* Asks */}
                <div>
                  <div className="mb-2 text-xs font-medium text-neutral-400">Asks</div>
                  <div className="space-y-1">
                    {(depth?.asks ?? []).map((lvl) => (
                      <div
                        key={`a-${lvl.price}`}
                        className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs"
                      >
                        <span className="text-neutral-200">{lvl.price}</span>
                        <span className="text-neutral-400">{lvl.qty}</span>
                      </div>
                    ))}
                    {!depth?.asks?.length ? (
                      <div className="text-xs text-neutral-500">—</div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-5">
              <div className="text-xs text-neutral-500">Last message</div>
              <pre className="mt-2 max-h-56 overflow-auto rounded-xl border border-neutral-800 bg-neutral-950 p-3 text-[11px] text-neutral-300">
                {lastMsg || "—"}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
