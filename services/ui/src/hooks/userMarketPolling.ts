import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookDepth, EventsResponse, TopOfBook, TradeEvent } from "../lib/types";
import { gatewayBaseUrl } from "../lib/gateway";

export function useMarketPolling(initialSymbol: string) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">(
    "disconnected"
  );

  const [tob, setTob] = useState<TopOfBook | null>(null);
  const [depth, setDepth] = useState<BookDepth | null>(null);
  const [events, setEvents] = useState<TradeEvent[]>([]);
  const [lastMsg, setLastMsg] = useState<string>("");

  const pollRef = useRef<number | null>(null);
  const eventsPollRef = useRef<number | null>(null);

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

  async function fetchEvents(sym: string) {
    const base = gatewayBaseUrl();
    const url = `${base}/events?symbol=${encodeURIComponent(sym)}&limit=30`;

    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);

    const data = JSON.parse(text) as EventsResponse;
    setEvents(Array.isArray(data.events) ? data.events : []);
  }

  const connectAndSubscribe = useCallback((sym: string) => {
    // clear old polls
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (eventsPollRef.current) {
      window.clearInterval(eventsPollRef.current);
      eventsPollRef.current = null;
    }

    setStatus("connecting");
    setLastMsg("");

    const s = sym.trim();
    setSymbol(s);

    if (!s) {
      setStatus("disconnected");
      setTob(null);
      setDepth(null);
      setEvents([]);
      setLastMsg(`{"error":"symbol is required"}`);
      return;
    }

    // immediate fetch, then poll
    Promise.all([fetchTopOfBook(s), fetchDepth(s, 10), fetchEvents(s)])
      .then(() => setStatus("connected"))
      .catch((e: any) => {
        setStatus("disconnected");
        setTob(null);
        setDepth(null);
        setEvents([]);
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

    eventsPollRef.current = window.setInterval(() => {
      fetchEvents(s).catch(() => {
        // don't nuke UI if tape fetch fails
      });
    }, 1000);
  }, []);

  useEffect(() => {
    // initial connect
    connectAndSubscribe(initialSymbol);

    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (eventsPollRef.current) window.clearInterval(eventsPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    symbol,
    setSymbol,
    status,
    tob,
    depth,
    events,
    spread,
    lastMsg,
    connectAndSubscribe,
    refreshEvents: fetchEvents,
  };
}
